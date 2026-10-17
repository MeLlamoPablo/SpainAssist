import './helpers/no-network';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { classifyAgentError, configureModel } from '@sa/agent';
import { afterEach, describe, expect, it } from 'vitest';
import { replayCodexCredential } from '../../src/llm/codex-auth';
import { API_KEY, type EnvOptions, type MeterEnv, startEnv } from './helpers/meter-env';

// The real pi code (the same `completeSimple` path the agent hosts and the answerer use) talking to
// the meter in front of the mock LLM: what the agents will actually see.
// `@earendil-works/pi-ai/utils/retry` is the function pi's agent loop uses to decide on retries.
const { isRetryableAssistantError } = await import('@earendil-works/pi-ai/utils/retry');

type Credential = { type: 'api_key'; key: string } | Record<string, unknown>;

async function runtimeFor(providerId: string, credential: Credential) {
  return ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: {
      read: async (id: string) => (id === providerId ? credential : undefined),
      list: async () => [{ providerId, type: (credential as { type: string }).type }],
      modify: async (id: string, fn: (current: unknown) => Promise<unknown>) =>
        id === providerId ? credential : fn(undefined),
      delete: async () => {},
    } as never,
  });
}

const context = (text: string, today = '2026-10-17') => ({
  systemPrompt: `You are a procedure agent.\nToday is Saturday ${today} (Europe/Madrid).`,
  messages: [{ role: 'user' as const, content: text, timestamp: Date.now() }],
});

const textOf = (message: { content: { type: string; text?: string }[] }) =>
  message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

let env: MeterEnv;
afterEach(() => env.close());

