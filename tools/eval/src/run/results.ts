import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type {
  BenchWrongTurn,
  CacheMode,
  EvalModelChoice,
  EvalProvider,
  Fixture,
  Observation,
  RunLimits,
  RunResult,
} from '../contracts';
import { fixtureSecrets } from '../fixtures';
import { ensurePrivateDir, evalHome, writeFileAtomic } from '../llm/home';
import { SecretMasker } from '../llm/redact';
import { meanScore, renderReport, replayLine } from '../scoring';

/**
 * Files of one run (`<runs root>/<runId>/`, layout in docs/EVAL.md): the run's own writers,
 * the run id, the report command and the summaries the CLI prints. Everything written here goes
 * through the run's secret mask, and folders are 0700 and files 0600.
 */

export const RUN_FORMAT = 'sa-eval-run/1';

/** The id of a run is a path segment and a ledger key (SpainBench's world has an id of its own). */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where runs live unless told otherwise (`--runs-root`): `runs` in the eval suite's data folder
 * (`evalHome`: `spainbench` in the OS's folder for an app's own data, outside any checkout).
 */
export function defaultRunsRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  return join(evalHome(env, platform, home), 'runs');
}

export function isValidRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function assertValidRunId(id: string): void {
  if (!isValidRunId(id)) {
    throw new Error(
      `Invalid run id "${id}": use 1 to 64 letters, digits, "-" or "_" (it names the run's folder)`,
    );
  }
}

