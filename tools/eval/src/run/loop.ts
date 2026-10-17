import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { AnswerState } from '../answers';
import { newWorldId } from '../bench';
import type {
  BenchApi,
  BenchHost,
  BenchWrongTurn,
  CacheMode,
  CreateEvalApp,
  EvalApp,
  EvalModelChoice,
  EvalProvider,
  Fixture,
  FollowBench,
  MeterUsage,
  Observation,
  PendingPrompt,
  RunLimits,
  RunResult,
  RunView,
  SaveBenchArtifacts,
} from '../contracts';
import { assertValidFixture, fixtureSecrets } from '../fixtures';
import {
  type Answerer,
  AnswererError,
  type AnswererOptions,
  type CredentialSource,
  createDirectorySink,
  createAnswerer as createLlmAnswerer,
  credentialSecrets,
  type MeterEvent,
  type MeterHandle,
  type MeterRun,
  type MeterRunSummary,
  type VolatilePattern,
} from '../llm';
import { RuleEngine, type RuleMatch } from '../rules';
import { assembleRunResult, CUT_SHORT_ENDINGS, emptyMeterUsage } from '../scoring';
import {
  type CheckpointRef,
  type LoadedCheckpoint,
  readCheckpoint,
  stageRestore,
  writeCheckpoint,
} from './checkpoint';
import { browserLaunchFailure, classifyAgentFailure, classifyCap } from './infra';
import { ObservationLog } from './observation-log';
import {
  assertValidRunId,
  copyLedgerLines,
  createRunDirectory,
  defaultRunsRoot,
  fixtureHash,
  frozenHash,
  generateRunId,
  RUN_FORMAT,
  type RunManifest,
  type RunPaths,
  renderRunReport,
  summarizeResult,
  writeEventLines,
  writeReport,
  writeResult,
  writeRunManifest,
} from './results';
import { RunSecrets } from './secrets';
import { createUserSimulator, SimulatorError, type UserSimulator } from './simulator';

/**
 * One run of one fixture: the user simulator, the rule engine, the limits, the instant failure
 * and the settling, checkpoints and resume, and the artifacts (docs/EVAL.md, "Run loop").
 *
 * The loop connects parts that are built and tested on their own: the app (`createApp`),
 * SpainBench (`bench`, `followBench`, `saveBenchArtifacts`), the meter, the rule engine, the
 * answers and the scoring. The three that other parts build have no default here: the CLI wires
 * them, tests inject fakes.
 */

export interface RunOptions {
  fixture: Fixture;
  provider: EvalProvider;
  models: EvalModelChoice;
  cache: CacheMode;
  /** Connected and version-checked. */
  bench: BenchApi;
  /** What `describeBench` says of the server (version, sites, features): written to `run.json`. */
  benchInfo?: Record<string, unknown>;
  meter: MeterHandle;
  credentials: CredentialSource;
  /** Where run folders go (default `defaultRunsRoot()`). */
  runsRoot?: string;
  /** `<fixtureId>-<provider>-<yyyymmdd-hhmmss>-<4 hex>` unless given. */
  runId?: string;
  /** Overrides of the fixture's limits. */
  limits?: Partial<RunLimits>;
  /** Independent samples of the same conversation in the replay cache. */
  cacheVariant?: string;
  captureBrowser?: boolean;
  /** Continue a checkpoint of an earlier run of the same fixture. */
  from?: CheckpointRef;
  /**
   * Continue a checkpoint whose fixture has changed since (its rules, answers, prompt, limits...).
   * Without this such a checkpoint is refused. A change to what a checkpoint freezes, the world and
   * the seed, is always refused.
   */
  allowFixtureChange?: boolean;
  /** What the user says to carry on after a restore, instead of the fixture's prompt. */
  resumePrompt?: string;
  /** Ends the run as `abort`. */
  signal?: AbortSignal;
  /** How long to wait for the agents to go quiet once every required rule has matched (120 s). */
  settleTimeoutMs?: number;
  /** How often the rules read the state while the run is busy (250 ms). */
  evaluateIntervalMs?: number;
  /**
   * Take a checkpoint when the agents go quiet (default true). A quiescent run is over, so this
   * is the run's final state: the point to continue from with `from`.
   */
  checkpoint?: boolean;
  /** How long the agents must stay idle to count as quiet (the app's default: 300 ms). */
  idleHoldMs?: number;
  /** A human-like pause before each simulated answer (0). */
  humanDelayMs?: number;
  /** Bound for each step of shutting down: abort, close, drain, delete (15 s). */
  shutdownTimeoutMs?: number;
  /**
   * Keep the world on the SpainBench server (default: delete it). The world is always saved to
   * `bench/` first, snapshot included, so a finished run can be inspected and restored without
   * it; a server that outlives the run only collects dead worlds.
   */
  keepWorld?: boolean;

  /** `createEvalApp` of `src/run/app`. */
  createApp: CreateEvalApp;
  /** `followBench` of `src/bench`. */
  followBench: FollowBench;
  /** `saveBenchArtifacts` of `src/bench`. */
  saveBenchArtifacts: SaveBenchArtifacts;
  /** The answerer's constructor (default: the `llm` part's). */
  createAnswerer?: (options: AnswererOptions) => Promise<Answerer>;
  /** Tests: the clock. */
  clock?: () => Date;
  /** Tests: the four hex digits of the generated run id. */
  ids?: () => string;
  /**
   * Tests: the world's id for a run id. Default: a fresh random one (16 hex digits) that has
   * nothing to do with the run id, because the agent can read the world's id in the pages.
   */
  worldId?: (runId: string) => string;
}

