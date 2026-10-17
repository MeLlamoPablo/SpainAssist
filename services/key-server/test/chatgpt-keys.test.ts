import { ChatGPTKeyResponse, TRANSCRIPTION_MODEL } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { openSecret, sealSecret } from '../src/crypto';
import { silentLogger } from '../src/logger';
import { MockProvisioner } from '../src/providers/key-provisioner';
import { SubsidyTeam } from '../src/subsidy-team';
import {
  DECIDER_MODEL,
  errorCode,
  fakeLiteLLM,
  type Harness,
  idToken,
  jsonResponse,
  litellmProvisioner,
  setup,
  TEST_ENCRYPTION_KEY,
  testConfig,
  testIdentity,
  tokenId,
} from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

function getKey(harness: Harness, token: string) {
  return harness.request('POST', '/v1/chatgpt-keys', { body: { idToken: token } });
}

async function chatgptRows(harness: Harness) {
  const { rows } = await harness.db.query<{
    kind: string;
    voucher_id: string | null;
    label: string;
    account_hash: string;
    key_ciphertext: string;
    key_hash: string;
    limit_usd: number;
    expires_at: string | null;
  }>(
    `SELECT kind, voucher_id, label, account_hash, key_ciphertext, key_hash,
            limit_usd::float8 AS limit_usd, expires_at
       FROM issued_keys WHERE kind = 'chatgpt' ORDER BY created_at`,
  );
  return rows;
}

