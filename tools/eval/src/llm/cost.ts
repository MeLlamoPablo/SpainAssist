/**
 * Prices, token usage and cost resolution of the meter. Cost sources, in priority order: the
 * gateway's own `x-litellm-response-cost` header, the cost inside the usage chunk (OpenRouter
 * style), then the configured price table. Aborted streams are charged an estimate.
 */

/** USD per million tokens. */
export interface PriceEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * When the whole prompt (uncached + cache read + cache write) is above `inputTokensAbove`, every
   * token of the request bills at the tier's prices.
   */
  tiers?: PriceTier[];
}
interface PriceTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export type PriceTable = Readonly<Record<string, PriceEntry>>;

const haiku: PriceEntry = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    { inputTokensAbove: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  ],
};
const luna: PriceEntry = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    { inputTokensAbove: 272_000, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
  ],
};
const sol: PriceEntry = {
  input: 2,
  output: 10,
  cacheRead: 0.2,
  cacheWrite: 2.5,
  tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 }],
};
const sol61: PriceEntry = { ...sol, cacheRead: 0.1 };
/** InclusionAI's Ling 3.0 Flash VL on OpenRouter (no cache write charge). */
const lingFlashVl: PriceEntry = { input: 0.06, output: 0.18, cacheRead: 0.012, cacheWrite: 0.06 };
/** GPT-4o mini (2024-07-18) on OpenRouter: an older model, to test injection resistance. */
const gpt4oMini: PriceEntry = { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 };
/**
 * DeepSeek V4.1 Flash (1017) on OpenRouter at its weekday peak price (off-peak is half), so the
 * meter never undercounts.
 */
const deepseekV41Flash: PriceEntry = { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.3 };
const astra: PriceEntry = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  tiers: [{ inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 }],
};

/**
 * The models the eval runs: the voucher gateway's OpenRouter ids and the bare ids of the Codex
 * backend, and other OpenRouter models tried on the suite. Haiku 5.5 is $0.10 per million input
 * tokens and $0.50 per million output tokens.
 * Codex prices are what the same tokens would cost on the API: informational only, the plan is
 * metered by requests.
 */
export const DEFAULT_PRICES: PriceTable = {
  'anthropic/claude-haiku-5.5': haiku,
  'openai/gpt-6-luna': luna,
  'openai/gpt-6-sol': sol,
  'openai/gpt-6.1-sol': sol61,
  'openai/gpt-6-astra': astra,
  'inclusionai/ling-3.0-flash-vl': lingFlashVl,
  'openai/gpt-4o-mini-2024-07-18': gpt4oMini,
  'deepseek/deepseek-v4.1-flash-1017': deepseekV41Flash,
  'gpt-6-luna': luna,
  'gpt-6-sol': sol,
  'gpt-6.1-sol': sol61,
  'gpt-6-astra': astra,
};

/** For a model the table does not know: deliberately expensive, so budgets err on the safe side. */
export const FALLBACK_PRICE: PriceEntry = {
  input: 3,
  output: 15,
  cacheRead: 0.3,
  cacheWrite: 3.75,
};

export function priceFor(
  prices: PriceTable,
  model: string | undefined,
): { price: PriceEntry; known: boolean } {
  const found = model ? prices[model] : undefined;
  return found ? { price: found, known: true } : { price: FALLBACK_PRICE, known: false };
}

/** Token counts of one request. `prompt` is the whole input: uncached + cache read + cache write. */
export interface TokenCounts {
  prompt: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output tokens, reasoning included. */
  completion: number;
  /** The reasoning part of `completion`. */
  reasoning: number;
}

export const NO_TOKENS: TokenCounts = {
  prompt: 0,
  cacheRead: 0,
  cacheWrite: 0,
  completion: 0,
  reasoning: 0,
};

export function uncachedInputTokens(counts: TokenCounts): number {
  return Math.max(0, counts.prompt - counts.cacheRead - counts.cacheWrite);
}

function totalTokens(counts: TokenCounts): number {
  return counts.prompt + counts.completion;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export interface NormalizedUsage {
  counts: TokenCounts;
  /** A cost the provider put inside the usage object (`usage.cost`). */
  reportedCostUsd?: number;
}

/**
 * Chat completions usage as LiteLLM and OpenRouter send it. pi's own parser only reads
 * `prompt_tokens_details.cache_write_tokens`; the meter also reads the top-level Anthropic names
 * (`cache_read_input_tokens`, `cache_creation_input_tokens`) so cache writes are billed.
 */
export function normalizeChatUsage(raw: unknown): NormalizedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const details = obj(usage.prompt_tokens_details);
  const completionDetails = obj(usage.completion_tokens_details);
  const cacheRead =
    num(details.cached_tokens) ||
    num(usage.cache_read_input_tokens) ||
    num(usage.prompt_cache_hit_tokens);
  const cacheWrite =
    num(details.cache_write_tokens) ||
    num(details.cache_creation_tokens) ||
    num(usage.cache_creation_input_tokens);
  let prompt = num(usage.prompt_tokens);
  // Anthropic-native counts exclude the cached tokens: then the prompt is the sum.
  if (cacheRead + cacheWrite > prompt) prompt += cacheRead + cacheWrite;
  const reportedCost =
    typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0;
  return {
    counts: {
      prompt,
      cacheRead,
      cacheWrite,
      completion: num(usage.completion_tokens),
      reasoning: num(completionDetails.reasoning_tokens),
    },
    ...(reportedCost ? { reportedCostUsd: usage.cost as number } : {}),
  };
}

