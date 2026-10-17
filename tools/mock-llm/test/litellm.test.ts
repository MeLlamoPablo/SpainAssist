import { afterEach, describe, expect, it } from 'vitest';
import { createMockLlm, type MockLlm } from '../src/index';
import { chat, parseSseBody, user } from './helpers';

let llm: MockLlm | undefined;
afterEach(async () => {
  await llm?.close();
  llm = undefined;
});

const reply = { text: 'Hola', usage: { promptTokens: 1000, completionTokens: 100 } };

describe('LiteLLM emulation', () => {
  it('is off by default: no gateway headers, plain usage', async () => {
    llm = await createMockLlm({ scenario: { rules: [], fallback: reply } });
    const res = await chat(llm, [user('x')], { stream: false });
    expect(res.headers.get('x-litellm-response-cost')).toBeNull();
    expect(res.headers.get('x-litellm-key-spend')).toBeNull();
    const body = (await res.json()) as { usage: Record<string, unknown> };
    expect(body.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 });
    expect(llm.litellm).toBeUndefined();
  });

  it('sends the cost and the key headers, one call behind, and charges the key', async () => {
    llm = await createMockLlm({
      scenario: { rules: [], fallback: reply },
      litellm: { maxBudgetUsd: 1 },
    });
    // Haiku 5.5 prices: (1000 * 0.1 + 100 * 0.5) / 1e6.
    const cost = (1000 * 0.1 + 100 * 0.5) / 1e6;
    const first = await chat(llm, [user('x')], { stream: false });
    expect(Number(first.headers.get('x-litellm-response-cost'))).toBeCloseTo(cost, 12);
    expect(first.headers.get('x-litellm-key-spend')).toBe('0');
    expect(first.headers.get('x-litellm-key-max-budget')).toBe('1');
    await first.text();
    const second = await chat(llm, [user('x')]);
    expect(Number(second.headers.get('x-litellm-key-spend'))).toBeCloseTo(cost, 12);
    await second.text();
    expect(llm.litellm?.state().spendUsd).toBeCloseTo(2 * cost, 12);
  });

  it('omits the max budget header for an uncapped key and the cost header on request', async () => {
    llm = await createMockLlm({
      scenario: { rules: [], fallback: reply },
      litellm: { responseCostHeader: false },
    });
    const res = await chat(llm, [user('x')], { stream: false });
    expect(res.headers.get('x-litellm-key-max-budget')).toBeNull();
    expect(res.headers.get('x-litellm-response-cost')).toBeNull();
    expect(res.headers.get('x-litellm-key-spend')).toBe('0');
  });

  it('reports cache and reasoning tokens in the openai shape (cache writes inside the details)', async () => {
    llm = await createMockLlm({
      scenario: {
        rules: [],
        fallback: {
          text: 'ok',
          usage: {
            promptTokens: 10_000,
            completionTokens: 200,
            cachedTokens: 8000,
            cacheWriteTokens: 1500,
            reasoningTokens: 120,
          },
        },
      },
      litellm: {},
    });
    const res = await chat(llm, [user('x')]);
    const usage = parseSseBody(await res.text())
      .map((event) => event.data)
      .find((data) => data !== '[DONE]' && data.usage)!;
    expect((usage as { usage: unknown }).usage).toEqual({
      prompt_tokens: 10_000,
      completion_tokens: 200,
      total_tokens: 10_200,
      prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1500 },
      completion_tokens_details: { reasoning_tokens: 120 },
    });
    // (500 uncached * 0.1 + 8000 * 0.01 + 1500 * 0.125 + 200 * 0.5) / 1e6
    const expected = (500 * 0.1 + 8000 * 0.01 + 1500 * 0.125 + 200 * 0.5) / 1e6;
    expect(Number(res.headers.get('x-litellm-response-cost'))).toBeCloseTo(expected, 12);
  });

  it('can put cache writes only in the top-level Anthropic fields, like LiteLLM does', async () => {
    llm = await createMockLlm({
      scenario: {
        rules: [],
        fallback: {
          text: 'ok',
          usage: {
            promptTokens: 4000,
            completionTokens: 50,
            cachedTokens: 1000,
            cacheWriteTokens: 2000,
          },
        },
      },
      litellm: { usageShape: 'anthropic', costInUsage: true },
    });
    const res = await chat(llm, [user('x')], { stream: false });
    const body = (await res.json()) as { usage: Record<string, unknown> };
    expect(body.usage).toMatchObject({
      prompt_tokens: 4000,
      prompt_tokens_details: { cached_tokens: 1000 },
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 2000,
    });
    expect(body.usage.cost).toBeCloseTo(Number(res.headers.get('x-litellm-response-cost')), 12);
    expect(JSON.stringify(body.usage.prompt_tokens_details)).not.toContain('cache_write');
  });

  it('derives cache tokens from ratios when a reply does not give them', async () => {
    llm = await createMockLlm({
      scenario: { rules: [], fallback: reply },
      litellm: { cacheReadRatio: 0.5, cacheWriteRatio: 0.25 },
    });
    const res = await chat(llm, [user('x')], { stream: false });
    const body = (await res.json()) as { usage: { prompt_tokens_details: Record<string, number> } };
    expect(body.usage.prompt_tokens_details).toEqual({
      cached_tokens: 500,
      cache_write_tokens: 250,
    });
  });

  it('lets a reply set the reported cost and extra headers', async () => {
    llm = await createMockLlm({
      scenario: {
        rules: [],
        fallback: { text: 'x', usage: { costUsd: 0.5 }, headers: { 'x-extra': '1' } },
      },
      litellm: {},
    });
    const res = await chat(llm, [user('x')], { stream: false });
    expect(res.headers.get('x-litellm-response-cost')).toBe('0.5');
    expect(res.headers.get('x-extra')).toBe('1');
  });

  it('answers 422 "Budget has been exceeded" once the key is over its cap', async () => {
    llm = await createMockLlm({
      scenario: { rules: [], fallback: { text: 'x', usage: { costUsd: 0.6 } } },
      litellm: { maxBudgetUsd: 1 },
    });
    expect((await chat(llm, [user('x')], { stream: false })).status).toBe(200);
    expect((await chat(llm, [user('x')], { stream: false })).status).toBe(200); // 1.2 now
    const over = await chat(llm, [user('x')], { stream: false });
    expect(over.status).toBe(422);
    const body = (await over.json()) as { error: { message: string; type: string } };
    expect(body.error.type).toBe('budget_exceeded');
    expect(body.error.message).toMatch(
      /Budget has been exceeded! Current cost: 1\.2, Max budget: 1/,
    );
    // The refusal is not charged and does not consume a rule.
    expect(llm.litellm?.state().spendUsd).toBeCloseTo(1.2, 12);
  });

  it('can answer the over-budget refusal with 402, as OpenRouter-style keys do', async () => {
    llm = await createMockLlm({
      scenario: { rules: [], fallback: { text: 'x', usage: { costUsd: 2 } } },
      litellm: { maxBudgetUsd: 1, budgetExceededStatus: 402 },
    });
    await (await chat(llm, [user('x')], { stream: false })).text();
    const over = await chat(llm, [user('x')], { stream: false });
    expect(over.status).toBe(402);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe('402');
  });

  it('serves the key state at /key/info and /__litellm', async () => {
    llm = await createMockLlm({ litellm: { maxBudgetUsd: 5, spendUsd: 1.25 } });
    const info = (await (await fetch(`${llm.url}/key/info`)).json()) as {
      info: { spend: number; max_budget: number };
    };
    expect(info.info).toEqual({ spend: 1.25, max_budget: 5 });
    const set = await fetch(`${llm.url}/__litellm`, {
      method: 'POST',
      body: JSON.stringify({ spendUsd: 4, maxBudgetUsd: null }),
    });
    expect(await set.json()).toEqual({ spendUsd: 4, maxBudgetUsd: null });
    llm.litellm?.set({ spendUsd: 2 });
    expect(llm.litellm?.state()).toEqual({ spendUsd: 2, maxBudgetUsd: null });
  });

  it('keeps /key/info static and /__litellm absent without the emulation', async () => {
    llm = await createMockLlm({});
    const info = (await (await fetch(`${llm.url}/key/info`)).json()) as { info: unknown };
    expect(info.info).toEqual({ spend: 0, max_budget: null });
    expect((await fetch(`${llm.url}/__litellm`)).status).toBe(404);
  });

  it('allows error replies with a custom type and fields', async () => {
    llm = await createMockLlm({
      scenario: {
        rules: [],
        fallback: {
          error: {
            status: 429,
            message: 'limit',
            type: 'usage_limit_reached',
            fields: { plan_type: 'plus', resets_at: 1893456000 },
          },
          headers: { 'retry-after': '60' },
        },
      },
    });
    const res = await chat(llm, [user('x')], { stream: false });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(await res.json()).toEqual({
      error: {
        message: 'limit',
        code: 429,
        type: 'usage_limit_reached',
        plan_type: 'plus',
        resets_at: 1893456000,
      },
    });
  });
});