describe('POST /v1/chatgpt-keys', () => {
  it('issues a permanent decider-only key with daily and monthly budgets', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({
      provisioner: litellmProvisioner(upstream.fetch, {
        models: ['openai/gpt-6-luna'],
        searchTools: ['exa'],
      }),
    });
    const res = await getKey(h, await idToken());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = ChatGPTKeyResponse.parse(await res.json());
    expect(body).toEqual({
      provider: 'litellm',
      baseUrl: 'https://llm.example.org/v1',
      apiKey: 'sk-litellm-key-1',
      deciderModel: DECIDER_MODEL,
      dailyLimitUsd: 0.1,
      monthlyLimitUsd: 0.5,
    });

    // The team of all ChatGPT keys (no global cap configured), then the key itself.
    expect(upstream.calls.map((c) => c.url)).toEqual([
      'http://litellm:4000/team/new',
      'http://litellm:4000/key/generate',
    ]);
    expect(upstream.calls[0]!.body).toEqual({
      team_alias: 'sa-chatgpt-keys',
      max_budget: null,
      budget_duration: '1mo',
      models: [DECIDER_MODEL, TRANSCRIPTION_MODEL],
    });
    const sent = upstream.calls[1]!.body as Record<string, unknown>;
    expect(sent).toEqual({
      key_alias: expect.stringMatching(/^sa-chatgpt-[0-9a-f-]{36}$/),
      // Not the voucher allowlist, no search tools: only the decider and call transcription.
      models: [DECIDER_MODEL, TRANSCRIPTION_MODEL],
      allowed_routes: ['/openrouter/alpha/decisions', '/v1/chat/completions', '/key/info'],
      budget_limits: [
        { budget_duration: '1d', max_budget: 0.1 },
        { budget_duration: '1mo', max_budget: 0.5 },
      ],
      team_id: 'team-1',
      metadata: { sa_kind: 'chatgpt' },
    });
    expect(sent).not.toHaveProperty('duration'); // permanent
    expect(sent).not.toHaveProperty('max_budget');

    const rows = await chatgptRows(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      voucher_id: null,
      label: sent.key_alias,
      key_hash: tokenId(1),
      limit_usd: 0.5,
      expires_at: null,
    });
    // Stored encrypted, bound to the account hash.
    expect(rows[0]!.key_ciphertext).not.toContain('sk-litellm-key-1');
    expect(openSecret(rows[0]!.key_ciphertext, TEST_ENCRYPTION_KEY, rows[0]!.account_hash)).toBe(
      'sk-litellm-key-1',
    );
  });

  it('gives every device of one OpenAI account the same key', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const first = ChatGPTKeyResponse.parse(
      await (await getKey(h, await idToken({ aud: 'oaiapp_laptop' }))).json(),
    );
    // Another install (its own client id), later sign-in, same account.
    const second = ChatGPTKeyResponse.parse(
      await (await getKey(h, await idToken({ aud: 'oaiapp_desktop', issuedAgo: 60 }))).json(),
    );
    expect(second.apiKey).toBe(first.apiKey);
    // Another account gets its own key.
    const other = ChatGPTKeyResponse.parse(
      await (await getKey(h, await idToken({ sub: 'google-oauth2|user-2' }))).json(),
    );
    expect(other.apiKey).not.toBe(first.apiKey);
    expect(upstream.calls.filter((c) => c.url.endsWith('/key/generate'))).toHaveLength(2);
    // The team is prepared once per process.
    expect(upstream.calls.filter((c) => c.url.includes('/team/'))).toHaveLength(1);
    expect(await chatgptRows(h)).toHaveLength(2);
  });

  it('serializes concurrent first requests of one account', async () => {
    const provisioner = new MockProvisioner({ delayMs: 10 });
    h = await setup({ provisioner });
    const token = await idToken();
    const responses = await Promise.all(Array.from({ length: 4 }, () => getKey(h!, token)));
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const keys = await Promise.all(
      responses.map(async (r) => ChatGPTKeyResponse.parse(await r.json()).apiKey),
    );
    expect(new Set(keys).size).toBe(1);
    expect(await chatgptRows(h)).toHaveLength(1);
    // Keys created by the losers of the race were disabled right away.
    const enabled = [...provisioner.keys.values()].filter((k) => !k.disabled);
    expect(enabled).toHaveLength(1);
  });

  it.each([
    ['a key OpenAI never published', { foreignKey: true }],
    ['another issuer', { iss: 'https://evil.example.org' }],
    ['an expired token', { expiresIn: -3600, issuedAgo: 7200 }],
    ['a token older than a day', { issuedAgo: 2 * 86_400, expiresIn: 3600 }],
    ['a token for OpenAI’s own Codex client', { aud: 'app_EMoamEEZ73f0CkXaXp7hrann' }],
    ['a token for several clients', { aud: ['oaiapp_one', 'app_other'] }],
  ])('rejects %s', async (_name, options) => {
    const upstream = fakeLiteLLM();
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const res = await getKey(h, await idToken(options));
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('invalid_identity');
    expect(upstream.calls).toEqual([]);
    expect(await chatgptRows(h)).toEqual([]);
  });

  it('rejects requests without an ID token', async () => {
    h = await setup();
    for (const body of [{}, { idToken: 'not-a-jwt' }, { accessToken: 'x.y.z' }]) {
      const res = await h.request('POST', '/v1/chatgpt-keys', { body });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe('bad_request');
    }
  });

  it('does not record anything when LiteLLM fails', async () => {
    let up = false;
    const upstream = fakeLiteLLM({
      generate: () => (up ? undefined : jsonResponse({ error: { message: 'busy' } }, 503)),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    const token = await idToken();
    const failed = await getKey(h, token);
    expect(failed.status).toBe(502);
    expect(await errorCode(failed)).toBe('provider_error');
    expect(await chatgptRows(h)).toEqual([]);
    up = true;
    expect((await getKey(h, token)).status).toBe(200);
  });

  it('puts every key in one team whose budget is the optional global cap', async () => {
    const upstream = fakeLiteLLM();
    const provisioner = litellmProvisioner(upstream.fetch);
    h = await setup({
      provisioner,
      config: {
        chatgptKeys: { ...testConfig().chatgptKeys, globalMonthlyBudgetUsd: 25 },
      },
    });
    expect((await getKey(h, await idToken())).status).toBe(200);
    expect(upstream.calls[0]!.body).toMatchObject({
      team_alias: 'sa-chatgpt-keys',
      max_budget: 25,
    });

    // After a restart with another cap, the same team is updated, not created again.
    const restarted = createApp({
      db: h.db,
      config: testConfig({
        chatgptKeys: { ...testConfig().chatgptKeys, globalMonthlyBudgetUsd: 40 },
      }),
      provisioner,
      identity: testIdentity(),
      logger: silentLogger,
    });
    const res = await restarted.request(
      '/v1/chatgpt-keys',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken: await idToken({ sub: 'auth0|user-3' }) }),
      },
      { incoming: { socket: { remoteAddress: '203.0.113.5' } } },
    );
    expect(res.status).toBe(200);
    const teamCalls = upstream.calls.filter((c) => c.url.includes('/team/'));
    expect(teamCalls.map((c) => c.url)).toEqual([
      'http://litellm:4000/team/new',
      'http://litellm:4000/team/update',
    ]);
    expect(teamCalls[1]!.body).toMatchObject({ team_id: 'team-1', max_budget: 40 });
    const generated = upstream.calls.filter((c) => c.url.endsWith('/key/generate'));
    expect(generated.map((c) => (c.body as { team_id: string }).team_id)).toEqual([
      'team-1',
      'team-1',
    ]);
  });

  it('can be disabled, and is disabled without an identity verifier', async () => {
    h = await setup({
      config: { chatgptKeys: { ...testConfig().chatgptKeys, enabled: false } },
    });
    let res = await getKey(h, await idToken());
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('chatgpt_keys_disabled');
    await h.close();
    h = await setup({ identity: null });
    res = await getKey(h, await idToken());
    expect(res.status).toBe(403);
  });

  it('has no anonymous search keys any more', async () => {
    h = await setup();
    expect((await h.request('POST', '/v1/search-tokens')).status).toBe(404);
    expect((await h.request('POST', '/v1/search', { body: { query: 'x' } })).status).toBe(404);
  });
});

