import { ASSISTANT_MODELS, DEFAULT_MODELS, type PiCredential } from '@sa/agent';
import type { HeadlessApp } from '@sa/desktop/headless';
import { describe, expect, it } from 'vitest';
import type { EvalAppDeps } from '../../../src/contracts';
import type { CredentialSource } from '../../../src/llm';
import { activateProvider, createProviderLib } from '../../../src/run/app/providers';

const KEY = 'sk-provider-test-7c3e1f9a';

function deps(credential: PiCredential | null, providerId = 'litellm'): EvalAppDeps {
  const credentials: CredentialSource = {
    providerId,
    credential: async (id) => (id === providerId ? credential : null),
    refreshCredential: async (id) => (id === providerId ? credential : null),
  };
  const meter = {
    agentBaseUrl: (key: string) => `http://127.0.0.1:4000/r/token/a/${key}/v1`,
    usage: () => ({ costUsd: 0.42 }),
  };
  return { meter: meter as unknown as EvalAppDeps['meter'], credentials };
}

const models = { answererModel: 'm', answererThinking: 'low' as const };

describe('the stubbed provider flows', () => {
  it("redeems a voucher with the run's credential, the meter as the gateway and the run's spend", async () => {
    const lib = createProviderLib('voucher', models, deps({ type: 'api_key', key: KEY }));
    expect(await lib.redeemVoucher('http://key-server.invalid', 'SA-EVAL01', undefined)).toEqual({
      provider: 'litellm',
      baseUrl: 'http://127.0.0.1:4000/r/token/a/app/v1',
      apiKey: KEY,
      limitUsd: 100,
      usageUsd: 0.42,
      addedUsd: 100,
      searchTools: [],
    });
    expect(await lib.getVoucherCredit('http://key-server.invalid', KEY)).toEqual({
      limitUsd: 100,
      spendUsd: 0.42,
      maxBudgetUsd: 100,
      expiresAt: null,
    });
  });

  it('refuses to redeem without an API key', async () => {
    const none = createProviderLib('voucher', models, deps(null));
    await expect(none.redeemVoucher('u', 'c', undefined)).rejects.toThrow(/no API key/);
    const oauth = createProviderLib(
      'voucher',
      models,
      deps({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }),
    );
    await expect(oauth.redeemVoucher('u', 'c', undefined)).rejects.toThrow(/no API key/);
  });

  it('fails every other way to get a provider, so nothing in the app reaches a service', async () => {
    const lib = createProviderLib('voucher', models, deps({ type: 'api_key', key: KEY }));
    await expect(lib.loginChatGPT({} as never)).rejects.toThrow(/not available in evaluation runs/);
    await expect(lib.refreshOAuthCredential('openai', {} as never)).rejects.toThrow(
      /not available/,
    );
    await expect(lib.revokeChatGPTCredential({} as never)).rejects.toThrow(/not available/);
    await expect(lib.getChatGPTKey('u', 't')).rejects.toThrow(/not available/);
  });

  it('has the Codex login of the credentials home for a Codex run, and none otherwise', async () => {
    const login: PiCredential = {
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: 9,
      accountId: 'x',
    };
    const fresh: PiCredential = { ...login, access: 'a2' };
    let refreshed = 0;
    const codexDeps = deps(login, 'openai-codex');
    codexDeps.credentials.refreshCredential = async () => {
      refreshed++;
      return fresh;
    };
    const codex = createProviderLib('codex', models, codexDeps);
    expect(await codex.codex?.login({} as never)).toEqual({ credential: login, account: 'eval' });
    expect(await codex.codex?.refresh(login)).toBe(fresh);
    expect(refreshed).toBe(1);

    const missing = createProviderLib('codex', models, deps(null, 'openai-codex'));
    await expect(missing.codex?.login({} as never)).rejects.toThrow(/no Codex login/);
    await expect(missing.codex?.refresh(login)).rejects.toThrow(/no Codex login/);

    // The key is present and undefined: it replaces the app's development Codex login.
    const voucher = createProviderLib('mock', models, deps({ type: 'api_key', key: KEY }));
    expect('codex' in voucher).toBe(true);
    expect(voucher.codex).toBeUndefined();
  });
});

describe('the models', () => {
  it("are the product's by default, the orchestrator's at high effort", () => {
    const lib = createProviderLib('voucher', models, deps({ type: 'api_key', key: KEY }));
    expect(lib.defaultModels).toEqual(DEFAULT_MODELS);
    expect(lib.assistantModels).toEqual(ASSISTANT_MODELS);
    expect(lib.assistantModels.voucher.thinkingLevel).toBe('high');
  });

  it('take the ids the run asks for, keeping the effort of the role', () => {
    const lib = createProviderLib(
      'voucher',
      {
        ...models,
        assistantModel: 'anthropic/claude-sonnet-5.5',
        procedureModel: 'openai/gpt-6-luna',
      },
      deps({ type: 'api_key', key: KEY }),
    );
    expect(lib.defaultModels).toEqual({
      chatgpt: 'openai/gpt-6-luna',
      voucher: 'openai/gpt-6-luna',
    });
    expect(lib.assistantModels.voucher).toEqual({
      ...ASSISTANT_MODELS.voucher,
      id: 'anthropic/claude-sonnet-5.5',
    });
    expect(lib.assistantModels.voucher.thinkingLevel).toBe('high');
  });
});

describe('activateProvider', () => {
  function app(results: { ok: boolean; error?: string }) {
    const calls: unknown[][] = [];
    const fake = {
      invoke: async (...args: unknown[]) => {
        calls.push(args);
        return results;
      },
    };
    return { fake: fake as unknown as HeadlessApp, calls };
  }

  it('redeems a voucher for a voucher or a mock run, and signs in for a Codex run', async () => {
    for (const provider of ['voucher', 'mock'] as const) {
      const { fake, calls } = app({ ok: true });
      await activateProvider(fake, provider);
      expect(calls).toEqual([['providers.redeemVoucher', 'SA-EVAL01']]);
    }
    const { fake, calls } = app({ ok: true });
    await activateProvider(fake, 'codex');
    expect(calls).toEqual([['providers.loginCodexDevice']]);
  });

  it('says why the provider could not be set up', async () => {
    const { fake } = app({ ok: false, error: 'No voucher.' });
    await expect(activateProvider(fake, 'voucher')).rejects.toThrow(
      'The model provider could not be set up: No voucher.',
    );
  });
});
