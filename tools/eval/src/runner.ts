/**
 * `runEvaluation`: the one place that joins the parts of the suite for a real run: SpainBench
 * (launched or connected), the meter and its credential, the mock LLM when the provider is
 * `mock`, the composed app, the follower and the artifacts of the bench, and the run loop. The
 * CLI calls it, and so do the end-to-end tests, so what the tests prove is what `eval run` does.
 *
 * It is two steps. `prepareEvaluation` decides everything that can be decided without starting a
 * process (the fixture, the run id, the checkpoint, the credential, Codex consent, the SpainBench
 * target, the voucher's balance against its floor) and refuses with `EvaluationRefused` (or the
 * typed error of the part that knows: `UnknownFixtureError`, `EvalHomeError`, `CodexConsentError`,
 * `BenchTargetError`, `CheckpointError`) before anything exists. `runEvaluation` then starts what
 * the run needs and stops everything it started, whatever happens: the bench server it launched,
 * the meter proxy and the mock LLM. The bench server's own log ends up in the run folder.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';
import {
  type BenchTarget,
  describeBench,
  followBenchEvents,
  openBench,
  resolveBenchTarget,
  runnable,
  saveBenchArtifacts,
} from './bench';
import { cachedChromium, NO_CHROMIUM_MESSAGE } from './chromium';
import type { CacheMode, EvalModelChoice, EvalProvider, Fixture, RunLimits } from './contracts';
import { getFixture } from './fixtures';
import {
  budgetStatus,
  type CredentialSource,
  createCredentialSource,
  createMeter,
  DEFAULT_ANSWERER_MODEL,
  DEFAULT_ANSWERER_THINKING,
  DEFAULT_CODEX_ANSWERER_MODEL,
  evalHome,
  loadVoucherCredential,
  type MeterLimitsInput,
} from './llm';
import { ensureLoopbackNoProxy } from './net/proxy-env';
import { type CheckpointRef, type RunOutcome, readCheckpoint, runFixture } from './run';
import { createEvalApp } from './run/app';
import { VOUCHER_FLOOR_USD } from './run/caps';
import { assertValidRunId, defaultRunsRoot, generateRunId } from './run/results';

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

export interface EvaluationRequest {
  /** `vida-laboral-sin-datos`, `vida-laboral-inyeccion:page-title`... (`getFixture`). */
  fixtureId: string;
  provider: EvalProvider;
  /** Record/replay of model calls (default `auto` for real providers, `off` for `mock`). */
  cache?: CacheMode;
  /** Independent samples of the same conversation in the cache. */
  cacheVariant?: string;
  /** Continue a checkpoint of an earlier run of the same fixture. */
  from?: CheckpointRef;
  /** Continue a checkpoint even though the fixture's rules, answers or limits changed since. */
  allowFixtureChange?: boolean;
  limits?: Partial<RunLimits>;
  models?: Partial<EvalModelChoice>;
  /** Overrides of the meter's caps (the reserve for the voucher is `VOUCHER_FLOOR_USD`). */
  meterLimits?: MeterLimitsInput;
  captureBrowser?: boolean;
  keepWorld?: boolean;
  runsRoot?: string;
  runId?: string;
  /** `--codex-consent`; `SA_EVAL_CODEX_CONSENT=1` does the same. */
  codexConsent?: boolean;
  /** The script of the model when `provider` is `mock` (and only then). */
  scenario?: ScenarioInput;
  /** SpainBench's environment (`SPAINBENCH_DIR`, `SPAINBENCH_URL`...); default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Base of a relative `SPAINBENCH_DIR` and `runsRoot` (default: the process' directory). */
  cwd?: string;
  /** Credentials home (default `evalHome(env)`: `SPAINBENCH_DATA_DIR` or the OS's data folder). */
  home?: string;
  /** Ends the run as `abort`. */
  signal?: AbortSignal;
  /**
   * The caller handles SIGINT and SIGTERM by aborting through `signal` (the CLI does): SpainBench
   * is then not killed by the signal, so the interrupted run can still save what the server knows.
   */
  handlesSignals?: boolean;
  /**
   * Bound for each step of shutting down (stopping the app, draining SpainBench's events, saving
   * the artifacts; default 15 s). A step that takes longer is a note of the result: a busy machine
   * may need more.
   */
  shutdownTimeoutMs?: number;
  /** Progress lines for a terminal (nothing is printed by default). */
  log?: (line: string) => void;
  /** Real voucher calls need at least this much left on the key (default `VOUCHER_FLOOR_USD`). */
  voucherFloorUsd?: number;
  /**
   * Where the browser of the agents is (default: Playwright's cache, `cachedChromium`). A run
   * without one is refused before anything starts: it would have the agents fail at the first
   * page, and nothing a model does can fix that.
   */
  chromiumPath?: () => string | undefined;
  /** Tests: answer a voucher run's balance question without asking the key server. */
  offlineBudget?: boolean;
  /** Tests: the `fetch` that asks the key server for the voucher's balance. */
  keyServerFetch?: typeof fetch;
}