describe('SubsidyTeam.syncModels', () => {
  it('moves the team and every ChatGPT key to a new decider model, once', async () => {
    const upstream = fakeLiteLLM();
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    await getKey(h, await idToken());
    await getKey(h, await idToken({ sub: 'google-oauth2|user-2' }));
    expect([...upstream.keys.values()].map((k) => k.models)).toEqual([
      [DECIDER_MODEL, TRANSCRIPTION_MODEL],
      [DECIDER_MODEL, TRANSCRIPTION_MODEL],
    ]);

    const next = 'perplexity/pplx-decider-next';
    const team = () =>
      new SubsidyTeam(h!.db, h!.provisioner, { deciderModel: next, monthlyBudgetUsd: null });
    upstream.calls.length = 0;
    expect(await team().syncModels()).toBe(2);
    expect(upstream.calls.map((c) => c.url)).toEqual([
      'http://litellm:4000/team/update',
      'http://litellm:4000/key/update',
      'http://litellm:4000/key/update',
    ]);
    expect(upstream.calls[0]!.body).toMatchObject({ models: [next, TRANSCRIPTION_MODEL] });
    expect([...upstream.keys.values()].map((k) => k.models)).toEqual([
      [next, TRANSCRIPTION_MODEL],
      [next, TRANSCRIPTION_MODEL],
    ]);

    // The next start finds the list applied and calls nothing.
    upstream.calls.length = 0;
    expect(await team().syncModels()).toBe(0);
    expect(upstream.calls).toEqual([]);
  });

  it('retries on the next call when an update fails', async () => {
    let fail = true;
    const upstream = fakeLiteLLM({
      update: () => (fail ? jsonResponse({ error: { message: 'down' } }, 500) : undefined),
    });
    h = await setup({ provisioner: litellmProvisioner(upstream.fetch) });
    await getKey(h, await idToken());
    const team = new SubsidyTeam(h.db, h.provisioner, {
      deciderModel: 'perplexity/pplx-decider-next',
      monthlyBudgetUsd: null,
    });
    await expect(team.syncModels()).rejects.toThrow('key update failed (500)');
    fail = false;
    expect(await team.syncModels()).toBe(1);
  });
});

describe('sealed keys', () => {
  it('only decrypt with the same key and the same account', () => {
    const sealed = sealSecret('sk-secret', TEST_ENCRYPTION_KEY, 'account-a');
    expect(sealed).toMatch(/^v1\./);
    expect(sealSecret('sk-secret', TEST_ENCRYPTION_KEY, 'account-a')).not.toBe(sealed); // random IV
    expect(openSecret(sealed, TEST_ENCRYPTION_KEY, 'account-a')).toBe('sk-secret');
    expect(() => openSecret(sealed, TEST_ENCRYPTION_KEY, 'account-b')).toThrow();
    expect(() => openSecret(sealed, Buffer.alloc(32, 1), 'account-a')).toThrow();
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    expect(() => openSecret(tampered, TEST_ENCRYPTION_KEY, 'account-a')).toThrow();
  });
});
