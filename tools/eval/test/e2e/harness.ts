/**
 * What the end-to-end tests share. They run the whole suite (`runEvaluation`: the real SpainBench
 * started from `SPAINBENCH_DIR`, the meter, `tools/mock-llm` as the model, the real agent hosts
 * and Chromium behind the network layer) and read what it leaves in the run folder.
 *
 * Import it first: it installs the deny-by-default network guard of the app tests for this
 * process (nothing in it may reach anything but 127.0.0.1; the hosts and Chromium have their own
 * guards, which the net part tests).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ScenarioInput } from '@sa/mock-llm';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { describe } from 'vitest';
import type { BenchWorldState, Observation, RunResult } from '../../src/contracts';
import type { RunOutcome } from '../../src/run';
import { PROFILE_KEY_SEED } from '../../src/run/app';
import { type EvaluationRequest, findBenchLog, runEvaluation } from '../../src/runner';
import { chromiumCached, expectNoEgress } from '../run/app/support';

export { expectNoEgress };

/** SpainBench's checkout: the tests that need it skip without it. */
const SPAINBENCH_DIR = process.env.SPAINBENCH_DIR;

/** `describe` for the suites that run the whole suite: they need SpainBench and Chromium. */
export const e2eSuite = describe.skipIf(!SPAINBENCH_DIR || !chromiumCached);

const roots: string[] = [];

/** A temp folder removed by `cleanup()` (set `SA_EVAL_E2E_KEEP=1` to look at the runs). */
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-eval-e2e-'));
  roots.push(dir);
  return dir;
}

