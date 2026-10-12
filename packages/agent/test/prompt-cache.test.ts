import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Api, Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPromptCacheKey } from '../src/host/extension';
import { configureModel, needsPromptCacheKey } from '../src/host/model';

type Body = {
  messages: { role: string; content: unknown }[];
  tools?: { cache_control?: unknown }[];
  prompt_cache_key?: string;
};

/** A LiteLLM stand-in that records each request body and answers with one streamed word. */
let server: Server;
let baseUrl: string;
const bodies: Body[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      chunk({ id: 'r1', choices: [{ index: 0, delta: { content: 'ok' } }] });
      chunk({
        id: 'r1',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function litellmModel(id: string): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  return { runtime, model: configureModel(runtime, { provider: 'litellm', id, baseUrl }) };
}

/** Sends a two-turn conversation with two tools and returns the request body LiteLLM got. */
async function send(
  runtime: ModelRuntime,
  model: Model<Api>,
  onPayload?: (payload: unknown) => unknown,
): Promise<Body> {
  const tool = (name: string) => ({
    name,
    description: `Tool ${name}`,
    parameters: { type: 'object', properties: {} },
  });
  const before = bodies.length;
  const response = await runtime
    .streamSimple(
      model,
      {
        systemPrompt: 'Eres un agente de trámites.',
        messages: [
          { role: 'user', content: 'Hola', timestamp: 1 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '¿En qué te ayudo?' }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'stop',
            timestamp: 2,
          },
          { role: 'user', content: 'Renueva mi carné', timestamp: 3 },
        ],
        tools: [tool('browser_open'), tool('procedure_update')],
      } as never,
      { apiKey: 'sk-test', sessionId: 'session-1', ...(onPayload ? { onPayload } : {}) },
    )
    .result();
  expect(response.errorMessage).toBeUndefined();
  expect(bodies.length).toBe(before + 1);
  return bodies[before] as Body;
}

function cacheControls(content: unknown): unknown[] {
  return Array.isArray(content)
    ? content.flatMap((part: { cache_control?: unknown }) =>
        part.cache_control ? [part.cache_control] : [],
      )
    : [];
}

describe('LiteLLM prompt caching', () => {
  it('marks the system prompt, the last tool and the last message of Anthropic models', async () => {
    const { runtime, model } = await litellmModel('anthropic/claude-haiku-5.5');
    expect(model.promptCache).toEqual({ short: 300, long: 3600 });
    expect(needsPromptCacheKey(model)).toBe(false);

    const body = await send(runtime, model);
    const marker = { type: 'ephemeral' };
    const [system, ...rest] = body.messages;
    expect(system?.role).toBe('system');
    expect(cacheControls(system?.content)).toEqual([marker]);
    expect(body.tools?.map((t) => t.cache_control)).toEqual([undefined, marker]);
    const last = rest.at(-1);
    expect(last?.role).toBe('user');
    expect(cacheControls(last?.content)).toEqual([marker]);
    // Only the last message: earlier ones stay unmarked.
    expect(rest.slice(0, -1).flatMap((m) => cacheControls(m.content))).toEqual([]);
  });

  it('sends OpenAI models the session id as prompt_cache_key, without cache_control', async () => {
    const { runtime, model } = await litellmModel('openai/gpt-6.1-sol');
    expect(model.promptCache).toEqual({ short: 300, long: 86_400 });
    expect(needsPromptCacheKey(model)).toBe(true);

    const body = await send(runtime, model, (payload) => withPromptCacheKey(payload, 'session-1'));
    expect(body.prompt_cache_key).toBe('session-1');
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('leaves other upstreams without a cache lifetime', async () => {
    const { model } = await litellmModel('google/gemini-3-pro');
    expect(model.promptCache).toBeUndefined();
    expect(needsPromptCacheKey(model)).toBe(false);
  });
});

describe('withPromptCacheKey', () => {
  it('keeps an existing key and caps new ones at 64 characters', () => {
    expect(withPromptCacheKey({ prompt_cache_key: 'kept' }, 'session')).toBeUndefined();
    expect(withPromptCacheKey('not an object', 'session')).toBeUndefined();
    const long = 'x'.repeat(80);
    expect(withPromptCacheKey({ model: 'm' }, long)).toEqual({
      model: 'm',
      prompt_cache_key: 'x'.repeat(64),
    });
  });
});
