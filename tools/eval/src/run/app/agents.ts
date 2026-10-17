/**
 * The agents of a run: the app's `AgentLib` (how it launches an agent host and talks to it) with
 * the eval host in place of the product's, pointed at the meter, with its own world.
 *
 * `buildAgentLaunch` is where the app hands over an agent's config, so it is where the run
 *   - points the model at the meter (`agentBaseUrl(<agent key>)`: `assistant`, `procedure-<id>`),
 *   - strips every research URL and key (the eval host answers web research itself),
 *   - turns idle compaction off (a background model call in the middle of a run would make
 *     replays and costs depend on timing),
 *   - writes this process' `HostEvalConfig` (one file and one net log per host process: `seq`
 *     numbers the records of one process) and launches the eval host bundle with it.
 * `createClient` is where it sees every `AgentEvent`: they are teed to the observers before the
 * app's own handlers run, and the clients are kept so `abort` can stop them all, whatever the app
 * is doing. Agents started later (a procedure's) go through the same two functions.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentEvent,
  type AgentHostConfig,
  type AgentLaunch,
  type AgentLaunchOptions,
  buildAgentLaunch,
  PiRpcClient,
  type PromptImage,
} from '@sa/agent';
import type { HeadlessOptions } from '@sa/desktop/headless';
import { ASSISTANT_AGENT_ID } from '@sa/shared';
import type {
  AgentKind,
  EvalAppDeps,
  EvalAppSpec,
  HostEvalConfig,
  ResearchAnswer,
} from '../../contracts';
import { evalHostLaunch, parseHostEvalConfig, writeHostEvalConfig } from '../../host';
import type { HostTable } from '../../net';

type AgentLib = NonNullable<HeadlessOptions['agentLib']>;
type AgentClientPort = ReturnType<AgentLib['createClient']>;

/** Which agent a host process is, and where its files are. */
export interface AgentIdentity {
  /** The meter's key: `assistant`, or `procedure-<procedureId>`. */
  agentKey: string;
  agent: AgentKind;
  procedureId?: string;
  /** pi's session file of this agent: the lossless record of what it did. */
  sessionFile: string;
  /** Which launch of this agent this is (1 for the first; a restart is a new process). */
  generation: number;
  /** `net/host-<agent key>[-<generation>].jsonl`: the net log of this host process. */
  netlog: string;
  configFile: string;
}

export interface AgentFleetOptions {
  spec: EvalAppSpec;
  deps: EvalAppDeps;
  /** The real hosts of the world (collector included): `HostEvalConfig.routes`. */
  hosts: HostTable;
  research: ResearchAnswer;
  /** The bundle `ensureEvalHostBundle` found or built. */
  hostBundle: string;
  /** A host process is about to start. */
  onLaunch(identity: AgentIdentity): void;
  /** Every event of every client, before the app sees it. */
  onEvent(identity: AgentIdentity, event: AgentEvent): void;
  /** An agent operation that the app waits on starts (+1) or ends (-1). */
  onOperation(delta: 1 | -1): void;
  /** No agent may start once the run is aborted. */
  aborted(): boolean;
}

/** What the host process may reach without a proxy: loopback only (the meter, the bridge). */
const NO_PROXY = '127.0.0.1,localhost,::1';

/** The agent key of the app's own agent ids. */
export function agentKeyOf(agentId: string): string {
  return agentId === ASSISTANT_AGENT_ID ? 'assistant' : `procedure-${agentId}`;
}

class TrackedClient implements AgentClientPort {
  constructor(
    private readonly inner: PiRpcClient,
    readonly identity: AgentIdentity,
    private readonly operation: (delta: 1 | -1) => void,
  ) {}

  private async track<T>(call: () => Promise<T>): Promise<T> {
    this.operation(1);
    try {
      return await call();
    } finally {
      this.operation(-1);
    }
  }

  start(): Promise<unknown> {
    return this.track(() => this.inner.start());
  }
  prompt(text: string, images?: PromptImage[]) {
    return this.track(() => this.inner.prompt(text, images));
  }
  steer(text: string) {
    return this.track(() => this.inner.steer(text));
  }
  followUp(text: string) {
    return this.track(() => this.inner.followUp(text));
  }
  abort(): Promise<void> {
    return this.inner.abort();
  }
  get running(): boolean {
    return this.inner.running;
  }
  on(listener: (event: AgentEvent) => void): () => void {
    return this.inner.on(listener);
  }
  stop(): Promise<void> {
    return this.inner.stop();
  }

  get alive(): boolean {
    return this.inner.alive;
  }