export function cleanup(): void {
  if (process.env.SA_EVAL_E2E_KEEP) {
    console.warn(`Kept: ${roots.join(' ')}`);
    return;
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface Workspace {
  /** Where runs are written. */
  runsRoot: string;
  /** The credentials home (the cache lives in it): a temp folder, never the real one. */
  home: string;
}

export function workspace(): Workspace {
  const root = tempRoot();
  const runsRoot = join(root, 'runs');
  const home = join(root, 'home');
  mkdirSync(runsRoot, { recursive: true });
  return { runsRoot, home };
}

/** `runEvaluation` with the mock provider on a workspace of its own. */
export function evaluate(
  space: Workspace,
  request: Omit<EvaluationRequest, 'provider' | 'runsRoot' | 'home' | 'env' | 'scenario'> & {
    scenario: ScenarioInput;
  },
): Promise<RunOutcome> {
  if (!SPAINBENCH_DIR) throw new Error('SPAINBENCH_DIR is not set');
  return runEvaluation({
    provider: 'mock',
    runsRoot: space.runsRoot,
    home: space.home,
    env: { SPAINBENCH_DIR },
    // A busy machine makes a page slow, and a scripted model that waits for it looks again: more
    // requests than the meter's caps and the fixtures' own limits for a real run allow. These runs
    // test the harness, not those caps (a test of them passes its own `limits` and `meterLimits`).
    meterLimits: { perAgentUsd: 100, perAgentRequests: 100_000, perRunRequests: 100_000 },
    // Stopping everything takes longer when the machine is busy: that is not what these test.
    shutdownTimeoutMs: 90_000,
    ...request,
    limits: { maxRequests: 100_000, maxCostUsd: 100, ...request.limits },
  });
}

// ---------------------------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------------------------

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readLines<T = Record<string, unknown>>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export interface RunFiles {
  dir: string;
  result: RunResult;
  events: Observation[];
  state: BenchWorldState;
}

export function readRun(outcome: RunOutcome): RunFiles {
  const dir = outcome.runDir;
  return {
    dir,
    result: readJson<RunResult>(join(dir, 'result.json')),
    events: readLines<Observation>(join(dir, 'events.jsonl')),
    state: readJson<BenchWorldState>(join(dir, 'bench', 'state.json')),
  };
}

type Of<T extends Observation['type']> = Extract<Observation, { type: T }>;

export function observations<T extends Observation['type']>(
  events: Observation[],
  type: T,
): Of<T>[] {
  return events.filter((event): event is Of<T> => event.type === type);
}

/** The tool calls the agents started, in order, as `agent:tool`. */
export function toolNames(events: Observation[]): string[] {
  return observations(events, 'tool_start').map((event) => `${event.agent}:${event.tool}`);
}

/** The ids that differ in every run (credentials, documents, procedures, downloads) as a placeholder. */
function withoutIds(text: string): string {
  return text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[a-z]{1,8}_[0-9a-f]{16}\b/gi,
    '<ID>',
  );
}

/** What a run's agents did, comparable across runs: each tool call with its arguments. */
export function toolCallSignature(events: Observation[]): string[] {
  return observations(events, 'tool_start').map(
    (event) => `${event.agent}:${event.tool} ${withoutIds(JSON.stringify(event.args))}`,
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

export const sha256 = (bytes: Uint8Array | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** The documents of the vault a run left in its profile (opened outside the app). */
export async function vaultDocuments(profileDir: string) {
  const vault = await Vault.open(
    join(profileDir, 'vault'),
    createTestKeyProvider(PROFILE_KEY_SEED),
  );
  return Promise.all(
    vault.listDocuments().map(async (document) => ({
      ...document,
      bytes: Buffer.from(await vault.readDocument(document.id)),
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------------------------

/** The spellings a secret may take in a file: plain, JSON, URL-encoded, base64 and hex. */
function spellings(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  const base64 = [0, 1, 2].map((shift) =>
    Buffer.concat([Buffer.alloc(shift, 'x'), bytes]).toString('base64'),
  );
  // Whatever precedes the secret changes its first characters and its last: keep the middle.
  const middles = base64.map((text) => text.slice(4, -4));
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    ...middles,
    bytes.toString('hex'),
  ];
}

/** Files under `dir` (relative) that hold the secret in any spelling. */
export function filesHolding(dir: string, secret: string, except: RegExp[] = []): string[] {
  const needles = spellings(secret).map((text) => Buffer.from(text, 'latin1'));
  const holders: string[] = [];
  for (const file of walk(dir)) {
    const name = relative(dir, file);
    if (except.some((pattern) => pattern.test(name))) continue;
    const bytes = readFileSync(file);
    if (needles.some((needle) => bytes.includes(needle))) holders.push(name);
  }
  return holders;
}

// ---------------------------------------------------------------------------------------------
// Nothing left running
// ---------------------------------------------------------------------------------------------

/** Every process below `pid`: the agent hosts, Chromium and SpainBench's server when it is a child. */
export function descendants(pid: number = process.pid): { pid: number; command: string }[] {
  const table = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      return match
        ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? '' }]
        : [];
    });
  const out: { pid: number; command: string }[] = [];
  const pending = [pid];
  while (pending.length > 0) {
    const parent = pending.pop() as number;
    for (const row of table) {
      if (row.ppid !== parent) continue;
      out.push({ pid: row.pid, command: row.command });
      pending.push(row.pid);
    }
  }
  return out.filter((row) => row.command.trim() !== '' && !/^ps\b/.test(row.command));
}

/** Whether something listens on a loopback port. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The loopback ports a run used: SpainBench's two listeners and the meter proxy. */
export function portsOf(runsRoot: string, run: RunFiles): { bench: number[]; meter: number[] } {
  const logFile = findBenchLog(runsRoot, run.result.runId);
  const log = logFile ? readFileSync(logFile, 'utf8') : '';
  const bench = [...log.matchAll(/(?:public|scoring) port (\d+)/g)].map((m) => Number(m[1]));
  const meter = new Set<number>();
  for (const event of observations(run.events, 'net')) {
    if (event.record.channel === 'llm') meter.add(Number(new URL(event.record.url).port));
  }
  return { bench, meter: [...meter] };
}

/**
 * The processes below this one that are not in `known`: waits for the ones that are leaving (a
 * killed process takes a moment to be reaped), so what is returned is what stayed.
 */
export async function leftovers(known: Set<number>, waitMs = 30_000): Promise<string[]> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const left = descendants().filter((row) => !known.has(row.pid));
    if (left.length === 0 || Date.now() > deadline) return left.map((row) => row.command);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until `test` is true, polling (for a run another promise is driving). */
export async function until(test: () => boolean, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
