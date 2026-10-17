/** `eval report <runDir|runId>`: what a finished run says about itself. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFixture } from '../../fixtures';
import { readRunManifest, readRunResult, reportRun, runPaths } from '../../run/results';
import { flag, parseCommandArgs, stringOption, UsageError } from '../args';
import type { CliDeps } from '../deps';
import { EXIT_FAILED, EXIT_OK, messageOf } from '../exit';
import { utcMinute } from '../format';
import { hasFile, isDirectory, resolveRunDir, resolveRunsRoot } from '../paths';
import { REPORT_SPEC } from '../specs';

/** The `## <title>` sections of a Markdown report, with their headings. */
export function extractSections(markdown: string, titles: readonly string[]): string {
  const out: string[] = [];
  let keep = false;
  for (const line of markdown.split('\n')) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) keep = titles.includes(heading[1] as string);
    if (keep) out.push(line);
  }
  return out.join('\n').trimEnd();
}

/** What an unfinished run's folder holds, for the message that says it has no result. */
function describeContents(dir: string): string {
  const names = readdirSync(dir).sort();
  return names.length > 0 ? names.join(', ') : 'nothing';
}

export async function reportCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(REPORT_SPEC, args, {
    min: 1,
    max: 1,
    names: '<runDir|runId>',
  });
  const json = flag(parsed, 'json');
  const rules = flag(parsed, 'rules');
  if (json && rules) throw new UsageError('Use --json or --rules, not both.', 'report');

  const argument = parsed.positionals[0] as string;
  const runsRoot = resolveRunsRoot(stringOption(parsed, 'runs-root'), deps.cwd, deps.env);
  const dir = resolveRunDir(argument, { cwd: deps.cwd, runsRoot });
  if (!isDirectory(dir)) {
    throw new UsageError(
      `No run folder at ${dir}. Pass a run folder or a run id (the ids are listed by "eval runs", under ${runsRoot}).`,
      'report',
    );
  }
  const paths = runPaths(dir);
  const hasRunJson = hasFile(dir, 'run.json');
  const hasResult = hasFile(dir, 'result.json');
  if (!hasRunJson && !hasResult) {
    throw new UsageError(
      `${dir} is not a run folder: it has neither run.json nor result.json (it holds: ${describeContents(dir)}). A run folder is what "eval run" creates.`,
      'report',
    );
  }
  if (!hasResult) {
    let what = '';
    try {
      const run = readRunManifest(dir);
      what = ` (${run.fixture.id}, ${run.provider}, started ${utcMinute(run.startedAt)})`;
    } catch {
      // run.json unreadable: the folder listing below still helps.
    }
    deps.stderr(
      `error: the run in ${dir}${what} did not finish: result.json is missing, so there is nothing to report. The folder holds: ${describeContents(dir)}.\n`,
    );
    return EXIT_FAILED;
  }

  let result: ReturnType<typeof readRunResult>;
  try {
    result = readRunResult(dir);
  } catch (error) {
    deps.stderr(`error: ${messageOf(error)}\n`);
    return EXIT_FAILED;
  }
  if (json) {
    deps.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT_OK;
  }

  let markdown: string;
  if (hasFile(dir, 'report.md')) {
    markdown = readFileSync(paths.report, 'utf8');
  } else {
    deps.stderr('report.md is missing: rendered again from result.json and events.jsonl.\n');
    markdown = reportRun(dir, { findFixture, write: false });
  }
  if (rules) {
    const tables = extractSections(markdown, ['Rules', 'Preconditions']);
    if (!tables) {
      deps.stderr(`error: ${join(dir, 'report.md')} has no rule table.\n`);
      return EXIT_FAILED;
    }
    deps.stdout(`${tables}\n`);
    return EXIT_OK;
  }
  deps.stdout(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  return EXIT_OK;
}
