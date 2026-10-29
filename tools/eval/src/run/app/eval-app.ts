/**
 * `createEvalApp`: the real headless app, composed with the meter, the network layer and the
 * observers, behind `EvalApp` (docs/EVAL.md, tools/eval/README.md "The eval app").
 *
 * What is real: `createHeadlessApp` (every service of the app: agents, bridge, procedures, vault,
 * browser, prompts, providers), the agent host process (the eval host bundle: the product's
 * `runHost` plus the world), Chromium, the vault. What is replaced: the person (the run drives
 * `send`, `respond` and `addClave`, which are the calls the UI makes), the network (every request
 * goes to SpainBench or nowhere) and the model's gateway (the meter).
 *
 * The decisions that shape it, with their reasons, are on the pieces: `providers.ts` (how the
 * model credential gets to the agents and never to disk), `agents.ts` (host launch), `browser.ts`
 * (the browser), `observers.ts` (what becomes an observation), `provider-vault.ts`.
 *
 * The app does not run in the run folder. Its user data directory is the working directory of the
 * agents (pi records it in their sessions) and holds their documents, so it lives in a neutral
 * temporary folder (`sa-<hex>`, see `neutralLocations`) that says nothing about evaluation, the
 * run or the fixture, should a path ever reach a prompt, a summary or a tool result; the run folder
 * gets a copy of it (`profile/`) at every checkpoint and at the end.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent } from '@sa/agent';
import { createHeadlessApp, type HeadlessApp } from '@sa/desktop/headless';
import { ASSISTANT_AGENT_ID, type PromptResponse } from '@sa/shared';
import type {
  CreateEvalApp,
  EvalApp,
  EvalAppDeps,
  EvalAppSpec,
  PendingPrompt,
  RunView,
} from '../../contracts';
import { fixtureSecrets } from '../../fixtures';
import { HostEvalConfigSchema } from '../../host';
import { credentialSecrets, type MeterRun } from '../../llm';
import {
  EvalNetwork,
  followNetLog,
  HostTable,
  NetLog,
  type NetLogFollower,
  normalizeHost,
} from '../../net';
import { AgentFleet, type AgentIdentity, writeHostLog } from './agents';
import {
  createEvalBrowserFactory,
  hasBrowserState,
  parseBrowserState,
  serializeBrowserState,
} from './browser';
import { maskHomeInTree } from './home-paths';
import { ensureEvalHostBundle, type HostBundleOptions } from './host-bundle';
import { Observers } from './observers';
import { offlinePlaces } from './places';
import { copyProfile, isEmptyDirectory, profileDirOf, seedVault } from './profile';
import { toPendingPrompt } from './prompts';
import { openRunVault, type VaultPort } from './provider-vault';
import { activateProvider, createProviderLib } from './providers';
import { loadResearchAnswer } from './research';
import { LeakLog, SecretBook } from './secrets';
import { SessionTail } from './session-tail';

/**
 * Where the app lives while a run goes: a folder under the OS temporary directory named like an
 * app's own (`sa-` and twelve hex digits), with the user data, the app's scratch space and its
 * exports inside. Nothing in the path says what is being done: no `eval`, no run id, no `runs`.
 */
export function neutralLocations(base = tmpdir()): {
  root: string;
  userData: string;
  tmpRoot: string;
  exports: string;
} {
  const root = join(base, `sa-${randomBytes(6).toString('hex')}`);
  return {
    root,
    userData: join(root, 'data'),
    tmpRoot: join(root, 'tmp'),
    exports: join(root, 'exports'),
  };
}

/** The profile's key provider seed: fixed, so a copied profile opens (a run's vault is synthetic). */
export const PROFILE_KEY_SEED = 'sa-eval-profile';
/** Nothing is reachable here: the app only needs a URL to enable voucher redemption, which is stubbed. */
const KEY_SERVER_PLACEHOLDER = 'http://key-server.eval.invalid';
/** Agents stay alive between messages for as long as a run can last. */
const IDLE_MS = 24 * 60 * 60 * 1000;
/** A host that is asked to stop and has not by then is killed. */
const STOP_GRACE_MS = 1000;

/** How `untilIdle` checks. */
const POLL_MS = 25;
const DEFAULT_HOLD_MS = 300;