/** The refusal to start: something the user can fix, in one line. */
export class EvaluationRefused extends Error {
  override readonly name = 'EvaluationRefused';
}

/** Default cache mode: real providers record and replay, the mock has nothing worth caching. */
export function defaultCache(provider: EvalProvider): CacheMode {
  return provider === 'mock' ? 'off' : 'auto';
}

export function defaultModels(
  provider: EvalProvider,
  models: Partial<EvalModelChoice> = {},
): EvalModelChoice {
  return {
    answererModel: provider === 'codex' ? DEFAULT_CODEX_ANSWERER_MODEL : DEFAULT_ANSWERER_MODEL,
    answererThinking: DEFAULT_ANSWERER_THINKING,
    ...models,
  };
}

const dollars = (value: number) => `$${value.toFixed(2)}`;

/** The refusal for a voucher key with less left than the floor, or undefined when it has enough. */
export function floorRefusal(remainingUsd: number, floorUsd: number): string | undefined {
  if (remainingUsd >= floorUsd) return undefined;
  return `The voucher key has ${dollars(remainingUsd)} left, under the ${dollars(floorUsd)} floor: real calls are stopped (replay a recorded run with --cache replay, or use another provider)`;
}

/** The refusal for a voucher key whose expiry date has passed, or undefined. */
export function expiryRefusal(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!expiresAt) return undefined;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at) || at > now.getTime()) return undefined;
  return `The voucher key expired on ${expiresAt}: redeem a new voucher and update litellm.json (or replay a recorded run with --cache replay, or use another provider)`;
}

export const NO_BENCH_MESSAGE =
  'No SpainBench to run against: set SPAINBENCH_DIR (the private repo: it is started on free ports) or SPAINBENCH_URL (a server that already runs)';

/** Everything `prepareEvaluation` decided: what `runEvaluation` starts the run with. */
export interface PreparedEvaluation {
  fixture: Fixture;
  provider: EvalProvider;
  cache: CacheMode;
  env: Record<string, string | undefined>;
  home: string;
  runsRoot: string;
  runId: string;
  credentials: CredentialSource;
  /** Launch or connect: never `none`. */
  target: Exclude<BenchTarget, { mode: 'none' }>;
  /** The voucher key's balance at the start, when the key server answered. */
  keyRemainingUsd?: number;
  voucherBaseUrl?: string;
  voucherFloorUsd: number;
}

/**
 * Checks a request and resolves what it needs, starting nothing: no process, no server, no run
 * folder. Refuses (see the file's comment) when it cannot start.
 */
