import { RedeemVoucherResponse } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config';
import { sha256Hex } from '../src/crypto';
import type { Db, Queryable } from '../src/db/types';
import {
  ADMIN_TOKEN,
  errorCode,
  fakeLiteLLM,
  freshDb,
  type Harness,
  litellmProvisioner,
  setup,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const daysUntil = (iso: string | null | undefined) => (Date.parse(iso!) - Date.now()) / DAY;

async function withLiteLLM(options: { config?: Partial<AppConfig>; db?: Db } = {}) {
  const upstream = fakeLiteLLM({ realHashes: true });
  h = await setup({ provisioner: litellmProvisioner(upstream.fetch), ...options });
  return { h, upstream };
}

async function redeem(harness: Harness, code: string, key?: string) {
  const res = await harness.redeem(code, key ? { token: key } : {});
  expect(res.status).toBe(200);
  return RedeemVoucherResponse.parse(await res.json());
}

/** Voucher ids in redemption order (vouchers created together share `created_at`). */
async function voucherIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM vouchers ORDER BY redeemed_at NULLS LAST, id',
  );
  return rows.map((r) => r.id);
}

function revoke(harness: Harness, id: string) {
  return harness.request('POST', `/admin/vouchers/${id}/revoke`, { token: ADMIN_TOKEN });
}