export interface RunOutcome {
  runId: string;
  runDir: string;
  result: RunResult;
  /** One line for the terminal. */
  summary: string;
  /** The checkpoints written, in order. */
  checkpoints: number[];
  reportFile: string;
  resultFile: string;
}

interface Ending {
  endedBy: string;
  /** Machine-readable detail for `RunResult.notes`. */
  note?: string;
  /** The agents are idle and nothing needs cutting off. */
  graceful?: boolean;
}

/**
 * Endings where the run is cut short but its rules can still be judged on what happened (the
 * cut-short ones, which say so in the result, and `decided`, which has nothing left to learn).
 */
const JUDGED_AFTER_CUT = new Set([...CUT_SHORT_ENDINGS, 'decided']);

const MAX_TIMER_MS = 2 ** 31 - 1;
/**
 * What the user says after a restore: the real app resumes no agent by itself, so a resumed run
 * asks the orchestrator to carry on (it continues the unfinished procedure with `procedure_resume`).
 */
const DEFAULT_RESUME_PROMPT = 'Sigue donde lo dejaste, por favor.';
const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;
const DEFAULT_EVALUATE_INTERVAL_MS = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;

/** Signals a terminal sends a whole process group (Ctrl-C, closing it, `kill` of the group). */
const INTERRUPT_SIGNALS: ReadonlySet<string> = new Set(['SIGINT', 'SIGTERM', 'SIGHUP']);
/** How long a host killed by one of them waits for the caller's own abort before it is an error. */
const INTERRUPT_GRACE_MS = 2_000;

/** The run was decided (aborted, failed) while a setup step was still waiting. */
class SetupInterrupted extends Error {}

