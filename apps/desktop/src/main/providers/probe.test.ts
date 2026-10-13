import type { CustomProbeInput } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { FetchFn } from '../remote/http';
import {
  parseLlamaCpp,
  parseLmStudio,
  parseModelList,
  parseOllama,
  probeCustomEndpoint,
} from './probe';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  redirect?: string;
}

/** A fetch answering JSON per URL (404 otherwise) and recording the requests. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    if (!(url in routes)) return new Response('not found', { status: 404 });
    const body = routes[url];
    if (body instanceof Error) throw body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as FetchFn;
  return { fetchFn, calls };
}

const input = (extra: Partial<CustomProbeInput> = {}): CustomProbeInput => ({
  baseUrl: 'http://127.0.0.1:11434/v1',
  api: 'openai-completions',
  model: 'qwen2.5vl:7b',
  ...extra,
});

describe('probeCustomEndpoint', () => {
  it('reads Ollama: capabilities from /api/show, the served context first', async () => {
    const { fetchFn, calls } = fakeFetch({
      'http://127.0.0.1:11434/v1/models': {
        object: 'list',
        data: [{ id: 'qwen2.5vl:7b' }, { id: 'llama3.1:8b' }],
      },
      'http://127.0.0.1:11434/api/show': {
        capabilities: ['completion', 'vision', 'tools'],
        model_info: { 'qwen25vl.context_length': 128_000 },
        parameters: 'temperature 0.7\nnum_ctx 32768',
      },
      'http://127.0.0.1:11434/api/ps': { models: [] },
    });
    const result = await probeCustomEndpoint(input({ apiKey: ' sk-local ' }), fetchFn);
    expect(result).toEqual({
      reachable: true,
      server: 'ollama',
      models: ['qwen2.5vl:7b', 'llama3.1:8b'],
      detected: { supportsImages: true, reasoning: false, contextWindow: 32_768 },
    });
    const show = calls.find((c) => c.url.endsWith('/api/show'));
    expect(show).toMatchObject({ method: 'POST', body: { model: 'qwen2.5vl:7b' } });
    // The key goes only to the endpoint's own origin, without following redirects.
    for (const call of calls) {
      expect(call.url.startsWith('http://127.0.0.1:11434/')).toBe(true);
      expect(call.redirect).toBe('manual');
      expect(call.headers.authorization).toBe('Bearer sk-local');
    }
  });

  it('uses the loaded context of Ollama, else the model maximum', () => {
    const show = {
      capabilities: ['completion', 'thinking'],
      model_info: { 'qwen3.context_length': 40_960 },
    };
    expect(
      parseOllama(show, { models: [{ name: 'qwen3:14b', context_length: 8192 }] }, 'qwen3:14b'),
    ).toEqual({
      server: 'ollama',
      detected: { supportsImages: false, reasoning: true, contextWindow: 8192 },
    });
    expect(parseOllama(show, undefined, 'qwen3:14b')?.detected.contextWindow).toBe(40_960);
    // Another server answering 200 with something else is not Ollama.
    expect(parseOllama({ error: 'nope' }, undefined, 'x')).toBeUndefined();
  });

  it('reads LM Studio: vlm means images, the loaded context first', async () => {
    const { fetchFn } = fakeFetch({
      'http://localhost:1234/api/v0/models': {
        object: 'list',
        data: [
          {
            id: 'google/gemma-3-12b',
            type: 'vlm',
            max_context_length: 131_072,
            loaded_context_length: 16_384,
          },
          { id: 'qwen3-8b', type: 'llm', max_context_length: 40_960 },
          { id: 'text-embedding-nomic', type: 'embeddings', max_context_length: 2048 },
        ],
      },
    });
    const result = await probeCustomEndpoint(
      input({ baseUrl: 'http://localhost:1234/v1', model: 'google/gemma-3-12b' }),
      fetchFn,
    );
    expect(result).toEqual({
      reachable: true,
      server: 'lmstudio',
      models: ['google/gemma-3-12b', 'qwen3-8b'],
      detected: { supportsImages: true, contextWindow: 16_384 },
    });
    expect(
      parseLmStudio(await (await fetchFn('http://localhost:1234/api/v0/models')).json(), 'qwen3-8b')
        ?.detected,
    ).toEqual({
      supportsImages: false,
      contextWindow: 40_960,
    });
  });

  it('reads llama.cpp: /props gives the served context and vision', () => {
    expect(
      parseLlamaCpp({
        default_generation_settings: { n_ctx: 8192, params: {} },
        modalities: { vision: true, audio: false },
      }),
    ).toEqual({ server: 'llamacpp', detected: { supportsImages: true, contextWindow: 8192 } });
    expect(parseLlamaCpp({ default_generation_settings: {} })).toBeUndefined();
  });

  it('reads limits and capabilities that OpenAI-style model lists carry', () => {
    // OpenRouter
    expect(
      parseModelList(
        {
          data: [
            {
              id: 'qwen/qwen3-vl',
              context_length: 262_144,
              architecture: { input_modalities: ['text', 'image'] },
              top_provider: { max_completion_tokens: 32_768 },
              supported_parameters: ['tools', 'reasoning'],
            },
          ],
        },
        'qwen/qwen3-vl',
      )?.detected,
    ).toEqual({
      contextWindow: 262_144,
      maxTokens: 32_768,
      supportsImages: true,
      reasoning: true,
    });
    // vLLM
    expect(parseModelList({ data: [{ id: 'm', max_model_len: 32_768 }] }, 'm')?.detected).toEqual({
      contextWindow: 32_768,
    });
    // Capability objects (Anthropic-style)
    expect(
      parseModelList(
        {
          data: [
            {
              id: 'm',
              max_input_tokens: 200_000,
              max_tokens: 64_000,
              capabilities: { image_input: { supported: true }, thinking: { supported: false } },
            },
          ],
        },
        'm',
      )?.detected,
    ).toEqual({
      contextWindow: 200_000,
      maxTokens: 64_000,
      supportsImages: true,
      reasoning: false,
    });
    // A model the server doesn't list: only the list.
    expect(parseModelList({ data: [{ id: 'a' }, { id: 'b' }] }, 'c')).toEqual({
      models: ['a', 'b'],
      detected: {},
    });
  });

  it('asks Anthropic-compatible servers with their headers at /v1/models', async () => {
    const { fetchFn, calls } = fakeFetch({
      'https://llm.example.test/v1/models': { data: [{ id: 'claude-x' }] },
    });
    const result = await probeCustomEndpoint(
      input({
        baseUrl: 'https://llm.example.test',
        api: 'anthropic-messages',
        model: 'claude-x',
        apiKey: 'sk-ant-test',
      }),
      fetchFn,
    );
    expect(result).toEqual({
      reachable: true,
      server: 'openai',
      models: ['claude-x'],
      detected: {},
    });
    const list = calls.find((c) => c.url.endsWith('/v1/models'));
    expect(list?.headers).toMatchObject({
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
    expect(list?.headers.authorization).toBeUndefined();
  });

  it('tolerates garbage, errors and silence: nothing detected', async () => {
    const { fetchFn } = fakeFetch({
      'http://127.0.0.1:11434/v1/models': 'not json',
      'http://127.0.0.1:11434/api/show': { capabilities: 'vision', model_info: 'x' },
      'http://127.0.0.1:11434/api/ps': new TypeError('fetch failed'),
      'http://127.0.0.1:11434/api/v0/models': { data: [{ id: 42 }] },
      'http://127.0.0.1:11434/props': { default_generation_settings: { n_ctx: 'big' } },
    });
    expect(await probeCustomEndpoint(input(), fetchFn)).toEqual({
      reachable: false,
      models: [],
      detected: {},
    });
  });

  it('drops values outside the contract and gives up after the timeout', async () => {
    expect(
      parseModelList({ data: [{ id: 'm', context_length: 12, max_model_len: -5 }] }, 'm')?.detected,
    ).toEqual({});
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as FetchFn;
    const started = Date.now();
    expect(await probeCustomEndpoint(input(), hanging, 50)).toEqual({
      reachable: false,
      models: [],
      detected: {},
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('lists models without a model name, skipping per-model probes', async () => {
    const { fetchFn, calls } = fakeFetch({
      'http://127.0.0.1:11434/v1/models': { data: [{ id: 'llama3.1:8b' }] },
    });
    const result = await probeCustomEndpoint(input({ model: '' }), fetchFn);
    expect(result.models).toEqual(['llama3.1:8b']);
    expect(calls.some((c) => c.url.endsWith('/api/show'))).toBe(false);
  });

  it('asks only http(s) endpoints', async () => {
    const { fetchFn, calls } = fakeFetch({});
    expect(await probeCustomEndpoint(input({ baseUrl: 'file:///etc' }), fetchFn)).toEqual({
      reachable: false,
      models: [],
      detected: {},
    });
    expect(calls).toEqual([]);
  });
});
