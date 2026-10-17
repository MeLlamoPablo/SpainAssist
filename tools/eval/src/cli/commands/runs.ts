/** `eval runs`: the run folders under the runs root, newest first. */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readRunManifest, readRunResult } from '../../run/results';
import { parseCommandArgs, positiveIntegerOption, stringOption } from '../args';
import type { CliDeps } from '../deps';
import { columns, percent, usd, utcMinute } from '../format';
import { hasFile, resolveRunsRoot } from '../paths';
import { RUNS_SPEC } from '../specs';

const DEFAULT_LIMIT = 20;

interface RunRow {
  id: string;
  fixture: string;
  provider: string;
  /** The result's status, `unfinished` (no result.json) or `unreadable`. */
  status: string;
  score: number | null;
  costUsd: number | null;
  /** ISO time the run started; undefined when run.json cannot be read. */
  startedAt: string | undefined;
  /** For ordering when `startedAt` is unknown. */
  modifiedMs: number;
}

/** The run folders under `runsRoot` (folders without a run.json, such as `_bench`, are not runs). */
export function listRuns(runsRoot: string): RunRow[] {
  let names: string[];
  try {
    names = readdirSync(runsRoot);
  } catch {
    return [];
  }
  const rows: RunRow[] = [];
  for (const name of names) {
    const dir = join(runsRoot, name);
    let modifiedMs: number;
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      modifiedMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (!hasFile(dir, 'run.json') && !hasFile(dir, 'result.json')) continue;
    const row: RunRow = {
      id: name,
      fixture: '-',
      provider: '-',
      status: 'unreadable',
      score: null,
      costUsd: null,
      startedAt: undefined,
      modifiedMs,
    };
    try {
      const run = readRunManifest(dir);
      row.fixture = run.fixture.id;
      row.provider = run.provider;
      row.startedAt = run.startedAt;
      row.status = 'unfinished';
    } catch {
      // run.json missing or invalid: the result may still say something.
    }
    if (hasFile(dir, 'result.json')) {
      try {
        const result = readRunResult(dir);
        row.fixture = result.fixtureId;
        row.provider = result.provider;
        row.status = result.status;
        row.score = result.score;
        row.costUsd = result.usage.costUsd;
      } catch {
        row.status = 'unreadable';
      }
    }
    rows.push(row);
  }
  const time = (row: RunRow) => (row.startedAt ? Date.parse(row.startedAt) : row.modifiedMs);
  return rows.sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id));
}

/** The table of `eval runs`. */
export function renderRuns(rows: readonly RunRow[], total: number, runsRoot: string): string {
  if (total === 0) return `No runs in ${runsRoot}\n`;
  const table = columns([
    ['RUN', 'FIXTURE', 'PROVIDER', 'STATUS', 'SCORE', 'COST', 'STARTED'],
    ...rows.map((row) => [
      row.id,
      row.fixture,
      row.provider,
      row.status,
      row.score === null ? '-' : percent(row.score),
      row.costUsd === null ? '-' : usd(row.costUsd),
      row.startedAt ? utcMinute(row.startedAt) : '-',
    ]),
  ]);
  const more =
    total > rows.length ? `\n${rows.length} of ${total} runs shown (more with --limit).` : '';
  return `${table.join('\n')}${more}\n`;
}

export async function runsCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(RUNS_SPEC, args, { min: 0, max: 0, names: '' });
  const limitText = stringOption(parsed, 'limit');
  const limit = limitText ? positiveIntegerOption('limit', limitText) : DEFAULT_LIMIT;
  const runsRoot = resolveRunsRoot(stringOption(parsed, 'runs-root'), deps.cwd, deps.env);
  const rows = listRuns(runsRoot);
  deps.stdout(renderRuns(rows.slice(0, limit), rows.length, runsRoot));
  return 0;
}