/** Seams for the tests of this module; the run loop never passes them. */
export interface EvalAppInternals {
  /** Where the eval host bundle is, and how to build it when it is not there. */
  hostBundle?: HostBundleOptions;
  /** Gets the headless app as soon as it exists (to call what a test must: its renderer API). */
  onApp?(app: HeadlessApp): void;
}

type State = 'open' | 'aborted' | 'closed';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolveSleep();
      },
      { once: true },
    );
  });

interface Parts {
  spec: EvalAppSpec;
  runDir: string;
  /** The run's meter: it is told every secret and tells when one is in a model request. */
  meter: MeterRun;
  /** The neutral folder the app lives in, and its user data: copied to `<runDir>/profile`, then removed. */
  neutral: { root: string; userData: string };
  app: HeadlessApp;
  vault: () => VaultPort;
  fleet: AgentFleet;
  network: EvalNetwork;
  browserLog: NetLog;
  secrets: SecretBook;
  leaks: LeakLog;
  observers: Observers;
  browserMasks: { takeHits(): number };
  /** Shared with the fleet: once set, no agent may start. */
  halt: { stopped: boolean };
}

class EvalAppImpl implements EvalApp {
  readonly runDir: string;
  private state: State = 'open';
  /** Operations the run started (`send`, `respond`, `addClave`) that have not returned. */
  private inflight = 0;
  /** Deliveries the app tracks after a run ended or a message was sent. */
  private settling = 0;
  /** Agent starts and prompts the app waits on. */
  private agentOperations = 0;
  private readonly tails = new Map<string, SessionTail>();
  private readonly followers: NetLogFollower[] = [];
  private readonly unsubscribe: (() => void)[] = [];
  private stopping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly parts: Parts) {
    this.runDir = parts.runDir;
  }

  // --- wiring (called by createEvalApp) --------------------------------------------------------

  /** An agent host is about to start: follow its session file and its net log. */
  onLaunch(identity: AgentIdentity): void {
    const { observers } = this.parts;
    if (!this.tails.has(identity.sessionFile)) {
      this.tails.set(
        identity.sessionFile,
        new SessionTail(identity.sessionFile, (entry) => observers.sessionEntry(identity, entry)),
      );
    }
    this.followers.push(followNetLog(identity.netlog, (record) => observers.netRecord(record)));
  }

  onAgentEvent(identity: AgentIdentity, event: AgentEvent): void {
    // A host that is stopped on purpose (an abort, the end of the run) dies: that is no event of
    // the run.
    if (event.type !== 'process_exit' || this.state === 'open') {
      this.parts.observers.agentEvent(identity, event);
    }
    if (event.type === 'log' || event.type === 'process_exit') {
      try {
        writeHostLog(this.runDir, identity, event, (text) => this.parts.secrets.mask(text));
      } catch {
        // a log that cannot be written must not take the agent down
      }
    }
    // A run ended: the app may now be handing a report to another agent, which is work no
    // agent is doing yet. Its own handler (registered after this one) runs before the check.
    if (event.type === 'run_end' || event.type === 'process_exit') this.settleDeliveries();
  }

  onAgentOperation(delta: 1 | -1): void {
    this.agentOperations += delta;
  }

  /** Starts listening to the app (after the profile was seeded: seeding is not part of the run). */
  attach(): void {
    const { app, observers, spec } = this.parts;
    this.unsubscribe.push(app.on((event) => observers.appEvent(event)));
    this.unsubscribe.push(this.parts.meter.on((event) => observers.meterEvent(event)));
    // What the run knew before the app existed (the fixture's passwords, the model's credential).
    for (const secret of this.parts.secrets.list()) this.parts.meter.addSecret(secret);
    observers.announcePending(app.services.prompts.pendingItems());
    observers.refreshCanaries();
    const onAbort = () => void this.abort('signal');
    spec.signal.addEventListener('abort', onAbort, { once: true });
    this.unsubscribe.push(() => spec.signal.removeEventListener('abort', onAbort));
    // Aborted while the app was starting: the listener above would never hear it.
    if (spec.signal.aborted) onAbort();
    // The browser's own log (the app process): immediate, with what its scrub masked.
    this.unsubscribe.push(
      this.parts.browserLog.on((record) =>
        observers.netRecord(record, { masked: this.parts.browserMasks.takeHits() > 0 }),
      ),
    );
  }

  // --- the user's side -------------------------------------------------------------------------

  private assertOpen(what: string): void {
    if (this.state !== 'open') throw new Error(`Cannot ${what}: the app was ${this.state}`);
  }

  private async operation<T>(fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
    }
  }

  /** Waits (in the background) for the deliveries the app tracks, counting as busy meanwhile. */
  private settleDeliveries(): void {
    const { services } = this.parts.app;
    this.settling++;
    queueMicrotask(() => {
      Promise.all([services.coordinator.settled(), services.chat.settled()])
        .catch(() => {})
        .finally(() => {
          this.settling--;
        });
    });
  }

  async send(text: string): Promise<void> {
    this.assertOpen('send a message');
    this.parts.observers.userMessage(text);
    await this.operation(async () => {
      await this.parts.app.invoke('chat.send', { text });
      this.settleDeliveries();
    });
  }

  pendingPrompts(): PendingPrompt[] {
    return this.parts.app.services.prompts
      .pendingItems()
      .map(({ owner, item }) => toPendingPrompt(owner, item));
  }

  async respond(itemId: string, response: PromptResponse): Promise<void> {
    this.assertOpen('answer a prompt');
    await this.operation(() => this.parts.app.invoke('chat.respond', itemId, response));
  }

  async addClave(input: { username: string; password: string; label?: string }): Promise<string> {
    this.assertOpen('add a credential');
    this.addSecret(input.password);
    const credential = await this.operation(() => this.parts.app.invoke('vault.addClave', input));
    return credential.id;
  }

  async addDocument(input: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    procedureId?: string;
  }): Promise<string> {
    this.assertOpen('add a document');
    const document = await this.operation(() =>
      this.parts.app.invoke('vault.addDocument', { ...input, source: 'user' }),
    );
    return document.id;
  }

  addSecret(value: string): void {
    this.parts.secrets.add(value);
    this.parts.app.logger.addSecret(value);
    // The meter searches every model request body for it from now on.
    this.parts.meter.addSecret(value);
    this.parts.observers.refreshCanaries();
  }

  // --- quiescence ------------------------------------------------------------------------------

  idle(): boolean {
    if (this.state !== 'open') return false;
    if (this.inflight > 0 || this.settling > 0 || this.agentOperations > 0) return false;
    const { services } = this.parts.app;
    if (services.agents.isRunning(ASSISTANT_AGENT_ID)) return false;
    for (const procedure of services.procedures.list()) {
      if (services.agents.isRunning(procedure.id)) return false;
    }
    return services.prompts.pendingItems().length === 0;
  }

  async untilIdle(
    options: { holdMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<boolean> {
    const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    const deadline =
      options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
    let idleSince: number | undefined;
    for (;;) {
      if (this.state !== 'open' || options.signal?.aborted) return false;
      if (this.idle()) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= holdMs) {
          // Everything the app did is in the observations before the caller acts on "idle".
          await this.drain();
          if (this.idle()) return true;
          idleSince = undefined;
        }
      } else {
        idleSince = undefined;
      }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(POLL_MS, left), options.signal);
    }
  }

  counters(): { toolCalls: number; prompts: number } {
    return this.parts.observers.counters();
  }

  /** Everything written so far by the hosts and the app has been read and turned into observations. */
  private async drain(): Promise<void> {
    await Promise.all([
      ...[...this.tails.values()].map((tail) => tail.drain()),
      ...this.followers.map((follower) => follower.drain()),
    ]);
    await this.parts.observers.flush();
  }

  // --- what the run reads ----------------------------------------------------------------------

  async vaultDocuments(): ReturnType<RunView['vaultDocuments']> {
    const vault = this.parts.vault();
    return vault.listDocuments().map((document) => ({
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      source: document.source,
      ...(document.procedureId ? { procedureId: document.procedureId } : {}),
      read: async () => new Uint8Array(await vault.readDocument(document.id)),
    }));
  }

  secretLeaks(): string[] {
    return this.parts.leaks.list();
  }

  // --- ending ----------------------------------------------------------------------------------

  async abort(reason: string): Promise<void> {
    if (this.state === 'open') {
      this.state = 'aborted';
      this.parts.halt.stopped = true;
      this.parts.app.logger.warn('the run was aborted', { reason });
      this.stopping = this.stopEverything();
    }
    await this.stopping;
  }

  /**
   * Nothing may reach the meter after this: no new agent can start (the fleet refuses), the ones
   * that run are asked to stop through the app (which marks them as stopping, so their death is
   * not reported to another agent) and killed if they do not.
   */
  private async stopEverything(): Promise<void> {
    const { app, fleet, network } = this.parts;
    const { services } = app;
    services.prompts.cancelEverything();
    await Promise.allSettled([services.agents.stopAll(), fleet.stopAll(STOP_GRACE_MS)]);
    await services.browser.closeAll().catch(() => {});
    await network.close().catch(() => {});
  }

  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  private async shutDown(): Promise<void> {
    const { app, fleet, network, browserLog, observers, runDir, secrets, neutral } = this.parts;
    const failures: unknown[] = [];
    const step = async (fn: () => Promise<void> | void) => {
      try {
        await fn();
      } catch (error) {
        failures.push(error);
      }
    };
    this.state = 'closed';
    this.parts.halt.stopped = true;
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    await step(() => this.stopping);
    // The app flushes what it writes lazily; the hosts are gone before it is done.
    await step(async () => {
      await Promise.all([app.close(), fleet.stopAll(STOP_GRACE_MS)]);
    });
    await step(async () => {
      await this.drain();
      observers.releaseWaitingEnds();
      await Promise.all([
        ...[...this.tails.values()].map((tail) => tail.stop()),
        ...this.followers.map((follower) => follower.stop()),
      ]);
      await observers.flush();
    });
    await step(() => network.close());
    await step(() => browserLog.close());
    await step(() => copyTranscripts(app, runDir, (text) => secrets.mask(text)));
    await step(() => maskHostLogs(runDir, (text) => secrets.mask(text)));
    // The app is gone: what it kept is the run's `profile/`, and the neutral folder goes.
    await step(() => copyProfile(neutral.userData, profileDirOf(runDir)));
    // The hosts' configs, logs, transcripts and the profile copy name the developer's home.
    for (const folder of ['host', 'net', 'logs', 'transcripts', 'profile']) {
      await step(() => maskHomeInTree(join(runDir, folder)));
    }
    await step(() => rm(neutral.root, { recursive: true, force: true }));
    await step(() => rm(join(runDir, 'tmp'), { recursive: true, force: true }));
    if (failures.length > 0) {
      throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'close failed');
    }
  }

  // --- checkpoints -----------------------------------------------------------------------------

  async checkpoint(dir: string): Promise<{ profileDir: string; browserStateFile?: string }> {
    this.assertOpen('take a checkpoint');
    if (!this.idle()) {
      throw new Error(
        'A checkpoint can only be taken while the app is idle: an agent is running, a prompt is pending or work is being handed over',
      );
    }
    const { app } = this.parts;
    const { services } = app;
    await this.drain();
    // The state of the browser first (it is asked through the agents' queue), then what is
    // written lazily: nothing runs in between because the app is idle.
    const states: Record<string, string> = {};
    const browser = services.browser.current();
    if (browser) {
      for (const procedure of services.procedures.list()) {
        const state = await browser.exportState(procedure.id);
        if (state && hasBrowserState(state)) states[procedure.id] = state;
      }
    }
    await Promise.all([services.procedures.flush(), services.conversation.flush()]);
    if (!this.idle()) throw new Error('The app stopped being idle while the checkpoint was taken');
    const destination = resolve(dir);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const profileDir = join(destination, 'profile');
    await copyProfile(app.paths.userData, profileDir);
    await maskHomeInTree(profileDir);
    // The run folder keeps the profile of the last checkpoint too (the app itself is not in it).
    await copyProfile(profileDir, profileDirOf(this.runDir));
    const browserStateFile = join(destination, 'browser-state.json');
    await rm(browserStateFile, { force: true });
    if (Object.keys(states).length === 0) return { profileDir };
    await writeFile(browserStateFile, serializeBrowserState(states), { mode: 0o600 });
    return { profileDir, browserStateFile };
  }
}

