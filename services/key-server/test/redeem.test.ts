import { RedeemVoucherResponse, TRANSCRIPTION_MODEL } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { DEMO_VOUCHER_CODE } from '../src/codes';
import type { Db, Queryable } from '../src/db/types';
import { MockProvisioner } from '../src/providers/key-provisioner';
import { ensureDemoVoucher } from '../src/vouchers';
import {
  ADMIN_TOKEN,
  errorCode,
  fakeLiteLLM,
  freshDb,
  type Harness,
  jsonResponse,
  litellmProvisioner,
  MASTER_KEY,
  setup,
  TEST_PEPPER,
  tokenId,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function voucherRows(db: Db) {
  const { rows } = await db.query<{ status: string; redeemed_at: Date | null }>(
    'SELECT status, redeemed_at FROM vouchers',
  );
  return rows;
}

async function count(db: Db, table: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe('POST /v1/vouchers/redeem', () => {
  it('exchanges a voucher for a capped key (mock provider)', async () => {
    h = await setup({ config: { searchTools: ['exa'] } });
    const [code] = await h.createVouchers({ amountUsd: 5 });
    const res = await h.redeem(code!);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = RedeemVoucherResponse.parse(await res.json());
    expect(body).toMatchObject({
      provider: 'litellm',
      baseUrl: 'http://127.0.0.1:8789/v1',
      limitUsd: 5,
      usageUsd: 0,
      addedUsd: 5,
      searchTools: ['exa'],
    });
    expect(body.apiKey).toMatch(/^sk-mock-[0-9a-f]{48}$/);
    // Key expiry: KEY_TTL_DAYS (180) from now.
    const ttlDays = (Date.parse(body.expiresAt!) - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(179.9);
    expect(ttlDays).toBeLessThanOrEqual(180);

    const [voucher] = await voucherRows(h.db);
    expect(voucher!.status).toBe('redeemed');
    expect(voucher!.redeemed_at).toBeInstanceOf(Date);
    const { rows: keys } = await h.db.query<{
      kind: string;
      provider: string;
      label: string;
      limit: number;
    }>('SELECT kind, provider, label, limit_usd::float8 AS limit FROM issued_keys');
    expect(keys).toEqual([
      { kind: 'voucher', provider: 'mock', label: expect.stringMatching(/^sa-voucher-/), limit: 5 },
    ]);
  });

  it('creates LiteLLM virtual keys through the admin API', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({
      provisioner: litellmProvisioner(upstream.fetch, {
        models: ['openai/gpt-6-luna', 'moonshotai/kimi-k2.6'],
        searchTools: ['exa', 'parallel'],
        voucherDeciderModel: 'perplexity/voucher-decider',
      }),
      config: { searchTools: ['exa', 'parallel'] },
    });
    const [code] = await h.createVouchers({ amountUsd: 7.5 });
    const res = await h.redeem(code!);
    expect(res.status).toBe(200);
    const body = RedeemVoucherResponse.parse(await res.json());
    expect(body).toEqual({
      provider: 'litellm',
      baseUrl: 'https://llm.example.org/v1',
      apiKey: 'sk-litellm-key-1',
      limitUsd: 7.5,
      usageUsd: 0,
      addedUsd: 7.5,
      searchTools: ['exa', 'parallel'],
      expiresAt: expect.any(String),
    });

    expect(upstream.calls).toHaveLength(1);
    const [call] = upstream.calls;
    expect(call!.url).toBe('http://litellm:4000/key/generate');
    expect(call!.method).toBe('POST');
    expect(call!.headers.get('authorization')).toBe(`Bearer ${MASTER_KEY}`);
    const { rows: vouchers } = await h.db.query<{ id: string }>('SELECT id FROM vouchers');
    const voucherId = vouchers[0]!.id;
    expect(call!.body).toEqual({
      key_alias: `sa-voucher-${voucherId}`,
      max_budget: 7.5,
      duration: expect.stringMatching(/^1555\d{4}s$/), // KEY_TTL_DAYS (180) in seconds
      // The voucher scan decider is always allowed: scans are screened on the voucher's budget.
      models: [
        'openai/gpt-6-luna',
        'moonshotai/kimi-k2.6',
        'perplexity/voucher-decider',
        TRANSCRIPTION_MODEL,
      ],
      allowed_routes: [
        '/v1/chat/completions',
        '/v1/models',
        '/v1/search',
        '/openrouter/alpha/decisions',
        '/key/info',
      ],
      object_permission: { search_tools: ['exa', 'parallel'] },
      metadata: { sa_kind: 'voucher', sa_voucher_id: voucherId },
    });
    // Never the voucher code, in any form.
    expect(JSON.stringify(call!.body)).not.toContain(code!.slice(3, 7));
    const { rows } = await h.db.query<{ key_hash: string }>('SELECT key_hash FROM issued_keys');
    expect(rows).toEqual([{ key_hash: tokenId(1) }]);
  });

  it('makes the key expire with the voucher when the voucher has a deadline', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const deadline = new Date(Date.now() + 20 * 86_400_000);
    const [code] = await h.createVouchers({ expiresAt: deadline.toISOString() });
    expect((await h.redeem(code!)).status).toBe(200);
    const { duration } = upstream.calls[0]!.body as { duration: string };
    const seconds = Number(duration.slice(0, -1));
    expect(duration.endsWith('s')).toBe(true);
    expect(Math.abs(seconds - 20 * 86_400)).toBeLessThan(60);
  });

  it('gives a mock key the voucher deadline as its expiry', async () => {
    h = await setup();
    const deadline = new Date(Date.now() + 20 * 86_400_000);
    const [code] = await h.createVouchers({ expiresAt: deadline.toISOString() });
    const body = RedeemVoucherResponse.parse(await (await h.redeem(code!)).json());
    expect(body.expiresAt).toBe(deadline.toISOString());
  });

  it('allows every model and tool when no allowlist is set, and omits duration without TTL', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({
      provisioner: litellmProvisioner(upstream.fetch),
      config: { keyTtlDays: 0 },
    });
    const [code] = await h.createVouchers();
    const body = RedeemVoucherResponse.parse(await (await h.redeem(code!)).json());
    expect(body.expiresAt).toBeUndefined();
    expect(body.searchTools).toEqual([]);
    const sent = upstream.calls[0]!.body as Record<string, unknown>;
    expect(sent.models).toEqual([]);
    expect(sent).not.toHaveProperty('duration');
    expect(sent).not.toHaveProperty('object_permission');
  });

  it('accepts codes typed in lowercase, with spaces or without the prefix', async () => {
    h = await setup();
    const codes = await h.createVouchers({ count: 3 });
    const variants = [
      codes[0]!.toLowerCase(),
      codes[1]!.replaceAll('-', ' '),
      codes[2]!.slice(3), // "XXXXXX"
    ];
    for (const variant of variants) expect((await h.redeem(variant)).status).toBe(200);
  });

  it('rejects unknown and malformed codes with invalid_code', async () => {
    h = await setup();
    for (const code of ['SA-000000', 'not a code', '1234']) {
      const res = await h.redeem(code);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('invalid_code');
    }
    const missing = await h.request('POST', '/v1/vouchers/redeem', { body: {} });
    expect(await errorCode(missing)).toBe('invalid_code');
    const notJson = await h.request('POST', '/v1/vouchers/redeem', { body: '{oops' });
    expect(await errorCode(notJson)).toBe('invalid_code');
  });

  it('rejects a voucher that was already redeemed', async () => {
    h = await setup();
    const [code] = await h.createVouchers();
    expect((await h.redeem(code!)).status).toBe(200);
    const again = await h.redeem(code!);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('already_redeemed');
  });

  it('rejects an expired voucher', async () => {
    h = await setup();
    const [code] = await h.createVouchers({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await h.db.query(`UPDATE vouchers SET expires_at = now() - interval '1 minute'`);
    const res = await h.redeem(code!);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('expired');
    expect((await voucherRows(h.db))[0]!.status).toBe('active');
  });

  it('rejects a revoked voucher', async () => {
    h = await setup();
    const [code] = await h.createVouchers();
    const { rows } = await h.db.query<{ id: string }>('SELECT id FROM vouchers');
    await h.request('POST', `/admin/vouchers/${rows[0]!.id}/revoke`, { token: ADMIN_TOKEN });
    const res = await h.redeem(code!);
    expect(res.status).toBe(410);
    expect(await errorCode(res)).toBe('revoked');
  });

  it('redeems a voucher only once under concurrent requests', async () => {
    const provisioner = new MockProvisioner({ delayMs: 25 }); // widen the race window
    h = await setup({ provisioner });
    const [code] = await h.createVouchers();
    const responses = await Promise.all(Array.from({ length: 8 }, () => h!.redeem(code!)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409, 409, 409]);
    expect(provisioner.keys.size).toBe(1);
    expect(await count(h.db, 'issued_keys')).toBe(1);
  });

  it('rolls back when LiteLLM fails, so the voucher can be redeemed later', async () => {
    let upstreamUp = false;
    const upstream = fakeLiteLLM({
      generate: () =>
        upstreamUp ? undefined : jsonResponse({ error: { message: 'Internal error' } }, 500),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [code] = await h.createVouchers();

    const failed = await h.redeem(code!);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe('provider_error');
    expect(await voucherRows(h.db)).toEqual([{ status: 'active', redeemed_at: null }]);
    expect(await count(h.db, 'issued_keys')).toBe(0);
    expect(h.logs.join('\n')).toContain('LiteLLM key creation failed (500): Internal error');

    upstreamUp = true;
    const retried = await h.redeem(code!);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { apiKey: string }).apiKey).toBe('sk-litellm-key-2');
  });

  it('maps unreachable, rejected and malformed LiteLLM answers to provider_error', async () => {
    const answers = [
      () => Promise.reject(new TypeError('fetch failed')),
      () => jsonResponse({ error: { message: 'Authentication Error', type: 'auth_error' } }, 401),
      () => jsonResponse({ detail: 'Key with alias already exists' }, 400),
      () => jsonResponse({ key: 'sk-no-token-id' }), // no hashed token: cannot manage it later
      () => jsonResponse({ key: 'not-a-key', token: tokenId(1) }),
      () => new Response('<html>Bad gateway</html>', { status: 200 }),
    ];
    for (const answer of answers) {
      h = await setup({ provisioner: litellmProvisioner(async () => answer()) });
      const [code] = await h.createVouchers();
      const res = await h.redeem(code!);
      expect(res.status).toBe(502);
      expect(await errorCode(res)).toBe('provider_error');
      expect((await voucherRows(h.db))[0]!.status).toBe('active');
      await h.close();
      h = undefined;
    }
  });

  it('blocks the new key if recording the redemption fails', async () => {
    const db = await freshDb();
    // Database double that fails when the issued key is written.
    const failingDb: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) => {
          const wrapped: Queryable = {
            exec: tx.exec.bind(tx),
            query: (sql, params) =>
              sql.includes('INSERT INTO issued_keys')
                ? Promise.reject(new Error('disk full'))
                : tx.query(sql, params),
          };
          return fn(wrapped);
        }),
    };
    const upstream = fakeLiteLLM();
    h = await setup({ db: failingDb, provisioner: litellmProvisioner(upstream.fetch) });
    const [code] = await h.createVouchers();
    const res = await h.redeem(code!);
    expect(res.status).toBe(500);
    expect(await errorCode(res)).toBe('internal');
    expect(upstream.calls.map((c) => [c.url, c.body])).toEqual([
      ['http://litellm:4000/key/generate', expect.anything()],
      ['http://litellm:4000/key/block', { key: tokenId(1) }],
    ]);
    expect((await voucherRows(db))[0]!.status).toBe('active');
  });

  it('re-arms the demo voucher after each redemption when DEV_SEED is on', async () => {
    h = await setup({ config: { devSeed: true } });
    await ensureDemoVoucher(h.db, { pepper: TEST_PEPPER });
    for (let i = 0; i < 3; i++) expect((await h.redeem(DEMO_VOUCHER_CODE)).status).toBe(200);
    const { rows } = await h.db.query<{ status: string; n: number }>(
      'SELECT status, count(*)::int AS n FROM vouchers GROUP BY status ORDER BY status',
    );
    expect(rows).toEqual([
      { status: 'active', n: 1 },
      { status: 'redeemed', n: 3 },
    ]);
  });

  it('treats the demo voucher as single-use without DEV_SEED', async () => {
    h = await setup();
    await ensureDemoVoucher(h.db, { pepper: TEST_PEPPER });
    expect((await h.redeem(DEMO_VOUCHER_CODE)).status).toBe(200);
    expect(await errorCode(await h.redeem(DEMO_VOUCHER_CODE))).toBe('already_redeemed');
    // Seeding again (server restart with DEV_SEED=1) recreates it.
    expect(await ensureDemoVoucher(h.db, { pepper: TEST_PEPPER })).toBe('created');
    expect(await ensureDemoVoucher(h.db, { pepper: TEST_PEPPER })).toBe('active');
    expect((await h.redeem(DEMO_VOUCHER_CODE)).status).toBe(200);
  });
});
