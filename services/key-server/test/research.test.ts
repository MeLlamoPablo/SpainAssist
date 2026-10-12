import { randomUUID } from 'node:crypto';
import { ResearchEvent, ResearchRunInfo } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { sha256Hex } from '../src/crypto';
import { ParallelTaskApi } from '../src/research/parallel';
import type { ResearchSettings } from '../src/research/service';
import { insertIssuedKey } from '../src/store';
import {
  errorCode,
  type FetchCall,
  fakeFetch,
  fakeLiteLLM,
  type Harness,
  jsonResponse,
  litellmProvisioner,
  setup,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const PARALLEL_KEY = 'parallel-test-key-0123456789';
const SECRET_INPUT = 'Requisitos para renovar el NIE en Málaga';
const SECRET_OUTPUT = 'Pide cita en la Comisaría de Málaga';

type Script = Array<'pending' | 'completed' | 'failed' | 'error'>;

/**
 * Fake Parallel Task API behind an injected fetch. Each run answers its result calls from
 * `script` in order (the last entry repeats): `pending` = 408, `completed` = 200 with an
 * output, `failed` = 404 + status "failed", `error` = 503.
 */
function fakeParallel(options: { script?: Script; create?: (call: FetchCall) => Response } = {}) {
  const script = options.script ?? ['pending', 'completed'];
  const polls = new Map<string, number>();
  let n = 0;
  const fake = fakeFetch((call) => {
    const url = new URL(call.url);
    if (url.pathname === '/v1/tasks/runs' && call.method === 'POST') {
      const custom = options.create?.(call);
      if (custom) return custom;
      n++;
      return jsonResponse({ run_id: `trun_${n}`, status: 'queued', is_active: true });
    }
    const result = /^\/v1\/tasks\/runs\/([^/]+)\/result$/.exec(url.pathname);
    if (result) {
      const id = result[1]!;
      const i = polls.get(id) ?? 0;
      polls.set(id, i + 1);
      const step = script[Math.min(i, script.length - 1)]!;
      if (step === 'pending') return jsonResponse({ type: 'error', error: {} }, 408);
      if (step === 'error') return jsonResponse({ type: 'error', error: {} }, 503);
      if (step === 'failed') return jsonResponse({ type: 'error', error: {} }, 404);
      return jsonResponse({
        run: { run_id: id, status: 'completed', is_active: false, processor: 'core2x' },
        output: {
          type: 'json',
          content: { answer: SECRET_OUTPUT },
          basis: [{ field: 'answer', citations: [{ url: 'https://sede.example.gob.es/' }] }],
        },
      });
    }
    const status = /^\/v1\/tasks\/runs\/([^/]+)$/.exec(url.pathname);
    if (status) {
      return jsonResponse({ run_id: status[1], status: 'failed', is_active: false });
    }
    return jsonResponse({ type: 'error', error: {} }, 404);
  });
  const creates = () =>
    fake.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/tasks/runs'));
  return { ...fake, creates };
}

async function harness(
  options: {
    script?: Script;
    create?: (call: FetchCall) => Response;
    settings?: Partial<ResearchSettings>;
    update?: (call: FetchCall) => Response | undefined;
    now?: () => number;
  } = {},
) {
  const litellm = fakeLiteLLM({ update: options.update, realHashes: true });
  const parallel = fakeParallel({ script: options.script, create: options.create });
  h = await setup({
    provisioner: litellmProvisioner(litellm.fetch),
    research: {
      upstream: new ParallelTaskApi({
        apiKey: PARALLEL_KEY,
        baseUrl: 'https://parallel.test',
        fetch: parallel.fetch,
      }),
      settings: { pollSeconds: 1, ...options.settings },
      now: options.now,
    },
  });
  return { h, litellm, parallel };
}

/** Redeems a fresh voucher and returns its key and LiteLLM token id. */
async function voucherKey(harness: Harness, amountUsd = 5) {
  const [code] = await harness.createVouchers({ amountUsd });
  const body = (await (await harness.redeem(code!)).json()) as { apiKey: string };
  const { rows } = await harness.db.query<{ key_hash: string }>(
    'SELECT key_hash FROM issued_keys ORDER BY created_at DESC LIMIT 1',
  );
  return { apiKey: body.apiKey, tokenId: rows[0]!.key_hash };
}

async function sseEvents(res: Response): Promise<ResearchEvent[]> {
  const text = await res.text();
  return text
    .split(/\n\n/)
    .map((frame) => frame.split('\n').find((line) => line.startsWith('data:')))
    .filter((line): line is string => !!line)
    .map((line) => ResearchEvent.parse(JSON.parse(line.slice(5))));
}

/** POSTs a research request; `mode` defaults to "balanced" (core2x at $0.05 in these tests). */
function research(harness: Harness, apiKey: string | undefined, body: Record<string, unknown>) {
  return harness.request('POST', '/v1/research', {
    token: apiKey,
    body: { mode: 'balanced', ...body },
  });
}

async function runRows(harness: Harness) {
  const { rows } = await harness.db.query<Record<string, unknown>>(
    `SELECT state, processor, price_usd::float8 AS price_usd, parallel_run_id
       FROM research_runs ORDER BY created_at`,
  );
  return rows;
}

describe('POST /v1/research', () => {
  it("reserves the price, runs the mode's processor on Parallel and streams the result", async () => {
    const { h, litellm, parallel } = await harness();
    const key = await voucherKey(h);

    const res = await research(h, key.apiKey, {
      input: SECRET_INPUT,
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await sseEvents(res);
    // Progress events depend on timing (the run is followed before the client attaches).
    const types = events.map((e) => e.type).filter((t) => t !== 'progress');
    expect(types).toEqual(['created', 'completed']);
    expect(events[0]).toMatchObject({ priceUsd: 0.05 });
    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      output: { type: 'json', content: { answer: SECRET_OUTPUT }, basis: [expect.any(Object)] },
    });

    // The mode picks our processor; the input and schema are the client's.
    const create = parallel.creates()[0]!;
    expect(create.headers.get('x-api-key')).toBe(PARALLEL_KEY);
    expect(create.body).toEqual({
      input: SECRET_INPUT,
      processor: 'core2x',
      metadata: { sa_run: events[0]!.id },
      task_spec: {
        output_schema: {
          type: 'json',
          json_schema: { type: 'object', properties: { answer: { type: 'string' } } },
        },
      },
    });

    // Charged by lowering max_budget (never by writing spend), with the master key.
    const update = litellm.calls.find((c) => c.url.endsWith('/key/update'))!;
    expect(update.body).toEqual({ key: key.tokenId, max_budget: 4.95 });
    expect(update.headers.get('authorization')).toBe('Bearer sk-master-test-0123456789');
    expect(litellm.keys.get(key.tokenId)).toMatchObject({ max_budget: 4.95, spend: 0 });
    expect(await runRows(h)).toEqual([
      { state: 'completed', processor: 'core2x', price_usd: 0.05, parallel_run_id: 'trun_1' },
    ]);

    // Nothing of the research reaches the logs or the database.
    const logs = h.logs.join('\n');
    expect(logs).toContain('research completed');
    for (const secret of [SECRET_INPUT, SECRET_OUTPUT, key.apiKey, PARALLEL_KEY]) {
      expect(logs).not.toContain(secret);
    }
    const dump = JSON.stringify(
      (await h.db.query('SELECT * FROM research_runs')).rows.concat(
        (await h.db.query('SELECT * FROM issued_keys')).rows,
      ),
    );
    expect(dump).not.toContain(SECRET_INPUT);
    expect(dump).not.toContain(SECRET_OUTPUT);
  });

  it('settles the run even when the client leaves', async () => {
    const { h, litellm } = await harness({ script: ['pending', 'pending', 'completed'] });
    const key = await voucherKey(h);
    const res = await research(h, key.apiKey, { input: 'x' });
    await res.body?.cancel();
    for (let i = 0; i < 50 && (await runRows(h))[0]?.state !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await runRows(h)).toMatchObject([{ state: 'completed' }]);
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.95);
  });

  it('runs and charges each mode with its processor', async () => {
    const { h, litellm, parallel } = await harness();
    const key = await voucherKey(h);
    for (const mode of ['fast', 'balanced', 'deep']) {
      const [created] = await sseEvents(await research(h, key.apiKey, { input: 'x', mode }));
      expect(created).toMatchObject({ type: 'created' });
    }
    expect(parallel.creates().map((c) => (c.body as { processor: string }).processor)).toEqual([
      'base',
      'core2x',
      'pro',
    ]);
    expect((await runRows(h)).map((r) => [r.processor, r.price_usd])).toEqual([
      ['base', 0.01],
      ['core2x', 0.05],
      ['pro', 0.1],
    ]);
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBeCloseTo(4.84);
  });

  it('never lets the client choose the processor', async () => {
    const { h, parallel } = await harness();
    const key = await voucherKey(h);
    for (const body of [
      { input: 'x', mode: undefined },
      { input: 'x', mode: 'pro' },
      { input: 'x', processor: 'ultra8x' },
      { input: 'x', task_spec: { output_schema: 'x' } },
      { input: 'x', mcp_servers: [] },
    ]) {
      const res = await research(h, key.apiKey, body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    expect(parallel.calls).toHaveLength(0);
  });

  it('sends a text output schema as a text spec', async () => {
    const { h, parallel } = await harness({ script: ['completed'] });
    const key = await voucherKey(h);
    await sseEvents(await research(h, key.apiKey, { input: 'x', outputSchema: 'Un resumen' }));
    expect(parallel.creates()[0]!.body).toMatchObject({
      task_spec: { output_schema: { type: 'text', description: 'Un resumen' } },
    });
  });

  it('refuses when the remaining budget is below the price', async () => {
    const { h, litellm, parallel } = await harness();
    const key = await voucherKey(h);
    litellm.keys.get(key.tokenId)!.spend = 4.96;
    const res = await research(h, key.apiKey, { input: 'x' });
    expect(res.status).toBe(402);
    expect(await errorCode(res)).toBe('insufficient_budget');
    expect(parallel.calls).toHaveLength(0);
    expect(litellm.calls.some((c) => c.url.endsWith('/key/update'))).toBe(false);
    expect(await runRows(h)).toEqual([]);
  });

  it('gives the price back when the run fails', async () => {
    const { h, litellm } = await harness({ script: ['pending', 'failed'] });
    const key = await voucherKey(h);
    const events = await sseEvents(await research(h, key.apiKey, { input: 'x' }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'failed', charged: false });
    expect(litellm.calls.filter((c) => c.url.endsWith('/key/update')).map((c) => c.body)).toEqual([
      { key: key.tokenId, max_budget: 4.95 },
      { key: key.tokenId, max_budget: 5 },
    ]);
    expect(await runRows(h)).toMatchObject([{ state: 'refunded' }]);
  });

  it('gives the price back when Parallel cannot create the run', async () => {
    const { h, litellm } = await harness({
      create: () => jsonResponse({ type: 'error', error: {} }, 500),
    });
    const key = await voucherKey(h);
    const res = await research(h, key.apiKey, { input: 'x' });
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('provider_error');
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(5);
    expect(await runRows(h)).toMatchObject([{ state: 'refunded', parallel_run_id: null }]);
  });

  it('reports a rejected request as a bad request, refunded', async () => {
    const { h, litellm } = await harness({
      create: () => jsonResponse({ type: 'error', error: { message: SECRET_INPUT } }, 422),
    });
    const key = await voucherKey(h);
    const res = await research(h, key.apiKey, { input: SECRET_INPUT });
    expect(res.status).toBe(400);
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(5);
    expect(h.logs.join('\n')).not.toContain(SECRET_INPUT);
  });

  it('keeps polling through transient Parallel errors', async () => {
    const { h, litellm } = await harness({ script: ['error', 'pending', 'completed'] });
    const key = await voucherKey(h);
    const events = await sseEvents(await research(h, key.apiKey, { input: 'x' }));
    expect(events.at(-1)?.type).toBe('completed');
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.95);
  });

  it('stops following after the time limit and keeps the charge', async () => {
    let clock = Date.now();
    const { h, litellm } = await harness({
      script: ['pending'],
      settings: { maxMinutes: 2 },
      now: () => {
        clock += 30_000;
        return clock;
      },
    });
    const key = await voucherKey(h);
    const events = await sseEvents(await research(h, key.apiKey, { input: 'x' }));
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'timeout', charged: true });
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.95);
    expect(await runRows(h)).toMatchObject([{ state: 'expired' }]);
  });

  it('accepts only active voucher keys', async () => {
    const { h, parallel } = await harness();
    const voucher = await voucherKey(h);

    expect((await research(h, undefined, { input: 'x' })).status).toBe(401);
    expect((await research(h, 'sk-not-a-key', { input: 'x' })).status).toBe(401);
    expect((await research(h, 'not-even-sk', { input: 'x' })).status).toBe(401);

    // ChatGPT (scan decider) keys cannot do research.
    const chatgptKey = 'sk-chatgpt-decider-key';
    await insertIssuedKey(h.db, {
      kind: 'chatgpt',
      chatgpt: { accountHash: 'account-hash', keyCiphertext: 'v1.sealed' },
      provider: 'litellm',
      keyHash: sha256Hex(chatgptKey),
      label: 'sa-chatgpt-test',
      limitUsd: 1,
    });
    const res = await research(h, chatgptKey, { input: 'x' });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthorized');

    // Revoked vouchers' keys neither.
    const { rows } = await h.db.query<{ id: string }>('SELECT id FROM vouchers');
    await h.request('POST', `/admin/vouchers/${rows[0]!.id}/revoke`, {
      token: 'admin-token-0123456789abcdef',
    });
    expect((await research(h, voucher.apiKey, { input: 'x' })).status).toBe(401);
    expect(parallel.calls).toHaveLength(0);
  });

  it('refuses keys LiteLLM reports as blocked', async () => {
    const { h, litellm } = await harness();
    const key = await voucherKey(h);
    litellm.keys.get(key.tokenId)!.blocked = true;
    expect((await research(h, key.apiKey, { input: 'x' })).status).toBe(401);
  });

  it('serializes concurrent reservations of one key against its budget', async () => {
    const { h, litellm, parallel } = await harness({ script: ['completed'] });
    const key = await voucherKey(h);
    // Room for exactly two runs.
    litellm.keys.get(key.tokenId)!.spend = 4.88;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => research(h!, key.apiKey, { input: 'x' })),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 402, 402]);
    await Promise.all(responses.map((r) => r.text()));
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBeCloseTo(4.9, 9);
    expect(parallel.creates()).toHaveLength(2);
    expect(await runRows(h)).toHaveLength(2);
  });

  it('limits the runs a key has in flight', async () => {
    const { h } = await harness({ script: ['completed'], settings: { maxActivePerKey: 1 } });
    const key = await voucherKey(h);
    await h.db.query(
      `INSERT INTO research_runs (id, issued_key_id, processor, price_usd, state, parallel_run_id)
       SELECT $1, id, 'core2x', 0.05, 'running', 'trun_other' FROM issued_keys`,
      [randomUUID()],
    );
    const res = await research(h, key.apiKey, { input: 'x' });
    expect(res.status).toBe(429);
  });

  it('is idempotent per request id', async () => {
    const { h, litellm, parallel } = await harness({ script: ['completed'] });
    const key = await voucherKey(h);
    const requestId = randomUUID();
    const first = await sseEvents(await research(h, key.apiKey, { input: 'x', requestId }));
    const second = await sseEvents(await research(h, key.apiKey, { input: 'x', requestId }));
    expect(second[0]!.id).toBe(first[0]!.id);
    expect(second.at(-1)?.type).toBe('completed');
    expect(parallel.creates()).toHaveLength(1);
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.95);
  });

  it('answers 503 when research is not configured', async () => {
    h = await setup();
    const res = await research(h, 'sk-anything', { input: 'x' });
    expect(res.status).toBe(503);
    expect(await errorCode(res)).toBe('research_unavailable');
  });
});

