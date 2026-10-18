import type { ChatGPTLoginCallbacks } from '@sa/agent';
import { agentAuthor } from '@sa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../core/i18n';
import { SECRET_IDS } from '../core/secrets';
import { createFakeProviderLib, FAKE_ID_TOKEN } from '../testing/fakes';
import { createFakeFetch, createTestApp, TEST_LOGIN_PAGES, type TestApp } from '../testing/harness';

let app: TestApp;
afterEach(async () => {
  await app?.close();
});

describe('ProviderManager', () => {
  it('redeems a voucher: key in the vault, gateway in app state, config in settings, status event', async () => {
    app = await createTestApp();
    const res = await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    expect(res).toMatchObject({
      ok: true,
      status: {
        configured: true,
        kind: 'voucher',
        label: 'Bono Spain Assist',
        // The app version's voucher model.
        model: 'test/voucher-model',
        // The voucher's credit, before the gateway reports any spend.
        credit: { usageUsd: 0, limitUsd: 5, remainingUsd: 5 },
      },
    });
    expect(await app.vault.getSecret(SECRET_IDS.voucher)).toBe('sk-litellm-voucher-key-123456');
    const settings = await app.invoke('settings.get');
    expect(settings.provider).toEqual({
      kind: 'voucher',
      secretId: SECRET_IDS.voucher,
      limitUsd: 5,
    });
    expect(JSON.stringify(settings)).not.toContain('sk-litellm-voucher-key');
    expect(app.events.some((e) => e.type === 'providers.status')).toBe(true);
    const status = await app.invoke('providers.status');
    expect(status.credit).toEqual({ usageUsd: 1, limitUsd: 5, remainingUsd: 4 });
    // An OpenAI-compatible provider at our LiteLLM gateway.
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'litellm',
      id: 'test/voucher-model',
      baseUrl: 'https://llm.example.test/v1',
      maxTokens: 8192,
    });
    // The assistant (orchestrator) has its own model and effort.
    expect(await app.services.providers.agentModel('assistant')).toEqual({
      provider: 'litellm',
      id: 'test/voucher-assistant',
      thinkingLevel: 'high',
      baseUrl: 'https://llm.example.test/v1',
      maxTokens: 8192,
    });
    expect(await app.services.providers.credentialFor('litellm')).toEqual({
      type: 'api_key',
      key: 'sk-litellm-voucher-key-123456',
    });
    expect(await app.services.providers.credentialFor('openrouter')).toBeNull();
  });

  it('sends the current voucher key with the next voucher, so it tops that key up', async () => {
    const sent: (string | undefined)[] = [];
    const fake = createFakeProviderLib();
    app = await createTestApp({
      providerLib: {
        ...fake,
        redeemVoucher(url, code, currentKey) {
          sent.push(currentKey);
          return fake.redeemVoucher(url, code, currentKey);
        },
      },
    });
    expect(await app.invoke('providers.redeemVoucher', 'VALID-CODE')).toMatchObject({
      ok: true,
      addedUsd: 5,
    });
    expect(await app.invoke('providers.redeemVoucher', 'VALID-CODE')).toMatchObject({
      ok: true,
      addedUsd: 5,
      // The whole key: what was spent before stays spent.
      status: { credit: { usageUsd: 1, limitUsd: 10, remainingUsd: 9 } },
    });
    expect(sent).toEqual([undefined, 'sk-litellm-voucher-key-123456']);
    expect(await app.vault.getSecret(SECRET_IDS.voucher)).toBe('sk-litellm-voucher-key-123456');
  });

  it('reads the voucher credit from the key server, with the gateway the voucher came with', async () => {
    const calls: string[] = [];
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async redeemVoucher() {
          return {
            provider: 'litellm',
            baseUrl: 'http://127.0.0.1:8789/v1/',
            apiKey: 'sk-mock-1',
            limitUsd: 5,
            usageUsd: 0,
            addedUsd: 5,
            searchTools: [],
          };
        },
        async getVoucherCredit(keyServerUrl, apiKey) {
          calls.push(`credit ${keyServerUrl} ${apiKey}`);
          return {
            limitUsd: 5,
            spendUsd: 0.5,
            maxBudgetUsd: 5,
            expiresAt: '2027-04-07T09:00:00.000Z',
          };
        },
      }),
    });
    expect((await app.invoke('providers.redeemVoucher', 'SA-DEMO42')).ok).toBe(true);
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'litellm',
      id: 'test/voucher-model',
      baseUrl: 'http://127.0.0.1:8789/v1',
      maxTokens: 8192,
    });
    const status = await app.invoke('providers.status');
    expect(status.credit).toEqual({ usageUsd: 0.5, limitUsd: 5, remainingUsd: 4.5 });
    expect(status.expiresAt).toBe('2027-04-07T09:00:00.000Z');
    expect(calls).toContain('credit http://127.0.0.1:8787 sk-mock-1');
    expect(app.logLines.join('\n')).not.toContain('sk-mock-1');
  });

  it('counts web research as used: it lowers the cap, not the vouchers total', async () => {
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async getVoucherCredit() {
          // A 5 USD voucher, 0.30 of LLM calls and a 0.11 research run.
          return { limitUsd: 5, spendUsd: 0.3, maxBudgetUsd: 4.89, expiresAt: null };
        },
      }),
    });
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    await app.services.providers.refreshCredit();
    const status = await app.invoke('providers.status');
    expect(status.credit?.limitUsd).toBe(5);
    expect(status.credit?.remainingUsd).toBeCloseTo(4.59);
    expect(status.credit?.usageUsd).toBeCloseTo(0.41);

    // The headers carry the same cap: the total stays what the vouchers add up to.
    const { token } = await app.procedureWithToken();
    await app.rpc('agent.voucherSpend', { spendUsd: 0.4, maxBudgetUsd: 4.89 }, token);
    const credit = (await app.invoke('providers.status')).credit;
    expect(credit?.limitUsd).toBe(5);
    expect(credit?.remainingUsd).toBeCloseTo(4.49);
  });

  it('refreshes the voucher credit after spending, and again once the gateway wrote the spend', async () => {
    let usageUsd = 1;
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async getVoucherCredit() {
          return { limitUsd: 5, spendUsd: usageUsd, maxBudgetUsd: 5, expiresAt: null };
        },
      }),
    });
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const lastEmittedUsage = () =>
      app.events.findLast((e) => e.type === 'providers.status')?.status.credit?.usageUsd;
    await vi.waitFor(() => expect(lastEmittedUsage()).toBe(1));

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      usageUsd = 2;
      app.services.providers.creditSpent();
      await vi.waitFor(() => expect(lastEmittedUsage()).toBe(2));

      usageUsd = 3;
      await vi.advanceTimersByTimeAsync(12_000);
      await vi.waitFor(() => expect(lastEmittedUsage()).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the voucher spend an agent read in the LiteLLM headers, and never moves it back', async () => {
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async getVoucherCredit() {
          return { limitUsd: 5, spendUsd: 1, maxBudgetUsd: 5, expiresAt: null };
        },
      }),
    });
    expect((await app.invoke('providers.redeemVoucher', 'VALID-CODE')).ok).toBe(true);
    const lastEmittedCredit = () =>
      app.events.findLast((e) => e.type === 'providers.status')?.status.credit;
    await vi.waitFor(() => expect(lastEmittedCredit()?.usageUsd).toBe(1));
    const { token } = await app.procedureWithToken();
    const reportSpend = (spendUsd: number) =>
      app.rpc('agent.voucherSpend', { spendUsd, maxBudgetUsd: 5 }, token);

    expect((await reportSpend(2.5)).status).toBe(200);
    expect(lastEmittedCredit()).toEqual({ usageUsd: 2.5, limitUsd: 5, remainingUsd: 2.5 });

    // An older header, or the key server before the gateway wrote the spend.
    await reportSpend(2);
    await app.services.providers.refreshCredit();
    expect((await app.invoke('providers.status')).credit?.usageUsd).toBe(2.5);

    expect(
      (await app.rpc('agent.voucherSpend', { spendUsd: -1, maxBudgetUsd: 5 }, token)).status,
    ).toBe(400);
  });

  it('keeps the voucher model fixed: no model list, and setModel is refused', async () => {
    app = await createTestApp();
    await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    expect(await app.invoke('providers.listModels')).toEqual([]);
    await expect(app.invoke('providers.setModel', 'other-model')).rejects.toThrow(
      t('es', 'invalidRequest'),
    );
    expect((await app.services.providers.agentModel()).id).toBe('test/voucher-model');
  });

  it('maps key-server error codes to plain messages', async () => {
    const codes: [string, string][] = [
      ['invalid_code', t('es', 'voucherInvalid')],
      ['bad_request', t('es', 'voucherInvalid')],
      ['already_redeemed', t('es', 'voucherUsed')],
      ['expired', t('es', 'voucherExpired')],
      ['revoked', t('es', 'voucherRevoked')],
      ['rate_limited', t('es', 'voucherRateLimited')],
      ['provider_error', t('es', 'voucherFailed')],
      ['internal', t('es', 'voucherFailed')],
    ];
    let next = '';
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async redeemVoucher() {
          if (next === 'network') throw new TypeError('fetch failed');
          throw Object.assign(new Error('nope'), { code: next });
        },
      }),
    });
    for (const [code, message] of codes) {
      next = code;
      expect(await app.invoke('providers.redeemVoucher', 'SA-XXXXXX')).toEqual({
        ok: false,
        error: message,
      });
    }
    next = 'network';
    expect(await app.invoke('providers.redeemVoucher', 'SA-XXXXXX')).toEqual({
      ok: false,
      error: t('es', 'voucherNetwork'),
    });
    expect((await app.invoke('providers.status')).configured).toBe(false);
  });

  it('sets BYOK and custom providers, changes the model and logs out (deleting the secret)', async () => {
    app = await createTestApp();
    expect(await app.invoke('providers.listByok')).toHaveLength(2);
    const unknown = await app.invoke('providers.setByok', {
      provider: 'nope',
      apiKey: 'k',
      model: 'm',
    });
    expect(unknown.ok).toBe(false);
    const byok = await app.invoke('providers.setByok', {
      provider: 'anthropic',
      apiKey: ' sk-ant-1 ',
      model: 'claude-x',
    });
    expect(byok).toMatchObject({
      ok: true,
      status: { kind: 'byok', label: 'Anthropic (clave propia)' },
    });
    expect(await app.vault.getSecret(SECRET_IDS.byok)).toBe('sk-ant-1');
    expect(await app.invoke('providers.setModel', 'claude-y')).toMatchObject({ model: 'claude-y' });
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'anthropic',
      id: 'claude-y',
    });
    // BYOK runs the assistant on the user's model too.
    expect(await app.services.providers.agentModel('assistant')).toEqual({
      provider: 'anthropic',
      id: 'claude-y',
    });

    const custom = await app.invoke('providers.setCustom', {
      baseUrl: 'http://localhost:11434/v1/',
      api: 'openai-completions',
      model: 'llama',
      apiKey: 'local-key',
    });
    expect(custom).toMatchObject({
      ok: true,
      status: { kind: 'custom', label: 'Servidor propio (localhost:11434)' },
    });
    expect((await app.invoke('settings.get')).provider).toEqual({
      kind: 'custom',
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      model: 'llama',
      secretId: SECRET_IDS.custom,
    });
    expect(await app.invoke('providers.logout')).toEqual({ status: { configured: false } });
    expect(await app.vault.getSecret(SECRET_IDS.custom)).toBeUndefined();
    await expect(app.invoke('providers.setModel', 'x')).rejects.toThrow(
      t('es', 'agentErrorNoProvider'),
    );
  });

  it('keeps the Exa key of BYOK and custom endpoints in the vault, and only says whether it is saved', async () => {
    app = await createTestApp();
    // Nothing to research with yet: only BYOK and custom endpoints take one.
    await expect(app.invoke('providers.setExaKey', 'exa-secret-key-123')).rejects.toThrow(
      t('es', 'invalidRequest'),
    );
    const byok = await app.invoke('providers.setByok', {
      provider: 'anthropic',
      apiKey: 'sk-ant-1',
      model: 'claude-x',
    });
    expect(byok).toMatchObject({ ok: true, status: { kind: 'byok', exaKey: false } });
    // zod: an empty key is refused, null deletes.
    await expect(app.invoke('providers.setExaKey', '  ')).rejects.toThrow();
    const saved = await app.invoke('providers.setExaKey', ' exa-secret-key-123 ');
    expect(saved).toMatchObject({ kind: 'byok', exaKey: true });
    expect(JSON.stringify(saved)).not.toContain('exa-secret-key-123');
    expect(await app.vault.getSecret(SECRET_IDS.exa)).toBe('exa-secret-key-123');
    expect(app.events.at(-1)).toEqual({ type: 'providers.status', status: saved });
    expect(await app.services.providers.exaKey()).toBe('exa-secret-key-123');
    expect(app.logLines.join('\n')).not.toContain('exa-secret-key-123');

    // Switching between BYOK and a custom endpoint keeps it.
    const custom = await app.invoke('providers.setCustom', {
      baseUrl: 'http://localhost:11434/v1',
      api: 'openai-completions',
      model: 'llama',
    });
    expect(custom).toMatchObject({ ok: true, status: { kind: 'custom', exaKey: true } });
    expect(await app.invoke('providers.setExaKey', null)).toMatchObject({ exaKey: false });
    expect(await app.vault.getSecret(SECRET_IDS.exa)).toBeUndefined();

    // Disconnecting deletes it: no other setup uses it.
    await app.invoke('providers.setExaKey', 'exa-secret-key-456');
    expect(await app.invoke('providers.logout')).toEqual({ status: { configured: false } });
    expect(await app.vault.getSecret(SECRET_IDS.exa)).toBeUndefined();
    expect(await app.services.providers.exaKey()).toBeUndefined();
  });

  it('signs in with ChatGPT: stable device id, browser opened, progress events, account shown', async () => {
    const deviceIds: string[] = [];
    const pages: unknown[] = [];
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async loginChatGPT(cb: ChatGPTLoginCallbacks) {
          deviceIds.push(cb.deviceId);
          pages.push(cb.pages);
          cb.onAuthUrl('https://auth.openai.com/api/accounts/authorize?client_id=x');
          cb.onProgress?.('exchanging');
          return {
            credential: {
              type: 'oauth',
              access: 'access-1',
              refresh: 'refresh-1',
              expires: Date.now() + 3_600_000,
            },
            account: 'lucia@example.com',
          };
        },
      }),
    });
    const res = await app.invoke('providers.loginChatGPT');
    expect(res).toMatchObject({
      ok: true,
      status: { kind: 'chatgpt', label: 'ChatGPT', account: 'lucia@example.com' },
    });
    expect(app.opened).toEqual(['https://auth.openai.com/api/accounts/authorize?client_id=x']);
    const progress = app.events.filter((e) => e.type === 'providers.loginProgress');
    expect(progress[0]).toMatchObject({
      url: 'https://auth.openai.com/api/accounts/authorize?client_id=x',
    });
    expect(progress[1]).toMatchObject({ message: t('es', 'loginExchanging') });
    await app.invoke('providers.loginChatGPT');
    expect(deviceIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(deviceIds[1]).toBe(deviceIds[0]);
    // The sign-in's pages come from the app's dependencies (MainDeps.chatgptLoginPages).
    expect(pages).toEqual([TEST_LOGIN_PAGES, TEST_LOGIN_PAGES]);
    expect(app.logLines.join('\n')).not.toContain('access-1');
    const { procedureId, token } = await app.procedureWithToken();
    expect(procedureId).toBeDefined();
    const cred = await app.rpc('agent.credential', { providerId: 'openai' }, token);
    expect(cred.body.result.credential).toMatchObject({ type: 'oauth', access: 'access-1' });
  });

  it('ends the ChatGPT session at OpenAI on sign out and when signing in again', async () => {
    let logins = 0;
    let revokeFails = false;
    const lib = createFakeProviderLib({
      async loginChatGPT() {
        logins++;
        return {
          credential: {
            type: 'oauth',
            access: `access-${logins}`,
            refresh: `refresh-${logins}`,
            expires: Date.now() + 3_600_000,
            clientId: 'oaiapp_1',
          },
        };
      },
    });
    const revokeChatGPTCredential = lib.revokeChatGPTCredential;
    lib.revokeChatGPTCredential = async (credential) => {
      if (revokeFails) throw new Error('Could not reach ChatGPT');
      await revokeChatGPTCredential(credential);
    };
    app = await createTestApp({ providerLib: lib });

    await app.invoke('providers.loginChatGPT');
    expect(lib.revoked).toEqual([]);
    // A second sign-in replaces the session: the old one ends.
    await app.invoke('providers.loginChatGPT');
    await vi.waitFor(() => expect(lib.revoked).toEqual(['refresh-1']));
    expect(await app.invoke('providers.logout')).toEqual({ status: { configured: false } });
    expect(lib.revoked).toEqual(['refresh-1', 'refresh-2']);
    expect(await app.vault.getSecret(SECRET_IDS.chatgpt)).toBeUndefined();

    // OpenAI unreachable: signed out here anyway, and the user is told.
    await app.invoke('providers.loginChatGPT');
    revokeFails = true;
    expect(await app.invoke('providers.logout')).toEqual({
      status: { configured: false },
      chatgptStillConnected: true,
    });
    expect(await app.vault.getSecret(SECRET_IDS.chatgpt)).toBeUndefined();
  });

  it('explains that ChatGPT needs a paid plan when the account is not eligible', async () => {
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        loginChatGPT: async () => {
          throw Object.assign(new Error('Token request failed (400): invalid_grant'), {
            code: 'not_eligible',
          });
        },
      }),
    });
    expect(await app.invoke('providers.loginChatGPT')).toEqual({
      ok: false,
      error: t('es', 'loginChatgptNotEligible'),
    });
  });

  it('cancels a sign-in in progress', async () => {
    // Wait until the manager reaches the provider library (it first reads and may persist the
    // device id), not a fixed delay: under load that takes longer than any sleep.
    let started!: () => void;
    const reachedLib = new Promise<void>((r) => {
      started = r;
    });
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        loginChatGPT: (cb: ChatGPTLoginCallbacks) =>
          new Promise((_resolve, reject) => {
            cb.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            started();
          }),
      }),
    });
    const pending = app.invoke('providers.loginChatGPT');
    await reachedLib;
    expect(await app.invoke('providers.loginChatGPT')).toEqual({
      ok: false,
      error: t('es', 'loginInProgress'),
    });
    await app.invoke('providers.cancelLogin');
    expect(await pending).toEqual({ ok: false, error: t('es', 'loginCancelled') });
  });

  it('serializes OAuth refreshes across agents and persists the result', async () => {
    const lib = createFakeProviderLib();
    app = await createTestApp({ providerLib: lib });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;
    // Fresh token: returned as is, no refresh.
    expect(await providers.refreshCredential('openai')).toMatchObject({ access: 'acc-token-1' });
    expect(lib.refreshCalls).toBe(0);
    // About to expire: three agents ask at once -> one refresh.
    const stored = JSON.parse((await app.vault.getSecret(SECRET_IDS.chatgpt))!);
    stored.credential.expires = Date.now() + 60_000;
    await app.vault.setSecret(SECRET_IDS.chatgpt, 'x', JSON.stringify(stored));
    const results = await Promise.all([
      providers.refreshCredential('openai'),
      providers.refreshCredential('openai'),
      providers.refreshCredential('openai'),
    ]);
    expect(lib.refreshCalls).toBe(1);
    expect(new Set(results.map((r) => r?.access))).toEqual(new Set(['acc-token-2']));
    const persisted = JSON.parse((await app.vault.getSecret(SECRET_IDS.chatgpt))!);
    expect(persisted.credential.access).toBe('acc-token-2');
    expect(persisted.account).toBe('user@example.com');
    expect(await providers.refreshCredential('anthropic')).toBeNull();
  });

  it('refuses the Codex device-code login when the build does not include it', async () => {
    app = await createTestApp();
    expect(await app.invoke('providers.loginCodexDevice')).toEqual({
      ok: false,
      error: t('es', 'loginCodexUnavailable'),
    });
  });

  it('signs in with a Codex device code (dev builds) and serves the openai-codex credential', async () => {
    let refreshed = 0;
    const credential = {
      type: 'oauth' as const,
      access: 'codex-access-1',
      refresh: 'codex-refresh-1',
      expires: Date.now() + 60_000,
      accountId: 'acct-1',
    };
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        codex: {
          async login(cb) {
            cb.onUserCode({
              userCode: 'ABCD-1234',
              verificationUrl: 'https://auth.openai.com/codex/device',
              expiresAt: Date.now() + 900_000,
            });
            return { credential, account: 'dev@example.com' };
          },
          async refresh(previous) {
            refreshed++;
            return { ...previous, access: 'codex-access-2', expires: Date.now() + 3_600_000 };
          },
        },
      }),
    });
    const res = await app.invoke('providers.loginCodexDevice');
    expect(res).toMatchObject({
      ok: true,
      status: {
        kind: 'codex',
        label: t('es', 'providerCodex'),
        account: 'dev@example.com',
      },
    });
    expect(app.events.find((e) => e.type === 'providers.loginProgress')).toMatchObject({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    });
    expect(app.opened).toEqual([]);
    const providers = app.services.providers;
    expect(await providers.agentModel()).toMatchObject({ provider: 'openai-codex' });
    expect(await providers.credentialFor('openai')).toBeNull();
    expect(await providers.credentialFor('openai-codex')).toMatchObject({ accountId: 'acct-1' });
    expect(await providers.refreshCredential('openai-codex')).toMatchObject({
      access: 'codex-access-2',
    });
    expect(refreshed).toBe(1);
    const stored = JSON.parse((await app.vault.getSecret(SECRET_IDS.codex))!);
    expect(stored.credential.access).toBe('codex-access-2');
    expect(app.logLines.join('\n')).not.toContain('codex-refresh-1');
    // Without SA_DEV_USER_KEY, a Codex session has no user.
    expect(providers.hasUserKey()).toBe(false);
    expect(await providers.userKey()).toBeUndefined();

    await app.invoke('providers.logout');
    expect(await app.vault.getSecret(SECRET_IDS.codex)).toBeUndefined();
  });

  it('saves a rotated Codex refresh token at once, even when the refresh then fails', async () => {
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        codex: {
          async login() {
            return {
              credential: {
                type: 'oauth' as const,
                access: 'codex-access-1',
                refresh: 'codex-refresh-1',
                expires: Date.now() - 1,
                accountId: 'acct-1',
              },
            };
          },
          async refresh(_previous, onRotatedRefreshToken) {
            await onRotatedRefreshToken?.('codex-refresh-2');
            throw new Error('token response has no expires_in');
          },
        },
      }),
    });
    await app.invoke('providers.loginCodexDevice');
    await expect(app.services.providers.refreshCredential('openai-codex')).rejects.toThrow(
      'expires_in',
    );
    const stored = JSON.parse((await app.vault.getSecret(SECRET_IDS.codex))!);
    expect(stored.credential).toMatchObject({
      access: 'codex-access-1',
      refresh: 'codex-refresh-2',
    });
    expect(app.logLines.join('\n')).not.toContain('codex-refresh-2');
  });

  it("uses SA_DEV_USER_KEY as a Codex session's user key", async () => {
    const devUserKey = { baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-dev-user-key-123456' };
    app = await createTestApp({
      env: { devUserKey },
      providerLib: createFakeProviderLib({
        codex: {
          async login() {
            return {
              credential: {
                type: 'oauth' as const,
                access: 'codex-access-1',
                refresh: 'codex-refresh-1',
                expires: Date.now() + 60_000,
                accountId: 'acct-1',
              },
            };
          },
          async refresh(previous) {
            return previous;
          },
        },
      }),
    });
    const providers = app.services.providers;
    await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    expect(await providers.userKey()).toEqual({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'sk-litellm-voucher-key-123456',
    });
    expect((await app.invoke('providers.loginCodexDevice')).ok).toBe(true);
    expect(providers.hasUserKey()).toBe(true);
    expect(await providers.userKey()).toEqual(devUserKey);
    expect(await providers.scanGateAccess()).toMatchObject({ apiKey: 'sk-dev-user-key-123456' });
    expect(app.logLines.join('\n')).not.toContain('sk-dev-user-key');
  });

  it('lists models only for BYOK and custom providers', async () => {
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        codex: {
          login: async () => ({
            credential: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3e6 },
          }),
          refresh: async (c) => c,
        },
      }),
    });
    expect(await app.invoke('providers.listModels')).toEqual([]);

    await app.invoke('providers.loginChatGPT');
    expect(await app.invoke('providers.listModels')).toEqual([]);
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'openai',
      id: 'gpt-test',
    });
    expect(await app.services.providers.agentModel('assistant')).toEqual({
      provider: 'openai',
      id: 'gpt-test-assistant',
      thinkingLevel: 'high',
    });
    // Learnings shared by procedure agents name their model and reasoning level.
    expect(await app.services.providers.agentAuthor()).toBe('gpt-test · medium');
    expect(await app.services.providers.agentAuthor('assistant')).toBe('gpt-test-assistant · high');

    await app.invoke('providers.loginCodexDevice');
    expect(await app.invoke('providers.listModels')).toEqual([]);
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'openai-codex',
      id: 'gpt-test',
    });
    expect(await app.services.providers.agentModel('assistant')).toEqual({
      provider: 'openai-codex',
      id: 'gpt-test-assistant',
      thinkingLevel: 'high',
    });

    await app.invoke('providers.setByok', { provider: 'anthropic', apiKey: 'k', model: 'x' });
    expect((await app.invoke('providers.listModels')).map((m) => m.provider)).toEqual([
      'anthropic',
      'anthropic',
      'anthropic',
    ]);

    await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'llama3.1:8b',
    });
    expect(await app.invoke('providers.listModels')).toEqual([
      { provider: 'custom', id: 'llama3.1:8b', name: 'llama3.1:8b' },
    ]);
    // A custom endpoint without reasoning runs at "off".
    expect(await app.services.providers.agentAuthor()).toBe('llama3.1:8b · off');
  });

  it('screens scans with the voucher key on the voucher gateway', async () => {
    app = await createTestApp();
    await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    expect(await app.services.providers.scanGateAccess()).toEqual({
      endpoint: 'https://llm.example.test/openrouter/alpha/decisions',
      apiKey: 'sk-litellm-voucher-key-123456',
    });
  });

  it('gets the ChatGPT account scan key with the ID token and keeps it with the credential', async () => {
    const tokens: string[] = [];
    const lib = createFakeProviderLib();
    const getKey = lib.getChatGPTKey;
    app = await createTestApp({
      providerLib: {
        ...lib,
        getChatGPTKey: (url, idToken) => {
          tokens.push(idToken);
          return getKey(url, idToken);
        },
      },
    });
    expect((await app.invoke('providers.loginChatGPT')).ok).toBe(true);
    const access = await app.services.providers.scanGateAccess();
    expect(access).toEqual({
      endpoint: 'https://llm.example.test/openrouter/alpha/decisions',
      apiKey: 'sk-litellm-chatgpt-scan-key-123456',
    });
    expect(tokens).toEqual([FAKE_ID_TOKEN]);
    // Stored with the ChatGPT credential: reused, never asked for again.
    const stored = JSON.parse((await app.vault.getSecret(SECRET_IDS.chatgpt))!);
    expect(stored.scanKey).toEqual({
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'sk-litellm-chatgpt-scan-key-123456',
    });
    expect(await app.services.providers.scanGateAccess()).toEqual(access);
    expect(tokens).toHaveLength(1);
    // Neither the key nor the ID token reach logs, settings or the agent's credential.
    const settings = JSON.stringify(await app.invoke('settings.get'));
    for (const secret of ['sk-litellm-chatgpt-scan-key', FAKE_ID_TOKEN]) {
      expect(app.logLines.join('\n')).not.toContain(secret);
      expect(settings).not.toContain(secret);
    }
    const credential = await app.services.providers.credentialFor('openai');
    expect(JSON.stringify(credential)).not.toContain('scan-key');
    // Signing out forgets it.
    await app.invoke('providers.logout');
    expect(await app.services.providers.scanGateAccess()).toBeUndefined();
  });

  it('signs in with ChatGPT even when the key server refuses the ID token', async () => {
    let calls = 0;
    app = await createTestApp({
      providerLib: createFakeProviderLib({
        async getChatGPTKey() {
          calls++;
          throw Object.assign(new Error('Sign in with ChatGPT again.'), {
            code: 'invalid_identity',
          });
        },
      }),
    });
    expect((await app.invoke('providers.loginChatGPT')).ok).toBe(true);
    expect(await app.services.providers.scanGateAccess()).toBeUndefined();
    expect(await app.services.providers.scanGateAccess()).toBeUndefined();
    expect(calls).toBe(1); // a refused token is not sent again
    expect(app.logLines.join('\n')).toContain('ChatGPT scan key unavailable');
  });

  it('has no user key for BYOK and custom endpoints', async () => {
    app = await createTestApp({
      env: { devUserKey: { baseUrl: 'https://llm.example.test/v1', apiKey: 'sk-dev-user-key-1' } },
    });
    await app.invoke('providers.setByok', {
      provider: 'anthropic',
      model: 'anthropic-model-a',
      apiKey: 'sk-ant-123456789',
    });
    expect(app.services.providers.hasUserKey()).toBe(false);
    expect(await app.services.providers.userKey()).toBeUndefined();
    expect(await app.services.providers.scanGateAccess()).toBeUndefined();
  });

  it('preconfigures SA_PROVIDER at startup', async () => {
    app = await createTestApp({
      env: {
        provider: {
          kind: 'custom',
          baseUrl: 'http://127.0.0.1:8789/v1',
          model: 'mock-model',
          api: 'openai-completions',
        },
      },
    });
    expect(await app.invoke('providers.status')).toMatchObject({
      configured: true,
      kind: 'custom',
      model: 'mock-model',
    });
  });
});