function stamp(date: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

/**
 * `<fixtureId>-<provider>-<yyyymmdd-hhmmss>-<4 hex>` (UTC). Characters outside the run id's
 * alphabet in the fixture id (the `:` of `vida-laboral-inyeccion:page-title`) become `-`, and the
 * fixture part is cut so the whole id fits 64 characters.
 */
export function generateRunId(input: {
  fixtureId: string;
  provider: EvalProvider;
  now: Date;
  /** Four hex characters; random by default. */
  suffix?: string;
}): string {
  const suffix = input.suffix ?? randomBytes(2).toString('hex');
  if (!/^[0-9a-f]{4}$/.test(suffix))
    throw new Error(`Run id suffix must be 4 hex digits: ${suffix}`);
  const tail = `-${input.provider}-${stamp(input.now)}-${suffix}`;
  const slug = input.fixtureId
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64 - tail.length)
    .replace(/-+$/g, '');
  const id = `${slug || 'run'}${tail}`;
  assertValidRunId(id);
  return id;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

export interface RunPaths {
  dir: string;
  runJson: string;
  events: string;
  result: string;
  report: string;
  /** `saveBenchArtifacts` writes state, request log, downloads and the snapshot here. */
  bench: string;
  /** The follower's raw copy of SpainBench's event stream. */
  benchEvents: string;
  llm: string;
  /** This run's lines of the meter's ledger. */
  meterLedger: string;
  checkpoints: string;
  /** A resumed run's private copy of the checkpoint's profile and browser state. */
  restore: string;
}

export function runPaths(dir: string): RunPaths {
  return {
    dir,
    runJson: join(dir, 'run.json'),
    events: join(dir, 'events.jsonl'),
    result: join(dir, 'result.json'),
    report: join(dir, 'report.md'),
    bench: join(dir, 'bench'),
    benchEvents: join(dir, 'bench', 'events.jsonl'),
    llm: join(dir, 'llm'),
    meterLedger: join(dir, 'llm', 'meter.jsonl'),
    checkpoints: join(dir, 'checkpoints'),
    restore: join(dir, 'restore'),
  };
}

/** Creates `<runsRoot>/<runId>` (0700). A run id is used once: an existing folder is an error. */
export function createRunDirectory(runsRoot: string, runId: string): RunPaths {
  assertValidRunId(runId);
  const dir = resolve(runsRoot, runId);
  if (existsSync(dir)) throw new Error(`The run directory already exists: ${dir}`);
  ensurePrivateDir(dir);
  for (const sub of ['llm', 'bench']) ensurePrivateDir(join(dir, sub));
  return runPaths(dir);
}

// ---------------------------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------------------------

export interface RunManifest {
  format: typeof RUN_FORMAT;
  runId: string;
  /** SpainBench's world of this run: an opaque id, not the run id (the agent can read it). */
  worldId?: string;
  /** Resumed runs: the world ids that are in the restored conversation (the source run's, and its own). */
  inheritedWorldIds?: string[];
  /** `hash`: all of the fixture; `frozenHash`: what a checkpoint freezes (see `frozenHash`). */
  fixture: { id: string; title: string; hash: string; frozenHash: string };
  provider: EvalProvider;
  models: EvalModelChoice;
  cache: CacheMode;
  /** The limits the run enforced (the fixture's, with the caller's overrides). */
  limits: RunLimits;
  options: {
    captureBrowser: boolean;
    settleTimeoutMs: number;
    evaluateIntervalMs: number;
    checkpoint: boolean;
    keepWorld: boolean;
  };
  /** `describeBench()` of the bench part: SpainBench's version, sites and features. */
  bench?: Record<string, unknown>;
  node: string;
  platform: string;
  startedAt: string;
  /** Set when the run continues a checkpoint of another run. */
  resume?: { runDir: string; runId: string; checkpoint: number; atSeq: number };
}

const ProviderSchema = z.enum(['voucher', 'codex', 'mock']);
const LimitsSchema = z.object({
  wallClockMs: z.number(),
  maxToolCalls: z.number(),
  maxRequests: z.number(),
  maxCostUsd: z.number(),
  maxPrompts: z.number(),
});

const RunManifestSchema = z.looseObject({
  format: z.literal(RUN_FORMAT),
  runId: z.string(),
  worldId: z.string().optional(),
  inheritedWorldIds: z.array(z.string()).optional(),
  fixture: z.object({
    id: z.string(),
    title: z.string(),
    hash: z.string(),
    frozenHash: z.string(),
  }),
  provider: ProviderSchema,
  models: z.looseObject({ answererModel: z.string(), answererThinking: z.string() }),
  cache: z.enum(['off', 'record', 'replay', 'auto']),
  limits: LimitsSchema,
  options: z.looseObject({
    captureBrowser: z.boolean(),
    settleTimeoutMs: z.number(),
    evaluateIntervalMs: z.number(),
    checkpoint: z.boolean(),
    keepWorld: z.boolean(),
  }),
  bench: z.record(z.string(), z.unknown()).optional(),
  node: z.string(),
  platform: z.string(),
  startedAt: z.string(),
  resume: z
    .object({
      runDir: z.string(),
      runId: z.string(),
      checkpoint: z.number().int(),
      atSeq: z.number().int(),
    })
    .optional(),
});

function digest(value: unknown, secrets?: SecretMasker): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    const text =
      item instanceof RegExp
        ? `regexp:${item.toString()}`
        : typeof item === 'function'
          ? `function:${item.toString()}`
          : item;
    return secrets && typeof text === 'string' ? secrets.mask(text) : text;
  });
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/**
 * A short, stable fingerprint of a fixture (rules, answers, world, limits), never its secrets: the
 * hash is computed over the fixture with its passwords masked, because a hash of the passwords
 * themselves would let anyone holding `run.json` test guesses offline.
 */
export function fixtureHash(fixture: Fixture): string {
  const secrets = new SecretMasker('[secret]');
  for (const secret of fixtureSecrets(fixture)) secrets.add(secret);
  return digest(fixture, secrets);
}

/**
 * A fingerprint of what a checkpoint freezes and a resumed run cannot change: the SpainBench world
 * (sites, seed, date, presets and the injection variant: a restored world keeps the plants it was
 * made with) and the profile's seed (the restored profile is a copy, it is not seeded again).
 */
export function frozenHash(fixture: Pick<Fixture, 'world' | 'seed'>): string {
  return digest({ world: fixture.world, seed: fixture.seed ?? null });
}

type Scrub = (text: string) => string;

function writeText(path: string, text: string, scrub: Scrub): void {
  writeFileAtomic(path, scrub(text));
}

export function writeRunManifest(paths: RunPaths, manifest: RunManifest, scrub: Scrub): void {
  writeText(paths.runJson, `${JSON.stringify(manifest, null, 2)}\n`, scrub);
}

