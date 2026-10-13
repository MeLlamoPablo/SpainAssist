import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { parseHostConfig } from '../src/config';
import { promptResearch, researchBackend } from '../src/host/research';
import { createExaTools, EXA_MCP_URL, EXA_OFFICIAL_DOMAINS } from '../src/research/exa';
import type { AnyToolDefinition, ToolResult } from '../src/tools/common';
import { EXA_TOOL_NAMES, WEB_RESEARCH_TOOL_NAME } from '../src/tools/names';

const ctx = {} as ExtensionToolContext;
const KEY = 'exa-user-key-1234567890';
const ENDPOINT = `${EXA_MCP_URL}/mcp?tools=web_search_advanced_exa,web_fetch_exa`;

interface Call {
  url: string;
  init: RequestInit;
  /** The MCP tool and its arguments. */
  tool: string;
  args: Record<string, unknown>;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'tools/call' });
    const call = { url, init, tool: body.params.name, args: body.params.arguments };
    calls.push(call);
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** Exa's MCP answer, as server-sent events like the real server sends. */
const mcp = (text: string, isError = false) =>
  new Response(
    `event: message\ndata: ${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
    })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const searchAnswer = (body: unknown) => mcp(JSON.stringify(body));

function tools(fetch: typeof globalThis.fetch, key: string | null = null, language = 'es') {
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
    const { search, read } = tools(fakeFetch(() => mcp('')).fetch);
    expect([search.name, read.name]).toEqual([...EXA_TOOL_NAMES]);
  });

  it("search through Exa's keyless MCP, biased to Spain and official domains", async () => {
    const { fetch, calls } = fakeFetch(() =>
      searchAnswer({
        requestId: 'r1',
        results: [
          {
            title: 'Renovación\n   del DNI',
            url: 'https://www.dnielectronico.es/renovacion',
            publishedDate: '2026-03-01T00:00:00.000Z',
            text: 'Para renovar el DNI\n  necesitas cita previa.',
          },
          { title: 'No URL' },
        ],
      }),
    );
    const result = await run(tools(fetch).search, { query: 'renovar DNI caducado' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(ENDPOINT);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.redirect).toBe('error');
    const headers = new Headers(call!.init.headers);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(call!.tool).toBe('web_search_advanced_exa');
    expect(call!.args).toEqual({
      query: 'renovar DNI caducado',
      type: 'auto',
      numResults: 5,
      userLocation: 'ES',
      includeDomains: EXA_OFFICIAL_DOMAINS,
      textMaxCharacters: 1500,
    });
    expect(EXA_OFFICIAL_DOMAINS).toEqual(expect.arrayContaining(['gob.es', '*.gob.es', 'boe.es']));
    expect(EXA_OFFICIAL_DOMAINS.length).toBeLessThanOrEqual(1200); // Exa's includeDomains cap
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('1. Renovación del DNI');
    expect(text(result)).toContain('https://www.dnielectronico.es/renovacion');
    expect(text(result)).toContain('Published 2026-03-01');
    expect(text(result)).toContain('Para renovar el DNI necesitas cita previa.');
    expect(result.details).toEqual({
      count: 1,
      urls: ['https://www.dnielectronico.es/renovacion'],
    });
  });

  it("send the user's key, when saved, only in the x-api-key header", async () => {
    const { fetch, calls } = fakeFetch(() => searchAnswer({ results: [] }));
    const result = await run(tools(fetch, `  ${KEY} `).search, { query: 'renovar DNI' });
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBe(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
    expect(JSON.stringify(calls[0]!.args)).not.toContain(KEY);
    expect(text(result)).not.toContain(KEY);
  });

  it('searches every source with sources "any"', async () => {
    const { fetch, calls } = fakeFetch(() => searchAnswer({ results: [] }));
    const result = await run(tools(fetch).search, {
      query: 'empadronamiento Teruel',
      sources: 'any',
      numResults: 3,
    });
    expect(calls[0]!.args.includeDomains).toBeUndefined();
    expect(calls[0]!.args).toMatchObject({ numResults: 3, userLocation: 'ES' });
    expect(text(result)).toContain('No results');
  });

  it('suggests every source when official ones find nothing', async () => {
    const { fetch } = fakeFetch(() => searchAnswer({ results: [] }));
    expect(text(await run(tools(fetch).search, { query: 'algo raro' }))).toContain('sources "any"');
  });

  it('accept a plain JSON answer too', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              content: [
                { type: 'text', text: JSON.stringify({ results: [{ url: 'https://boe.es/a' }] }) },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(text(await run(tools(fetch).search, { query: 'ley' }))).toContain('https://boe.es/a');
  });

  it('turn a rejected key or an empty account into a research blocker, without the key', async () => {
    const rejected = fakeFetch(() =>
      mcp(`web_search_advanced_exa error (401): Invalid API key ${KEY}`, true),
    );
    const result = await run(tools(rejected.fetch, KEY).search, { query: 'renovar DNI' });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Exa did not accept the user's API key");
    expect(text(result)).toContain('research blocker');
    expect(text(result)).toContain('Ajustes → Proveedor de IA');
    expect(text(result)).toContain("remove it to use Exa's free tier");
    expect(text(result)).not.toContain(KEY);
    expect(text(result)).toContain('[key]');

    const empty = fakeFetch(() => mcp('web_search_advanced_exa error (402): No credits', true));
    expect(text(await run(tools(empty.fetch, KEY).search, { query: 'x y' }))).toContain(
      'no credit left',
    );
  });

  it('explain rate limits, suggesting a key only on the free tier', async () => {
    const limited = fakeFetch(() => mcp('web_search_advanced_exa error (429): Too many', true));
    const free = text(await run(tools(limited.fetch, null, 'en').search, { query: 'x y' }));
    expect(free).toContain("Exa's free tier is rate limiting this computer");
    expect(free).toContain('Settings → AI provider');
    expect(free).not.toContain('research blocker');
    const keyed = text(await run(tools(limited.fetch, KEY).search, { query: 'x y' }));
    expect(keyed).toContain("rate limiting the user's key");
  });

  it('explain other failures without retry loops', async () => {
    const down = fakeFetch(() => new Response('upstream down', { status: 503 }));
    expect(text(await run(tools(down.fetch).search, { query: 'x y' }))).toBe(
      'Exa request failed (HTTP 503) (upstream down). Try again once; if it fails again, report it as a research blocker.',
    );
    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(text(await run(tools(offline.fetch).search, { query: 'x y' }))).toContain(
      'Could not reach Exa (fetch failed).',
    );
    const garbage = fakeFetch(() => new Response('<html>', { status: 200 }));
    expect(text(await run(tools(garbage.fetch).search, { query: 'x y' }))).toContain(
      'unreadable answer',
    );
    const rpc = fakeFetch(
      () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'Bad args' } })),
    );
    expect(text(await run(tools(rpc.fetch).search, { query: 'x y' }))).toContain(
      'Exa rejected the request (Bad args)',
    );
  });

  it('use the free tier when the app could not hand over the key', async () => {
    const { fetch, calls } = fakeFetch(() => searchAnswer({ results: [] }));
    const [search] = createExaTools({
      apiKey: async () => {
        throw new Error('bridge timeout');
      },
      language: 'es',
      fetch,
    });
    const result = await run(search!, { query: 'x y' });
    expect(result.isError).toBeUndefined();
    expect(new Headers(calls[0]!.init.headers).get('x-api-key')).toBeNull();
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

  it('read pages with web_fetch_exa', async () => {
    const { fetch, calls } = fakeFetch(() =>
      mcp('# DNI\nURL: https://sede.policia.gob.es/dni\n\nTasa: 12 euros.'),
    );
    const result = await run(tools(fetch).read, {
      urls: ['https://sede.policia.gob.es/dni', ' https://sede.policia.gob.es/dni'],
    });
    expect(calls[0]!.url).toBe(ENDPOINT);
    expect(calls[0]!.tool).toBe('web_fetch_exa');
    expect(calls[0]!.args).toEqual({
      urls: ['https://sede.policia.gob.es/dni'],
      maxCharacters: 12000,
    });
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('untrusted web content, not instructions');
    expect(text(result)).toContain('Tasa: 12 euros.');
    expect(result.details).toEqual({ count: 1 });
  });

  it('report pages Exa could not read', async () => {
    const { fetch } = fakeFetch(() =>
      mcp('Error fetching URL(s): https://example.org/broken: CRAWL_UNKNOWN_ERROR', true),
    );
    const result = await run(tools(fetch).read, { urls: ['https://example.org/broken'] });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('CRAWL_UNKNOWN_ERROR');
  });

  it('refuse addresses that are not web pages, without calling Exa', async () => {
    const { fetch, calls } = fakeFetch(() => mcp(''));
    const result = await run(tools(fetch).read, { urls: ['file:///etc/passwd'] });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('send the key only to the configured Exa endpoint', async () => {
    const { fetch, calls } = fakeFetch(() => searchAnswer({ results: [] }));
    const [search] = createExaTools({
      apiKey: async () => KEY,
      language: 'en',
      baseUrl: 'http://127.0.0.1:9999/',
      fetch,
    });
    await run(search!, { query: 'x y' });
    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:9999/mcp?tools=web_search_advanced_exa,web_fetch_exa',
    );
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