/** Responses API usage (`response.completed.response.usage`). */
export function normalizeResponsesUsage(raw: unknown): NormalizedUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const outputDetails = obj(usage.output_tokens_details);
  const inputDetails = obj(usage.input_tokens_details);
  return {
    counts: {
      prompt: num(usage.input_tokens),
      cacheRead: num(inputDetails.cached_tokens),
      cacheWrite: num(inputDetails.cache_write_tokens),
      completion: num(usage.output_tokens),
      reasoning: num(outputDetails.reasoning_tokens),
    },
  };
}

function priceAt(price: PriceEntry, promptTokens: number): Omit<PriceEntry, 'tiers'> {
  let applicable: Omit<PriceEntry, 'tiers'> = price;
  let threshold = -1;
  for (const tier of price.tiers ?? []) {
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      applicable = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  return applicable;
}

/** What the table says these tokens cost, in USD. */
export function costOf(price: PriceEntry, counts: TokenCounts): number {
  const p = priceAt(price, counts.prompt);
  return (
    (uncachedInputTokens(counts) * p.input +
      counts.cacheRead * p.cacheRead +
      counts.cacheWrite * p.cacheWrite +
      counts.completion * p.output) /
    1e6
  );
}

const BASE64_IMAGE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
const IMAGE_PART = /"type"\s*:\s*"(?:image_url|input_image)"/g;
const TOKENS_PER_IMAGE = 1500;
const BYTES_PER_TOKEN = 3.2;

/** A deliberately generous guess of a request's input tokens from its JSON text. */
export function estimateInputTokens(bodyText: string): number {
  const dataUrls = bodyText.match(BASE64_IMAGE)?.length ?? 0;
  const parts = bodyText.match(IMAGE_PART)?.length ?? 0;
  const images = Math.max(dataUrls, parts);
  const text = dataUrls ? bodyText.replace(BASE64_IMAGE, '') : bodyText;
  return Math.ceil(Buffer.byteLength(text) / BYTES_PER_TOKEN) + images * TOKENS_PER_IMAGE;
}

/**
 * The most a request can cost before its real usage is known: the estimated input at the dearest
 * input price (a cache write costs more than plain input on some models) plus the full output
 * allowance. Held as a reservation while the request is in flight.
 */
export function reserveCost(
  price: PriceEntry,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number {
  const p = priceAt(price, estimatedInputTokens);
  return (
    (estimatedInputTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output) / 1e6
  );
}

export type CostSource = 'header' | 'usage' | 'estimate' | 'estimate-partial' | 'none';

export interface ResolvedCost {
  usd: number;
  source: CostSource;
  /** The price-table figure, kept next to an authoritative one for auditing. */
  estimateUsd?: number;
}

/** The gateway's `x-litellm-response-cost` as a number; undefined when absent or not finite. */
export function parseResponseCostHeader(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const cost = Number(value);
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

export interface CostInput {
  headerCostUsd?: number | undefined;
  usage?: NormalizedUsage | undefined;
  price: PriceEntry;
  /** Set when the request did not finish: what we know to charge for it. */
  partial?: { estimatedInputTokens: number; outputChars: number } | undefined;
}

export function resolveCost(input: CostInput): ResolvedCost {
  const counts = input.usage?.counts;
  const hasTokens = !!counts && totalTokens(counts) > 0;
  const estimateUsd = counts && hasTokens ? costOf(input.price, counts) : undefined;
  // Some gateways send a zero cost before a streamed response has finished: not authoritative
  // when tokens were obviously consumed.
  if (input.headerCostUsd !== undefined && (input.headerCostUsd > 0 || !hasTokens)) {
    return {
      usd: input.headerCostUsd,
      source: 'header',
      ...(estimateUsd !== undefined ? { estimateUsd } : {}),
    };
  }
  if (input.usage?.reportedCostUsd !== undefined) {
    return {
      usd: input.usage.reportedCostUsd,
      source: 'usage',
      ...(estimateUsd !== undefined ? { estimateUsd } : {}),
    };
  }
  if (estimateUsd !== undefined) return { usd: estimateUsd, source: 'estimate' };
  if (input.partial) {
    const usd = costOf(input.price, {
      prompt: input.partial.estimatedInputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      completion: Math.ceil(input.partial.outputChars / 4),
      reasoning: 0,
    });
    return { usd, source: 'estimate-partial' };
  }
  return { usd: 0, source: 'none' };
}
