import { afterEach, expect, it } from 'vitest';
import { normalizeVoucherCode } from '../src/codes';
import {
  ADMIN_TOKEN,
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

/** Every row of every table in the public schema, as JSON text. */
async function dumpDatabase(harness: Harness): Promise<string> {
  const { rows: tables } = await harness.db.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name`,
  );
  expect(tables.map((t) => t.name)).toEqual(
    expect.arrayContaining(['issued_keys', 'server_settings', 'vouchers']),
  );
  const parts: string[] = [];
  for (const { name } of tables) {
    const { rows } = await harness.db.query<{ row: string }>(
      `SELECT row_to_json(t)::text AS row FROM "${name}" t`,
    );
    parts.push(...rows.map((r) => r.row));
  }
  return parts.join('\n');
}

it('never stores or logs voucher codes, API keys, the master key or client IPs', async () => {
  const upstream = fakeLiteLLM();
  h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
  const clientIp = '198.51.100.77';
  const codes = await h.createVouchers({ count: 3 });
  const redeemed = (await (await h.redeem(codes[0]!, { ip: clientIp })).json()) as {
    apiKey: string;
  };
  expect(redeemed.apiKey).toBe('sk-litellm-key-1');
  const subject = 'google-oauth2|1234567890';
  const email = 'ana.garcia@example.org';
  const token = await idToken({ sub: subject, email, aud: 'oaiapp_secret-install' });
  const chatgpt = (await (
    await h.request('POST', '/v1/chatgpt-keys', { ip: clientIp, body: { idToken: token } })
  ).json()) as { apiKey: string };
  expect(chatgpt.apiKey).toBe('sk-litellm-key-2');
  // A failed redemption attempt with a code that looks real.
  await h.redeem('SA-ZZZZZZ', { ip: clientIp });

  const secrets = [
    ...codes,
    ...codes.map((c) => normalizeVoucherCode(c)!),
    'ZZZZZZ',
    redeemed.apiKey,
    chatgpt.apiKey,
    token,
    subject,
    email,
    'oaiapp_secret-install',
    clientIp,
    MASTER_KEY,
    ADMIN_TOKEN,
  ];
  const dump = await dumpDatabase(h);
  expect(dump.length).toBeGreaterThan(0);
  expect(dump).toContain(tokenId(1)); // the hashed token is what we keep, to block the key
  const logs = h.logs.join('\n');
  expect(logs).toContain('voucher redeemed'); // logging works...
  expect(logs).toContain('ChatGPT key issued');
  for (const secret of secrets) {
    expect(dump, 'database').not.toContain(secret);
    expect(logs, 'logs').not.toContain(secret);
  }
});

it('redacts keys and hashes LiteLLM echoes back in error messages', async () => {
  const echoed = `Authentication Error, Invalid proxy server token passed. Received API Key = ${MASTER_KEY}, Key Hash (Token) = ${tokenId(9)}. Unable to find token in cache or LiteLLM_VerificationTokenTable`;
  const upstream = fakeLiteLLM({
    generate: () => jsonResponse({ error: { message: echoed, type: 'auth_error' } }, 401),
  });
  h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
  const [code] = await h.createVouchers();
  const res = await h.redeem(code!);
  expect(res.status).toBe(502);
  const body = await res.text();
  const logs = h.logs.join('\n');
  expect(logs).toContain('LiteLLM key creation failed (401): Authentication Error');
  for (const text of [body, logs]) {
    expect(text).not.toContain(MASTER_KEY);
    expect(text).not.toContain(tokenId(9));
  }
});
