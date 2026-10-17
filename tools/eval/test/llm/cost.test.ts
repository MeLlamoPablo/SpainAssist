import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import {
  costOf,
  DEFAULT_PRICES,
  estimateInputTokens,
  FALLBACK_PRICE,
  normalizeChatUsage,
  normalizeResponsesUsage,
  parseResponseCostHeader,
  priceFor,
  reserveCost,
  resolveCost,
  type TokenCounts,
  uncachedInputTokens,
} from '../../src/llm/cost';

const haiku = DEFAULT_PRICES['anthropic/claude-haiku-5.5']!;
const counts = (partial: Partial<TokenCounts>): TokenCounts => ({
  prompt: 0,
  cacheRead: 0,
  cacheWrite: 0,
  completion: 0,
  reasoning: 0,
  ...partial,
});

describe('price table', () => {
  it('prices Haiku 5.5 at $0.10 per million input tokens and $0.50 per million output tokens', () => {
    // 100,000 prompt tokens is the last size below the tier: a tenth of a million input tokens.
    expect(costOf(haiku, counts({ prompt: 100_000 }))).toBeCloseTo(0.01, 12);
    expect(costOf(haiku, counts({ completion: 1_000_000 }))).toBeCloseTo(0.5, 12);
    expect(haiku.input).toBe(0.1);
    expect(haiku.output).toBe(0.5);
    expect(costOf(haiku, counts({ prompt: 10_000, completion: 1_000 }))).toBeCloseTo(0.0015, 12);
  });

  it('prices cache reads and writes separately from plain input', () => {
    const c = counts({ prompt: 10_000, cacheRead: 8_000, cacheWrite: 1_000, completion: 100 });
    expect(uncachedInputTokens(c)).toBe(1_000);
    expect(costOf(haiku, c)).toBeCloseTo(
      (1_000 * 0.1 + 8_000 * 0.01 + 1_000 * 0.125 + 100 * 0.5) / 1e6,
      12,
    );
  });

  it('bills the whole request at the tier prices above 100k prompt tokens', () => {
    const below = costOf(haiku, counts({ prompt: 100_000, completion: 1000 }));
    const above = costOf(haiku, counts({ prompt: 100_001, completion: 1000 }));
    expect(below).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 12);
    expect(above).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e6, 12);
  });

  it('knows the Codex models and falls back to a dear price for unknown ones', () => {
    expect(priceFor(DEFAULT_PRICES, 'gpt-6.1-sol').known).toBe(true);
    expect(priceFor(DEFAULT_PRICES, 'openai/gpt-6-luna').known).toBe(true);
    const unknown = priceFor(DEFAULT_PRICES, 'vendor/never-heard-of');
    expect(unknown).toEqual({ price: FALLBACK_PRICE, known: false });
    expect(priceFor(DEFAULT_PRICES, undefined).known).toBe(false);
    expect(FALLBACK_PRICE.input).toBeGreaterThan(haiku.input);
  });
});

describe('usage normalisation', () => {
  it('reads the OpenAI shape LiteLLM sends: cached tokens, cache writes and reasoning', () => {
    expect(
      normalizeChatUsage({
        prompt_tokens: 10_000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 1_500 },
        completion_tokens_details: { reasoning_tokens: 120 },
      }),
    ).toEqual({
      counts: {
        prompt: 10_000,
        cacheRead: 8_000,
        cacheWrite: 1_500,
        completion: 200,
        reasoning: 120,
      },
    });
  });

  it('reads cache writes from the top-level Anthropic names, which pi ignores', () => {
    const usage = normalizeChatUsage({
      prompt_tokens: 4000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 1000 },
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 2000,
    });
    expect(usage?.counts).toMatchObject({ prompt: 4000, cacheRead: 1000, cacheWrite: 2000 });
    expect(
      normalizeChatUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 4 })?.counts.cacheRead,
    ).toBe(4);
  });

  it('treats Anthropic-native counts (cache excluded from the prompt) as additive', () => {
    const usage = normalizeChatUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 500,
    });
    expect(usage?.counts).toMatchObject({ prompt: 1500, cacheRead: 900, cacheWrite: 500 });
  });

  it('keeps a cost reported inside the usage object', () => {
    expect(
      normalizeChatUsage({ prompt_tokens: 1, completion_tokens: 1, cost: 0.0042 })?.reportedCostUsd,
    ).toBe(0.0042);
    expect(normalizeChatUsage({ prompt_tokens: 1, cost: -1 })?.reportedCostUsd).toBeUndefined();
  });

  it('tolerates garbage', () => {
    expect(normalizeChatUsage(undefined)).toBeUndefined();
    expect(normalizeChatUsage('x')).toBeUndefined();
    expect(
      normalizeChatUsage({ prompt_tokens: 'many', completion_tokens: NaN })?.counts.prompt,
    ).toBe(0);
  });

  it('reads Responses usage', () => {
    expect(
      normalizeResponsesUsage({
        input_tokens: 120,
        input_tokens_details: { cached_tokens: 100, cache_write_tokens: 10 },
        output_tokens: 30,
        output_tokens_details: { reasoning_tokens: 5 },
      }),
    ).toEqual({
      counts: { prompt: 120, cacheRead: 100, cacheWrite: 10, completion: 30, reasoning: 5 },
    });
    expect(normalizeResponsesUsage(null)).toBeUndefined();
  });
});

