import { afterEach, describe, expect, it } from 'vitest';
import { MockProvisioner } from '../src/providers/key-provisioner';
import {
  ADMIN_TOKEN,
  errorCode,
  fakeLiteLLM,
  type Harness,
  idToken,
  jsonResponse,
  litellmProvisioner,
  MASTER_KEY,
  setup,
  tokenId,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

interface ListedVoucher {
  id: string;
  status: string;
  expired: boolean;
  amountUsd: number;
  note: string | null;
  batch: string | null;
  key: { provider: string; disabledAt: string | null } | null;
}

async function list(harness: Harness, query = ''): Promise<ListedVoucher[]> {
  const res = await harness.request('GET', `/admin/vouchers${query}`, { token: ADMIN_TOKEN });
  expect(res.status).toBe(200);
  return ((await res.json()) as { vouchers: ListedVoucher[] }).vouchers;
}

function revoke(harness: Harness, id: string) {
  return harness.request('POST', `/admin/vouchers/${id}/revoke`, { token: ADMIN_TOKEN });
}

describe('admin API', () => {
  it('is disabled when ADMIN_TOKEN is not configured', async () => {
    h = await setup({ config: { adminToken: undefined } });
    const res = await h.request('POST', '/admin/vouchers', {
      token: ADMIN_TOKEN,
      body: { count: 1, amountUsd: 5 },
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });

  it('requires the admin bearer token', async () => {
    h = await setup();
    for (const token of [undefined, 'wrong-token-0123456789', `${ADMIN_TOKEN}x`]) {
      const res = await h.request('GET', '/admin/vouchers', { token });
      expect(res.status).toBe(401);
      expect(await errorCode(res)).toBe('unauthorized');
    }
    expect((await h.request('GET', '/admin/vouchers', { token: ADMIN_TOKEN })).status).toBe(200);
  });

  it('creates vouchers and shows the codes only once', async () => {
    h = await setup();
    const res = await h.request('POST', '/admin/vouchers', {
      token: ADMIN_TOKEN,
      body: { count: 3, amountUsd: 2.5, note: 'charla', batch: 'feria-2026' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { codes: string[]; batch: string; amountUsd: number };
    expect(body.codes).toHaveLength(3);
    expect(new Set(body.codes).size).toBe(3);
    for (const code of body.codes) expect(code).toMatch(/^SA-[0-9A-Z]{6}$/);
    expect(body).toMatchObject({ batch: 'feria-2026', amountUsd: 2.5 });

    const vouchers = await list(h);
    expect(vouchers).toHaveLength(3);
    for (const v of vouchers) {
      expect(v).toMatchObject({
        status: 'active',
        expired: false,
        amountUsd: 2.5,
        note: 'charla',
        batch: 'feria-2026',
        key: null,
      });
      expect(JSON.stringify(v)).not.toMatch(/code|hash/i);
    }
  });

  it('generates a batch name when omitted', async () => {
    h = await setup();
    const res = await h.request('POST', '/admin/vouchers', {
      token: ADMIN_TOKEN,
      body: { count: 1, amountUsd: 5 },
    });
    const body = (await res.json()) as { batch: string };
    expect(body.batch).toMatch(/^b-\d{4}-\d\d-\d\d-[0-9a-f]{6}$/);
  });

  it('validates creation requests', async () => {
    h = await setup();
    for (const body of [
      { count: 0, amountUsd: 5 },
      { count: 1001, amountUsd: 5 },
      { count: 1, amountUsd: 0 },
      { count: 1, amountUsd: -5 },
      { count: 1 },
      { count: 1, amountUsd: 5, expiresAt: 'tomorrow' },
      { count: 1, amountUsd: 5, expiresAt: '2001-01-01T00:00:00Z' },
      { count: 1, amount: 5 },
      { count: 1, amountUsd: 5, searchQuota: 10 }, // searches share the voucher's budget now
    ]) {
      const res = await h.request('POST', '/admin/vouchers', { token: ADMIN_TOKEN, body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
    expect(await list(h)).toHaveLength(0);
  });

  it('lists vouchers filtered by status and batch', async () => {
    h = await setup();
    const [a] = await h.createVouchers({ batch: 'one' });
    await h.createVouchers({ count: 2, batch: 'two' });
    await h.redeem(a!);
    // ChatGPT keys never show up as voucher keys.
    const token = await idToken();
    expect((await h.request('POST', '/v1/chatgpt-keys', { body: { idToken: token } })).status).toBe(
      200,
    );
    expect((await list(h, '?status=redeemed')).map((v) => v.batch)).toEqual(['one']);
    expect(await list(h, '?status=active')).toHaveLength(2);
    expect(await list(h, '?batch=two')).toHaveLength(2);
    expect(await list(h, '?limit=1')).toHaveLength(1);
    expect(await list(h)).toHaveLength(3);
    const [redeemed] = await list(h, '?status=redeemed');
    expect(redeemed!.key).toMatchObject({ provider: 'mock', disabledAt: null });
    const bad = await h.request('GET', '/admin/vouchers?status=lost', { token: ADMIN_TOKEN });
    expect(bad.status).toBe(400);
  });

  it('filters expired vouchers apart from active ones', async () => {
    h = await setup();
    const soon = new Date(Date.now() + 60_000).toISOString();
    await h.createVouchers({ batch: 'old', expiresAt: soon });
    await h.createVouchers({ batch: 'fresh', expiresAt: soon });
    await h.createVouchers({ batch: 'forever' });
    await h.db.query(`UPDATE vouchers SET expires_at = now() - interval '1 minute'
                       WHERE batch = 'old'`);

    const expired = await list(h, '?status=expired');
    expect(expired.map((v) => v.batch)).toEqual(['old']);
    expect(expired[0]).toMatchObject({ status: 'active', expired: true });
    expect((await list(h, '?status=active')).map((v) => v.batch).sort()).toEqual([
      'forever',
      'fresh',
    ]);
    expect(await list(h, '?status=expired&batch=fresh')).toEqual([]);
    expect(await list(h)).toHaveLength(3);
  });

  it('revokes a voucher and blocks its LiteLLM key by its hashed token', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [code] = await h.createVouchers();
    await h.redeem(code!);
    const [voucher] = await list(h);

    const res = await revoke(h, voucher!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: voucher!.id, status: 'revoked', keysDisabled: 1 });
    const block = upstream.calls[1]!;
    expect(block.method).toBe('POST');
    expect(block.url).toBe('http://litellm:4000/key/block');
    expect(block.headers.get('authorization')).toBe(`Bearer ${MASTER_KEY}`);
    expect(block.body).toEqual({ key: tokenId(1) });

    const [after] = await list(h);
    expect(after!.status).toBe('revoked');
    expect(after!.key!.disabledAt).not.toBeNull();

    // Idempotent: revoking again does not call LiteLLM again.
    expect((await revoke(h, voucher!.id)).status).toBe(200);
    expect(upstream.calls).toHaveLength(2);
  });

  it('counts a key LiteLLM no longer knows (404) as disabled', async () => {
    const upstream = fakeLiteLLM({
      block: () => jsonResponse({ error: { message: 'Key not found.', type: 'not_found' } }, 404),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [code] = await h.createVouchers();
    await h.redeem(code!);
    const [voucher] = await list(h);
    const res = await revoke(h, voucher!.id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keysDisabled: number }).keysDisabled).toBe(1);
    expect((await list(h))[0]!.key!.disabledAt).not.toBeNull();
  });

  it('reports a failed key block and retries it on the next revoke', async () => {
    let litellmUp = true;
    const upstream = fakeLiteLLM({
      block: () => (litellmUp ? undefined : jsonResponse({ error: { message: 'down' } }, 503)),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const [code] = await h.createVouchers();
    await h.redeem(code!);
    const [voucher] = await list(h);

    litellmUp = false;
    const failed = await revoke(h, voucher!.id);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe('provider_error');
    const [stillEnabled] = await list(h);
    expect(stillEnabled!.status).toBe('revoked'); // the voucher itself is revoked right away
    expect(stillEnabled!.key!.disabledAt).toBeNull();
    expect(h.logs.join('\n')).toContain('LiteLLM key block failed (503): down');

    litellmUp = true;
    const retried = await revoke(h, voucher!.id);
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { keysDisabled: number }).keysDisabled).toBe(1);
  });

  it('refuses to forget a LiteLLM key while LiteLLM is not configured', async () => {
    h = await setup({ provisioner: litellmProvisioner(fakeLiteLLM().fetch) });
    const [code] = await h.createVouchers();
    await h.redeem(code!);
    const [voucher] = await list(h);
    // Same database, server restarted without LITELLM_ADMIN_URL (mock provider).
    const db = h.db;
    const mock = await setup({ db, provisioner: new MockProvisioner() });
    const res = await revoke(mock, voucher!.id);
    expect(res.status).toBe(502);
    expect((await list(mock))[0]!.key!.disabledAt).toBeNull();
  });

  it('disables mock keys locally and returns 404 for unknown vouchers', async () => {
    const provisioner = new MockProvisioner();
    h = await setup({ provisioner });
    const [code] = await h.createVouchers();
    await h.redeem(code!);
    const [voucher] = await list(h);
    await revoke(h, voucher!.id);
    expect([...provisioner.keys.values()][0]!.disabled).toBe(true);

    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid']) {
      const res = await revoke(h, id);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('not_found');
    }
  });
});