describe('pi through the meter: vouchers (litellm provider)', () => {
  async function voucherModel(run: ReturnType<MeterEnv['openRun']>, agent = 'procedure-1') {
    const runtime = await runtimeFor('litellm', { type: 'api_key', key: API_KEY });
    const model = configureModel(runtime, {
      provider: 'litellm',
      id: 'anthropic/claude-haiku-5.5',
      baseUrl: run.agentBaseUrl(agent),
      maxTokens: 8192,
    });
    return { runtime, model };
  }

  it('sends the production request, gets the answer and the gateway headers, and is metered', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: 'Hola desde el gateway',
            usage: {
              promptTokens: 2000,
              completionTokens: 100,
              cachedTokens: 1200,
              cacheWriteTokens: 300,
            },
          },
        },
        litellm: { maxBudgetUsd: 5 },
      },
    });
    const run = env.openRun();
    const { runtime, model } = await voucherModel(run);
    let headers: Record<string, string> = {};
    const message = await runtime.completeSimple(model, context('Hola'), {
      reasoning: 'medium',
      sessionId: 'session-1',
      onResponse: (response: { headers?: Record<string, string> }) => {
        headers = response.headers ?? {};
      },
    } as never);
    expect(message.stopReason).toBe('stop');
    expect(textOf(message)).toBe('Hola desde el gateway');

    // What the gateway saw is what production sends: litellm path, cache markers, max_tokens.
    const seen = env.llm.requests().at(-1)!;
    const body = seen.body as Record<string, unknown> & {
      messages: { content: { cache_control?: unknown }[] }[];
    };
    expect(seen.path).toBe('/v1/chat/completions');
    expect(seen.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(body).toMatchObject({
      model: 'anthropic/claude-haiku-5.5',
      stream: true,
      max_tokens: 8192,
      reasoning_effort: 'medium',
    });
    expect(JSON.stringify(body.messages)).toContain('cache_control');
    // The spend headers reach pi (the host forwards them as agent.voucherSpend).
    expect(headers['x-litellm-key-max-budget']).toBe('5');
    expect(headers['x-litellm-key-spend']).toBeDefined();

    // pi's own count and the meter's agree on tokens; cost is the gateway's.
    const usage = run.usage();
    expect(usage.inputTokens).toBe(message.usage.input);
    expect(usage.outputTokens).toBe(message.usage.output);
    expect(usage.cachedInputTokens).toBe(message.usage.cacheRead);
    expect(usage.cacheWriteTokens).toBe(message.usage.cacheWrite);
    expect(usage.costUsd).toBeCloseTo(Number(headers['x-litellm-response-cost']), 12);
  });

  it('turns a budget stop into a provider error pi does not retry, classified as a quota stop', async () => {
    env = await startEnv();
    const run = env.openRun({ limits: { perRunUsd: 0.001 } });
    const { runtime, model } = await voucherModel(run);
    const message = await runtime.completeSimple(model, context('Hola'), {
      reasoning: 'medium',
    } as never);
    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toMatch(/out of budget/);
    expect(message.errorMessage).toMatch(/^402/);
    expect(isRetryableAssistantError(message)).toBe(false);
    expect(classifyAgentError(message.errorMessage ?? '')).toBe('quota');
    expect(env.llm.requests()).toHaveLength(0);
  });

  it('does not let pi retry a replay miss, a request cap or the kill switch either', async () => {
    env = await startEnv();
    const miss = env.openRun({ cache: 'replay' });
    const { runtime, model } = await voucherModel(miss);
    const missed = await runtime.completeSimple(model, context('Hola'), {
      reasoning: 'medium',
    } as never);
    expect(missed.stopReason).toBe('error');
    expect(missed.errorMessage).toMatch(/^424/);
    expect(missed.errorMessage).toMatch(/Replay cache miss/);
    expect(isRetryableAssistantError(missed)).toBe(false);

    const capped = env.openRun({ limits: { perRunRequests: 0 } });
    const cappedModel = await voucherModel(capped);
    const cappedMessage = await cappedModel.runtime.completeSimple(
      cappedModel.model,
      context('Hola'),
      { reasoning: 'medium' } as never,
    );
    expect(isRetryableAssistantError(cappedMessage)).toBe(false);
    expect(classifyAgentError(cappedMessage.errorMessage ?? '')).toBe('quota');
  });

  it('records a conversation and replays it for free: another day, another session, the same answer', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: { text: 'Respuesta grabada', reasoning: 'Pienso un poco.' },
        },
        litellm: {},
      },
    });
    const recorded = env.openRun({ cache: 'record' });
    const a = await voucherModel(recorded);
    const first = await a.runtime.completeSimple(a.model, context('Hola'), {
      reasoning: 'medium',
      sessionId: 'one',
    } as never);
    expect(env.llm.requests()).toHaveLength(1);

    const replayed = env.openRun({ cache: 'replay' });
    // Replay needs no key: pi gets the placeholder the run loop would give it.
    const runtime = await runtimeFor('litellm', {
      type: 'api_key',
      key: 'sk-eval-placeholder-not-a-key',
    });
    const model = configureModel(runtime, {
      provider: 'litellm',
      id: 'anthropic/claude-haiku-5.5',
      baseUrl: replayed.agentBaseUrl('procedure-1'),
      maxTokens: 8192,
    });
    const second = await runtime.completeSimple(model, context('Hola', '2026-12-24'), {
      reasoning: 'medium',
      sessionId: 'two',
    } as never);
    expect(env.llm.requests()).toHaveLength(1);
    expect(second.content).toEqual(first.content);
    expect(second.usage.input).toBe(first.usage.input);
    expect(replayed.usage()).toMatchObject({ cacheHits: 1, costUsd: 0 });
  });
});

