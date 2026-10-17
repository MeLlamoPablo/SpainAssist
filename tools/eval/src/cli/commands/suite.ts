/**
 * `eval suite [fixture...]`: the full run (`FIXTURE_IDS`: fixtures 1 and 2, and fixture 3 once per
 * injection variant) or the fixtures named, one after the other, with the options of `run`; one
 * summary line per run, then the table and the mean. It writes nothing beyond the runs' folders.
 */
import { join } from 'node:path';
import type { RunResult } from '../../contracts';
import { FIXTURE_IDS, getFixture } from '../../fixtures';
import { generateRunId, renderSummaryTable } from '../../run/results';
import { type EvaluationRequest, findBenchLog } from '../../runner';
import { parseCommandArgs, stringOption, UsageError } from '../args';
import type { CliDeps } from '../deps';
import { classifyError, EXIT_FAILED, messageOf, suiteExit } from '../exit';
import { resolveRunsRoot } from '../paths';
import { followRunProgress } from '../progress';
import { SUITE_SPEC } from '../specs';
import { readSharedOptions } from './run-options';

export async function suiteCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseCommandArgs(SUITE_SPEC, args, {
    min: 0,
    max: Number.POSITIVE_INFINITY,
    names: '[fixture...]',
  });
  const fixtureIds = parsed.positionals.length > 0 ? parsed.positionals : [...FIXTURE_IDS];
  // A fixture that does not exist is a usage error whatever else is wrong, before anything starts.
  for (const id of fixtureIds) getFixture(id);
  const shared = readSharedOptions(parsed, 'suite');
  const runsRoot = resolveRunsRoot(stringOption(parsed, 'runs-root'), deps.cwd, deps.env);

  const scenarios = new Map<string, EvaluationRequest['scenario']>();
  if (shared.scenarioName !== undefined) {
    for (const id of fixtureIds) {
      try {
        scenarios.set(id, await deps.mockScenario(id, shared.scenarioName));
      } catch (error) {
        throw new UsageError(
          `Scenario "${shared.scenarioName}" for ${id}: ${messageOf(error)}`,
          'suite',
        );
      }
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const stopListening = deps.onInterrupt((signal) => {
    if (interrupted) {
      deps.stderr('Interrupted again: exiting at once.\n');
      deps.exit(EXIT_FAILED);
    }
    interrupted = true;
    deps.stderr(
      `Interrupted (${signal}): ending the run in progress and saving what exists; the rest are skipped (again to exit at once)...\n`,
    );
    controller.abort(new Error(`interrupted by ${signal}`));
  });

  const results: RunResult[] = [];
  let thrown: { code: number } | undefined;
  try {
    for (const fixtureId of fixtureIds) {
      if (interrupted) break;
      const startedAt = deps.now();
      const runId = generateRunId({ fixtureId, provider: shared.provider, now: startedAt });
      deps.stderr(
        `Run ${runId}: ${fixtureId} with ${shared.provider}${
          shared.scenarioName !== undefined ? ` (scenario ${shared.scenarioName})` : ''
        } [${results.length + 1} of ${fixtureIds.length}]\n`,
      );
      const progress = followRunProgress({
        runDir: join(runsRoot, runId),
        startedAt,
        now: deps.now,
        write: deps.stderr,
      });
      try {
        const scenario = scenarios.get(fixtureId);
        const outcome = await deps.runEvaluation({
          ...shared.request,
          fixtureId,
          runsRoot,
          runId,
          ...(scenario ? { scenario } : {}),
          env: deps.env,
          cwd: deps.cwd,
          signal: controller.signal,
          handlesSignals: true,
          chromiumPath: deps.chromiumPath,
          log: (line) => deps.stderr(`${line}\n`),
        });
        await progress.stop().catch(() => undefined);
        results.push(outcome.result);
        (shared.json ? deps.stderr : deps.stdout)(`${outcome.summary}\n`);
      } catch (error) {
        // A run that cannot even start (no SpainBench, no credential...) says so for the whole suite.
        await progress.stop().catch(() => undefined);
        const failure = classifyError(error, deps.env.SA_EVAL_DEBUG === '1');
        deps.stderr(`error: ${failure.message}\n`);
        const benchLog = findBenchLog(runsRoot, runId);
        if (benchLog) deps.stderr(`SpainBench server log: ${benchLog}\n`);
        thrown = { code: failure.code };
        break;
      }
    }
  } finally {
    stopListening();
  }

  if (results.length > 0) {
    const table = renderSummaryTable(results);
    if (shared.json) {
      deps.stdout(`${JSON.stringify(results, null, 2)}\n`);
      deps.stderr(`\n${table}`);
    } else {
      deps.stdout(`\n${table}`);
    }
  }
  const verdict = suiteExit(results, shared.minScore);
  for (const reason of verdict.reasons) deps.stderr(`${reason}\n`);
  if (verdict.reasons.length === 0 && shared.minScore === undefined) {
    const notPasses = results.filter(
      (result) => result.status === 'failed_required' || result.status === 'inconclusive',
    );
    if (notPasses.length > 0) {
      deps.stderr(
        `${notPasses.map((r) => `${r.fixtureId} (${r.status})`).join(', ')}: the exit code is 0 anyway: pass --min-score <0..1> to make a mean below the bar (or a run without a score) fail.\n`,
      );
    }
  }
  if (thrown) return thrown.code;
  if (interrupted) return EXIT_FAILED;
  return verdict.code;
}