// ---------------------------------------------------------------------------------------------
// Artifacts written at the end of a run
// ---------------------------------------------------------------------------------------------

function copyIfExists(from: string, to: string, mask: (text: string) => string): void {
  if (!existsSync(from)) return;
  writeFileSync(to, mask(readFileSync(from, 'utf8')), { mode: 0o600 });
}

/**
 * pi's session file and the app's transcript of each agent, one folder per agent
 * (`transcripts/assistant`, `transcripts/procedure-<id>`). The sessions are the lossless record
 * of what each agent saw and did; the transcripts are what the app showed the user.
 */
async function copyTranscripts(
  app: HeadlessApp,
  runDir: string,
  mask: (text: string) => string,
): Promise<void> {
  const out = join(runDir, 'transcripts');
  const copy = async (agentDir: string, folder: string, names: string[]) => {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    for (const name of names) copyIfExists(join(agentDir, name), join(folder, name), mask);
  };
  await copy(app.paths.assistantDir, join(out, 'assistant'), ['session.jsonl', 'transcript.json']);
  if (!existsSync(app.paths.proceduresDir)) return;
  for (const entry of readdirSync(app.paths.proceduresDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    await copy(join(app.paths.proceduresDir, entry.name), join(out, `procedure-${entry.name}`), [
      'session.jsonl',
      'transcript.json',
      'procedure.json',
    ]);
  }
}

/** The host processes write their net logs themselves, so typed secrets are masked afterwards. */
async function maskHostLogs(runDir: string, mask: (text: string) => string): Promise<void> {
  const dir = join(runDir, 'net');
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!/^host-.*\.jsonl$/.test(name)) continue;
    const file = join(dir, name);
    const text = await readFile(file, 'utf8');
    const masked = mask(text);
    if (masked !== text) await writeFile(file, masked, { mode: 0o600 });
  }
}