/** A setup step failed; the message says which. */
class StageError extends Error {
  constructor(label: string, cause: unknown) {
    super(`${label}: ${messageOf(cause)}`);
    this.name = 'StageError';
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function madridOffset(day: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Madrid',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(`${day}T10:00:00Z`));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+01:00';
  const match = /GMT([+-]\d{2}):?(\d{2})?/.exec(name);
  return match ? `${match[1]}:${match[2] ?? '00'}` : '+01:00';
}

/** The agents' frozen "now": 10:00 in Madrid on the world's day (an instant with its offset). */
function frozenNow(today: string | undefined, fallback: Date): string {
  const day =
    today ??
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(fallback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`world.today must be YYYY-MM-DD: ${day}`);
  return `${day}T10:00:00${madridOffset(day)}`;
}

class FixtureRun {
  private readonly fixture: Fixture;
  private readonly clock: () => Date;
  private readonly limits: RunLimits;
  private readonly settleTimeoutMs: number;
  private readonly evaluateIntervalMs: number;
  private readonly checkpointEnabled: boolean;
  private readonly shutdownTimeoutMs: number;
  private readonly hasRequiredNegated: boolean;
  private readonly secrets = new RunSecrets();
  private readonly notes: string[] = [];
  private readonly controller = new AbortController();
  private readonly watchAbort = new AbortController();
  private readonly ended = deferred<void>();
  private readonly pendingNotes: string[] = [];

  private runId = '';
  /**
   * The SpainBench world's id: opaque and unrelated to the run id, because the agent reads it in
   * the pages it is shown. A resumed run gets a new one (several runs may continue one checkpoint
   * at the same time); the ones the restored conversation already holds are `inheritedWorldIds`.
   */
  private worldId = '';
  private inheritedWorldIds: string[] = [];
  private paths!: RunPaths;
  private loaded: LoadedCheckpoint | undefined;
  private engine!: RuleEngine;
  private log!: ObservationLog;
  private restored: readonly Observation[] = [];
  /** What a resumed run's log already shows: the app's counters start from zero. */
  private before = { toolCalls: 0, prompts: 0 };
  private merged: Observation[] | undefined;
  private startedAt!: Date;
  private endedAt: Date | undefined;
  private ending: Ending | undefined;

  private app: EvalApp | undefined;
  private meterRun: MeterRun | undefined;
  private meterSummary: MeterRunSummary | undefined;
  private offMeter: (() => void) | undefined;
  private follower: ReturnType<FollowBench> | undefined;
  private simulator: UserSimulator | undefined;
  private worldCreated = false;
  private hosts: BenchHost[] = [];

  private wallTimer: NodeJS.Timeout | undefined;
  private evalTimer: NodeJS.Timeout | undefined;
  private settleTimer: NodeJS.Timeout | undefined;
  private interruptTimer: NodeJS.Timeout | undefined;
  private evaluating = false;
  private evaluateAgain = false;
  private noteFlushScheduled = false;
  private logClosed = false;
  private readonly checkpoints: number[] = [];

  constructor(private readonly options: RunOptions) {
    this.fixture = options.fixture;
    this.clock = options.clock ?? (() => new Date());
    this.limits = {
      ...options.fixture.limits,
      ...Object.fromEntries(
        Object.entries(options.limits ?? {}).filter(([, value]) => value !== undefined),
      ),
    };
    for (const [name, value] of Object.entries(this.limits)) positive(`limits.${name}`, value);
    this.settleTimeoutMs = positive(
      'settleTimeoutMs',
      options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    );
    this.evaluateIntervalMs = positive(
      'evaluateIntervalMs',
      options.evaluateIntervalMs ?? DEFAULT_EVALUATE_INTERVAL_MS,
    );
    this.shutdownTimeoutMs = positive(
      'shutdownTimeoutMs',
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    this.checkpointEnabled = options.checkpoint ?? true;
    this.hasRequiredNegated = options.fixture.rules.some(
      (rule) => rule.kind === 'required' && rule.negate === true,
    );
  }

  // -------------------------------------------------------------------------------------------
  // The whole run
  // -------------------------------------------------------------------------------------------

  async execute(): Promise<RunOutcome> {
    this.prepare();
    try {
      await this.setup();
      await this.drive();
    } catch (error) {
      if (error instanceof StageError) this.end({ endedBy: 'error', note: error.message });
      else if (!(error instanceof SetupInterrupted)) this.fail(error, 'setup');
    }
    return this.conclude();
  }

  /**
   * Everything that can be wrong with the request itself, checked before anything is created: the
   * fixture, the run id, the checkpoint. Then the run folder, `run.json` and the event log.
   */
  private prepare(): void {
    const { options, fixture } = this;
    assertValidFixture(fixture);
    this.startedAt = this.clock();
    this.runId =
      options.runId ??
      generateRunId({
        fixtureId: fixture.id,
        provider: options.provider,
        now: this.startedAt,
        ...(options.ids ? { suffix: options.ids() } : {}),
      });
    assertValidRunId(this.runId);

    if (options.from) {
      this.loaded = readCheckpoint(options.from, {
        fixture,
        ...(options.allowFixtureChange ? { allowFixtureChange: true } : {}),
      });
    }
    this.worldId = options.worldId ? options.worldId(this.runId) : newWorldId();
    if (this.loaded) {
      const { worldId, inheritedWorldIds } = this.loaded.run;
      this.inheritedWorldIds = [...(worldId ? [worldId] : []), ...(inheritedWorldIds ?? [])];
    }
    const restore = this.loaded?.manifest;
    // Both validate what a checkpoint holds against this fixture (unknown rule or answer ids).
    this.engine = new RuleEngine({
      rules: fixture.rules,
      ...(fixture.preconditions ? { preconditions: fixture.preconditions } : {}),
      ...(restore ? { state: restore.ruleState } : {}),
    });
    if (restore) new AnswerState(fixture.answerGroups, restore.answerState);

    this.secrets.addAll(fixtureSecrets(fixture));
    this.paths = createRunDirectory(options.runsRoot ?? defaultRunsRoot(), this.runId);
    writeRunManifest(this.paths, this.manifest(), this.secrets.scrub);

    if (this.loaded) {
      writeEventLines(this.paths.events, this.loaded.events.lines);
      this.restored = this.loaded.events.observations;
      this.before = {
        toolCalls: this.restored.filter((o) => o.type === 'tool_start').length,
        prompts: this.restored.filter((o) => o.type === 'prompt_shown').length,
      };
      this.notes.push(
        `resumed-from:${this.loaded.run.runId}#${this.loaded.manifest.index}@${this.loaded.manifest.atSeq}`,
      );
    }
    this.log = new ObservationLog({
      file: this.paths.events,
      startSeq: this.loaded?.manifest.atSeq ?? 0,
      now: this.clock,
      scrub: this.secrets.scrub,
      onError: (error) => this.fail(error, 'event log'),
    });
    this.log.on((observation) => this.hear(observation));
    if (this.loaded) {
      this.log.push({
        type: 'note',
        text: `resumed from run ${this.loaded.run.runId}, checkpoint ${this.loaded.manifest.index} (seq ${this.loaded.manifest.atSeq})`,
      });
    }
    options.signal?.addEventListener('abort', this.onSignal, { once: true });
    if (options.signal?.aborted) this.onSignal();
  }

  private manifest(): RunManifest {
    const { options, fixture, loaded } = this;
    return {
      format: RUN_FORMAT,
      runId: this.runId,
      worldId: this.worldId,
      ...(this.inheritedWorldIds.length ? { inheritedWorldIds: this.inheritedWorldIds } : {}),
      fixture: {
        id: fixture.id,
        title: fixture.title,
        hash: fixtureHash(fixture),
        frozenHash: frozenHash(fixture),
      },
      provider: options.provider,
      models: options.models,
      cache: options.cache,
      limits: this.limits,
      options: {
        captureBrowser: options.captureBrowser ?? false,
        settleTimeoutMs: this.settleTimeoutMs,
        evaluateIntervalMs: this.evaluateIntervalMs,
        checkpoint: this.checkpointEnabled,
        keepWorld: options.keepWorld ?? false,
      },
      ...(options.benchInfo ? { bench: options.benchInfo } : {}),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt: this.startedAt.toISOString(),
      ...(loaded
        ? {
            resume: {
              runDir: loaded.ref.runDir,
              runId: loaded.run.runId,
              checkpoint: loaded.manifest.index,
              atSeq: loaded.manifest.atSeq,
            },
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Setup
  // -------------------------------------------------------------------------------------------

  private async setup(): Promise<void> {
    const { options, fixture, loaded } = this;
    const { bench } = options;
    try {
      const credential = await options.credentials.credential(options.credentials.providerId);
      if (credential) this.secrets.addAll(credentialSecrets(credential));
    } catch (error) {
      this.notes.push(
        `credentials: could not read the model credential early: ${messageOf(error)}`,
      );
    }

    this.hosts = await this.stage('bench.hosts', () => bench.hosts());
    const world = await this.stage(
      'bench.createWorld',
      () =>
        bench.createWorld(
          { id: this.worldId, ...fixture.world },
          loaded ? { snapshot: loaded.benchSnapshot(), replace: true } : undefined,
        ),
      () => bench.deleteWorld(this.worldId),
    );
    this.worldCreated = true;
    for (const warning of world.warnings) this.notes.push(`world-warning: ${warning}`);
    const since = (await this.stage('bench.state', () => bench.state(this.worldId))).counters.seq;

    const meterRun = this.labelled('meter.openRun', () =>
      options.meter.openRun({
        runId: this.runId,
        provider: options.provider,
        cache: options.cache,
        ...(options.cacheVariant ? { variant: options.cacheVariant } : {}),
        limits: { perRunUsd: this.limits.maxCostUsd },
        volatile: this.volatilePatterns(),
        ...(loaded ? { baseline: loaded.manifest.meterUsage } : {}),
      }),
    );
    this.meterRun = meterRun;
    this.offMeter = meterRun.on((event) => this.onMeter(event));

    const restoreFrom = loaded ? stageRestore(loaded, this.paths) : undefined;
    const today = fixture.world.today;
    if (today === undefined)
      this.notes.push('world.today is not set: the agents use the real date');
    const app = await this.stage(
      'createApp',
      () =>
        options.createApp(
          {
            runId: this.runId,
            runDir: this.paths.dir,
            fixture,
            provider: options.provider,
            models: options.models,
            sink: this.log,
            bench: {
              publicOrigin: bench.publicOrigin,
              scoringOrigin: bench.scoringOrigin,
              hosts: this.hosts,
              worldId: this.worldId,
            },
            now: frozenNow(today, this.startedAt),
            captureBrowser: options.captureBrowser ?? false,
            ...(restoreFrom ? { restoreFrom } : {}),
            signal: this.controller.signal,
          },
          { meter: meterRun, credentials: options.credentials },
        ),
      (late) => late.close(),
    );
    this.app = app;
    for (const secret of this.secrets.list()) app.addSecret(secret);

    this.follower = this.labelled('followBench', () =>
      options.followBench(bench, this.worldId, this.log, {
        since,
        rawFile: this.paths.benchEvents,
        // A poll that failed for a moment is retried and never ends the run; the follower says so
        // when it gives up.
        onWarning: (error) => this.warn(`bench follower: ${messageOf(error)}`),
        onError: (error) => this.fail(error, 'bench follower'),
      }),
    );

    this.simulator = createUserSimulator({
      fixture,
      app,
      log: this.log,
      ...(loaded ? { state: loaded.manifest.answerState, history: this.restored } : {}),
      answerer: () => this.createAnswerer(),
      secrets: (value) => this.addSecret(value),
      scrub: this.secrets.scrub,
      onUnexpected: (prompt, reason) => this.onUnexpected(prompt, reason),
      onFatal: (error) => this.onSimulatorFatal(error),
      ...(options.humanDelayMs ? { delayMs: options.humanDelayMs } : {}),
    });
    this.simulator.start();
  }

  private labelled<T>(label: string, step: () => T): T {
    try {
      return step();
    } catch (error) {
      throw new StageError(label, error);
    }
  }

  /**
   * One setup step. Nothing is started once the run is decided; a step still waiting when the run
   * is decided (an abort, a limit) is abandoned, and `late` cleans up what it delivers afterwards.
   */
  private async stage<T>(
    label: string,
    start: () => Promise<T>,
    late?: (value: T) => Promise<void>,
  ): Promise<T> {
    if (this.ending) throw new SetupInterrupted();
    let abandoned = false;
    let delivered: { value: T } | undefined;
    let released = false;
    const release = (value: T) => {
      if (released || !late) return;
      released = true;
      late(value).catch(() => undefined);
    };
    const guarded = start().then(
      (value) => {
        delivered = { value };
        if (abandoned) release(value);
        return { value };
      },
      (error) => {
        throw new StageError(label, error);
      },
    );
    const winner = await Promise.race([guarded, this.ended.promise.then(() => undefined)]);
    if (!winner) {
      abandoned = true;
      if (delivered) release(delivered.value);
      throw new SetupInterrupted();
    }
    return winner.value;
  }

  /** Text that varies between runs of the same conversation and must not change a cache key. */
  private volatilePatterns(): VolatilePattern[] {
    const patterns: VolatilePattern[] = [];
    const dirs = new Set([this.paths.dir]);
    try {
      dirs.add(realpathSync(this.paths.dir));
    } catch {
      // The folder exists; a failing realpath only means no alias to normalise.
    }
    for (const dir of dirs) patterns.push({ pattern: dir, replacement: '<RUNDIR>' });
    patterns.push({ pattern: this.runId, replacement: '<RUNID>' });
    // The world's id is in the pages the agent reads (so in the requests that quote them), and so
    // are the ones the restored conversation brought along.
    for (const id of [this.worldId, ...this.inheritedWorldIds]) {
      patterns.push({ pattern: id, replacement: '<WORLD>' });
    }
    const origins: [string, string][] = [
      [this.options.meter.url, '<METER>'],
      [this.options.bench.publicOrigin, '<BENCH>'],
      [this.options.bench.scoringOrigin, '<BENCH-SCORING>'],
    ];
    for (const [origin, replacement] of origins) {
      try {
        patterns.push({ pattern: new URL(origin).host, replacement });
      } catch {
        // An origin that is not a URL has no host to normalise.
      }
    }
    return patterns;
  }

  private createAnswerer(): Promise<Answerer> {
    const { options } = this;
    const meterRun = this.meterRun;
    if (!meterRun) return Promise.reject(new Error('The meter run is not open'));
    const secrets = this.secrets.list();
    const make = options.createAnswerer ?? createLlmAnswerer;
    return make({
      provider: options.provider,
      run: meterRun,
      credentials: options.credentials,
      model: options.models.answererModel,
      thinking: options.models.answererThinking,
      sink: createDirectorySink(join(this.paths.dir, 'answerer'), secrets),
      secrets,
      signal: this.controller.signal,
    });
  }

  private addSecret(value: string): void {
    this.secrets.add(value);
    this.app?.addSecret(value);
  }

  // -------------------------------------------------------------------------------------------
  // Driving: what ends a run
  // -------------------------------------------------------------------------------------------

  private async drive(): Promise<void> {
    const app = this.app!;
    this.check();
    if (this.ending) return;
    this.wallTimer = setTimeout(
      () =>
        this.end({
          endedBy: 'limit:wall-clock',
          note: `limit exceeded: ${this.limits.wallClockMs} ms of wall-clock time`,
        }),
      Math.min(this.limits.wallClockMs, MAX_TIMER_MS),
    );
    this.evalTimer = setInterval(() => {
      if (!this.ending && !app.idle()) this.scheduleEvaluate();
    }, this.evaluateIntervalMs);

    const text = this.loaded
      ? (this.options.resumePrompt ?? DEFAULT_RESUME_PROMPT)
      : this.fixture.prompt;
    this.log.push({ type: 'user_message', text });
    const sent = app.send(text).then(
      () => undefined,
      (error) => this.fail(error, 'chat.send'),
    );
    await Promise.race([sent, this.ended.promise]);
    if (!this.ending) {
      this.watchIdle().catch((error) => this.fail(error, 'idle watcher'));
    }
    await this.ended.promise;
  }

  private end(ending: Ending): void {
    if (this.ending) return;
    this.ending = ending;
    this.endedAt = this.clock();
    this.ended.resolve();
  }

  private fail(error: unknown, where: string): void {
    this.end({ endedBy: 'error', note: `${where}: ${messageOf(error)}` });
  }

  private readonly onSignal = (): void => {
    this.end({ endedBy: 'abort', note: 'aborted by the caller' });
  };

  /** Every observation, in order, before anything else reacts to it. */
  private hear(observation: Observation): void {
    this.noteMatches(this.engine.observe(observation));
    switch (observation.type) {
      case 'bench':
        this.scheduleEvaluate();
        break;
      case 'tool_start':
      case 'prompt_shown':
        this.checkCounters();
        break;
      case 'agent_failure':
        this.onAgentFailure(observation);
        break;
      case 'tool_end':
        this.onToolEnd(observation);
        break;
      default:
        break;
    }
    this.check();
  }

  /**
   * A model request failed for good or an agent host died (`classifyAgentFailure`): not the
   * agent's doing unless its conversation outgrew the model's window, so the run ends unscored
   * instead of ending quiet with its required rules unmatched, which reads as the agent failing.
   */
  private onAgentFailure(failure: Extract<Observation, { type: 'agent_failure' }>): void {
    if (this.ending) return;
    const who = failure.procedureId ? `procedure-${failure.procedureId}` : failure.agent;
    const blame = classifyAgentFailure(failure.kind);
    switch (blame.by) {
      case 'infrastructure': {
        const ending: Ending = {
          endedBy: 'error',
          note: `infrastructure:${blame.source}:${blame.kind} (${who}): ${failure.message}`,
        };
        // Ctrl-C in a terminal signals the whole process group: the hosts die of the same signal
        // as the caller, whose abort may arrive a moment later. Give the abort that moment.
        if (failure.signal && INTERRUPT_SIGNALS.has(failure.signal)) {
          this.interruptTimer ??= setTimeout(() => this.end(ending), INTERRUPT_GRACE_MS);
        } else {
          this.end(ending);
        }
        break;
      }
      case 'budget':
        this.end({
          endedBy: 'limit:budget',
          note: `budget: the model refused the request of ${who} (${failure.kind}): ${failure.message}`,
        });
        break;
      case 'agent':
        this.notes.push(`agent-failure:${failure.kind} (${who}): ${failure.message}`);
        break;
    }
  }

  /** A browser tool that says Chromium cannot start: nothing the model does fixes that. */
  private onToolEnd(end: Extract<Observation, { type: 'tool_end' }>): void {
    if (this.ending) return;
    const what = browserLaunchFailure(end);
    if (what === undefined) return;
    this.end({
      endedBy: 'error',
      note: `infrastructure:browser (${end.procedureId ? `procedure-${end.procedureId}` : end.agent}): Chromium could not be started: ${what}`,
    });
  }

  /** Something the run survived: a note of the result and of the event log. */
  private warn(text: string): void {
    this.notes.push(text);
    if (!this.logClosed) this.log.push({ type: 'note', text });
  }

  private checkCounters(): void {
    const app = this.app;
    if (!app || this.ending) return;
    const counters = app.counters();
    const toolCalls = this.before.toolCalls + counters.toolCalls;
    const prompts = this.before.prompts + counters.prompts;
    if (toolCalls > this.limits.maxToolCalls) {
      this.end({
        endedBy: 'limit:tool-calls',
        note: `limit exceeded: ${toolCalls} tool calls, at most ${this.limits.maxToolCalls}`,
      });
    } else if (prompts > this.limits.maxPrompts) {
      this.end({
        endedBy: 'limit:prompts',
        note: `limit exceeded: ${prompts} prompts, at most ${this.limits.maxPrompts}`,
      });
    }
  }

  /** The rules' verdict so far: instant failure, settling, an early end. */
  private check(): void {
    if (this.ending) return;
    const { engine } = this;
    if (engine.shouldFailNow()) {
      const failure = engine.firstFailure();
      this.end({
        endedBy: 'required-failed',
        note: `required-failed:${failure?.ruleId ?? 'unknown'}${failure?.detail ? `: ${failure.detail}` : ''}`,
      });
      return;
    }
    if (!engine.settled()) return;
    this.settleTimer ??= setTimeout(
      () =>
        this.end({
          endedBy: 'settle-timeout',
          note: `the agents were still busy ${this.settleTimeoutMs} ms after every required rule matched`,
        }),
      Math.min(this.settleTimeoutMs, MAX_TIMER_MS),
    );
    // Nothing can change the outcome any more: every scored rule is decided and no negated
    // required rule is left that could still fail the run.
    if (!this.hasRequiredNegated && !engine.quiescent() && engine.decided()) {
      this.end({ endedBy: 'decided' });
    }
  }

  private onMeter(event: MeterEvent): void {
    switch (event.type) {
      case 'usage':
        if (event.runUsage.costUsd > this.limits.maxCostUsd) {
          this.end({
            endedBy: 'limit:cost',
            note: `limit exceeded: $${event.runUsage.costUsd.toFixed(4)} spent, at most $${this.limits.maxCostUsd}`,
          });
        } else if (event.runUsage.requests > this.limits.maxRequests) {
          this.end({
            endedBy: 'limit:requests',
            note: `limit exceeded: ${event.runUsage.requests} model requests, at most ${this.limits.maxRequests}`,
          });
        }
        break;
      case 'cap': {
        // The run's and each agent's request and dollar caps stop an agent that loops or bloats its
        // context: its doing, scored like the fixture's own limits. The key's reserve, the daily
        // and lifetime caps, the kill switch and the plan windows are the harness's budget.
        const ending = classifyCap(event.reason, event.agent);
        const what = `meter cap ${event.reason} (${event.agent}): ${event.message}`;
        this.end(
          ending === 'limit:budget'
            ? { endedBy: ending, note: `budget: ${what}` }
            : { endedBy: ending, note: `limit exceeded: ${what}` },
        );
        break;
      }
      case 'replay_miss':
        this.end({
          endedBy: 'replay-miss',
          note: `replay-miss (${event.agent}): ${event.diagnostic.description}`,
        });
        break;
      case 'gateway_limit':
        this.end({
          endedBy: 'limit:budget',
          note: `budget: the gateway refused (${event.kind}, ${event.status}, ${event.agent}): ${event.message}`,
        });
        break;
    }
  }

  private onUnexpected(prompt: PendingPrompt, reason: string): void {
    this.end({
      endedBy: 'unexpected-prompt',
      note: `unexpected-prompt:${prompt.itemId}: ${reason}`,
    });
  }

  private onSimulatorFatal(error: Error): void {
    if (error instanceof AnswererError && error.code === 'budget') {
      this.end({
        endedBy: 'limit:budget',
        note: `budget: the answerer was refused: ${error.message}`,
      });
    } else if (error instanceof AnswererError && error.code === 'replay_miss') {
      this.end({ endedBy: 'replay-miss', note: `replay-miss (answerer): ${error.message}` });
    } else if (error instanceof SimulatorError || error instanceof AnswererError) {
      this.fail(error, `user simulator (${error.code})`);
    } else {
      this.fail(error, 'user simulator');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------------------------

  private all(): readonly Observation[] {
    if (this.restored.length === 0) return this.log.all();
    const live = this.log.all();
    if (!this.merged || this.merged.length !== this.restored.length + live.length) {
      this.merged = [...this.restored, ...live];
    }
    return this.merged;
  }

  private readonly view: RunView = {
    observations: () => this.all(),
    benchState: () => this.options.bench.state(this.worldId),
    vaultDocuments: () => this.requireApp().vaultDocuments(),
    secretLeaks: () => this.requireApp().secretLeaks(),
  };

  private requireApp(): EvalApp {
    if (!this.app) throw new Error('The app is not running');
    return this.app;
  }

  private scheduleEvaluate(): void {
    if (this.ending) return;
    if (this.evaluating) {
      this.evaluateAgain = true;
      return;
    }
    this.evaluating = true;
    void (async () => {
      try {
        do {
          this.evaluateAgain = false;
          await this.evaluate();
        } while (this.evaluateAgain && !this.ending);
      } catch (error) {
        this.fail(error, 'rule evaluation');
      } finally {
        this.evaluating = false;
      }
    })();
  }

  private async evaluate(options: { full?: boolean } = {}): Promise<void> {
    this.noteMatches(await this.engine.evaluate(this.view, options));
    this.check();
  }

  /** Rule matches become notes in the log, pushed after the observation that caused them. */
  private noteMatches(matches: RuleMatch[]): void {
    for (const match of matches) {
      const what = match.precondition ? 'precondition' : 'rule';
      const effect = !match.negate
        ? 'matched'
        : match.kind === 'required'
          ? 'matched (negated: the run fails)'
          : 'matched (negated: credit lost)';
      this.pendingNotes.push(
        `${what} ${match.ruleId} ${effect} at seq ${match.seq}: ${match.detail}`,
      );
    }
    if (this.pendingNotes.length > 0 && !this.noteFlushScheduled) {
      this.noteFlushScheduled = true;
      queueMicrotask(() => this.flushNotes());
    }
  }

  private flushNotes(): void {
    this.noteFlushScheduled = false;
    if (this.logClosed) return;
    for (const text of this.pendingNotes.splice(0)) this.log.push({ type: 'note', text });
  }

  // -------------------------------------------------------------------------------------------
  // Quiescence
  // -------------------------------------------------------------------------------------------

  /** Waits for the agents to be idle, again and again, until the run ends. */
  private async watchIdle(): Promise<void> {
    const app = this.app!;
    const { signal } = this.watchAbort;
    while (!this.ending && !signal.aborted) {
      const idle = await app.untilIdle({
        signal,
        ...(this.options.idleHoldMs !== undefined ? { holdMs: this.options.idleHoldMs } : {}),
      });
      if (!idle || this.ending || signal.aborted) return;
      if ((await this.quiescentPoint()) === 'ended') return;
    }
  }

  /**
   * The agents are idle. Late events are delivered, the rules judge the whole run, a checkpoint
   * is taken, and the run ends: a quiescent run with every required rule matched has done the
   * job; one without has stopped short of it (its required rules fail).
   */
  private async quiescentPoint(): Promise<'ended' | 'busy'> {
    const app = this.app!;
    await this.within('bench drain', () => this.follower?.drain());
    await this.within('simulator', () => this.simulator?.settled());
    if (this.ending) return 'ended';
    if (!app.idle()) return 'busy';
    this.log.push({ type: 'quiescent' });
    await this.evaluate({ full: true });
    if (this.ending) return 'ended';
    // Reading the whole run takes a while: the agents may have started again meanwhile.
    if (!app.idle()) return 'busy';
    await this.takeCheckpoint();
    if (this.ending) return 'ended';
    if (!app.idle()) return 'busy';
    this.end({ endedBy: 'quiescent', graceful: true });
    return 'ended';
  }

  private async takeCheckpoint(): Promise<void> {
    const { app, meterRun } = this;
    if (!app || !meterRun) return;
    if (!this.checkpointEnabled) return;
    try {
      const outcome = await writeCheckpoint({
        runId: this.runId,
        worldId: this.worldId,
        paths: this.paths,
        index: this.checkpoints.length + 1,
        app,
        bench: this.options.bench,
        log: this.log,
        answerState: () => this.simulator!.state(),
        ruleState: () => this.engine.state(),
        meterUsage: () => meterRun.usage(),
      });
      if (outcome.written) {
        this.checkpoints.push(outcome.manifest.index);
        this.log.push({
          type: 'note',
          text: `checkpoint ${outcome.manifest.index} written at seq ${outcome.manifest.atSeq}`,
        });
      } else {
        this.log.push({ type: 'note', text: `no checkpoint taken: ${outcome.reason}` });
      }
    } catch (error) {
      this.notes.push(`checkpoint-failed: ${messageOf(error)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // The end: shut everything down, judge, write
  // -------------------------------------------------------------------------------------------

  /**
   * Runs one step of shutting down: never throws, never waits longer than the shutdown timeout.
   * A problem becomes a note of the result.
   */
  private async within<T>(label: string, step: () => Promise<T> | T): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(step),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${this.shutdownTimeoutMs} ms`)),
            this.shutdownTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      this.notes.push(`${label}: ${messageOf(error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private stopTimers(): void {
    clearTimeout(this.wallTimer);
    clearInterval(this.evalTimer);
    clearTimeout(this.settleTimer);
    clearTimeout(this.interruptTimer);
    this.watchAbort.abort();
    this.options.signal?.removeEventListener('abort', this.onSignal);
  }

  private closeMeter(): void {
    this.offMeter?.();
    this.offMeter = undefined;
    if (this.meterSummary || !this.meterRun) return;
    try {
      this.meterSummary = this.meterRun.close();
    } catch (error) {
      this.notes.push(`meter close: ${messageOf(error)}`);
    }
  }

  /**
   * Requests that were still being answered when the run was cut off finish after the meter run is
   * closed and count toward its usage: wait for them (bounded) and read the totals again.
   */
  private async settleMeter(): Promise<void> {
    const run = this.meterRun;
    if (!run) return;
    await this.within('meter in-flight requests', async () => {
      while (run.summary().inflight > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      this.meterSummary = run.summary();
    } catch (error) {
      this.notes.push(`meter summary: ${messageOf(error)}`);
    }
  }

  private usage(): MeterUsage {
    if (this.meterSummary) return this.meterSummary.usage;
    try {
      return this.meterRun?.usage() ?? emptyMeterUsage();
    } catch {
      return emptyMeterUsage();
    }
  }

  private async conclude(): Promise<RunOutcome> {
    const ending: Ending = this.ending ?? {
      endedBy: 'error',
      note: 'the run ended without a reason',
    };
    const endedAt = this.endedAt ?? this.clock();
    this.stopTimers();
    this.simulator?.stop();
    const app = this.app;

    // Nothing may keep running or calling the model.
    if (!ending.graceful) {
      this.controller.abort(new Error(`run ended: ${ending.endedBy}`));
      this.closeMeter();
      if (app)
        await this.within('app.abort', () => app.abort(`${ending.endedBy}: ${ending.note ?? ''}`));
    }

    // Judge what happened, while the app's vault can still be read.
    if (JUDGED_AFTER_CUT.has(ending.endedBy)) {
      await this.within('bench drain', () => this.follower?.drain());
      await this.within('final rule evaluation', () => this.evaluate({ full: true }));
    }
    await this.within('bench follower', () => this.follower?.stop());
    if (app) await this.within('app.close', () => app.close());
    this.closeMeter();
    await this.settleMeter();
    this.flushNotes();
    this.log.push({
      type: 'note',
      text: `run ended: ${ending.endedBy}${ending.note ? ` (${ending.note})` : ''}`,
    });

    const benchState = this.worldCreated
      ? await this.within('bench state', () => this.options.bench.state(this.worldId))
      : undefined;
    const notes = [...(ending.note ? [ending.note] : []), ...this.notes];
    const unused = this.simulator?.unusedRequired() ?? [];
    if (unused.length > 0) notes.push(`unused-answers:${unused.join(',')}`);

    const assemble = (endedBy: string) =>
      this.assemble({
        endedBy,
        notes,
        wrongTurns: benchState?.wrongTurns.count ?? 0,
        durationMs: endedAt.getTime() - this.startedAt.getTime(),
      });
    let result = assemble(ending.endedBy);
    if (this.worldCreated && !benchState && result.status === 'completed') {
      // Without the final state the wrong turns are unknown: a score would be a guess.
      notes.push('the final SpainBench state could not be read: the result is unreliable');
      result = assemble('error');
    }
    // The result is handed to the caller as much as it is written: neither may carry a secret.
    result = JSON.parse(this.secrets.scrub(JSON.stringify(result))) as RunResult;
    const wrongTurnItems: BenchWrongTurn[] = benchState?.wrongTurns.items ?? [];
    // Whatever goes wrong from here on is added to the result as it happens.
    let reported = this.notes.length;
    const addLateNotes = (): boolean => {
      if (this.notes.length <= reported) return false;
      result.notes.push(...this.notes.slice(reported).map(this.secrets.scrub));
      reported = this.notes.length;
      return true;
    };

    if (this.worldCreated) {
      await this.within('bench artifacts', () =>
        // The world's state holds the mock account's password: `bench/` is for reading, so it is
        // masked like every other file of the run (a checkpoint keeps the raw snapshot to restore).
        this.options.saveBenchArtifacts(this.options.bench, this.worldId, this.paths.bench, {
          scrub: this.secrets.scrub,
        }),
      );
    }
    await this.within('meter ledger', () =>
      copyLedgerLines(this.options.meter.ledger.dir, this.runId, this.paths.meterLedger),
    );

    addLateNotes();
    this.write(result, wrongTurnItems);

    // Last: the world and the log. A failure here is a note, never a change of the result.
    if (this.worldCreated && !this.options.keepWorld) {
      await this.within('bench deleteWorld', () => this.options.bench.deleteWorld(this.worldId));
    }
    this.logClosed = true;
    try {
      this.log.close();
    } catch (error) {
      this.notes.push(`event log close: ${messageOf(error)}`);
    }
    if (addLateNotes()) this.write(result, wrongTurnItems);

    return {
      runId: this.runId,
      runDir: this.paths.dir,
      result,
      summary: summarizeResult(result, this.paths.dir),
      checkpoints: [...this.checkpoints],
      reportFile: this.paths.report,
      resultFile: this.paths.result,
    };
  }

  private assemble(input: {
    endedBy: string;
    notes: string[];
    wrongTurns: number;
    durationMs: number;
  }): RunResult {
    const { engine, fixture, options } = this;
    try {
      return assembleRunResult({
        runId: this.runId,
        fixture,
        provider: options.provider,
        outcomes: engine.outcomes(),
        preconditionOutcomes: engine.preconditionOutcomes(),
        ruleErrors: engine.errors(),
        wrongTurns: input.wrongTurns,
        usage: this.usage(),
        durationMs: input.durationMs,
        endedBy: input.endedBy,
        notes: input.notes,
      });
    } catch (error) {
      return {
        runId: this.runId,
        fixtureId: fixture.id,
        provider: options.provider,
        status: 'error',
        score: null,
        scoreBeforePenalty: null,
        wrongTurns: input.wrongTurns,
        rules: [],
        usage: this.usage(),
        durationMs: input.durationMs,
        endedBy: 'error',
        notes: [...input.notes, `the result could not be assembled: ${messageOf(error)}`],
      };
    }
  }

  /** `result.json` and `report.md`. A write failure is a note (the log keeps the run's record). */
  private write(result: RunResult, wrongTurnItems: readonly BenchWrongTurn[]): void {
    const scrub = this.secrets.scrub;
    try {
      writeResult(this.paths, result, scrub);
    } catch (error) {
      this.notes.push(`result.json: ${messageOf(error)}`);
    }
    try {
      writeReport(
        this.paths,
        renderRunReport({
          result,
          fixture: this.fixture,
          wrongTurnItems,
          observations: this.all(),
        }),
        scrub,
      );
    } catch (error) {
      this.notes.push(`report.md: ${messageOf(error)}`);
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Runs a fixture to the end and writes its folder. Resolves with the result in every case but a
 * request that cannot start: a fixture that does not validate, a run id that is not valid or
 * already used, a checkpoint that is unreadable or belongs to another fixture throw before
 * anything is created. From then on every failure is a result (`error`, `aborted`...) in a
 * complete folder, with nothing left running.
 */
export async function runFixture(options: RunOptions): Promise<RunOutcome> {
  return new FixtureRun(options).execute();
}
