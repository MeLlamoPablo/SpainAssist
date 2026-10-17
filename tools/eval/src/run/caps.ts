import { RUN_LIMITS } from '../fixtures/vida-laboral';
import type { MeterLimitsInput } from '../llm';

/**
 * The caps a run really gets, in one place: what `runEvaluation` hands the meter and what
 * `eval budget` shows (the meter's own defaults in `src/llm/limits.ts` are what is left over).
 *
 * Two kinds, told apart by whose doing they are (`src/run/infra.ts`):
 * - the AGENT's limits: the fixture's `RunLimits` and the meter's per-run and per-agent request and
 *   dollar caps. The fixtures' are lower than the meter's, so they fire first; the ending is
 *   `limit:requests`, `limit:cost` or `limit:tool-calls` and the rules judge what happened;
 * - the HARNESS's budget: the key's balance, the daily and lifetime caps, the kill switch and the
 *   gateway's limits. A run stopped by one ends as `limit:budget`: no score.
 */

/** The meter caps of a voucher run of the shipped fixtures that differ from the meter's defaults. */
export function shippedMeterLimits(): MeterLimitsInput {
  return { perRunUsd: RUN_LIMITS.maxCostUsd };
}

/** The text `eval budget` adds under the meter's caps: what stops a run, and who is blamed. */
export function describeRunLimits(): string {
  const l = RUN_LIMITS;
  return [
    "Limits of a run (the agent's doing: the rules judge what happened)",
    `  ${l.maxRequests} model requests and $${l.maxCostUsd.toFixed(2)} per run, ${l.maxToolCalls} tool calls, ${l.maxPrompts} prompts, ${l.wallClockMs / 60_000} minutes; ` +
      '--max-requests, --max-cost, --max-tool-calls and --wall-clock change them for one run',
    '  the per-run and per-agent caps above count the same way: a run that reaches one ends as',
    '  limit:requests or limit:cost and is scored by its rules, so a looping agent fails its required rules',
    "Budget of the harness (not the agent's doing: no score)",
    "  the key's balance, the daily and lifetime caps, the kill switch and the gateway or plan limits end",
    '  a run as limit:budget (status aborted); the model gateway failing or a host crashing is an error, also unscored',
  ].join('\n');
}