describe('GET /v1/vouchers/credit', () => {
  it('keeps the vouchers total while research lowers the cap', async () => {
    const { h, litellm } = await harness();
    const key = await voucherKey(h);
    await sseEvents(await research(h, key.apiKey, { input: SECRET_INPUT }));
    litellm.keys.get(key.tokenId)!.spend = 0.3;

    const res = await h.request('GET', '/v1/vouchers/credit', { token: key.apiKey });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      limitUsd: 5,
      spendUsd: 0.3,
      maxBudgetUsd: 4.95,
      expiresAt: expect.any(String),
    });

    // A top-up adds to the total; what was used, research included, stays used.
    const [code] = await h.createVouchers({ amountUsd: 5 });
    const topUp = await (await h.redeem(code!, { token: key.apiKey })).json();
    expect(topUp).toMatchObject({ limitUsd: 10, usageUsd: 0.35, addedUsd: 5 });
    const after = await h.request('GET', '/v1/vouchers/credit', { token: key.apiKey });
    expect(await after.json()).toMatchObject({ limitUsd: 10, spendUsd: 0.3, maxBudgetUsd: 9.95 });
  });

  it('answers only voucher keys', async () => {
    const { h } = await harness();
    for (const token of [undefined, 'sk-unknown-key', 'not-a-key']) {
      const res = await h.request('GET', '/v1/vouchers/credit', { token });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
  });
});

