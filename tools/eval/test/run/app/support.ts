/**
 * What the tests of `createEvalApp` share: the real pieces on 127.0.0.1 (the eval host bundle,
 * `tools/mock-llm` behind the meter, a fake SpainBench) and helpers to drive a run the way the
 * run loop will. Import it first: it installs the deny-by-default network guard of the llm tests
 * for the test process (the agent hosts and Chromium have their own guards, which the net part
 * tests; the world's only upstream is a loopback port).
 */

import { execFileSync } from 'node:child_process';
import dns from 'node:dns';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScenarioInput } from '@sa/mock-llm';
import { afterAll, describe } from 'vitest';
import type {
  EvalApp,
  EvalAppDeps,
  EvalAppSpec,
  Fixture,
  Observation,
  PendingPrompt,
} from '../../../src/contracts';
import { getFixture } from '../../../src/fixtures';
import { type CredentialSource, createCredentialSource } from '../../../src/llm';
import {
  createEvalAppWith,
  type EvalAppInternals,
  ensureEvalHostBundle,
} from '../../../src/run/app';
import { ObservationLog } from '../../../src/run/observation-log';
import { type MeterEnv, startEnv } from '../../llm/helpers/meter-env';
import { NetworkGuardError } from '../../llm/helpers/no-network';
import { cachedBrowser, notCachedMessage } from '../../net/chromium';
import {
  BENCH_HOSTS,
  COLLECTOR,
  type FakeBench,
  IDP,
  PORTAL,
  startFakeBench,
} from '../../net/fake-bench';

export { COLLECTOR, IDP, PORTAL };

/**
 * What the app process (this one) tried to reach outside this machine. The guard of the llm tests
 * makes such an attempt throw; this keeps the attempt, so a test can see one that code swallowed.
 */
export const egressAttempts: string[] = [];

function recordRefusals<Args extends unknown[], Result>(
  fn: (this: unknown, ...args: Args) => Result,
): (this: unknown, ...args: Args) => Result {
  return function recorded(this: unknown, ...args: Args): Result {
    try {
      const result = fn.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          if (error instanceof NetworkGuardError) egressAttempts.push(error.message);
          throw error;
        }) as Result;
      }
      return result;
    } catch (error) {
      if (error instanceof NetworkGuardError) egressAttempts.push(error.message);
      throw error;
    }
  };
}

net.Socket.prototype.connect = recordRefusals(net.Socket.prototype.connect) as never;
dns.lookup = recordRefusals(dns.lookup) as never;
globalThis.fetch = recordRefusals(globalThis.fetch) as never;

/** No test may read the real credentials home; the temp one is removed when the file is done. */
const testEvalHome = mkdtempSync(join(tmpdir(), 'sa-eval-app-home-'));
process.env.SPAINBENCH_DATA_DIR = testEvalHome;
afterAll(() => rmSync(testEvalHome, { recursive: true, force: true }));

const packageRoot = join(import.meta.dirname, '..', '..', '..');

