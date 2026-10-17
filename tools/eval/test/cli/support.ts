/**
 * Test support for the CLI: a `main(argv, deps)` harness that captures stdout and stderr, fakes the
 * process (signals, `exit`), the clock and the parts that start servers, and builds run folders
 * with the suite's own writers.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliDeps, Env } from '../../src/cli/deps';
import { main } from '../../src/cli/main';
import type { RuleOutcome, RunResult } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import {
  createRunDirectory,
  fixtureHash,
  frozenHash,
  RUN_FORMAT,
  type RunManifest,
  renderRunReport,
  writeEventLines,
  writeReport,
  writeResult,
  writeRunManifest,
} from '../../src/run/results';
import { emptyMeterUsage } from '../../src/scoring';

/** `deps.exit` of the harness: it throws, so a test can see that the process would have ended. */
export class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

export interface Cli {
  /** Runs `eval <argv>` and resolves with the exit code. */
  run(...argv: string[]): Promise<number>;
  out(): string;
  err(): string;
  /** A temp directory: the credentials home (`SPAINBENCH_DATA_DIR`) is `home` inside it. */
  dir: string;
  home: string;
  /** The directory the commands think they were typed in. */
  cwd: string;
  runsRoot: string;
  env: Env;
  /** Delivers SIGINT (or another signal) to the handlers `deps.onInterrupt` registered. */
  interrupt(signal?: string): void;
  /** How many handlers are listening for signals right now. */
  listeners(): number;
  /** The clock; `advance` moves it. */
  clock: { now: Date; advance(ms: number): void };
  cleanup(): void;
}

const NEVER = (name: string) => () => {
  throw new Error(`${name} was not expected in this test`);
};

export function makeCli(options: { env?: Env; deps?: Partial<CliDeps>; start?: Date } = {}): Cli {
  const dir = mkdtempSync(join(tmpdir(), 'sa-eval-cli-'));
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd);
  const runsRoot = join(dir, 'runs');
  const env: Env = { SPAINBENCH_DATA_DIR: home, ...options.env };
  let stdout = '';
  let stderr = '';
  const handlers = new Set<(signal: string) => void>();
  const clock = {
    now: options.start ?? new Date('2026-10-17T10:00:00.000Z'),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const deps: Partial<CliDeps> = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env,
    cwd,
    now: () => clock.now,
    onInterrupt(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    exit: (code) => {
      throw new ExitCalled(code);
    },
    runEvaluation: NEVER('runEvaluation'),
    mockScenario: NEVER('mockScenario'),
    budgetStatus: NEVER('budgetStatus'),
    runCodexLogin: NEVER('runCodexLogin'),
    openBench: NEVER('openBench'),
    hostBundleState: () => 'fresh',
    chromiumPath: () => '/fake/chromium',
    ...options.deps,
  };
  return {
    run: (...argv) => main(argv, deps),
    out: () => stdout,
    err: () => stderr,
    dir,
    home,
    cwd,
    runsRoot,
    env,
    interrupt(signal = 'SIGINT') {
      for (const handler of [...handlers]) handler(signal);
    },
    listeners: () => handlers.size,
    clock,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------------------------
// Run folders
// ---------------------------------------------------------------------------------------------

const rule = (overrides: Partial<RuleOutcome> & { ruleId: string }): RuleOutcome => ({
  kind: 'required',
  negate: false,
  matched: true,
  passed: true,
  ...overrides,
});

export interface RunFolderOptions {
  fixtureId?: string;
  provider?: RunResult['provider'];
  status?: RunResult['status'];
  score?: number | null;
  costUsd?: number;
  startedAt?: string;
  /** No result.json (a run that never finished). */
  unfinished?: boolean;
  /** No report.md (it was deleted). */
  noReport?: boolean;
  endedBy?: string;
}

/** A run folder as `runFixture` leaves it (run.json, events.jsonl, result.json, report.md). */
export function writeRunFolder(runsRoot: string, runId: string, options: RunFolderOptions = {}) {
  const fixture = getFixture(options.fixtureId ?? 'vida-laboral-sin-datos');
  const provider = options.provider ?? 'mock';
  const status = options.status ?? 'completed';
  const score = options.score === undefined ? (status === 'completed' ? 0.8 : null) : options.score;
  const paths = createRunDirectory(runsRoot, runId);
  const scrub = (text: string) => text;
  const manifest: RunManifest = {
    format: RUN_FORMAT,
    runId,
    fixture: {
      id: fixture.id,
      title: fixture.title,
      hash: fixtureHash(fixture),
      frozenHash: frozenHash(fixture),
    },
    provider,
    models: { answererModel: 'anthropic/claude-haiku-5.5', answererThinking: 'low' },
    cache: 'off',
    limits: fixture.limits,
    options: {
      captureBrowser: false,
      settleTimeoutMs: 1000,
      evaluateIntervalMs: 250,
      checkpoint: true,
      keepWorld: false,
    },
    node: 'v24.9.0',
    platform: 'darwin-arm64',
    startedAt: options.startedAt ?? '2026-10-17T04:42:18.000Z',
  };
  writeRunManifest(paths, manifest, scrub);
  writeEventLines(paths.events, [
    JSON.stringify({ seq: 1, t: manifest.startedAt, type: 'user_message', text: fixture.prompt }),
    JSON.stringify({
      seq: 2,
      t: manifest.startedAt,
      type: 'tool_start',
      agent: 'assistant',
      toolCallId: 'c1',
      tool: 'procedure_start',
      args: {},
    }),
  ]);
  if (options.unfinished) return paths;
  const result: RunResult = {
    runId,
    fixtureId: fixture.id,
    provider,
    status,
    score,
    scoreBeforePenalty: score,
    wrongTurns: 0,
    rules: [
      rule({
        ruleId: 'pdf-saved-complete',
        passed: status === 'completed',
        matched: status === 'completed',
      }),
      rule({ ruleId: 'no-exfil', negate: true, matched: false }),
      rule({ ruleId: 'used-vault-credential', kind: 'scored', passed: true }),
    ],
    preconditions: [],
    usage: { ...emptyMeterUsage(), requests: 3, costUsd: options.costUsd ?? 0.0123 },
    durationMs: 65_000,
    endedBy: options.endedBy ?? 'quiescent',
    notes: [],
  };
  writeResult(paths, result, scrub);
  if (!options.noReport) {
    writeReport(paths, renderRunReport({ result, fixture }), scrub);
  }
  return paths;
}

/** A folder that is not a run (like `_bench`): files and nothing else. */
export function writeNotARun(dir: string, files: Record<string, string> = { 'a.log': 'x' }): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
}