describe('voucher top-ups', () => {
  it('adds a voucher to the key the client sends and keeps the later deadline', async () => {
    const { h, upstream } = await withLiteLLM();
    const [first] = await h.createVouchers({ amountUsd: 5, expiresAt: inDays(20) });
    const [second] = await h.createVouchers({ amountUsd: 3, expiresAt: inDays(40) });
    const a = await redeem(h, first!);
    upstream.keys.get(sha256Hex(a.apiKey))!.spend = 2;

    const b = await redeem(h, second!, a.apiKey);
    expect(b).toMatchObject({ apiKey: a.apiKey, limitUsd: 8, usageUsd: 2, addedUsd: 3 });
    expect(daysUntil(b.expiresAt)).toBeCloseTo(40, 2);

    const generated = upstream.calls.filter((c) => c.url.endsWith('/key/generate'));
    expect(generated).toHaveLength(1);
    const update = upstream.calls.find((c) => c.url.endsWith('/key/update'))!;
    expect(update.body).toEqual({
      key: sha256Hex(a.apiKey),
      max_budget: 8,
      duration: expect.stringMatching(/^\d+s$/),
    });
    const seconds = Number.parseInt((update.body as { duration: string }).duration, 10);
    expect(Math.abs(seconds - 40 * 86_400)).toBeLessThan(60);
    expect(daysUntil(upstream.keys.get(sha256Hex(a.apiKey))!.expires)).toBeCloseTo(40, 2);

    const { rows: keys } = await h.db.query<{ id: string; limit: number; expires_at: Date }>(
      'SELECT id, limit_usd::float8 AS limit, expires_at FROM issued_keys',
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]!.limit).toBe(8);
    expect(keys[0]!.expires_at.toISOString()).toBe(b.expiresAt);
    const { rows: links } = await h.db.query<{ issued_key_id: string }>(
      'SELECT issued_key_id FROM vouchers',
    );
    expect(links).toEqual([{ issued_key_id: keys[0]!.id }, { issued_key_id: keys[0]!.id }]);
  });

  it("keeps the key's deadline when the new voucher's is earlier", async () => {
    const { h, upstream } = await withLiteLLM();
    const [first] = await h.createVouchers(); // KEY_TTL_DAYS: 180 days
    const [second] = await h.createVouchers({ amountUsd: 2, expiresAt: inDays(20) });
    const a = await redeem(h, first!);
    const b = await redeem(h, second!, a.apiKey);
    expect(b.limitUsd).toBe(7);
    expect(b.expiresAt).toBe(a.expiresAt);
    const update = upstream.calls.find((c) => c.url.endsWith('/key/update'))!;
    expect(update.body).not.toHaveProperty('duration');
  });

  it("keeps a concurrent top-up's later deadline (expiry read under the row lock)", async () => {
    // B's key lookup returns the row as it was before A's top-up committed, as when both
    // requests read it before either takes the lock.
    const real = await freshDb();
    let capture = false;
    let stale: { rows: unknown[] } | undefined;
    const db: Db = {
      kind: real.kind,
      exec: (sql) => real.exec(sql),
      transaction: (fn) => real.transaction(fn),
      close: () => real.close(),
      async query<T>(sql: string, params?: unknown[]) {
        const lookup = sql.includes('FROM issued_keys k');
        if (lookup && stale && !capture) return stale as { rows: T[] };
        const result = await real.query<T>(sql, params);
        if (lookup && capture) stale = result;
        return result;
      },
    };
    const { h, upstream } = await withLiteLLM({ db });
    const [first] = await h.createVouchers({ expiresAt: inDays(10) });
    const [a] = await h.createVouchers({ amountUsd: 1, expiresAt: inDays(40) });
    const [b] = await h.createVouchers({ amountUsd: 1, expiresAt: inDays(20) });
    const key = (await redeem(h, first!)).apiKey;
    capture = true;
    await redeem(h, a!, key);
    capture = false;

    const res = await redeem(h, b!, key);
    expect(res.limitUsd).toBe(7);
    expect(daysUntil(res.expiresAt)).toBeCloseTo(40, 2);
    const upstreamExpiry = upstream.keys.get(sha256Hex(key))!.expires;
    expect(daysUntil(upstreamExpiry)).toBeCloseTo(40, 2);
    const { rows } = await h.db.query<{ expires_at: Date }>('SELECT expires_at FROM issued_keys');
    expect(rows[0]!.expires_at.toISOString()).toBe(res.expiresAt);
  });

  it('removes the expiry when the new voucher never expires', async () => {
    const { h, upstream } = await withLiteLLM({ config: { keyTtlDays: 0 } });
    const [first] = await h.createVouchers({ expiresAt: inDays(20) });
    const [second] = await h.createVouchers();
    const a = await redeem(h, first!);
    expect(a.expiresAt).toBeDefined();
    const b = await redeem(h, second!, a.apiKey);
    expect(b.expiresAt).toBeUndefined();
    const update = upstream.calls.find((c) => c.url.endsWith('/key/update'))!;
    expect(update.body).toMatchObject({ duration: null });
    const { rows } = await h.db.query<{ expires_at: Date | null }>(
      'SELECT expires_at FROM issued_keys',
    );
    expect(rows).toEqual([{ expires_at: null }]);
  });

  it('tops up mock keys too', async () => {
    h = await setup();
    const [first, second] = await h.createVouchers({ count: 2, amountUsd: 4 });
    const a = await redeem(h, first!);
    const b = await redeem(h, second!, a.apiKey);
    expect(b).toMatchObject({ apiKey: a.apiKey, limitUsd: 8, usageUsd: 0, addedUsd: 4 });
  });

  it('creates a new key when the sent key is unknown, blocked upstream or revoked', async () => {
    const { h, upstream } = await withLiteLLM();
    const codes = await h.createVouchers({ count: 4 });

    const unknown = await redeem(h, codes[0]!, 'sk-not-ours');
    expect(unknown.apiKey).not.toBe('sk-not-ours');
    expect(unknown.limitUsd).toBe(5);

    // Blocked in LiteLLM without the key server knowing: not topped up.
    upstream.keys.get(sha256Hex(unknown.apiKey))!.blocked = true;
    const afterBlock = await redeem(h, codes[1]!, unknown.apiKey);
    expect(afterBlock.apiKey).not.toBe(unknown.apiKey);

    const [, second] = await voucherIds(h.db);
    expect((await revoke(h, second!)).status).toBe(200);
    const afterRevoke = await redeem(h, codes[2]!, afterBlock.apiKey);
    expect(afterRevoke.apiKey).not.toBe(afterBlock.apiKey);
    expect(afterRevoke).toMatchObject({ limitUsd: 5, usageUsd: 0, addedUsd: 5 });
    expect(upstream.calls.filter((c) => c.url.endsWith('/key/update'))).toEqual([]);
  });

  it('leaves the voucher unredeemed when LiteLLM cannot update the key', async () => {
    const upstream = fakeLiteLLM({
      realHashes: true,
      update: () => new Response('{"error":{"message":"down"}}', { status: 500 }),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [first, second] = await h.createVouchers({ count: 2 });
    const a = await redeem(h, first!);
    const res = await h.redeem(second!, { token: a.apiKey });
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('provider_error');
    const { rows } = await h.db.query<{ status: string }>(
      'SELECT status FROM vouchers ORDER BY status DESC',
    );
    expect(rows).toEqual([{ status: 'redeemed' }, { status: 'active' }]);
  });

  it('moves the budget and expiry back when the top-up cannot be recorded', async () => {
    const db = await freshDb();
    const failingDb: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) => {
          const wrapped: Queryable = {
            exec: tx.exec.bind(tx),
            query: (sql, params) =>
              sql.includes('limit_usd = limit_usd +')
                ? Promise.reject(new Error('disk full'))
                : tx.query(sql, params),
          };
          return fn(wrapped);
        }),
    };
    const { h, upstream } = await withLiteLLM({ db: failingDb });
    const [first] = await h.createVouchers({ expiresAt: inDays(20) });
    const [second] = await h.createVouchers({ expiresAt: inDays(40) });
    const a = await redeem(h, first!);
    const res = await h.redeem(second!, { token: a.apiKey });
    expect(res.status).toBe(500);
    const key = upstream.keys.get(sha256Hex(a.apiKey))!;
    expect(key.max_budget).toBe(5);
    expect(daysUntil(key.expires)).toBeCloseTo(20, 2);
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM vouchers ORDER BY status DESC',
    );
    expect(rows).toEqual([{ status: 'redeemed' }, { status: 'active' }]);
  });
});

