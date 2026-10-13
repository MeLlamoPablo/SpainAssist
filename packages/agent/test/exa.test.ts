import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { parseHostConfig } from '../src/config';
import { promptResearch, researchBackend } from '../src/host/research';
import { createExaTools, EXA_API_URL, EXA_OFFICIAL_DOMAINS } from '../src/research/exa';
import type { AnyToolDefinition, ToolResult } from '../src/tools/common';
import { EXA_TOOL_NAMES, WEB_RESEARCH_TOOL_NAME } from '../src/tools/names';

const ctx = {} as ExtensionToolContext;
const KEY = 'exa-user-key-1234567890';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const call = { url, init, body: JSON.parse(String(init.body ?? '{}')) };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function tools(fetch: typeof globalThis.fetch, key: string | null = KEY, language = 'es') {
  const [search, read] = createExaTools({
    apiKey: async () => key ?? undefined,
    language: language as 'es' | 'en',
    fetch,
  });
  return { search: search!, read: read! };
}

async function run(tool: AnyToolDefinition, params: unknown): Promise<ToolResult> {
  return tool.execute('call-1', params, undefined, undefined, ctx) as Promise<ToolResult>;
}

const text = (result: ToolResult) => (result.content[0] as { text: string }).text;

describe('Exa tools', () => {
  it('are exa_search and exa_fetch', () => {
    const { search, read } = tools(fakeFetch(() => json(200, {})).fetch);
    expect([search.name, read.name]).toEqual([...EXA_TOOL_NAMES]);
  });

  it('search the official API with the user key, biased to Spain and official domains', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        requestId: 'r1',
        results: [
          {
            title: 'Renovación del DNI',
            url: 'https://www.dnielectronico.es/renovacion',
            publishedDate: '2026-03-01T00:00:00.000Z',
            text: 'Para renovar el DNI\n  necesitas cita previa.',
          },
          { title: 'No URL' },
        ],
        costDollars: { total: 0.007 },
      }),
    );
    const result = await run(tools(fetch).search, { query: 'renovar DNI caducado' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${EXA_API_URL}/search`);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    expect(new Headers(call!.init.headers).get('x-api-key')).toBe(KEY);
    expect(call!.body).toMatchObject({
      query: 'renovar DNI caducado',
      type: 'auto',
      numResults: 5,
      userLocation: 'ES',
      includeDomains: EXA_OFFICIAL_DOMAINS,
      contents: { text: { maxCharacters: 1500 } },
    });
    expect(EXA_OFFICIAL_DOMAINS).toEqual(expect.arrayContaining(['gob.es', '*.gob.es', 'boe.es']));
    expect(EXA_OFFICIAL_DOMAINS.length).toBeLessThanOrEqual(1200); // Exa's includeDomains cap
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('1. Renovación del DNI');
    expect(text(result)).toContain('https://www.dnielectronico.es/renovacion');
    expect(text(result)).toContain('Published 2026-03-01');
    expect(text(result)).toContain('Para renovar el DNI necesitas cita previa.');
    expect(text(result)).not.toContain(KEY);
    expect(result.details).toEqual({
      count: 1,
      urls: ['https://www.dnielectronico.es/renovacion'],
      costUsd: 0.007,
    });
  });

  it('searches every source with sources "any"', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { results: [] }));
    const result = await run(tools(fetch).search, {
      query: 'empadronamiento Teruel',
      sources: 'any',
      numResults: 3,
    });
    expect(calls[0]!.body.includeDomains).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ numResults: 3, userLocation: 'ES' });
    expect(text(result)).toContain('No results');
  });

  it('suggests every source when official ones find nothing', async () => {
    const { fetch } = fakeFetch(() => json(200, { results: [] }));
    expect(text(await run(tools(fetch).search, { query: 'algo raro' }))).toContain('sources "any"');
  });

  it('report a research blocker without a key, and never call Exa', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const es = await run(tools(fetch, null).search, { query: 'renovar DNI' });
    expect(es.isError).toBe(true);
    expect(text(es)).toContain('Web research is blocked: no Exa API key is saved.');
    expect(text(es)).toContain('Ajustes → Proveedor de IA');
    expect(text(es)).toContain('Do not ask the user for information or execute the procedure');
    const en = await run(tools(fetch, '  ', 'en').read, { urls: ['https://boe.es/x'] });
    expect(text(en)).toContain('Settings → AI provider');
    expect(calls).toHaveLength(0);
  });

  it('turn a rejected key or an empty account into a research blocker, without the key', async () => {
    const rejected = fakeFetch(() => json(401, { error: `Invalid API key ${KEY}` }));
    const result = await run(tools(rejected.fetch).search, { query: 'renovar DNI' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Exa did not accept the user's API key");
    expect(text(result)).toContain('research blocker');
    expect(text(result)).not.toContain(KEY);
    expect(text(result)).toContain('[key]');

    const empty = fakeFetch(() => json(402, { error: 'Insufficient credits' }));
    expect(text(await run(tools(empty.fetch).search, { query: 'x y' }))).toContain(
      'no credit left',
    );
  });

  it('explain rate limits and other failures without retry loops', async () => {
    const limited = fakeFetch(() => json(429, { error: 'Too many requests' }));
    expect(text(await run(tools(limited.fetch).search, { query: 'x y' }))).toContain(
      'rate limiting',
    );
    const down = fakeFetch(() => new Response('upstream down', { status: 503 }));
    const result = await run(tools(down.fetch).search, { query: 'x y' });
    expect(text(result)).toBe(
      'Exa request failed (HTTP 503) (upstream down). Try again once; if it fails again, report it as a research blocker.',
    );
    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(text(await run(tools(offline.fetch).search, { query: 'x y' }))).toContain(
      'Could not reach Exa (fetch failed).',
    );
  });

  it('explain when the app could not hand over the key', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const [search] = createExaTools({
      apiKey: async () => {
        throw new Error('bridge timeout');
      },
      language: 'es',
      fetch,
    });
    const result = await run(search!, { query: 'x y' });
    expect(text(result)).toContain('Could not get the Exa key from the app (bridge timeout)');
    expect(calls).toHaveLength(0);
  });

  it('propagate cancellation', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(() => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(
      tools(fetch).search.execute(
        'call-1',
        { query: 'renovar DNI' },
        controller.signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('read pages through /contents, listing the ones Exa could not read', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        results: [
          {
            url: 'https://sede.policia.gob.es/dni',
            title: 'DNI',
            text: 'Tasa: 12 euros.',
          },
        ],
        statuses: [
          { id: 'https://sede.policia.gob.es/dni', status: 'success' },
          {
            id: 'https://example.org/broken',
            status: 'error',
            error: { tag: 'CRAWL_NOT_FOUND', httpStatusCode: 404 },
          },
        ],
        costDollars: { total: 0.002 },
      }),
    );
    const result = await run(tools(fetch).read, {
      urls: [
        'https://sede.policia.gob.es/dni',
        ' https://sede.policia.gob.es/dni',
        'https://example.org/broken',
      ],
      fresh: true,
    });
    expect(calls[0]!.url).toBe(`${EXA_API_URL}/contents`);
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBe(KEY);
    expect(calls[0]!.body).toEqual({
      urls: ['https://sede.policia.gob.es/dni', 'https://example.org/broken'],
      text: { maxCharacters: 12000 },
      maxAgeHours: 0,
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('# DNI\nhttps://sede.policia.gob.es/dni');
    expect(text(result)).toContain('Tasa: 12 euros.');
    expect(text(result)).toContain(
      'Could not read https://example.org/broken: CRAWL_NOT_FOUND (HTTP 404).',
    );
    expect(result.details).toEqual({ count: 1, failed: 1, costUsd: 0.002 });
  });

  it('refuse addresses that are not web pages, without calling Exa', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const result = await run(tools(fetch).read, { urls: ['file:///etc/passwd'] });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('send the key only to the configured Exa endpoint', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { results: [] }));
    const [search] = createExaTools({
      apiKey: async () => KEY,
      language: 'en',
      baseUrl: 'http://127.0.0.1:9999/',
      fetch,
    });
    await run(search!, { query: 'x y' });
    expect(calls[0]!.url).toBe('http://127.0.0.1:9999/search');
  });
});

describe('web research per provider kind', () => {
  const base = { procedureId: 'p1', sessionFile: '/tmp/p1.jsonl', language: 'es' };
  const config = (model: Record<string, unknown>, research: Record<string, unknown> = {}) =>
    parseHostConfig({ ...base, model, research });
  const keyServerUrl = 'https://keys.example.org';
  const yes = async () => true;
  const no = async () => false;

  it('BYOK and custom endpoints research with Exa, never web_research', async () => {
    expect(
      await researchBackend(config({ provider: 'anthropic', id: 'c' }, { exa: true }), no),
    ).toBe('exa');
    const custom = config(
      { provider: 'custom', id: 'm', baseUrl: 'http://127.0.0.1:1/v1' },
      { exa: true, keyServerUrl },
    );
    expect(await researchBackend(custom, no)).toBe('exa');
    // An OpenAI API key (BYOK) does not spend a ChatGPT plan.
    expect(await researchBackend(config({ provider: 'openai', id: 'g' }, { exa: true }), yes)).toBe(
      'exa',
    );
    expect(promptResearch('exa')).toBe('exa');
  });

  it('vouchers and ChatGPT plans keep web_research', async () => {
    const voucher = config(
      { provider: 'litellm', id: 'm', baseUrl: 'https://llm.example.org/v1' },
      { keyServerUrl },
    );
    expect(await researchBackend(voucher, no)).toBe('key server');
    expect(await researchBackend(config({ provider: 'openai', id: 'g' }), yes)).toBe('chatgpt');
    expect(await researchBackend(config({ provider: 'openai-codex', id: 'g' }), yes)).toBe(
      'chatgpt',
    );
    expect(promptResearch('key server')).toBe(WEB_RESEARCH_TOOL_NAME);
    expect(promptResearch('chatgpt')).toBe(WEB_RESEARCH_TOOL_NAME);
  });

  it('the assistant and providers without research get none', async () => {
    const assistant = parseHostConfig({
      ...base,
      role: 'assistant',
      model: { provider: 'anthropic', id: 'c' },
      research: { exa: true },
    });
    expect(await researchBackend(assistant, yes)).toBeUndefined();
    expect(await researchBackend(config({ provider: 'openai', id: 'g' }), no)).toBeUndefined();
    expect(await researchBackend(config({ provider: 'anthropic', id: 'c' }), no)).toBeUndefined();
    expect(promptResearch(undefined)).toBeUndefined();
  });
});
