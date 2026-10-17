/**
 * Exit codes of `eval` and what maps to them:
 *
 * - 0: it worked; for `run`, the run produced a result (completed, failed_required, inconclusive);
 * - 1: an error; for `run`, a run that ended in error or was aborted (Ctrl-C, or the harness ran
 *   out of budget or of recorded model calls: no score), or one below `--min-score`;
 * - 2: a usage error, or the command refused to start: something the user can fix first.
 */
import type { RunResult } from '../contracts';
import { meanScore } from '../scoring';
import { UsageError } from './args';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

/** Why a command that threw ends as it does: the line for stderr and the exit code. */
interface Failure {
  code: typeof EXIT_FAILED | typeof EXIT_USAGE;
  message: string;
}

/**
 * The errors that mean "nothing was started because something the user can fix is wrong", by
 * `name` (every error class of the suite sets it): the refusals of `runEvaluation`, an unknown
 * fixture, SpainBench settings and servers that cannot be used, a missing or unsafe credential,
 * Codex without consent or a login, an unusable checkpoint.
 */
const REFUSALS = new Set([
  'EvaluationRefused',
  'UnknownFixtureError',
  'BenchTargetError',
  'BenchLaunchError',
  'BenchVersionError',
  'BenchError',
  'EvalHomeError',
  'CodexConsentError',
  'CodexAuthError',
  'CheckpointError',
]);

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps what a command threw to its exit code and message. */
export function classifyError(error: unknown, debug = false): Failure {
  if (error instanceof UsageError) return { code: EXIT_USAGE, message: error.message };
  const name = error instanceof Error ? error.name : '';
  if (REFUSALS.has(name)) return { code: EXIT_USAGE, message: messageOf(error) };
  const stack = debug && error instanceof Error && error.stack ? `\n${error.stack}` : '';
  return {
    code: EXIT_FAILED,
    message: `${messageOf(error)}${stack || '\n(set SA_EVAL_DEBUG=1 for the stack)'}`,
  };
}

/** `run`'s exit code from the result: 0 for a result with a verdict, 1 for none or below the bar. */
export function resultExit(
  result: Pick<RunResult, 'status' | 'score'> &
    Partial<Pick<RunResult, 'endedBy' | 'unsettledNegated'>>,
  minScore?: number,
): { code: number; reason?: string } {
  if (result.status === 'error' || result.status === 'aborted') {
    return { code: EXIT_FAILED, reason: `the run ended ${result.status}: it has no score` };
  }
  if (minScore !== undefined) {
    if (result.score === null) {
      return {
        code: EXIT_FAILED,
        reason: `the run is ${result.status} and has no score, so --min-score ${minScore} is not met`,
      };
    }
    if (result.score < minScore) {
      return {
        code: EXIT_FAILED,
        reason: `score ${result.score} is below --min-score ${minScore}`,
      };
    }
    if (result.unsettledNegated?.length) {
      return {
        code: EXIT_FAILED,
        reason: `the run was cut short (${result.endedBy}) before ${result.unsettledNegated.join(', ')} could be judged to the end, so --min-score ${minScore} is not met`,
      };
    }
  }
  return { code: EXIT_OK };
}

/**
 * `suite`'s exit code from the results of its runs: 1 when any run errored or was aborted, and,
 * with `--min-score`, when the mean of the scored runs is below the bar, a run has no score
 * (it cannot show the bar was met) or was cut short before its negated rules could be judged.
 */
export function suiteExit(
  results: readonly RunResult[],
  minScore?: number,
): { code: number; reasons: string[] } {
  const reasons: string[] = [];
  for (const result of results) {
    if (result.status === 'error' || result.status === 'aborted') {
      reasons.push(`${result.fixtureId} ended ${result.status}: it has no score`);
    } else if (minScore !== undefined) {
      if (result.score === null) {
        reasons.push(
          `${result.fixtureId} is ${result.status} and has no score, so --min-score ${minScore} is not met`,
        );
      } else if (result.unsettledNegated?.length) {
        reasons.push(
          `${result.fixtureId} was cut short (${result.endedBy}) before ${result.unsettledNegated.join(', ')} could be judged to the end, so --min-score ${minScore} is not met`,
        );
      }
    }
  }
  const mean = meanScore(results);
  if (minScore !== undefined && mean !== undefined && mean < minScore) {
    reasons.push(`the mean score ${Math.round(mean * 1e6) / 1e6} is below --min-score ${minScore}`);
  }
  return { code: reasons.length > 0 ? EXIT_FAILED : EXIT_OK, reasons };
}