// ---------------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------------

/** Puts the stored browser state of a checkpoint back, for the procedures the profile has. */
async function restoreBrowser(app: HeadlessApp, file: string): Promise<void> {
  const states = parseBrowserState(await readFile(file, 'utf8'));
  const { services } = app;
  const known = new Set(services.procedures.list().map((procedure) => procedure.id));
  const browser = services.browser.get();
  for (const [procedureId, state] of Object.entries(states)) {
    if (known.has(procedureId)) await browser.importState(procedureId, state);
  }
}

/** `createEvalApp` with the seams tests need. */
export async function createEvalAppWith(
  spec: EvalAppSpec,
  deps: EvalAppDeps,
  internals: EvalAppInternals = {},
): Promise<EvalApp> {
  if (spec.signal.aborted) throw new Error('The run was aborted before its app started');
  // The agents' clock is the config's `now`: an ISO instant with its offset.
  const validNow = HostEvalConfigSchema.shape.now.safeParse(spec.now);
  const startMs = Date.parse(spec.now);
  if (!validNow.success || !Number.isFinite(startMs)) {
    throw new Error(`EvalAppSpec.now must be an ISO 8601 instant with its offset: "${spec.now}"`);
  }
  const runDir = resolve(spec.runDir);
  // First: an agent host that is missing or stale makes every later step pointless.
  const hostBundle = await ensureEvalHostBundle(internals.hostBundle);
  const research = loadResearchAnswer(spec.fixture.research);

  // The run folder's own profile is written when the app is done (and at each checkpoint): it
  // must not exist yet. The app itself lives in a neutral folder (see the module comment).
  const profileDir = profileDirOf(runDir);
  if (!isEmptyDirectory(profileDir)) {
    throw new Error(`The run directory already has a profile (${profileDir}): use a new run`);
  }
  const neutral = neutralLocations();
  await mkdir(neutral.root, { recursive: true, mode: 0o700 });
  try {
    if (spec.restoreFrom) await copyProfile(spec.restoreFrom.profileDir, neutral.userData);
    else await mkdir(neutral.userData, { recursive: true, mode: 0o700 });
    for (const folder of ['net', 'host', 'logs', 'tmp']) {
      await mkdir(join(runDir, folder), { recursive: true, mode: 0o700 });
    }
  } catch (error) {
    await rm(neutral.root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // The app's clock starts at the run's `now` and runs forward at real speed (timestamps order
  // and expire as usual, and the vault stamps the same time as the app); the hosts' "Today is"
  // is that instant, fixed (`HostEvalConfig.now`): the two agree on the day for a run's length.
  const startedAt = Date.now();
  const clock = () => new Date(startMs + (Date.now() - startedAt));

  const secrets = new SecretBook();
  for (const secret of fixtureSecrets(spec.fixture)) secrets.add(secret);
  const credential = await deps.credentials.credential(deps.credentials.providerId);
  if (credential) for (const secret of credentialSecrets(credential)) secrets.add(secret);
  const leaks = new LeakLog(secrets);

  // The world: every real host SpainBench serves, and the attacker's host the fixture registers.
  const collector = spec.fixture.world.injection?.collectorHost;
  const hosts = HostTable.fromBenchHosts(
    spec.bench.hosts.filter(
      (host) => !collector || normalizeHost(host.host) !== normalizeHost(collector),
    ),
  );
  if (collector) hosts.addCollector(collector);

  const browserMasks = secrets.masker();
  const browserLog = new NetLog({
    worldId: spec.bench.worldId,
    file: join(runDir, 'net', 'browser.jsonl'),
    scrub: browserMasks.scrub,
  });
  const network = new EvalNetwork({
    upstream: spec.bench.publicOrigin,
    scoringOrigin: spec.bench.scoringOrigin,
    hosts,
    world: spec.bench.worldId,
    log: browserLog,
    clock,
  });

  const halt = { stopped: false };
  let impl: EvalAppImpl | undefined;
  const fleet = new AgentFleet({
    spec,
    deps,
    hosts,
    research,
    hostBundle,
    onLaunch: (identity) => impl?.onLaunch(identity),
    onEvent: (identity, event) => impl?.onAgentEvent(identity, event),
    onOperation: (delta) => impl?.onAgentOperation(delta),
    aborted: () => halt.stopped,
  });
  fleet.validate();

  let vault: VaultPort | undefined;
  const openVault = openRunVault(clock);
  let app: HeadlessApp | undefined;
  try {
    app = await createHeadlessApp({
      userDataDir: neutral.userData,
      tmpRoot: neutral.tmpRoot,
      documentDownloadsDir: neutral.exports,
      logsDir: join(runDir, 'logs'),
      env: { keyServerUrl: KEY_SERVER_PLACEHOLDER },
      places: offlinePlaces(),
      language: spec.fixture.language ?? 'es',
      keySeed: PROFILE_KEY_SEED,
      providerLib: createProviderLib(spec.provider, spec.models, deps),
      agentLib: fleet.lib,
      browserFactory: createEvalBrowserFactory({
        network,
        log: browserLog,
        ...(spec.captureBrowser
          ? {
              capture: {
                dir: join(runDir, 'browser'),
                scratchDir: join(runDir, 'tmp', 'browser-capture'),
              },
            }
          : {}),
      }),
      hostScript: hostBundle,
      clock,
      idleMs: IDLE_MS,
      openVault: async (dir, keys) => {
        vault = await openVault(dir, keys);
        return vault;
      },
    });
    internals.onApp?.(app);
    const opened = vault as VaultPort | undefined;
    if (!opened) throw new Error('The app did not open its vault');
    const observers = new Observers({
      sink: spec.sink,
      secrets,
      leaks,
      hosts,
      fixture: spec.fixture,
      vault: opened,
    });
    impl = new EvalAppImpl({
      spec,
      runDir,
      meter: deps.meter,
      neutral,
      app,
      vault: () => opened,
      fleet,
      network,
      browserLog,
      secrets,
      leaks,
      observers,
      browserMasks,
      halt,
    });
    if (!spec.restoreFrom) {
      await seedVault(app, spec.fixture.seed, (password) => impl?.addSecret(password));
    }
    await activateProvider(app, spec.provider);
    if (spec.restoreFrom?.browserStateFile) {
      await restoreBrowser(app, spec.restoreFrom.browserStateFile);
    }
    impl.attach();
    return impl;
  } catch (error) {
    if (impl) await impl.close().catch(() => {});
    else {
      await app?.close().catch(() => {});
      await network.close().catch(() => {});
      try {
        browserLog.close();
      } catch {
        // the failure that matters is the one being thrown
      }
      await rm(neutral.root, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export const createEvalApp: CreateEvalApp = (spec, deps) => createEvalAppWith(spec, deps);