describe('custom endpoint capabilities', () => {
  /** An Ollama server: `extra` answers more paths. */
  const ollama = (extra: Record<string, unknown> = {}) =>
    createFakeFetch(({ url }) => {
      const routes: Record<string, unknown> = {
        '/v1/models': { data: [{ id: 'qwen2.5vl:7b' }, { id: 'qwen3:14b' }] },
        '/api/ps': { models: [] },
        ...extra,
      };
      const body = routes[url.pathname];
      return body === undefined ? new Response('', { status: 404 }) : Response.json(body);
    });

  it('passes the capabilities to every agent role and reasons at the normal level', async () => {
    app = await createTestApp();
    const capabilities = {
      supportsImages: true,
      reasoning: true,
      contextWindow: 40_960,
      maxTokens: 8192,
    };
    const res = await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen3:14b',
      ...capabilities,
    });
    expect(res.ok).toBe(true);
    expect((await app.invoke('settings.get')).provider).toEqual({
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen3:14b',
      ...capabilities,
    });
    const expected = {
      provider: 'custom',
      id: 'qwen3:14b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      ...capabilities,
    };
    expect(await app.services.providers.agentModel()).toEqual(expected);
    expect(await app.services.providers.agentModel('assistant')).toEqual(expected);
    // A reasoning model runs at the default thinking level, not "off".
    expect(await app.services.providers.agentAuthor()).toBe('qwen3:14b · medium');
  });

  it('probes an endpoint for the form with the typed key, which is never logged', async () => {
    const fetch = ollama({
      '/api/show': {
        capabilities: ['completion', 'vision'],
        model_info: { 'x.context_length': 32_768 },
      },
    });
    app = await createTestApp({ fetch });
    const result = await app.invoke('providers.probeCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen2.5vl:7b',
      apiKey: 'sk-local-probe-key',
    });
    expect(result).toEqual({
      reachable: true,
      server: 'ollama',
      models: ['qwen2.5vl:7b', 'qwen3:14b'],
      detected: { supportsImages: true, reasoning: false, contextWindow: 32_768 },
    });
    expect(fetch.requests.every((r) => r.url.host === '127.0.0.1:11434')).toBe(true);
    expect(fetch.requests[0]?.headers.get('authorization')).toBe('Bearer sk-local-probe-key');
    expect(app.logLines.join('\n')).not.toContain('sk-local-probe-key');
  });

  it('lists the served models, and detects again when the model changes', async () => {
    const fetch = ollama({
      '/api/show': { capabilities: ['completion', 'thinking'], parameters: 'num_ctx 16384' },
    });
    app = await createTestApp({ fetch });
    await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen2.5vl:7b',
      apiKey: 'sk-local-saved-key',
      supportsImages: true,
      maxTokens: 4096,
    });
    expect((await app.invoke('providers.listModels')).map((m) => m.id)).toEqual([
      'qwen2.5vl:7b',
      'qwen3:14b',
    ]);
    // The saved key goes to the endpoint.
    expect(fetch.requests.at(-1)?.headers.get('authorization')).toBe('Bearer sk-local-saved-key');

    await app.invoke('providers.setModel', 'qwen3:14b');
    // What the user set for the old model doesn't carry over.
    expect((await app.invoke('settings.get')).provider).toEqual({
      kind: 'custom',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen3:14b',
      secretId: SECRET_IDS.custom,
      supportsImages: false,
      reasoning: true,
      contextWindow: 16_384,
    });
  });

  it('falls back to the defaults when the server cannot be reached', async () => {
    app = await createTestApp();
    await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'a',
      supportsImages: true,
    });
    await app.invoke('providers.setModel', 'b');
    expect(await app.services.providers.agentModel()).toEqual({
      provider: 'custom',
      id: 'b',
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
    });
    expect(await app.services.providers.agentAuthor()).toBe('b · off');
  });

  it('preconfigures SA_PROVIDER capabilities', async () => {
    app = await createTestApp({
      env: {
        provider: {
          kind: 'custom',
          baseUrl: 'http://127.0.0.1:8789/v1',
          model: 'mock-model',
          api: 'openai-completions',
          supportsImages: true,
          contextWindow: 32_768,
        },
      },
    });
    expect(await app.services.providers.agentModel()).toMatchObject({
      supportsImages: true,
      contextWindow: 32_768,
    });
  });
});