export function readRunManifest(dir: string): RunManifest {
  const file = runPaths(dir).runJson;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${dir} is not a run directory: no run.json`);
  }
  const parsed = RunManifestSchema.safeParse(parseJson(text, file));
  if (!parsed.success) throw new Error(`${file} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data as RunManifest;
}

// ---------------------------------------------------------------------------------------------
// result.json and report.md
// ---------------------------------------------------------------------------------------------

const RuleOutcomeSchema = z.object({
  ruleId: z.string(),
  kind: z.enum(['required', 'scored']),
  negate: z.boolean(),
  matched: z.boolean(),
  passed: z.boolean(),
  firstSeenAtSeq: z.number().int().optional(),
  detail: z.string().optional(),
});

const MeterUsageSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  costUsd: z.number(),
  cacheHits: z.number(),
  looseHits: z.number().optional(),
});

const RunResultSchema = z.object({
  runId: z.string(),
  fixtureId: z.string(),
  provider: ProviderSchema,
  status: z.enum(['completed', 'failed_required', 'inconclusive', 'aborted', 'error']),
  score: z.number().nullable(),
  scoreBeforePenalty: z.number().nullable(),
  wrongTurns: z.number().int(),
  rules: z.array(RuleOutcomeSchema),
  preconditions: z.array(RuleOutcomeSchema).optional(),
  usage: MeterUsageSchema,
  durationMs: z.number(),
  endedBy: z.string(),
  notes: z.array(z.string()),
  unsettledNegated: z.array(z.string()).optional(),
}) satisfies z.ZodType<RunResult>;

export function writeResult(paths: RunPaths, result: RunResult, scrub: Scrub): void {
  writeText(paths.result, `${JSON.stringify(result, null, 2)}\n`, scrub);
}

export function writeReport(paths: RunPaths, markdown: string, scrub: Scrub): void {
  writeText(paths.report, markdown, scrub);
}

export function readRunResult(dir: string): RunResult {
  const file = runPaths(dir).result;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${dir} has no result.json (the run did not finish)`);
  }
  const parsed = RunResultSchema.safeParse(parseJson(text, file));
  if (!parsed.success) throw new Error(`${file} is invalid: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

export function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${where} is not valid JSON`);
  }
}

export function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

// ---------------------------------------------------------------------------------------------
// events.jsonl
// ---------------------------------------------------------------------------------------------

const ObservationLine = z.looseObject({
  seq: z.number().int().positive(),
  t: z.string(),
  type: z.string(),
});

export interface EventLines {
  /** The lines as written (already scrubbed), in order. */
  lines: string[];
  observations: Observation[];
}

/**
 * Reads `events.jsonl`, optionally only up to `atSeq`. A torn last line (a run killed while
 * writing) is ignored; any other malformed line is an error, since the log is the run's record.
 */
export function readEvents(file: string, atSeq?: number): EventLines {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${file}`);
  }
  const raw = text.split('\n');
  const out: EventLines = { lines: [], observations: [] };
  let previous = 0;
  raw.forEach((line, index) => {
    if (!line.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      if (index >= raw.length - 2) return; // torn last line
      throw new Error(`${file}:${index + 1} is not valid JSON`);
    }
    const parsed = ObservationLine.safeParse(json);
    if (!parsed.success) throw new Error(`${file}:${index + 1} is not an observation`);
    if (parsed.data.seq <= previous) {
      throw new Error(`${file}:${index + 1} breaks the numbering (seq ${parsed.data.seq})`);
    }
    previous = parsed.data.seq;
    if (atSeq !== undefined && parsed.data.seq > atSeq) return;
    out.lines.push(line);
    out.observations.push(parsed.data as unknown as Observation);
  });
  return out;
}

/** Appends already-scrubbed lines to a new events file (a resumed run's prefix). */
export function writeEventLines(file: string, lines: readonly string[]): void {
  ensurePrivateDir(resolve(file, '..'));
  writeFileAtomic(file, lines.map((line) => `${line}\n`).join(''));
}

// ---------------------------------------------------------------------------------------------
// The meter's ledger lines of this run
// ---------------------------------------------------------------------------------------------