describe('pi through the meter: Codex (openai-codex provider)', () => {
  async function codexModel(run: ReturnType<MeterEnv['openRun']>) {
    const credential = replayCodexCredential();
    const runtime = await runtimeFor('openai-codex', credential);
    const model = configureModel(runtime, {
      provider: 'openai-codex',
      id: 'gpt-6.1-sol',
      baseUrl: run.agentBaseUrl('procedure-1'),
    });
    return { runtime, model, credential };
  }

  const startCodex = (options: EnvOptions = {}) =>
    startEnv({
      provider: 'codex',
      upstreamPath: '/backend-api',
      ...options,
      meter: { codexConsent: true, ...options.meter },
    });

  it('falls back from WebSocket to SSE, sends the zstd body and the account header, and is metered', async () => {
    env = await startCodex({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: 'Hola desde Codex',
            usage: {
              promptTokens: 300,
              completionTokens: 20,
              cachedTokens: 200,
              reasoningTokens: 5,
            },
          },
        },
      },
    });
    const run = env.openRun();
    const { runtime, model, credential } = await codexModel(run);
    const message = await runtime.completeSimple(model, context('Hola'), {
      reasoning: 'medium',
      sessionId: 'sess-1',
    } as never);
    expect(message.stopReason).toBe('stop');
    expect(textOf(message)).toBe('Hola desde Codex');

    // The WebSocket attempt never reached the upstream: the meter answered 426 itself.
    const upstream = env.llm.requests();
    expect(upstream.map((r) => r.method)).toEqual(['POST']);
    const seen = upstream[0]!;
    expect(seen.path).toBe('/backend-api/codex/responses');
    expect(seen.headers['content-encoding']).toBe('zstd');
    expect(seen.headers.authorization).toBe(`Bearer ${credential.access}`);
    expect(seen.headers['chatgpt-account-id']).toBe('acct-replay');
    expect(seen.body).toMatchObject({ model: 'gpt-6.1-sol', stream: true, store: false });
    expect(run.usage()).toMatchObject({
      requests: 1,
      inputTokens: message.usage.input,
      cachedInputTokens: message.usage.cacheRead,
      outputTokens: message.usage.output,
      costUsd: 0,
    });
    expect(env.ledgerLines().at(-1)).toMatchObject({
      provider: 'codex',
      kind: 'forward',
      status: 200,
    });
  });

  it('records and replays a Codex conversation for free', async () => {
    env = await startCodex({
      mock: { scenario: { rules: [], fallback: { text: 'Respuesta grabada' } } },
    });
    const recorded = env.openRun({ cache: 'record' });
    const a = await codexModel(recorded);
    const first = await a.runtime.completeSimple(a.model, context('Hola'), {
      reasoning: 'medium',
      sessionId: 'one',
    } as never);
    const upstreamCalls = env.llm.requests().length;

    const replayed = env.openRun({ cache: 'replay' });
    const b = await codexModel(replayed);
    const second = await b.runtime.completeSimple(b.model, context('Hola', '2027-01-04'), {
      reasoning: 'medium',
      sessionId: 'two',
    } as never);
    expect(env.llm.requests()).toHaveLength(upstreamCalls);
    expect(second.content).toEqual(first.content);
    expect(replayed.usage().cacheHits).toBe(1);
  });

  it('shows a usage limit as pi\'s "usage limit" error (not retried), then answers the cooldown locally', async () => {
    env = await startCodex({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            error: {
              status: 429,
              message: 'The usage limit has been reached',
              type: 'usage_limit_reached',
              fields: { plan_type: 'plus', resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 },
            },
          },
        },
      },
    });
    const run = env.openRun();
    const { runtime, model } = await codexModel(run);
    const first = await runtime.completeSimple(model, context('Hola'), {
      reasoning: 'medium',
    } as never);
    expect(first.stopReason).toBe('error');
    expect(isRetryableAssistantError(first)).toBe(false);
    expect(classifyAgentError(first.errorMessage ?? '')).toBe('quota');
    const upstreamCalls = env.llm.requests().length;
    const second = await runtime.completeSimple(model, context('Hola otra vez'), {
      reasoning: 'medium',
    } as never);
    expect(second.errorMessage).toBe(first.errorMessage);
    expect(env.llm.requests()).toHaveLength(upstreamCalls);
  });

  it('stops at the request cap with a non-retryable quota error', async () => {
    env = await startCodex();
    const run = env.openRun({ limits: { perRunRequests: 1 } });
    const { runtime, model } = await codexModel(run);
    const ok = await runtime.completeSimple(model, context('Uno'), {
      reasoning: 'medium',
    } as never);
    expect(ok.stopReason).toBe('stop');
    const capped = await runtime.completeSimple(model, context('Dos'), {
      reasoning: 'medium',
    } as never);
    expect(capped.stopReason).toBe('error');
    expect(capped.errorMessage).toMatch(/quota exceeded \(out of budget\)/);
    expect(isRetryableAssistantError(capped)).toBe(false);
    expect(classifyAgentError(capped.errorMessage ?? '')).toBe('quota');
  });
});