describe('GET /v1/research/:id', () => {
  it('shows a run only to the key that started it', async () => {
    const { h } = await harness({ script: ['completed'] });
    const owner = await voucherKey(h);
    const other = await voucherKey(h);
    const [created] = await sseEvents(await research(h, owner.apiKey, { input: 'x' }));
    const id = created!.id;

    const mine = await h.request('GET', `/v1/research/${id}`, { token: owner.apiKey });
    expect(mine.status).toBe(200);
    expect(ResearchRunInfo.parse(await mine.json())).toMatchObject({
      id,
      status: 'completed',
      charged: true,
      priceUsd: 0.05,
      output: { content: { answer: SECRET_OUTPUT } },
    });

    for (const path of [`/v1/research/${id}`, `/v1/research/${id}/events`]) {
      const res = await h.request('GET', path, { token: other.apiKey });
      expect(res.status).toBe(404);
    }
    expect((await h.request('GET', '/v1/research/nope', { token: owner.apiKey })).status).toBe(404);

    const replay = await sseEvents(
      await h.request('GET', `/v1/research/${id}/events`, { token: owner.apiKey }),
    );
    expect(replay.map((e) => e.type)).toEqual(['created', 'completed']);
  });
});

describe('resume (after a restart)', () => {
  it('follows running runs, refunds stale reservations and retries failed refunds', async () => {
    let failUpdates = false;
    const { h, litellm } = await harness({
      script: ['completed'],
      update: () => (failUpdates ? jsonResponse({ error: { message: 'down' } }, 500) : undefined),
    });
    const key = await voucherKey(h);
    const keyRow = (await h.db.query<{ id: string }>('SELECT id FROM issued_keys')).rows[0]!.id;
    // Three runs whose price was already taken from the budget.
    litellm.keys.get(key.tokenId)!.max_budget = 4.85;
    const insert = (state: string, parallelRunId: string | null, age: string) =>
      h.db.query(
        `INSERT INTO research_runs
           (id, issued_key_id, processor, price_usd, state, parallel_run_id, created_at)
         VALUES ($1, $2, 'core2x', 0.05, $3, $4, now() - $5::interval)`,
        [randomUUID(), keyRow, state, parallelRunId, age],
      );
    await insert('running', 'trun_9', '1 minute');
    await insert('reserved', null, '1 hour');
    await insert('reserved', null, '10 seconds'); // may still be starting: left alone

    failUpdates = true;
    expect(await h.research!.resume()).toEqual({ followed: 1, refunded: 0 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await runRows(h)).map((r) => r.state).sort()).toEqual([
      'completed',
      'refunding',
      'reserved',
    ]);

    failUpdates = false;
    expect(await h.research!.resume()).toEqual({ followed: 0, refunded: 1 });
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.9);
    expect((await runRows(h)).map((r) => r.state).sort()).toEqual([
      'completed',
      'refunded',
      'reserved',
    ]);
    // A refund happens once.
    expect(await h.research!.refund((await pendingIds(h))[0]!)).toBe('settled');
    expect(litellm.keys.get(key.tokenId)!.max_budget).toBe(4.9);
  });
});

async function pendingIds(harness: Harness): Promise<string[]> {
  const { rows } = await harness.db.query<{ id: string }>(
    `SELECT id FROM research_runs WHERE state = 'refunded'`,
  );
  return rows.map((r) => r.id);
}

describe('research configuration', () => {
  it('maps fast, balanced and deep to lite, core and pro at list price, off without a key', () => {
    const config = loadConfig({});
    expect(config.research.modes).toEqual({
      fast: { processor: 'lite', priceUsd: 0.005 },
      balanced: { processor: 'core', priceUsd: 0.025 },
      deep: { processor: 'pro', priceUsd: 0.1 },
    });
    expect(config.parallel).toBeUndefined();
    expect(loadConfig({ PARALLEL_API_KEY: 'k' }).parallel).toEqual({
      apiKey: 'k',
      baseUrl: 'https://api.parallel.ai',
    });
  });
});
