/**
 * Everything the commands touch outside their own arguments: the terminal, the process, the
 * clock, and the parts of the suite that start servers, call models or ask the network.
 * `main(argv, deps)` takes these so tests inject fakes; `defaultDeps()` is the real thing, with the
 * heavy parts loaded only when a command uses them (`eval --help` answers at once).
 */
import { statSync } from 'node:fs';
import type { ScenarioInput } from '@sa/mock-llm';
import type { BenchServer, BenchTarget } from '../bench';
import { cachedChromium } from '../chromium';
import type { BudgetStatus, BudgetStatusOptions } from '../llm/budget';
import type { CodexLoginOptions, CodexLoginSummary } from '../llm/codex-auth';
import type { RunOutcome } from '../run';
import type { EvaluationRequest } from '../runner';

export type Env = Record<string, string | undefined>;
type HostBundleState = 'fresh' | 'missing' | 'stale';

export interface CliDeps {
  /** Writes text exactly as given (the caller adds newlines). */
  stdout(text: string): void;
  stderr(text: string): void;
  env: Env;
  /** Relative paths in arguments and in `SPAINBENCH_DIR` resolve against this directory. */
  cwd: string;
  now(): Date;
  /** Calls `handler` on SIGINT and SIGTERM; returns the function that stops listening. */
  onInterrupt(handler: (signal: string) => void): () => void;
  /** Ends the process at once (the second Ctrl-C). */
  exit(code: number): never;

  /** `runEvaluation` of `src/runner.ts`: the real run. */
  runEvaluation(request: EvaluationRequest): Promise<RunOutcome>;
  /** `mockScenario` of `src/scenarios`: the script of the mock model for a fixture. */
  mockScenario(fixtureId: string, name: string): ScenarioInput | Promise<ScenarioInput>;
  budgetStatus(options: BudgetStatusOptions): Promise<BudgetStatus>;
  runCodexLogin(options: CodexLoginOptions): Promise<CodexLoginSummary>;
  /** Starts or connects to SpainBench (`list` and `doctor` look at it and stop it again). */
  openBench(target: BenchTarget, options: { logFile: string }): Promise<BenchServer>;
  /** `hostBundleState` of `src/run/app`. */
  hostBundleState(): HostBundleState | Promise<HostBundleState>;
  /** The Chromium the browser service launches, when it is in Playwright's cache. */
  chromiumPath(): string | undefined;
}

/** The directory the user typed the command in: pnpm runs scripts from the package's folder. */
function invocationDir(env: Env, cwd: string): string {
  const initial = env.INIT_CWD;
  try {
    if (initial && statSync(initial).isDirectory()) return initial;
  } catch {
    // Not there: use the process' own directory.
  }
  return cwd;
}

export function defaultDeps(): CliDeps {
  const env = process.env;
  return {
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    env,
    cwd: invocationDir(env, process.cwd()),
    now: () => new Date(),
    onInterrupt(handler) {
      const signals = ['SIGINT', 'SIGTERM'] as const;
      const listeners = signals.map((signal) => {
        const listener = () => handler(signal);
        process.on(signal, listener);
        return [signal, listener] as const;
      });
      return () => {
        for (const [signal, listener] of listeners) process.off(signal, listener);
      };
    },
    exit: (code) => process.exit(code),
    runEvaluation: async (request) => (await import('../runner')).runEvaluation(request),
    mockScenario: async (fixtureId, name) =>
      (await import('../scenarios')).mockScenario(fixtureId, name),
    budgetStatus: async (options) => (await import('../llm/budget')).budgetStatus(options),
    runCodexLogin: async (options) => (await import('../llm/codex-auth')).runCodexLogin(options),
    openBench: async (target, options) => (await import('../bench')).openBench(target, options),
    hostBundleState: async () => (await import('../run/app/host-bundle')).hostBundleState(),
    chromiumPath: cachedChromium,
  };
}
