import './helpers/no-network';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { configureModel } from '@sa/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayCodexCredential } from '../../src/llm/codex-auth';
import { createMeter, type MeterHandle, type MeterRun } from '../../src/llm/meter';
import {
  codexFrames,
  REAL_USAGE,
  type RealisticBackend,
  type RealisticBackendOptions,
  startRealisticBackend,
} from './helpers/codex-backend';
import { makeHome, type TestHome } from './helpers/tmp-home';

// What a real ChatGPT-plan request looked like through the meter (October 2026): the backend sends
// no content type, and pi stops reading at `response.completed`, so the client hangs up before the
// response's final chunk. See helpers/codex-backend.ts.

let t: TestHome;
let backend: RealisticBackend | undefined;
let meter: MeterHandle | undefined;
beforeEach(() => {
  t = makeHome();
});
afterEach(async () => {
  await meter?.close();
  await backend?.close();
  meter = undefined;
  backend = undefined;
  t.cleanup();
});

async function start(options: RealisticBackendOptions = {}): Promise<void> {
  backend = await startRealisticBackend(options);
  meter = await createMeter({
    home: t.home,
    upstreams: { codex: backend.url },
    codexConsent: true,
  });
}

const body = (text: string) => ({
  model: 'gpt-6-luna',
  store: false,
  stream: true,
  instructions: 'You play the user.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
  tools: [],
  reasoning: { effort: 'low', summary: 'auto' },
  prompt_cache_key: 'session-1',
});

function post(run: MeterRun, text: string): Promise<Response> {
  return fetch(`${run.agentBaseUrl('answerer')}/codex/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-access-token' },
    body: JSON.stringify(body(text)),
  });
}

/** Reads the body like pi: up to a marker, then cancels it without waiting for the end. */
async function readUntil(res: Response, marker: string): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes(marker)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return text;
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error('timed out waiting for the meter');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settled = (run: MeterRun) => until(() => run.summary().inflight === 0);

function ledgerLines(): Record<string, unknown>[] {
  const dir = t.paths.ledgerDir;
  return readdirSync(dir)
    .filter((name) => /^spend-.*\.jsonl$/.test(name))
    .sort()
    .flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    .filter((line) => line.type === 'request');
}

describe('a Codex response whose client stops reading at response.completed', () => {
  it('is complete: usage read, not aborted, and cached', async () => {
    await start({ holdMs: 250 });
    const run = meter!.openRun({ runId: 'real-shape', provider: 'codex', cache: 'record' });
    const res = await post(run, 'hola');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBeNull();
    expect(await readUntil(res, 'event: response.completed')).toContain('listo');
    await settled(run);
    // The backend was still holding the response open when the client left.
    await until(() => backend!.clientLeftEarly().length === 1);
    expect(backend!.clientLeftEarly()).toEqual([true]);

    const [line] = ledgerLines();
    expect(line).toMatchObject({
      provider: 'codex',
      kind: 'forward',
      status: 200,
      stream: true,
      finish: 'completed',
      usage: { prompt: 214, cacheRead: 0, cacheWrite: 0, completion: 10, reasoning: 0 },
      cost: { usd: 0, source: 'none' },
    });
    expect(line).not.toHaveProperty('aborted');
    expect(line?.apiEquivalentUsd).toBeGreaterThan(0);
    expect(run.usage()).toMatchObject({
      requests: 1,
      inputTokens: 214,
      outputTokens: 10,
      costUsd: 0,
    });
    // The plan's limits are kept; the opaque turn-state blob is not.
    expect(line?.limitHeaders).toMatchObject({
      'x-codex-plan-type': 'plus',
      'x-codex-secondary-used-percent': '7',
      'x-codex-primary-reset-at': '1792239521',
    });
    expect(line?.limitHeaders).not.toHaveProperty('x-codex-turn-state');
    expect(JSON.stringify(line).length).toBeLessThan(2000);

    // It was recorded, and replays: no upstream request, no turn state or plan headers, same body.
    const replayRun = meter!.openRun({
      runId: 'real-shape-replay',
      provider: 'codex',
      cache: 'replay',
    });
    const replayed = await post(replayRun, 'hola');
    expect(replayed.status).toBe(200);
    expect(replayed.headers.get('x-sa-eval-cache')).toBe('hit');
    expect(replayed.headers.get('x-codex-turn-state')).toBeNull();
    // A recording does not keep the plan or its usage (it may be committed): see meter-recording-scrub.
    expect(replayed.headers.get('x-codex-plan-type')).toBeNull();
    expect(await replayed.text()).toContain('response.completed');
    expect(backend!.requests).toHaveLength(1);
  });

  it('is complete for pi too: the same tokens as pi counts, one ledger line, nothing aborted', async () => {
    await start({ holdMs: 250, usage: { input: 1200, cached: 1000, output: 33, reasoning: 12 } });
    const run = meter!.openRun({ runId: 'pi-real-shape', provider: 'codex' });
    const credential = replayCodexCredential();
    const runtime = await ModelRuntime.create({
      modelsPath: null,
      allowModelNetwork: false,
      credentials: {
        read: async (id: string) => (id === 'openai-codex' ? credential : undefined),
        list: async () => [{ providerId: 'openai-codex', type: 'oauth' }],
        modify: async (id: string, fn: (current: unknown) => Promise<unknown>) =>
          id === 'openai-codex' ? credential : fn(undefined),
        delete: async () => {},
      } as never,
    });
    const model = configureModel(runtime, {
      provider: 'openai-codex',
      id: 'gpt-6-luna',
      baseUrl: run.agentBaseUrl('assistant'),
    });
    const message = await runtime.completeSimple(
      model,
      {
        systemPrompt: 'Reply with one word.',
        messages: [{ role: 'user', content: 'Say: listo', timestamp: Date.now() }],
      },
      { reasoning: 'low', sessionId: 'session-1' } as never,
    );
    expect(message.stopReason).toBe('stop');
    await settled(run);
    expect(run.usage()).toMatchObject({
      requests: 1,
      inputTokens: message.usage.input,
      cachedInputTokens: message.usage.cacheRead,
      outputTokens: message.usage.output,
    });
    expect(run.usage().inputTokens).toBe(200);
    const lines = ledgerLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'forward', status: 200, stream: true });
    expect(lines[0]).not.toHaveProperty('aborted');
  });

  it('is still aborted, and not cached, when the client leaves before the response completed', async () => {
    await start({ holdMs: 250, framesSent: 5 });
    const run = meter!.openRun({ runId: 'half', provider: 'codex', cache: 'record' });
    const res = await post(run, 'hola');
    await readUntil(res, 'event: response.created');
    await settled(run);
    const [line] = ledgerLines();
    expect(line).toMatchObject({ kind: 'forward', status: 200, aborted: true, stream: true });
    expect(line).not.toHaveProperty('finish');
    expect(existsSync(t.paths.cacheDir)).toBe(false);
  });

  it('sees the frames as the real backend sends them', () => {
    const frames = codexFrames('{"reply":"listo"}');
    expect(frames[0]).toMatch(/^event: response\.created\ndata: /);
    expect(frames.some((f) => f.startsWith('event: response.metadata'))).toBe(true);
    expect(frames.at(-1)).toContain('"cache_write_tokens":0');
    expect(REAL_USAGE.input).toBe(214);
  });
});