export async function prepareEvaluation(request: EvaluationRequest): Promise<PreparedEvaluation> {
  const fixture = getFixture(request.fixtureId);
  const provider = request.provider;
  if (provider === 'mock' && !request.scenario) {
    throw new EvaluationRefused(
      'The mock provider needs a scenario: the script the model follows (see --scenario)',
    );
  }
  if (provider !== 'mock' && request.scenario) {
    throw new EvaluationRefused(
      `A scenario is the script of the mock model: it does not apply to the ${provider} provider`,
    );
  }
  const cache: CacheMode = request.cache ?? defaultCache(provider);
  const env = request.env ?? process.env;
  const cwd = request.cwd ?? process.cwd();
  const home = request.home ?? evalHome(env);
  const runsRoot = resolve(cwd, request.runsRoot ?? defaultRunsRoot(env));
  const runId =
    request.runId ?? generateRunId({ fixtureId: fixture.id, provider, now: new Date() });
  try {
    assertValidRunId(runId);
  } catch (error) {
    throw new EvaluationRefused((error as Error).message);
  }
  if (existsSync(join(runsRoot, runId))) {
    throw new EvaluationRefused(
      `The run directory already exists: ${join(runsRoot, runId)} (a run id is used once: pick another --run-id)`,
    );
  }
  if (request.from) {
    readCheckpoint(request.from, {
      fixture,
      ...(request.allowFixtureChange ? { allowFixtureChange: true } : {}),
    });
  }

  // Fail before anything starts: the credential, Codex consent, the target.
  const credentials = createCredentialSource({
    provider,
    cache,
    home,
    ...(request.codexConsent !== undefined ? { consent: request.codexConsent } : {}),
    env,
  });
  const target = resolveBenchTarget(env, { cwd });
  if (target.mode === 'none') throw new EvaluationRefused(NO_BENCH_MESSAGE);
  if (!(request.chromiumPath ?? cachedChromium)()) throw new EvaluationRefused(NO_CHROMIUM_MESSAGE);

  const voucherFloorUsd = request.voucherFloorUsd ?? VOUCHER_FLOOR_USD;
  let keyRemainingUsd: number | undefined;
  let voucherBaseUrl: string | undefined;
  if (provider === 'voucher' && cache !== 'replay') {
    const voucher = loadVoucherCredential({ home });
    voucherBaseUrl = voucher.baseUrl;
    const expired = expiryRefusal(voucher.expiresAt);
    if (expired) throw new EvaluationRefused(expired);
    const status = await budgetStatus({
      home,
      ...(request.offlineBudget ? { offline: true } : {}),
      ...(request.keyServerFetch ? { fetchImpl: request.keyServerFetch } : {}),
    });
    if (status.voucher.status === 'ok') {
      keyRemainingUsd = status.voucher.remainingUsd;
      // The key server knows the expiry even when `litellm.json` does not record it.
      const lapsed = expiryRefusal(status.voucher.expiresAt);
      if (lapsed) throw new EvaluationRefused(lapsed);
      const refusal = floorRefusal(status.voucher.remainingUsd, voucherFloorUsd);
      if (refusal) throw new EvaluationRefused(refusal);
    }
  }

  return {
    fixture,
    provider,
    cache,
    env,
    home,
    runsRoot,
    runId,
    credentials,
    target,
    ...(keyRemainingUsd !== undefined ? { keyRemainingUsd } : {}),
    ...(voucherBaseUrl !== undefined ? { voucherBaseUrl } : {}),
    voucherFloorUsd,
  };
}

// ---------------------------------------------------------------------------------------------
// The log of a launched SpainBench
// ---------------------------------------------------------------------------------------------

/** Where a launched server's log is written while the run is still being set up. */
export function pendingBenchLog(runsRoot: string, runId: string): string {
  return join(runsRoot, '_bench', `${runId}.log`);
}

/** Where it is kept once the run is over: with the run's other logs. */
export function runBenchLog(runDir: string): string {
  return join(runDir, 'logs', 'bench-server.log');
}

/**
 * Moves the server's log into the run folder (`logs/bench-server.log`). A run that failed before
 * its folder existed leaves the log where it was written, and this says where. Returns the log's
 * location, or undefined when there is none (a server that was connected, not launched).
 */
export function settleBenchLog(runsRoot: string, runId: string): string | undefined {
  const pending = pendingBenchLog(runsRoot, runId);
  if (!existsSync(pending)) return undefined;
  const runDir = resolve(runsRoot, runId);
  if (!existsSync(runDir)) return pending;
  const target = runBenchLog(runDir);
  mkdirSync(join(runDir, 'logs'), { recursive: true, mode: 0o700 });
  try {
    renameSync(pending, target);
  } catch {
    copyFileSync(pending, target);
    rmSync(pending, { force: true });
  }
  try {
    rmdirSync(join(runsRoot, '_bench'));
  } catch {
    // Other runs' logs are still there.
  }
  return target;
}

