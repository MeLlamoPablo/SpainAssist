/** `eval run <fixture>`: one run against SpainBench, with Ctrl-C and live progress. */
import { join } from 'node:path';
import { getFixture } from '../../fixtures';
import { parseCheckpointRef } from '../../run/checkpoint';
import { generateRunId } from '../../run/results';
import { type EvaluationRequest, findBenchLog } from '../../runner';
import { flag, parseCommandArgs, stringOption, UsageError } from '../args';
import type { CliDeps } from '../deps';
import { classifyError, EXIT_FAILED, messageOf, resultExit } from '../exit';
import { resolveFromArgument, resolveRunsRoot } from '../paths';
import { followRunProgress } from '../progress';
import { RUN_SPEC } from '../specs';
import { readSharedOptions } from './run-options';

/** Results that exit 0 without `--min-score` although they are not a pass. */
const NO_BAR_STATUSES: ReadonlySet<string> = new Set(['failed_required', 'inconclusive']);

/** The part of the request that comes from the arguments (the rest is the process' own). */
type RunRequest = Omit<
  EvaluationRequest,
  'env' | 'cwd' | 'home' | 'signal' | 'log' | 'scenario' | 'runsRoot' | 'runId'
> & { runsRoot: string; runId: string };

/** What `run`'s arguments say, checked: nothing is started to find out. */
interface RunArguments {
  request: RunRequest;
  scenarioName: string | undefined;
  minScore: number | undefined;
  json: boolean;
  runDir: string;
}

function parseRunArguments(
  args: readonly string[],
  context: { cwd: string; now: Date; env: Record<string, string | undefined> },
): RunArguments {
  const parsed = parseCommandArgs(RUN_SPEC, args, { min: 1, max: 1, names: '<fixture>' });
  const fixtureId = parsed.positionals[0] as string;
  const shared = readSharedOptions(parsed, 'run');
  const from = stringOption(parsed, 'from');
  const runsRoot = resolveRunsRoot(stringOption(parsed, 'runs-root'), context.cwd, context.env);
  const runId =
    stringOption(parsed, 'run-id') ??
    generateRunId({ fixtureId, provider: shared.provider, now: context.now });
  const checkpoint =
    from !== undefined
      ? parseCheckpointRef(resolveFromArgument(from, { cwd: context.cwd, runsRoot }))
      : undefined;

  return {
    request: {
      fixtureId,
      ...shared.request,
      ...(checkpoint ? { from: checkpoint } : {}),
      ...(flag(parsed, 'allow-fixture-change') ? { allowFixtureChange: true } : {}),
      runsRoot,
      runId,
    },
    scenarioName: shared.scenarioName,
    minScore: shared.minScore,
    json: shared.json,
    runDir: join(runsRoot, runId),
  };
}

export async function runCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const startedAt = deps.now();
  const given = parseRunArguments(args, { cwd: deps.cwd, now: startedAt, env: deps.env });
  const { request } = given;
  // A fixture that does not exist is a usage error whatever else is wrong.
  getFixture(request.fixtureId);

  let scenario: EvaluationRequest['scenario'];
  if (given.scenarioName) {
    try {
      scenario = await deps.mockScenario(request.fixtureId, given.scenarioName);
    } catch (error) {
      throw new UsageError(
        `Scenario "${given.scenarioName}" for ${request.fixtureId}: ${messageOf(error)}`,
        'run',
      );
    }
  }

  deps.stderr(
    `Run ${request.runId}: ${request.fixtureId} with ${request.provider}${
      given.scenarioName ? ` (scenario ${given.scenarioName})` : ''
    }\n`,
  );

  const controller = new AbortController();
  let interrupted = false;
  const stopListening = deps.onInterrupt((signal) => {
    if (interrupted) {
      deps.stderr('Interrupted again: exiting at once.\n');
      deps.exit(EXIT_FAILED);
    }
    interrupted = true;
    deps.stderr(
      `Interrupted (${signal}): ending the run and saving what exists (again to exit at once)...\n`,
    );
    controller.abort(new Error(`interrupted by ${signal}`));
  });
  const progress = followRunProgress({
    runDir: given.runDir,
    startedAt,
    now: deps.now,
    write: deps.stderr,
  });

  try {
    const outcome = await deps.runEvaluation({
      ...request,
      ...(scenario ? { scenario } : {}),
      env: deps.env,
      cwd: deps.cwd,
      signal: controller.signal,
      handlesSignals: true,
      chromiumPath: deps.chromiumPath,
      log: (line) => deps.stderr(`${line}\n`),
    });
    await progress.stop().catch(() => undefined);

    if (given.json) {
      deps.stdout(`${JSON.stringify(outcome.result, null, 2)}\n`);
      deps.stderr(`${outcome.summary}\nreport: ${outcome.reportFile}\n`);
    } else {
      deps.stdout(`${outcome.summary}\nreport: ${outcome.reportFile}\n`);
    }
    const verdict = resultExit(outcome.result, given.minScore);
    if (verdict.reason) deps.stderr(`${verdict.reason}\n`);
    else if (given.minScore === undefined && NO_BAR_STATUSES.has(outcome.result.status)) {
      // Exit 0 is for "the run produced a result": a CI step that must fail on this needs the bar.
      deps.stderr(
        `The run is ${outcome.result.status}, and the exit code is 0 anyway: pass --min-score <0..1> to make a score below the bar (or none) fail.\n`,
      );
    }
    return interrupted ? EXIT_FAILED : verdict.code;
  } catch (error) {
    await progress.stop().catch(() => undefined);
    const failure = classifyError(error, deps.env.SA_EVAL_DEBUG === '1');
    deps.stderr(`error: ${failure.message}\n`);
    const benchLog = findBenchLog(request.runsRoot, request.runId);
    if (benchLog) deps.stderr(`SpainBench server log: ${benchLog}\n`);
    return interrupted ? EXIT_FAILED : failure.code;
  } finally {
    stopListening();
  }
}