  /** Ends the process now (the polite `stop` waits for pi). */
  kill(): void {
    const pid = this.inner.pid;
    if (pid === undefined || !this.inner.alive) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

export class AgentFleet {
  readonly lib: AgentLib;
  private readonly clients = new Set<TrackedClient>();
  private readonly launches = new WeakMap<AgentLaunch, AgentIdentity>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly options: AgentFleetOptions) {
    this.lib = {
      buildAgentLaunch: (launchOptions) => this.buildLaunch(launchOptions),
      createClient: (launch) => this.createClient(launch),
    };
  }

  private identify(config: AgentHostConfig): AgentIdentity {
    const { runDir } = this.options.spec;
    const assistant = config.role === 'assistant';
    const agentKey = agentKeyOf(config.procedureId);
    const generation = (this.generations.get(agentKey) ?? 0) + 1;
    this.generations.set(agentKey, generation);
    const suffix = generation > 1 ? `-${generation}` : '';
    return {
      agentKey,
      agent: assistant ? 'assistant' : 'procedure',
      ...(assistant ? {} : { procedureId: config.procedureId }),
      sessionFile: config.sessionFile,
      generation,
      netlog: join(runDir, 'net', `host-${agentKey}${suffix}.jsonl`),
      configFile: join(runDir, 'host', `${agentKey}${suffix}.json`),
    };
  }

  private hostConfig(identity: AgentIdentity): HostEvalConfig {
    const { spec, hosts, research } = this.options;
    return {
      worldId: spec.bench.worldId,
      mockOrigin: spec.bench.publicOrigin,
      scoringOrigin: spec.bench.scoringOrigin,
      routes: hosts.patterns(),
      // A stranger's domain does not exist; a plausible official one is in `routes` and answers
      // with the mock's neutral 404 (docs/EVAL.md, "Unmapped hosts").
      unmapped: { mode: 'enotfound' },
      netlog: identity.netlog,
      // The meter's origin is allowed by the host itself (it is the model's base URL).
      llm: { extraAllowOrigins: [] },
      research: { shape: 'auto', answers: [research] },
      now: spec.now,
    };
  }

  /**
   * Throws now if the world could not configure a host (a bad route, a non-loopback mock origin, a
   * clock without an offset), instead of when the first agent is about to start.
   */
  validate(): void {
    const { runDir } = this.options.spec;
    parseHostEvalConfig(
      this.hostConfig({
        agentKey: 'validation',
        agent: 'assistant',
        sessionFile: join(runDir, 'validation.jsonl'),
        generation: 1,
        netlog: join(runDir, 'net', 'host-validation.jsonl'),
        configFile: join(runDir, 'host', 'validation.json'),
      }),
    );
  }

  private buildLaunch(launchOptions: AgentLaunchOptions): AgentLaunch {
    const { options } = this;
    if (options.aborted()) throw new Error('The run was aborted: no agent may start');
    const identity = this.identify(launchOptions.config);
    const config: AgentHostConfig = {
      ...launchOptions.config,
      model: {
        ...launchOptions.config.model,
        baseUrl: options.deps.meter.agentBaseUrl(identity.agentKey),
      },
      // Only the eval host's research stub exists: no key server, Exa or BOE override, and no
      // access to private hosts.
      research: {},
      idleCompaction: { minTokens: Number.MAX_SAFE_INTEGER },
    };
    writeHostEvalConfig(identity.configFile, this.hostConfig(identity));
    const evalLaunch = evalHostLaunch(identity.configFile);
    options.onLaunch(identity);
    const launch = buildAgentLaunch({
      ...launchOptions,
      config,
      nodeBinary: process.execPath,
      electronRunAsNode: false,
      hostPath: options.hostBundle,
      inheritEnv: evalLaunch.inheritEnv,
      extraEnv: {
        ...launchOptions.extraEnv,
        ...evalLaunch.extraEnv,
        NO_PROXY,
        no_proxy: NO_PROXY,
      },
    });
    this.launches.set(launch, identity);
    return launch;
  }

  private createClient(launch: AgentLaunch): AgentClientPort {
    const { options } = this;
    const identity = this.launches.get(launch);
    if (!identity) throw new Error('createClient got a launch that buildAgentLaunch did not make');
    if (options.aborted()) throw new Error('The run was aborted: no agent may start');
    const inner = new PiRpcClient(launch);
    // First listener: the observers see an event before the app reacts to it.
    inner.on((event) => options.onEvent(identity, event));
    const client = new TrackedClient(inner, identity, options.onOperation);
    this.clients.add(client);
    inner.on((event) => {
      if (event.type === 'process_exit') this.clients.delete(client);
    });
    return client;
  }

  get active(): number {
    return [...this.clients].filter((client) => client.alive).length;
  }

  /**
   * Ends every host process: asks politely, then kills what is still alive after `graceMs`.
   * Resolves once they are all gone.
   */
  async stopAll(graceMs = 1000): Promise<void> {
    const clients = [...this.clients];
    const timers = clients.map((client) => {
      const timer = setTimeout(() => client.kill(), graceMs);
      timer.unref();
      return timer;
    });
    await Promise.allSettled(clients.map((client) => client.stop()));
    for (const timer of timers) clearTimeout(timer);
    // `stop` of a client that was killed returns once its exit was seen; make sure of the rest.
    for (const client of clients) client.kill();
  }
}

/** Where an agent's host log goes: stderr lines of the host (diagnostics, `denied:` lines). */
export function writeHostLog(
  runDir: string,
  identity: AgentIdentity,
  event: Extract<AgentEvent, { type: 'log' | 'process_exit' }>,
  mask: (text: string) => string,
): void {
  const dir = join(runDir, 'logs');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `host-${identity.agentKey}.log`);
  const stamp = new Date().toISOString();
  const line =
    event.type === 'log'
      ? `${stamp} ${event.level.toUpperCase().padEnd(5)} [#${identity.generation}] ${event.message}`
      : `${stamp} EXIT  [#${identity.generation}] code=${event.code} signal=${event.signal}\n${event.stderrTail}`;
  appendFileSync(file, `${mask(line)}\n`, { mode: 0o600 });
}
