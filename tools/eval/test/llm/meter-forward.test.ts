import './helpers/no-network';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MeterEvent } from '../../src/llm/meter';
import {
  API_KEY,
  chatBody,
  completionText,
  type MeterEnv,
  post,
  postStreaming,
  startEnv,
  userMessage,
} from './helpers/meter-env';

describe('meter proxy: forwarding', () => {
  let env: MeterEnv;
  beforeEach(async () => {
    env = await startEnv();
  });
  afterEach(() => env.close());

  it('forwards the request bytes untouched and the upstream sees the production path', async () => {
    const run = env.openRun();
    const body = JSON.stringify(chatBody([userMessage('Sácame la vida laboral 🇪🇸')]));
    const res = await fetch(`${run.agentBaseUrl('procedure-1')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        'x-custom-header': 'kept',
        'user-agent': 'pi (test)',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(completionText(await res.text())).toBe('ok');

    const seen = env.llm.requests().at(-1)!;
    expect(seen.method).toBe('POST');
    // The agent prefix is gone: the gateway sees /v1/chat/completions, exactly as in production.
    expect(seen.path).toBe('/v1/chat/completions');
    expect(JSON.stringify(seen.body)).toBe(body);
    expect(seen.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(seen.headers['x-custom-header']).toBe('kept');
    expect(seen.headers['user-agent']).toBe('pi (test)');
    expect(seen.headers['accept-encoding']).toBe('identity');
    expect(seen.headers.host).toBe(new URL(env.llm.url).host);
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength(body)));
    expect(seen.headers.connection).not.toBe('upgrade');
  });

  it("streams the response with its headers, including the gateway's x-litellm-*", async () => {
    const run = env.openRun();
    const direct = await fetch(`${env.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(chatBody([userMessage('hola')])),
    });
    const directText = await direct.text();
    const res = await post(run, 'procedure-1', chatBody([userMessage('hola')]));
    expect(res.headers.get('content-type')).toBe(direct.headers.get('content-type'));
    expect(res.headers.get('x-litellm-response-cost')).toBe(
      direct.headers.get('x-litellm-response-cost'),
    );
    expect(res.headers.get('x-litellm-key-spend')).not.toBeNull();
    // Same stream, byte for byte (ids differ only by the mock's counter).
    const text = await res.text();
    // (the mock's completion ids and timestamps are the only things that differ between two calls)
    const normalize = (raw: string) =>
      raw.replace(/chatcmpl-mock-\d+/g, 'ID').replace(/"created":\d+/g, '"created":0');
    expect(normalize(text)).toBe(normalize(directText));
    expect(res.headers.get('x-sa-eval')).toBeNull();
  });

  it('refuses what is not a model call (model list, key info, embeddings): no budget covers it', async () => {
    const run = env.openRun();
    const events: MeterEvent[] = [];
    run.on((event) => events.push(event));
    const base = run.agentBaseUrl('procedure-1');
    const headers = { authorization: `Bearer ${API_KEY}` };
    const refused = [
      await fetch(`${base}/models`, { headers }),
      await fetch(`${base}/key/info`, { headers }),
      await fetch(`${base}/embeddings`, { method: 'POST', headers, body: '{"input":"x"}' }),
      await fetch(`${base}/chat/completions`, { headers }),
      await fetch(`${env.meter.url}/r/${run.token}/a/procedure-1/v1/messages`, {
        method: 'POST',
        headers,
        body: '{}',
      }),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(res.headers.get('x-sa-eval')).toBe('path_not_allowed');
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('path_not_allowed');
      expect(body.error.message).toContain('chat/completions');
    }
    // Nothing reached the upstream; every refusal is in the ledger and counted, and none ends the run.
    expect(env.llm.requests()).toHaveLength(0);
    expect(
      env.ledgerLines().map((line) => [line.kind, line.reason, line.path, line.status]),
    ).toEqual([
      ['reject', 'path_not_allowed', '/v1/models', 403],
      ['reject', 'path_not_allowed', '/v1/key/info', 403],
      ['reject', 'path_not_allowed', '/v1/embeddings', 403],
      ['reject', 'path_not_allowed', '/v1/chat/completions', 403],
      ['reject', 'path_not_allowed', '/v1/messages', 403],
    ]);
    expect(run.summary().rejects).toEqual({ path_not_allowed: 5 });
    expect(run.usage().requests).toBe(0);
    expect(events).toEqual([]);
    // The model path itself still works.
    expect((await post(run, 'procedure-1', chatBody([userMessage('hola')]))).status).toBe(200);
  });

  it('serves hosts configured without the upstream base path', async () => {
    const run = env.openRun();
    const bare = run.agentBaseUrl('procedure-1').replace(/\/v1$/, '');
    expect(bare).not.toMatch(/\/v1$/);
    const res = await fetch(`${bare}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(chatBody([userMessage('x')])),
    });
    expect(res.status).toBe(200);
    expect(env.llm.requests().at(-1)?.path).toBe('/v1/chat/completions');
    await res.text();
  });

  it('puts the upstream base path in the agent URL', () => {
    const run = env.openRun();
    const url = run.agentBaseUrl('procedure-1');
    expect(url).toBe(`${env.meter.url}/r/${run.token}/a/procedure-1/v1`);
    expect(env.meter.agentBaseUrl(run.token, 'answerer')).toBe(
      `${env.meter.url}/r/${run.token}/a/answerer/v1`,
    );
    expect(() => env.meter.agentBaseUrl('f'.repeat(32), 'x')).toThrow(/Unknown run/);
    expect(() => run.agentBaseUrl('bad/key')).toThrow(/Invalid agent key/);
    expect(() => run.agentBaseUrl('')).toThrow(/Invalid agent key/);
  });

  it('serves several runs and agents from one proxy, each with its own usage', async () => {
    const a = env.openRun();
    const b = env.openRun();
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
    await (await post(a, 'assistant', chatBody([userMessage('1')]))).text();
    await (await post(a, 'procedure-1', chatBody([userMessage('2')]))).text();
    await (await post(a, 'procedure-1', chatBody([userMessage('3')]))).text();
    await (await post(b, 'assistant', chatBody([userMessage('4')]))).text();
    expect(a.usage().requests).toBe(3);
    expect(b.usage().requests).toBe(1);
    expect(a.agentUsage('procedure-1').requests).toBe(2);
    expect(a.agentUsage('assistant').requests).toBe(1);
    expect(a.agentKeys().sort()).toEqual(['assistant', 'procedure-1']);
    expect(b.agentKeys()).toEqual(['assistant']);
    expect(a.agentUsage('never-used')).toMatchObject({ requests: 0, costUsd: 0 });
    // Asking about an agent does not make it one.
    expect(a.agentKeys().sort()).toEqual(['assistant', 'procedure-1']);
  });

  it('only serves registered run tokens and refuses non-loopback Host headers', async () => {
    const run = env.openRun();
    const wrong = await fetch(`${env.meter.url}/r/${'0'.repeat(32)}/a/x/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    expect(wrong.status).toBe(404);
    expect(await fetch(`${env.meter.url}/anything`)).toMatchObject({ status: 404 });
    expect(await fetch(`${env.meter.url}/r/not-a-token/a/x/v1/models`)).toMatchObject({
      status: 404,
    });

    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(env.meter.url);
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: `/r/${run.token}/a/x/v1/models`,
          headers: { host: 'attacker.example' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(env.llm.requests()).toHaveLength(0);

    // A closed run stops being served.
    const closed = run.close();
    expect(closed.runId).toBe(run.runId);
    const after = await fetch(`${run.agentBaseUrl('x')}/models`);
    expect(after.status).toBe(404);
  });

  it('refuses WebSocket upgrades with 426 so pi falls back to SSE, without reaching the upstream', async () => {
    const run = env.openRun();
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(run.agentBaseUrl('procedure-1'));
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}/codex/responses`,
          headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGVzdA==' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('upgrade', () => resolve(101));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(426);
    expect(env.llm.requests()).toHaveLength(0);
  });

  it('answers 502 when the upstream is unreachable, and does not charge for it', async () => {
    await env.llm.close();
    const run = env.openRun();
    const res = await post(run, 'procedure-1', chatBody([userMessage('x')]));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe('upstream_error');
    expect(run.usage()).toMatchObject({ requests: 1, costUsd: 0 });
    expect(env.ledgerLines().at(-1)).toMatchObject({ kind: 'forward', status: 502 });
  });

  it('rejects bodies over the limit', async () => {
    const small = await startEnv({ meter: { maxBodyBytes: 200 } });
    try {
      const run = small.openRun();
      const res = await post(run, 'x', chatBody([userMessage('y'.repeat(1000))]));
      expect(res.status).toBe(413);
      expect(small.llm.requests()).toHaveLength(0);
    } finally {
      await small.close();
    }
  });

  it('streams in small pieces without waiting for the whole answer', async () => {
    await env.llm.close();
    env = await startEnv({
      mock: {
        scenario: { rules: [], fallback: { text: 'x'.repeat(60) } },
        chunkSize: 5,
        chunkDelayMs: 25,
      },
    });
    const run = env.openRun();
    const res = await postStreaming(run, 'procedure-1', chatBody([userMessage('x')]));
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now();
    let more = 0;
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
      more++;
    }
    expect(first.done).toBe(false);
    expect(more).toBeGreaterThan(3);
    // The first bytes came well before the stream ended (12 chunks at 25 ms).
    expect(Date.now() - firstAt).toBeGreaterThan(100);
  });
});

describe('meter proxy: usage, cost and events', () => {
  let env: MeterEnv;
  afterEach(() => env.close());

  it('reads cached, cache-write and reasoning tokens and takes the cost from the gateway header', async () => {
    env = await startEnv({
      mock: {
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
      },
    });
    const run = env.openRun();
    const res = await post(run, 'procedure-1', chatBody([userMessage('x')]));
    const gatewayCost = Number(res.headers.get('x-litellm-response-cost'));
    await res.text();
    expect(run.usage()).toEqual({
      requests: 1,
      inputTokens: 500,
      cachedInputTokens: 8000,
      cacheWriteTokens: 1500,
      outputTokens: 200,
      reasoningTokens: 120,
      costUsd: gatewayCost,
      cacheHits: 0,
      looseHits: 0,
    });
    const line = env.ledgerLines()[0]!;
    expect(line).toMatchObject({
      kind: 'forward',
      status: 200,
      stream: true,
      agent: 'procedure-1',
      model: 'anthropic/claude-haiku-5.5',
      usage: { prompt: 10_000, cacheRead: 8000, cacheWrite: 1500, completion: 200, reasoning: 120 },
      cost: { source: 'header' },
      litellm: { responseCostUsd: gatewayCost },
    });
  });

  it('bills cache writes that only the top-level Anthropic usage fields carry (pi ignores them)', async () => {
    env = await startEnv({
      mock: {
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
        litellm: { usageShape: 'anthropic', responseCostHeader: false },
      },
    });
    const run = env.openRun();
    await (await post(run, 'procedure-1', chatBody([userMessage('x')]))).text();
    expect(run.usage()).toMatchObject({
      inputTokens: 1000,
      cachedInputTokens: 1000,
      cacheWriteTokens: 2000,
    });
    // No header and no usage cost: the price table prices the write at $0.125 per million.
    const expected = (1000 * 0.1 + 1000 * 0.01 + 2000 * 0.125 + 50 * 0.5) / 1e6;
    expect(run.usage().costUsd).toBeCloseTo(expected, 12);
    expect(env.ledgerLines()[0]).toMatchObject({ cost: { source: 'estimate' } });
  });

  it('takes the cost from the usage chunk when there is no header, before the price table', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: 'ok',
            usage: { promptTokens: 1000, completionTokens: 100, costUsd: 0.0777 },
          },
        },
        litellm: { responseCostHeader: false, costInUsage: true },
      },
    });
    const run = env.openRun();
    await (await post(run, 'procedure-1', chatBody([userMessage('x')]))).text();
    expect(run.usage().costUsd).toBeCloseTo(0.0777, 12);
    expect(env.ledgerLines()[0]).toMatchObject({ cost: { source: 'usage' } });
  });

  it('falls back to the configured price table: Haiku at $0.10 / $0.50 per million tokens', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: { text: 'ok', usage: { promptTokens: 20_000, completionTokens: 1_000 } },
        },
        litellm: { responseCostHeader: false },
      },
    });
    const run = env.openRun();
    await (await post(run, 'procedure-1', chatBody([userMessage('x')]))).text();
    expect(run.usage().costUsd).toBeCloseTo((20_000 * 0.1 + 1_000 * 0.5) / 1e6, 12);
    expect(env.ledgerLines()[0]).toMatchObject({ cost: { source: 'estimate' } });
  });

  it('lets the caller override or extend the price table', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: { text: 'ok', usage: { promptTokens: 1_000_000, completionTokens: 0 } },
        },
        litellm: { responseCostHeader: false },
      },
      meter: {
        prices: {
          'anthropic/claude-haiku-5.5': { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        },
      },
    });
    const run = env.openRun({ limits: { perRunUsd: 100, dailyUsd: 100 } });
    await (await post(run, 'procedure-1', chatBody([userMessage('x')]))).text();
    expect(run.usage().costUsd).toBeCloseTo(1, 12);
  });

  it('charges an unknown model at the dear fallback price', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: { text: 'ok', usage: { promptTokens: 1000, completionTokens: 0 } },
        },
        litellm: { responseCostHeader: false },
      },
    });
    const run = env.openRun();
    await (
      await post(run, 'procedure-1', chatBody([userMessage('x')], { model: 'vendor/unknown-9' }))
    ).text();
    expect(run.usage().costUsd).toBeCloseTo((1000 * 3) / 1e6, 12);
  });

  it('works with non-streamed JSON completions too', async () => {
    env = await startEnv();
    const run = env.openRun();
    const res = await post(
      run,
      'answerer',
      chatBody([userMessage('x')], { stream: false, stream_options: undefined }),
    );
    expect(completionText(await res.text())).toBe('ok');
    expect(run.usage()).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 100 });
    expect(env.ledgerLines()[0]).toMatchObject({ stream: false, status: 200 });
  });

  it("emits a usage event per finished request with the agent's and the run's totals", async () => {
    env = await startEnv();
    const run = env.openRun();
    const events: MeterEvent[] = [];
    const off = run.on((event) => events.push(event));
    await (await post(run, 'assistant', chatBody([userMessage('1')]))).text();
    await (await post(run, 'procedure-1', chatBody([userMessage('2')]))).text();
    off();
    await (await post(run, 'procedure-1', chatBody([userMessage('3')]))).text();
    expect(events.map((e) => e.type)).toEqual(['usage', 'usage']);
    const second = events[1] as Extract<MeterEvent, { type: 'usage' }>;
    expect(second.runId).toBe(run.runId);
    expect(second.agent).toBe('procedure-1');
    expect(second.request).toMatchObject({
      kind: 'forward',
      status: 200,
      aborted: false,
      model: 'anthropic/claude-haiku-5.5',
    });
    expect(second.request.usage.prompt).toBe(1000);
    expect(second.agentUsage.requests).toBe(1);
    expect(second.runUsage.requests).toBe(2);
  });

  it('survives a throwing subscriber', async () => {
    env = await startEnv();
    const run = env.openRun();
    const seen: string[] = [];
    run.on(() => {
      throw new Error('subscriber bug');
    });
    run.on((event) => seen.push(event.type));
    const res = await post(run, 'x', chatBody([userMessage('x')]));
    expect(res.status).toBe(200);
    await res.text();
    expect(seen).toEqual(['usage']);
  });

  it('summarizes a run: usage, agents, refusals', async () => {
    env = await startEnv();
    const run = env.openRun();
    await (await post(run, 'assistant', chatBody([userMessage('1')]))).text();
    const summary = run.summary();
    expect(summary).toMatchObject({
      runId: run.runId,
      provider: 'voucher',
      cache: 'off',
      replayedCostUsd: 0,
      apiEquivalentUsd: 0,
      rejects: {},
      inflight: 0,
    });
    expect(summary.agents.assistant?.usage.requests).toBe(1);
    expect(run.close().usage.requests).toBe(1);
  });

  it('starts a resumed run from the usage of its checkpoint', async () => {
    env = await startEnv();
    const baseline = {
      requests: 10,
      inputTokens: 5000,
      cachedInputTokens: 100,
      cacheWriteTokens: 0,
      outputTokens: 700,
      reasoningTokens: 50,
      costUsd: 0.4,
      cacheHits: 6,
    };
    // 0.4 already spent: one request (reserve about $0.0041) fits under the cap, a bigger one does not.
    const run = env.openRun({ baseline, limits: { perRunUsd: 0.4055 } });
    expect(run.usage()).toEqual({ ...baseline, looseHits: 0 });
    await (await post(run, 'procedure-1', chatBody([userMessage('x')]))).text();
    expect(run.usage()).toMatchObject({ requests: 11, cacheHits: 6, inputTokens: 6000 });
    const refused = await post(
      run,
      'procedure-1',
      chatBody([userMessage('y')], { max_tokens: 30_000 }),
    );
    expect(refused.status).toBe(402);
    await refused.text();
  });
});
