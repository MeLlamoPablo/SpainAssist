import type { EvalProvider, MeterUsage } from '../contracts';
import { type TokenCounts, uncachedInputTokens } from './cost';

/**
 * Running totals of the meter, per run and per agent. `MeterUsage` (contracts.ts) is the shape the
 * run result and the checkpoints carry:
 *
 * - `inputTokens` is the uncached input (pi's `usage.input`): the whole prompt is
 *   `inputTokens + cachedInputTokens + cacheWriteTokens`;
 * - `outputTokens` includes `reasoningTokens`;
 * - `requests` and the token counts cover everything the agents used, requests served from the
 *   cache included (the workload of the run), while `costUsd` is real spend only: cache hits are
 *   free, Codex runs are metered in requests (the plan has no price per call), and `mock` runs
 *   carry the mock's simulated cost so the cost limits can be exercised;
 * - `cacheHits` are the requests answered from a recording and `looseHits` those of them that
 *   were not an exact replay (the recorded conversation's pages or screenshots differed), so the
 *   share of a verdict that comes from recorded model output, and how closely, is always known.
 */

export const EMPTY_USAGE: MeterUsage = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  cacheHits: 0,
  looseHits: 0,
};

export interface RequestOutcome {
  kind: 'forward' | 'replay';
  counts: TokenCounts;
  /** Real (or simulated, for `mock`) USD charged. */
  costUsd: number;
  /** Live cost of a replayed request, or the API-equivalent of a Codex request. */
  virtualCostUsd: number;
  /** A replay that was not an exact replay of its recording. */
  loose?: boolean;
}

export class UsageTotals {
  /** Requests that went upstream (what the request caps count). */
  forwarded = 0;
  private readonly usage: MeterUsage;
  replayedCostUsd = 0;
  apiEquivalentUsd = 0;
  readonly rejects: Record<string, number> = {};

  constructor(baseline?: MeterUsage) {
    this.usage = { ...EMPTY_USAGE, ...baseline };
    this.forwarded = Math.max(0, this.usage.requests - this.usage.cacheHits);
  }

  add(outcome: RequestOutcome, provider: EvalProvider): void {
    const u = this.usage;
    u.requests++;
    if (outcome.kind === 'forward') this.forwarded++;
    if (outcome.kind === 'replay') {
      u.cacheHits++;
      if (outcome.loose) u.looseHits = (u.looseHits ?? 0) + 1;
      this.replayedCostUsd += outcome.virtualCostUsd;
    }
    if (provider === 'codex') this.apiEquivalentUsd += outcome.virtualCostUsd;
    u.inputTokens += uncachedInputTokens(outcome.counts);
    u.cachedInputTokens += outcome.counts.cacheRead;
    u.cacheWriteTokens += outcome.counts.cacheWrite;
    u.outputTokens += outcome.counts.completion;
    u.reasoningTokens += outcome.counts.reasoning;
    u.costUsd += outcome.costUsd;
  }

  reject(reason: string): void {
    this.rejects[reason] = (this.rejects[reason] ?? 0) + 1;
  }

  /** The whole prompt tokens so far (uncached + cached + written). */
  promptTokens(): number {
    return this.usage.inputTokens + this.usage.cachedInputTokens + this.usage.cacheWriteTokens;
  }

  costUsd(): number {
    return this.usage.costUsd;
  }

  snapshot(): MeterUsage {
    return { ...this.usage };
  }
}