describe('cost resolution', () => {
  const usage = { counts: counts({ prompt: 10_000, completion: 1_000 }) };
  const estimate = (10_000 * 0.1 + 1_000 * 0.5) / 1e6;

  it('prefers the gateway header, then the usage cost, then the price table', () => {
    expect(resolveCost({ headerCostUsd: 0.5, usage, price: haiku })).toMatchObject({
      usd: 0.5,
      source: 'header',
    });
    const withCost = { ...usage, reportedCostUsd: 0.25 };
    expect(resolveCost({ usage: withCost, price: haiku })).toMatchObject({
      usd: 0.25,
      source: 'usage',
    });
    const table = resolveCost({ usage, price: haiku });
    expect(table.source).toBe('estimate');
    expect(table.usd).toBeCloseTo(estimate, 12);
  });

  it('keeps the table estimate next to an authoritative cost for auditing', () => {
    const resolved = resolveCost({ headerCostUsd: 0.5, usage, price: haiku });
    expect(resolved.estimateUsd).toBeCloseTo(estimate, 12);
  });

  it('does not trust a zero header when tokens were obviously used', () => {
    expect(resolveCost({ headerCostUsd: 0, usage, price: haiku }).source).toBe('estimate');
    expect(resolveCost({ headerCostUsd: 0, price: haiku })).toMatchObject({
      usd: 0,
      source: 'header',
    });
  });

  it('charges an estimate for a stream that gave no usage', () => {
    const partial = resolveCost({
      price: haiku,
      partial: { estimatedInputTokens: 20_000, outputChars: 4_000 },
    });
    expect(partial.source).toBe('estimate-partial');
    expect(partial.usd).toBeCloseTo((20_000 * 0.1 + 1_000 * 0.5) / 1e6, 12);
    expect(resolveCost({ price: haiku })).toEqual({ usd: 0, source: 'none' });
  });

  it('parses the header strictly', () => {
    expect(parseResponseCostHeader('0.0012')).toBe(0.0012);
    expect(parseResponseCostHeader('0')).toBe(0);
    for (const bad of [undefined, '', '  ', 'None', 'abc', '-1', 'Infinity']) {
      expect(parseResponseCostHeader(bad)).toBeUndefined();
    }
  });
});

describe('estimates and reservations', () => {
  it('estimates text tokens from bytes and counts every screenshot as a fixed cost, not its bytes', () => {
    const text = JSON.stringify({ messages: [{ role: 'user', content: 'a'.repeat(3200) }] });
    expect(estimateInputTokens(text)).toBeGreaterThan(1000);
    expect(estimateInputTokens(text)).toBeLessThan(1100);
    const image = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
    const withImage = JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }],
    });
    expect(estimateInputTokens(withImage)).toBeGreaterThanOrEqual(1500);
    expect(estimateInputTokens(withImage)).toBeLessThan(1700);
    const remote = JSON.stringify({
      content: [{ type: 'input_image', image_url: 'https://x.example/a.png' }],
    });
    expect(estimateInputTokens(remote)).toBeGreaterThanOrEqual(1500);
  });

  it('reserves at least what the request can cost, with cache writes at their dearer price', () => {
    const reserve = reserveCost(haiku, 20_000, 8192);
    expect(reserve).toBeGreaterThanOrEqual((20_000 * 0.125 + 8192 * 0.5) / 1e6 - 1e-12);
    // A request that really used 20k cache-written tokens and 8192 output tokens costs no more.
    const worst = costOf(haiku, counts({ prompt: 20_000, cacheWrite: 20_000, completion: 8192 }));
    expect(reserve).toBeGreaterThanOrEqual(worst - 1e-12);
    // Above the tier threshold the reservation uses the tier prices.
    expect(reserveCost(haiku, 150_000, 8192)).toBeGreaterThan(reserveCost(haiku, 90_000, 8192) * 4);
  });
});