describe('ChatGPT plan models', () => {
  const MODELS_URL = 'https://api.openai.com/v1/models';

  /** OpenAI's model list for a ChatGPT sign-in (synthetic, real shape). */
  const modelList = (slugs: string[]) =>
    Response.json({
      models: slugs.map((slug) => ({
        slug,
        display_name: slug,
        visibility: 'list',
        supported_in_api: true,
        input_modalities: ['text', 'image'],
        supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }],
      })),
    });

  /** OpenAI answers the model list with `answer`; every other backend is offline. */
  const openai = (answer: () => Response | Promise<Response>) =>
    createFakeFetch(({ url }) => {
      if (url.href !== MODELS_URL) throw new TypeError('fetch failed');
      return answer();
    });

  const listRequests = (fetch: { requests: { url: URL }[] }) =>
    fetch.requests.filter((r) => r.url.href === MODELS_URL).length;

  it("runs ChatGPT procedures on the best model the account's plan offers", async () => {
    let slugs = ['gpt-other', 'gpt-test-luna'];
    const fetch = openai(() => modelList(slugs));
    app = await createTestApp({ fetch });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;

    // No gpt-test (a Plus account without sol): the next model of the list.
    expect(await providers.agentModel()).toEqual({ provider: 'openai', id: 'gpt-test-luna' });
    expect(fetch.requests[0]?.headers.get('authorization')).toBe('Bearer acc-token-1');
    expect(await providers.agentAuthor()).toBe(agentAuthor('gpt-test-luna', 'medium'));
    // The assistant keeps its fixed model.
    expect(await providers.agentModel('assistant')).toEqual({
      provider: 'openai',
      id: 'gpt-test-assistant',
      thinkingLevel: 'high',
    });
    // The status shows the model in use, and says so when it changes.
    expect(providers.status().model).toBe('gpt-test-luna');
    expect(app.events.filter((e) => e.type === 'providers.status').at(-1)).toMatchObject({
      status: { model: 'gpt-test-luna' },
    });

    // Another account that has the app's model (Pro) keeps it.
    slugs = ['gpt-test-luna', 'gpt-test'];
    await app.invoke('providers.logout');
    await app.invoke('providers.loginChatGPT');
    expect(await providers.agentModel()).toEqual({ provider: 'openai', id: 'gpt-test' });
    expect(listRequests(fetch)).toBe(2);
    expect(app.logLines.join('\n')).not.toContain('acc-token-1');
  });

  it('asks once an hour, and callers at the same time share one request', async () => {
    let now = Date.parse('2026-10-18T09:00:00.000Z');
    let fail = false;
    const fetch = openai(() =>
      fail ? new Response('', { status: 503 }) : modelList(['gpt-test-luna']),
    );
    app = await createTestApp({ fetch, clock: () => new Date(now) });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;

    const [a, b] = await Promise.all([providers.agentModel(), providers.agentModel()]);
    expect([a.id, b.id]).toEqual(['gpt-test-luna', 'gpt-test-luna']);
    expect(listRequests(fetch)).toBe(1);
    now += 59 * 60_000;
    expect((await providers.agentModel()).id).toBe('gpt-test-luna');
    expect(listRequests(fetch)).toBe(1);
    now += 2 * 60_000;
    expect((await providers.agentModel()).id).toBe('gpt-test-luna');
    expect(listRequests(fetch)).toBe(2);

    // A failed check after the hour keeps the same account's last pick, as the status shows.
    fail = true;
    now += 61 * 60_000;
    expect((await providers.agentModel()).id).toBe('gpt-test-luna');
    expect((await providers.agentModel()).id).toBe('gpt-test-luna');
    expect(providers.status().model).toBe('gpt-test-luna');
    expect(listRequests(fetch)).toBe(3);
  });

  it('keeps the default model when the list is unavailable, and asks again a minute later', async () => {
    let now = Date.parse('2026-10-18T09:00:00.000Z');
    let answer = () => new Response('{"error":"server_error"}', { status: 500 });
    const fetch = openai(() => answer());
    app = await createTestApp({ fetch, clock: () => new Date(now) });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;

    expect(await providers.agentModel()).toEqual({ provider: 'openai', id: 'gpt-test' });
    expect(providers.status().model).toBe('gpt-test');
    const log = app.logLines.join('\n');
    expect(log).toContain('chatgpt model list unavailable');
    expect(log).toContain('http');
    expect(log).not.toContain('server_error');
    // An outage: agents and scans don't each wait for OpenAI.
    expect((await providers.agentModel()).id).toBe('gpt-test');
    expect(listRequests(fetch)).toBe(1);
    // The failure is not kept: a minute later OpenAI is asked again.
    answer = () => modelList(['gpt-test-luna']);
    now += 61_000;
    expect((await providers.agentModel()).id).toBe('gpt-test-luna');
    expect(listRequests(fetch)).toBe(2);
  });

  it('does not keep a list that arrives after the account changed', async () => {
    const answers: ((res: Response) => void)[] = [];
    const fetch = openai(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        }),
    );
    app = await createTestApp({ fetch });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;

    const first = providers.agentModel();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    // Signed in again (another account) while the first account's list is on its way.
    await app.invoke('providers.loginChatGPT');
    answers[0]?.(modelList(['gpt-test-luna']));
    // The old list is dropped and the new account is asked.
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(providers.status().model).toBe('gpt-test');
    answers[1]?.(modelList(['gpt-test']));
    expect((await first).id).toBe('gpt-test');
    expect((await providers.agentModel()).id).toBe('gpt-test');
    expect(providers.status().model).toBe('gpt-test');
    expect(answers).toHaveLength(2);
  });

  it("asks the new account when the previous account's lookup fails", async () => {
    const answers: ((res: Response) => void)[] = [];
    const fetch = openai(
      () =>
        new Promise<Response>((resolve) => {
          answers.push(resolve);
        }),
    );
    app = await createTestApp({ fetch });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;

    const first = providers.agentModel();
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await app.invoke('providers.loginChatGPT');
    // The old account's failure neither answers for the new account nor holds it back.
    answers[0]?.(new Response('', { status: 503 }));
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]?.(modelList(['gpt-test-luna']));
    expect((await first).id).toBe('gpt-test-luna');
    expect(providers.status().model).toBe('gpt-test-luna');
    expect(answers).toHaveLength(2);
  });

  it('keeps the default model without a usable credential, and asks nothing', async () => {
    const fetch = openai(() => modelList(['gpt-test-luna']));
    app = await createTestApp({ fetch });
    await app.invoke('providers.loginChatGPT');
    const providers = app.services.providers;
    const stored = JSON.parse((await app.vault.getSecret(SECRET_IDS.chatgpt))!);
    delete stored.credential.access;
    await app.vault.setSecret(SECRET_IDS.chatgpt, 'x', JSON.stringify(stored));
    expect((await providers.agentModel()).id).toBe('gpt-test');
    await app.vault.deleteSecret(SECRET_IDS.chatgpt);
    expect((await providers.agentModel()).id).toBe('gpt-test');
    expect(listRequests(fetch)).toBe(0);
  });

  it('never asks for vouchers, BYOK, custom endpoints or Codex', async () => {
    const fetch = openai(() => modelList(['gpt-test-luna']));
    app = await createTestApp({
      fetch,
      providerLib: createFakeProviderLib({
        codex: {
          async login() {
            const credential = {
              type: 'oauth' as const,
              access: 'codex-access-1',
              refresh: 'codex-refresh-1',
              expires: Date.now() + 3_600_000,
            };
            return { credential, account: 'dev@example.com' };
          },
          async refresh(previous) {
            return previous;
          },
        },
      }),
    });
    const providers = app.services.providers;

    await app.invoke('providers.redeemVoucher', 'VALID-CODE');
    expect((await providers.agentModel()).id).toBe('test/voucher-model');
    // An OpenAI API key runs on pi's `openai` provider too, but keeps the user's model.
    await app.invoke('providers.setByok', {
      provider: 'openai',
      apiKey: 'sk-byok-test',
      model: 'gpt-6.1-sol',
    });
    expect(await providers.agentModel()).toEqual({ provider: 'openai', id: 'gpt-6.1-sol' });
    await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      model: 'qwen3:14b',
    });
    expect((await providers.agentModel()).id).toBe('qwen3:14b');
    await app.invoke('providers.loginCodexDevice');
    expect(await providers.agentModel()).toEqual({ provider: 'openai-codex', id: 'gpt-test' });
    expect(providers.status().model).toBe('gpt-test');
    expect(listRequests(fetch)).toBe(0);
  });
});