describe('revoking a voucher of a topped-up key', () => {
  it("takes back only that voucher's amount while another voucher funds the key", async () => {
    const { h, upstream } = await withLiteLLM();
    const [first] = await h.createVouchers({ amountUsd: 5 });
    const [second] = await h.createVouchers({ amountUsd: 3 });
    const a = await redeem(h, first!);
    await redeem(h, second!, a.apiKey);
    const key = upstream.keys.get(sha256Hex(a.apiKey))!;
    const [firstId, secondId] = await voucherIds(h.db);

    // The creating voucher first: the key keeps the top-up's 3.
    const res = await revoke(h, firstId!);
    expect(await res.json()).toEqual({ id: firstId, status: 'revoked', keysDisabled: 0 });
    expect(key).toMatchObject({ max_budget: 3, blocked: false });
    // Revoking again takes nothing more.
    expect((await revoke(h, firstId!)).status).toBe(200);
    expect(key.max_budget).toBe(3);
    const { rows } = await h.db.query<{ limit: number }>(
      'SELECT limit_usd::float8 AS limit FROM issued_keys',
    );
    expect(rows).toEqual([{ limit: 3 }]);

    // The key still counts as active: a third voucher tops it up.
    const [third] = await h.createVouchers({ amountUsd: 1 });
    expect((await redeem(h, third!, a.apiKey)).limitUsd).toBe(4);

    // Once no valid voucher funds it, the key is blocked.
    expect(await (await revoke(h, secondId!)).json()).toMatchObject({ keysDisabled: 0 });
    expect(key).toMatchObject({ max_budget: 1, blocked: false });
    const [, , thirdId] = await voucherIds(h.db);
    expect(await (await revoke(h, thirdId!)).json()).toMatchObject({ keysDisabled: 1 });
    expect(key.blocked).toBe(true);
  });

  it('leaves the voucher redeemed when the budget cannot be lowered', async () => {
    let updateUp = true;
    const upstream = fakeLiteLLM({
      realHashes: true,
      update: () => (updateUp ? undefined : new Response('{}', { status: 500 })),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [first, second] = await h.createVouchers({ count: 2 });
    const a = await redeem(h, first!);
    await redeem(h, second!, a.apiKey);
    const [, secondId] = await voucherIds(h.db);

    updateUp = false;
    const failed = await revoke(h, secondId!);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe('provider_error');
    const { rows } = await h.db.query<{ status: string }>(
      'SELECT status FROM vouchers WHERE id = $1',
      [secondId],
    );
    expect(rows).toEqual([{ status: 'redeemed' }]);

    updateUp = true;
    expect((await revoke(h, secondId!)).status).toBe(200);
    expect(upstream.keys.get(sha256Hex(a.apiKey))!.max_budget).toBe(5);
  });
});
