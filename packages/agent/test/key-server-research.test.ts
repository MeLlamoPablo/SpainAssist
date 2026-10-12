import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import { createKeyServerResearchTool } from '../src/research/key-server-research';
import type { ToolResult } from '../src/tools/common';

const ctx = {} as ExtensionToolContext;
const RUN = '0b6c1d7e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
const KEY = 'sk-litellm-voucher-key';

const frame = (data: unknown) =>
  `event: ${(data as { type: string }).type}\ndata: ${JSON.stringify(data)}\n\n`;
const created = frame({ type: 'created', id: RUN, priceUsd: 0.05 });
const progress = frame({ type: 'progress', id: RUN, status: 'running', elapsedSeconds: 25 });
const completed = frame({
  type: 'completed',
  id: RUN,
  output: { type: 'text', content: 'Información oficial', basis: [{ field: 'output' }] },
});

function sse(frames: string[]): Response {
  return new Response(frames.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

function fakeFetch(answers: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer(call);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function tool(fetch: typeof globalThis.fetch, apiKey: string | null = KEY) {
  return createKeyServerResearchTool({
    keyServerUrl: 'https://keys.example.org/',
    apiKey: async () => apiKey ?? undefined,
    language: 'es',
    fetch,
  });
}

describe('web research through the key server', () => {
  it('requires a mode and says nothing about which one to pick', () => {
    const { description, parameters } = tool(fakeFetch([]).fetch);
    const schema = parameters as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['query', 'mode']));
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['fast', 'balanced', 'deep'] });
    expect(description).not.toMatch(/\b(fast|balanced|deep|mode)\b/i);
  });

  it('streams one run in the chosen mode and returns its output', async () => {
    const fake = fakeFetch([() => sse([created, progress, completed])]);
    const updates: ToolResult[] = [];
    const result = await tool(fake.fetch).execute(
      'call',
      { query: 'renovar el NIE', mode: 'deep', outputSchema: { type: 'object' } },
      undefined,
      (update: ToolResult) => updates.push(update),
      ctx,
    );
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.url).toBe('https://keys.example.org/v1/research');
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(call!.headers.get('accept')).toBe('text/event-stream');
    expect(call!.body).toEqual({
      input: 'renovar el NIE',
      mode: 'deep',
      outputSchema: { type: 'object' },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[0]!.content[0]).toMatchObject({ text: 'Investigando fuentes…' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      success: true,
      id: RUN,
      outputReady: true,
      output: { content: 'Información oficial' },
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('follows the same run again when the stream drops', async () => {
    const fake = fakeFetch([() => sse([created, progress]), () => sse([created, completed])]);
    const result = await tool(fake.fetch).execute(
      'call',
      { query: 'x', mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(fake.calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'https://keys.example.org/v1/research'],
      ['GET', `https://keys.example.org/v1/research/${RUN}/events`],
    ]);
    expect(fake.calls[1]!.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(result.structuredContent).toMatchObject({ success: true });
  });

  it('reports failed runs without asking for a retry loop', async () => {
    const fake = fakeFetch([
      () =>
        sse([
          created,
          frame({
            type: 'failed',
            id: RUN,
            code: 'failed',
            message: 'The research run failed. It was not charged.',
            charged: false,
          }),
        ]),
    ]);
    const result = await tool(fake.fetch).execute(
      'call',
      { query: 'x', mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('not charged');
  });

  it('explains an empty voucher', async () => {
    const fake = fakeFetch([
      () =>
        new Response(
          JSON.stringify({ error: { code: 'insufficient_budget', message: 'Not enough' } }),
          { status: 402, headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const result = await tool(fake.fetch).execute(
      'call',
      { query: 'x', mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('no credit left');
  });

  it('is blocked without a voucher key', async () => {
    const fake = fakeFetch([() => sse([])]);
    const result = await tool(fake.fetch, null).execute(
      'call',
      { query: 'x', mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it('propagates a user abort', async () => {
    const controller = new AbortController();
    const fetch = (async (_url: string, init?: RequestInit) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      return sse([]);
    }) as typeof globalThis.fetch;
    await expect(
      tool(fetch).execute('call', { query: 'x', mode: 'fast' }, controller.signal, undefined, ctx),
    ).rejects.toThrow();
  });
});