/** Copies left by test processes that died before they cleaned up. */
function pruneDeadBundles(): void {
  const dist = join(packageRoot, 'dist');
  for (const name of readdirSync(dist)) {
    const pid = /^app-test-(\d+)-/.exec(name)?.[1];
    if (!pid) continue;
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        rmSync(join(dist, name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * The eval host bundle, built if it is missing or stale, and copied for this process: another test
 * file may rebuild `dist/eval-host.js` while this one runs hosts from it. The copy is checked and
 * retried, so a build that races the copy is never what a host reads.
 */
export async function prepareHostBundle(): Promise<{ bundle: string; cleanup(): void }> {
  const shared = await ensureEvalHostBundle();
  pruneDeadBundles();
  const dir = join(
    packageRoot,
    'dist',
    `app-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const bundle = join(dir, 'eval-host.js');
  mkdirSync(dir, { recursive: true });
  for (let attempt = 1; ; attempt++) {
    cpSync(shared, bundle);
    try {
      execFileSync(process.execPath, ['--check', bundle], { stdio: 'pipe' });
      break;
    } catch (error) {
      if (attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
  return { bundle, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fixture that is one of the real ones, with the world of the fake bench. */
export function testFixture(
  id: 'vida-laboral-sin-datos' | 'vida-laboral-con-datos' = 'vida-laboral-sin-datos',
  over: Partial<Fixture> = {},
): Fixture {
  const base = getFixture(id);
  return {
    ...base,
    world: { ...base.world, injection: { variant: 'page-title', collectorHost: COLLECTOR } },
    ...over,
  };
}

export const NOW = '2026-10-16T10:00:00+02:00';

export interface StackOptions {
  scenario?: ScenarioInput;
  fixture?: Fixture;
  provider?: 'mock' | 'codex';
  /** Replaces the credential source (the key the meter forwards). */
  credentials?: CredentialSource;
  captureBrowser?: boolean;
  restoreFrom?: EvalAppSpec['restoreFrom'];
  runDir?: string;
  hostBundle: string;
  internals?: EvalAppInternals;
  /** Mock LLM options. */
  chunkSize?: number;
}

export interface Stack {
  runDir: string;
  bench: FakeBench;
  env: MeterEnv;
  llm: MeterEnv['llm'];
  run: ReturnType<MeterEnv['openRun']>;
  log: ObservationLog;
  spec: EvalAppSpec;
  deps: EvalAppDeps;
  abort: AbortController;
  app: EvalApp;
  observations(): readonly Observation[];
  of<T extends Observation['type']>(type: T): Extract<Observation, { type: T }>[];
  close(): Promise<void>;
}

/** Everything but the app, for tests that create the app themselves. */
export async function startWorld(options: StackOptions) {
  const runDir = options.runDir ?? mkdtempSync(join(tmpdir(), 'sa-eval-app-run-'));
  const bench = await startFakeBench();
  const provider = options.provider ?? 'mock';
  const env = await startEnv({
    provider,
    // The meter forwards a Codex run to the mock's ChatGPT backend path, with the Codex consent.
    ...(provider === 'codex'
      ? { upstreamPath: '/backend-api', meter: { codexConsent: true } }
      : {}),
    mock: {
      scenario: options.scenario ?? { rules: [], fallback: { text: 'Hola.' } },
      chunkSize: options.chunkSize ?? 24,
      litellm: {},
    },
  });
  const run = env.openRun({ cache: 'off' });
  const log = new ObservationLog({ file: join(runDir, 'events.jsonl') });
  const abort = new AbortController();
  // A Codex run gets the synthetic login of replay mode: no file of the credentials home is read.
  const credentials =
    options.credentials ??
    createCredentialSource({
      provider,
      ...(provider === 'codex' ? { cache: 'replay' as const } : {}),
    });
  const spec: EvalAppSpec = {
    runId: 'run-app-test',
    runDir,
    fixture: options.fixture ?? testFixture(),
    provider,
    models: { answererModel: 'anthropic/claude-haiku-5.5', answererThinking: 'low' },
    sink: log,
    bench: {
      publicOrigin: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts: BENCH_HOSTS,
      worldId: 'run-app-test',
    },
    now: NOW,
    captureBrowser: options.captureBrowser ?? false,
    ...(options.restoreFrom ? { restoreFrom: options.restoreFrom } : {}),
    signal: abort.signal,
  };
  const deps: EvalAppDeps = { meter: run, credentials };
  return { runDir, bench, env, run, log, abort, spec, deps };
}

export async function startStack(options: StackOptions): Promise<Stack> {
  const world = await startWorld(options);
  let app: EvalApp;
  try {
    app = await createEvalAppWith(world.spec, world.deps, {
      hostBundle: { bundle: options.hostBundle, sources: [] },
      ...options.internals,
    });
  } catch (error) {
    await world.env.close();
    await world.bench.close();
    throw error;
  }
  const stack: Stack = {
    ...world,
    llm: world.env.llm,
    app,
    observations: () => world.log.all(),
    of: (type) => world.log.all().filter((o) => o.type === type) as never,
    async close() {
      await app.close().catch(() => {});
      world.run.close();
      await world.env.close();
      await world.bench.close();
      world.log.close();
    },
  };
  return stack;
}

/** For an `afterAll`: nothing in this process reached for the network, swallowed or not. */
export function expectNoEgress(): void {
  if (egressAttempts.length > 0) {
    throw new Error(
      `The app process tried to reach outside this machine: ${egressAttempts.join(', ')}`,
    );
  }
}

export function removeRunDir(runDir: string): void {
  rmSync(runDir, { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `test` returns something truthy (the value) or fails after `timeoutMs`. */
export async function waitFor<T>(
  test: () => T | undefined | false,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** How a test answers the prompts of a run: the simulator's job, scripted. */
export type Answer = (prompt: PendingPrompt, app: EvalApp) => Promise<boolean>;

/**
 * Answers every prompt with `answer` (which says whether it handled it) until the app is idle:
 * what the run loop does with `untilIdle` and `pendingPrompts`.
 */
export async function driveToIdle(
  app: EvalApp,
  answer: Answer,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const handled = new Set<string>();
  while (Date.now() < deadline) {
    for (const prompt of app.pendingPrompts()) {
      if (handled.has(prompt.itemId)) continue;
      handled.add(prompt.itemId);
      if (!(await answer(prompt, app))) throw new Error(`Unexpected prompt: ${prompt.title}`);
    }
    if (await app.untilIdle({ holdMs: 300, timeoutMs: 500 })) return;
  }
  throw new Error('Timed out driving the app to idle');
}

/**
 * `describe` for the suites that drive a browser: the app's own is Playwright's cached Chromium. A
 * machine without it skips them with a message, as the network layer's tests do (nothing is ever
 * downloaded).
 */
export const chromiumCached = cachedBrowser('chromium') !== undefined;
export const browserSuite = chromiumCached ? describe : describe.skip;
if (!chromiumCached) console.warn(notCachedMessage('chromium'));