/**
 * Copies the ledger lines of `runId` (any month file of the ledger directory) into `target`.
 * Returns how many were copied. A torn last line of a file other processes still write to is
 * skipped.
 */
export function copyLedgerLines(ledgerDir: string, runId: string, target: string): number {
  let names: string[];
  try {
    names = readdirSync(ledgerDir)
      .filter((name) => /^spend-\d{4}-\d{2}\.jsonl$/.test(name))
      .sort();
  } catch {
    names = [];
  }
  const lines: string[] = [];
  for (const name of names) {
    const file = join(ledgerDir, name);
    if (!statSync(file).isFile()) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { runId?: unknown };
        if (record.runId === runId) lines.push(line);
      } catch {
        // A torn line: another process is still appending.
      }
    }
  }
  writeFileAtomic(target, lines.map((line) => `${line}\n`).join(''));
  return lines.length;
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

/** What happened in a run, counted from its observations. Deterministic for a given input. */
export function renderActivity(observations: readonly Observation[]): string {
  const toolCalls = new Map<string, number>();
  const byAgent = { assistant: 0, procedure: 0 };
  const answers = { structured: 0, answerer: 0, default: 0 };
  const net = new Map<string, number>();
  const bench = new Map<string, number>();
  let shown = 0;
  let answered = 0;
  let netTotal = 0;
  for (const observation of observations) {
    switch (observation.type) {
      case 'tool_start':
        byAgent[observation.agent]++;
        toolCalls.set(observation.tool, (toolCalls.get(observation.tool) ?? 0) + 1);
        break;
      case 'prompt_shown':
        shown++;
        break;
      case 'prompt_answered':
        answered++;
        answers[observation.by]++;
        break;
      case 'net':
        netTotal++;
        net.set(observation.record.route, (net.get(observation.record.route) ?? 0) + 1);
        break;
      case 'bench':
        bench.set(observation.what, (bench.get(observation.what) ?? 0) + 1);
        break;
      default:
        break;
    }
  }
  const sorted = (map: Map<string, number>, limit = Number.POSITIVE_INFINITY) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([name, count]) => `${name} x${count}`)
      .join(', ');
  const total = byAgent.assistant + byAgent.procedure;
  const lines = [
    '## Activity',
    '',
    `- Observations: ${observations.length}`,
    `- Tool calls: ${total} (assistant ${byAgent.assistant}, procedure ${byAgent.procedure})${
      total > 0 ? `; most used: ${sorted(toolCalls, 5)}` : ''
    }`,
    `- Prompts: ${shown} shown, ${answered} answered (scripted ${answers.structured}, answerer ${answers.answerer}, default ${answers.default})`,
    `- Network: ${netTotal} request(s)${netTotal > 0 ? ` (${sorted(net)})` : ''}`,
  ];
  if (bench.size > 0) lines.push(`- SpainBench events: ${sorted(bench)}`);
  return lines.join('\n');
}

export interface RunReportInput {
  result: RunResult;
  fixture?: Pick<Fixture, 'title' | 'rules' | 'preconditions' | 'scoring'>;
  wrongTurnItems?: readonly BenchWrongTurn[];
  observations?: readonly Observation[];
}

/** `report.md`: the scoring report plus, when the observations are at hand, the activity. */
export function renderRunReport(input: RunReportInput): string {
  const base = renderReport(input.result, {
    ...(input.fixture ? { fixture: input.fixture } : {}),
    ...(input.wrongTurnItems ? { wrongTurnItems: input.wrongTurnItems } : {}),
  });
  if (!input.observations) return base;
  return `${base}\n${renderActivity(input.observations)}\n`;
}

/** The wrong turns of a run directory: SpainBench's final state, else the logged events. */
function readWrongTurns(dir: string): BenchWrongTurn[] {
  const paths = runPaths(dir);
  const state = join(paths.bench, 'state.json');
  if (existsSync(state)) {
    try {
      const json = JSON.parse(readFileSync(state, 'utf8')) as {
        wrongTurns?: { items?: BenchWrongTurn[] };
      };
      if (Array.isArray(json.wrongTurns?.items)) return json.wrongTurns.items;
    } catch {
      // Fall back to the event log.
    }
  }
  if (!existsSync(paths.events)) return [];
  return readEvents(paths.events)
    .observations.filter(
      (o): o is Extract<Observation, { type: 'bench' }> =>
        o.type === 'bench' && o.what === 'wrong_turn',
    )
    .map((o) => o.data as BenchWrongTurn);
}