/** The log of the server a run launched, wherever it is now (undefined: none exists). */
export function findBenchLog(runsRoot: string, runId: string): string | undefined {
  for (const file of [runBenchLog(resolve(runsRoot, runId)), pendingBenchLog(runsRoot, runId)]) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Not there.
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runEvaluation(request: EvaluationRequest): Promise<RunOutcome> {
  // The model gateway's key and the scoring token go to loopback services: not to a proxy.
  ensureLoopbackNoProxy();
  const log = request.log ?? (() => {});
  const plan = await prepareEvaluation(request);
  const { provider } = plan;

  let llm: MockLlm | undefined;
  let server: Awaited<ReturnType<typeof openBench>> | undefined;
  let meter: Awaited<ReturnType<typeof createMeter>> | undefined;
  try {
    server = await openBench(plan.target, {
      logFile: pendingBenchLog(plan.runsRoot, plan.runId),
      ...(request.handlesSignals ? { keepOnSignal: true } : {}),
    });
    const verdict = runnable(plan.fixture, server.version);
    if (!verdict.ok) throw new EvaluationRefused(`${plan.fixture.id}: ${verdict.reason}`);
    log(
      `SpainBench ${server.version.version} (${server.mode === 'launch' ? 'started here' : 'connected'})`,
    );

    if (provider === 'mock') {
      llm = await createMockLlm({ scenario: request.scenario!, litellm: {} });
    }
    const upstream =
      provider === 'mock'
        ? `${llm!.url}/v1`
        : provider === 'voucher'
          ? plan.voucherBaseUrl
          : CODEX_BASE_URL;
    meter = await createMeter({
      home: plan.home,
      upstreams: upstream ? { [provider]: upstream } : {},
      limits: {
        ...(provider === 'voucher' ? { reserveUsd: plan.voucherFloorUsd } : {}),
        ...request.meterLimits,
      },
      ...(plan.keyRemainingUsd !== undefined ? { keyRemainingUsd: plan.keyRemainingUsd } : {}),
      ...(request.codexConsent !== undefined ? { codexConsent: request.codexConsent } : {}),
      env: plan.env,
      onError: (error) => log(`meter: ${error.message}`),
    });

    return await runFixture({
      fixture: plan.fixture,
      provider,
      models: defaultModels(provider, request.models),
      cache: plan.cache,
      bench: server.api,
      benchInfo: describeBench(server.version) as unknown as Record<string, unknown>,
      meter,
      credentials: plan.credentials,
      runsRoot: plan.runsRoot,
      runId: plan.runId,
      ...(request.limits ? { limits: request.limits } : {}),
      ...(request.cacheVariant ? { cacheVariant: request.cacheVariant } : {}),
      ...(request.captureBrowser !== undefined ? { captureBrowser: request.captureBrowser } : {}),
      ...(request.from ? { from: request.from } : {}),
      ...(request.allowFixtureChange ? { allowFixtureChange: true } : {}),
      ...(request.keepWorld !== undefined ? { keepWorld: request.keepWorld } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.shutdownTimeoutMs !== undefined
        ? { shutdownTimeoutMs: request.shutdownTimeoutMs }
        : {}),
      createApp: createEvalApp,
      followBench: followBenchEvents,
      saveBenchArtifacts,
    });
  } finally {
    await meter?.close().catch((error) => log(`The meter did not close cleanly: ${reason(error)}`));
    await llm
      ?.close()
      .catch((error) => log(`The mock LLM did not close cleanly: ${reason(error)}`));
    await server?.stop().catch((error) => log(`SpainBench did not stop cleanly: ${reason(error)}`));
    try {
      settleBenchLog(plan.runsRoot, plan.runId);
    } catch (error) {
      log(`The SpainBench log could not be moved into the run folder: ${reason(error)}`);
    }
  }
}
