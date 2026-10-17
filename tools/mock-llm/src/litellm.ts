/**
 * LiteLLM gateway emulation for the mock LLM (`MockLlmOptions.litellm`): a simulated virtual key
 * with a spend and an optional cap, the `x-litellm-*` response headers, token usage with
 * cache-read, cache-write and reasoning tokens in the shapes LiteLLM sends, and the 422
 * "Budget has been exceeded!" answer. It exists so the eval's meter proxy, cost accounting and
 * ceilings can be developed and tested for free.
 *
 * Like the real gateway, `x-litellm-key-spend` is the spend BEFORE the call (one call behind).
 */

export interface LiteLlmPrices {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface LiteLlmOptions {
  /** The simulated key's cap in USD; omit for an uncapped key (no `x-litellm-key-max-budget`). */
  maxBudgetUsd?: number;
  /** Starting spend in USD (default 0). */
  spendUsd?: number;
  /** Prices of the simulated cost; default Claude Haiku 5.5 on the gateway. */
  prices?: LiteLlmPrices;
  /** Share of the prompt reported as cache reads when a reply gives no explicit counts (default 0). */
  cacheReadRatio?: number;
  /** Share of the prompt reported as cache writes when a reply gives no explicit counts (default 0). */
  cacheWriteRatio?: number;
  /**
   * Where the cache tokens appear: `openai` = `prompt_tokens_details` only (pi reads both
   * counts); `anthropic` = also the top-level `cache_read_input_tokens` /
   * `cache_creation_input_tokens`, with cache writes ONLY there (pi ignores them: the meter
   * must read them). Default `openai`.
   */
  usageShape?: 'openai' | 'anthropic';
  /** Send `x-litellm-response-cost` (default true). */
  responseCostHeader?: boolean;
  /** Also put `cost` in the usage object, OpenRouter style (default false). */
  costInUsage?: boolean;
  /**
   * HTTP status of the "Budget has been exceeded!" answer. 422 is what our gateway really sends
   * (docs/research/scan-frame-gate.md); 402 is what OpenRouter-style keys send ("Key limit exceeded").
   */
  budgetExceededStatus?: 402 | 422;
}

export const HAIKU_PRICES: LiteLlmPrices = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
};

export interface TokenCounts {
  /** The whole prompt, cached tokens included. */
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface KeyState {
  spendUsd: number;
  maxBudgetUsd: number | null;
}

export class LiteLlmKey {
  private spend: number;
  private max: number | null;
  readonly prices: LiteLlmPrices;

  constructor(readonly options: LiteLlmOptions = {}) {
    this.spend = options.spendUsd ?? 0;
    this.max = options.maxBudgetUsd ?? null;
    this.prices = options.prices ?? HAIKU_PRICES;
  }

  state(): KeyState {
    return { spendUsd: this.spend, maxBudgetUsd: this.max };
  }

  set(patch: { spendUsd?: number; maxBudgetUsd?: number | null }): void {
    if (patch.spendUsd !== undefined) this.spend = patch.spendUsd;
    if (patch.maxBudgetUsd !== undefined) this.max = patch.maxBudgetUsd;
  }

  exceeded(): boolean {
    return this.max !== null && this.spend >= this.max;
  }

  charge(costUsd: number): void {
    this.spend += costUsd;
  }

  /** The gateway's answer for a key over its budget (422 by default). */
  budgetError(): { status: number; body: unknown } {
    const status = this.options.budgetExceededStatus ?? 422;
    return {
      status,
      body: {
        error: {
          message: `Budget has been exceeded! Current cost: ${this.spend}, Max budget: ${this.max}`,
          type: 'budget_exceeded',
          param: null,
          code: String(status),
        },
      },
    };
  }

  cost(counts: TokenCounts): number {
    const p = this.prices;
    const uncached = Math.max(
      0,
      counts.promptTokens - counts.cachedTokens - counts.cacheWriteTokens,
    );
    return (
      (uncached * p.input +
        counts.cachedTokens * p.cacheRead +
        counts.cacheWriteTokens * p.cacheWrite +
        counts.completionTokens * p.output) /
      1e6
    );
  }

  /** The token counts to report, deriving cache tokens from the ratios when not given. */
  counts(base: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    reasoningTokens?: number | undefined;
  }): TokenCounts {
    const cached =
      base.cachedTokens ?? Math.floor(base.promptTokens * (this.options.cacheReadRatio ?? 0));
    const written =
      base.cacheWriteTokens ?? Math.floor(base.promptTokens * (this.options.cacheWriteRatio ?? 0));
    return {
      promptTokens: base.promptTokens,
      completionTokens: base.completionTokens,
      cachedTokens: Math.min(cached, base.promptTokens),
      cacheWriteTokens: Math.min(written, Math.max(0, base.promptTokens - cached)),
      reasoningTokens: Math.min(base.reasoningTokens ?? 0, base.completionTokens),
    };
  }

  /** The headers of a successful call; `spendBeforeUsd` is the key's spend before it. */
  headers(costUsd: number | undefined, spendBeforeUsd: number): Record<string, string> {
    const headers: Record<string, string> = {
      'x-litellm-key-spend': String(spendBeforeUsd),
    };
    if (this.max !== null) headers['x-litellm-key-max-budget'] = String(this.max);
    if (costUsd !== undefined && this.options.responseCostHeader !== false) {
      headers['x-litellm-response-cost'] = String(costUsd);
    }
    return headers;
  }
}

/**
 * Chat-completions usage object. Without cache tokens it is the plain OpenAI shape the mock always
 * had; with them it adds `prompt_tokens_details` and `completion_tokens_details`, plus the
 * top-level Anthropic names when `shape` is `anthropic`.
 */
export function chatUsage(
  counts: TokenCounts,
  shape: 'openai' | 'anthropic' = 'openai',
  costUsd?: number,
): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    prompt_tokens: counts.promptTokens,
    completion_tokens: counts.completionTokens,
    total_tokens: counts.promptTokens + counts.completionTokens,
  };
  const hasCache = counts.cachedTokens > 0 || counts.cacheWriteTokens > 0;
  if (hasCache) {
    usage.prompt_tokens_details = {
      cached_tokens: counts.cachedTokens,
      ...(shape === 'openai' && counts.cacheWriteTokens > 0
        ? { cache_write_tokens: counts.cacheWriteTokens }
        : {}),
    };
    if (shape === 'anthropic') {
      usage.cache_read_input_tokens = counts.cachedTokens;
      usage.cache_creation_input_tokens = counts.cacheWriteTokens;
    }
  }
  if (counts.reasoningTokens > 0) {
    usage.completion_tokens_details = { reasoning_tokens: counts.reasoningTokens };
  }
  if (costUsd !== undefined) usage.cost = costUsd;
  return usage;
}