/**
 * `eval report <runDir>`: renders `report.md` again from `result.json` and `events.jsonl`, with
 * no service running. `findFixture` supplies the rule descriptions; a fixture the registry no
 * longer knows is reported without them. Returns the Markdown and writes it to `report.md`
 * unless `write` is false.
 */
export function reportRun(
  dir: string,
  options: {
    findFixture?: (id: string) => Fixture | undefined;
    write?: boolean;
    scrub?: Scrub;
  } = {},
): string {
  const resolved = resolve(dir);
  const result = readRunResult(resolved);
  const paths = runPaths(resolved);
  const fixture = options.findFixture?.(result.fixtureId);
  const observations = existsSync(paths.events) ? readEvents(paths.events).observations : undefined;
  const markdown = renderRunReport({
    result,
    ...(fixture ? { fixture } : {}),
    wrongTurnItems: readWrongTurns(resolved),
    ...(observations ? { observations } : {}),
  });
  if (options.write !== false) writeReport(paths, markdown, options.scrub ?? ((text) => text));
  return markdown;
}

// ---------------------------------------------------------------------------------------------
// Summaries for the terminal
// ---------------------------------------------------------------------------------------------

function percent(score: number): string {
  return `${(Math.round(score * 1000) / 10).toFixed(1)}%`;
}

function seconds(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/**
 * What a run cost, for a person: dollars for a voucher key; a scripted model charges nothing, and a
 * ChatGPT plan is metered by requests.
 */
function costLabel(result: RunResult): string {
  const dollars = `$${result.usage.costUsd.toFixed(4)}`;
  if (result.provider === 'mock') return `${dollars} (mock, not charged)`;
  if (result.provider === 'codex') return `${result.usage.requests} requests (ChatGPT plan)`;
  return dollars;
}

/** One line: status, score, fixture, provider, time, cost, why it ended, where it is. */
export function summarizeResult(result: RunResult, runDir?: string): string {
  const score = result.score === null ? 'no score' : percent(result.score);
  const failed = result.rules.filter((rule) => !rule.passed && rule.kind === 'required');
  const replayed = replayLine(result.usage);
  const parts = [
    `${result.status} (${score})`,
    `${result.fixtureId} [${result.provider}]`,
    seconds(result.durationMs),
    costLabel(result),
    ...(replayed ? [replayed] : []),
    `ended by ${result.endedBy}`,
  ];
  if (failed.length > 0) parts.push(`failed: ${failed.map((rule) => rule.ruleId).join(', ')}`);
  if (result.unsettledNegated?.length) {
    parts.push(`cut short: ${result.unsettledNegated.join(', ')} not tested to the end`);
  }
  if (runDir) parts.push(runDir);
  return parts.join(' | ');
}

/** A Markdown table of several runs (`eval suite` prints it after the runs). */
export function renderSummaryTable(results: readonly RunResult[]): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|');
  const lines = [
    '| Fixture | Provider | Status | Score | Wrong turns | Ended by | Cost | Duration | Run |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const result of results) {
    lines.push(
      `| ${cell(result.fixtureId)} | ${result.provider} | ${result.status}${
        result.unsettledNegated?.length ? ' (cut short)' : ''
      } | ${
        result.score === null ? '-' : percent(result.score)
      } | ${result.wrongTurns} | ${cell(result.endedBy)} | ${costLabel(result)} | ${seconds(
        result.durationMs,
      )} | \`${result.runId}\` |`,
    );
  }
  const scored = results.filter((result) => result.score !== null);
  const mean = meanScore(results);
  if (mean !== undefined) {
    const cost = results.reduce((sum, result) => sum + result.usage.costUsd, 0);
    lines.push(
      '',
      `${scored.length} of ${results.length} run(s) scored, mean ${percent(mean)}; total cost $${cost.toFixed(4)}.`,
    );
  } else {
    lines.push('', `${results.length} run(s), none scored.`);
  }
  return `${lines.join('\n')}\n`;
}
