import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildChatGPTAuthorizeUrl,
  CHATGPT_ENDPOINTS,
  type ChatGPTEndpoints,
  ChatGPTLoginError,
  credentialNeedsRefresh,
  loginChatGPT,
  parseChatGPTCallback,
  refreshOAuthCredential,
  revokeChatGPTCredential,
} from '../src/providers/chatgpt';
import { DEFAULT_MODELS, listByokProviders, listProviderModels } from '../src/providers/models';
import {
  getChatGPTKey,
  getVoucherCredit,
  KeyServerError,
  parseLiteLLMSpendHeaders,
  redeemVoucher,
} from '../src/providers/services';

// ---------------------------------------------------------------------------------------------
// Fake OpenAI auth server (token endpoint, discovery, JWKS)
// ---------------------------------------------------------------------------------------------

interface FakeAuth {
  endpoints: Partial<ChatGPTEndpoints>;
  tokenRequests: URLSearchParams[];
  nonce?: string;
  scope: string;
  idTokenAudience?: string;
  tokenStatus: number;
  issued: number;
  revocations: URLSearchParams[];
  /** Status of the next revocation responses; 200 once they run out. */
  revocationStatuses: number[];
  close(): Promise<void>;
}

let auth: FakeAuth;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
let publicJwk: JWK;

async function startFakeAuth(): Promise<FakeAuth> {
  const state = {
    tokenRequests: [] as URLSearchParams[],
    nonce: undefined as string | undefined,
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    idTokenAudience: undefined as string | undefined,
    tokenStatus: 200,
    issued: 0,
    revocations: [] as URLSearchParams[],
    revocationStatuses: [] as number[],
  };
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: base,
        jwks_uri: `${base}/jwks`,
        revocation_endpoint: `${base}/api/accounts/oauth/revoke`,
      });
    }
    if (url.pathname === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        state.revocations.push(new URLSearchParams(body));
        res.writeHead(state.revocationStatuses.shift() ?? 200);
        res.end();
      });
      return;
    }
    if (url.pathname === '/jwks') return json(200, { keys: [publicJwk] });
    if (url.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', async () => {
        const form = new URLSearchParams(body);
        state.tokenRequests.push(form);
        if (state.tokenStatus !== 200) {
          return json(state.tokenStatus, { error: 'invalid_grant', error_description: 'expired' });
        }
        state.issued++;
        const idToken = await new SignJWT({ nonce: state.nonce, email: 'ana@example.com' })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(base)
          .setAudience(state.idTokenAudience ?? form.get('client_id') ?? '')
          .setIssuedAt()
          .setExpirationTime('1h')
          .sign(privateKey);
        json(200, {
          access_token: `access-${state.issued}`,
          refresh_token: `refresh-${state.issued}`,
          id_token: idToken,
          scope: state.scope,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    endpoints: {
      authorizeUrl: `${base}/api/accounts/authorize`,
      tokenUrl: `${base}/api/accounts/oauth/token`,
      issuer: base,
      callbackPort: 0,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  privateKey = keys.privateKey;
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  auth = await startFakeAuth();
});
afterAll(async () => {
  await auth.close();
});
beforeEach(() => {
  auth.tokenRequests.length = 0;
  auth.scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  auth.idTokenAudience = undefined;
  auth.tokenStatus = 200;
  auth.revocations.length = 0;
  auth.revocationStatuses.length = 0;
});

const deviceId = randomUUID();

/** Runs loginChatGPT and plays the browser: follows the redirect with the given parameters. */
async function login(
  callback: (url: URL) => Record<string, string>,
  extra: Record<string, unknown> = {},
) {
  let resolveUrl!: (url: string) => void;
  const authUrl = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const result = loginChatGPT({
    deviceId,
    onAuthUrl: resolveUrl,
    endpoints: auth.endpoints,
    ...extra,
  });
  result.catch(() => {});
  const url = new URL(await authUrl);
  auth.nonce = url.searchParams.get('nonce') ?? undefined;
  const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
  for (const [key, value] of Object.entries(callback(url))) redirect.searchParams.set(key, value);
  const page = await fetch(redirect);
  return { result, url, page };
}

describe('Sign in with ChatGPT', () => {
  it('builds the official authorize URL', () => {
    const url = new URL(
      buildChatGPTAuthorizeUrl({
        deviceId: 'A2C4E6F8-1234-4abc-8def-1234567890AB',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        redirectUri: 'http://127.0.0.1:1455/auth/callback',
      }),
    );
    expect(url.origin + url.pathname).toBe(CHATGPT_ENDPOINTS.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'Spain Assist',
      ext_agent_host_id: 'urn:uuid:a2c4e6f8-1234-4abc-8def-1234567890ab',
      response_type: 'code',
      redirect_uri: 'http://127.0.0.1:1455/auth/callback',
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: 's',
      nonce: 'n',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
    const reauth = new URL(
      buildChatGPTAuthorizeUrl({
        deviceId,
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        redirectUri: 'http://127.0.0.1:1455/auth/callback',
        clientId: 'oaiapp_123',
      }),
    );
    expect(reauth.searchParams.get('client_id')).toBe('oaiapp_123');
    expect(reauth.searchParams.has('agent_name_hint')).toBe(false);
    expect(() =>
      buildChatGPTAuthorizeUrl({
        deviceId: 'not-a-uuid',
        state: 's',
        nonce: 'n',
        codeChallenge: 'c',
        redirectUri: 'x',
      }),
    ).toThrow(/device id/);
  });

  it('validates callbacks', () => {
    const ok = parseChatGPTCallback(
      'http://127.0.0.1:1455/auth/callback?code=c&state=s&client_id=oaiapp_1',
      's',
    );
    expect(ok).toMatchObject({ code: 'c', clientId: 'oaiapp_1' });
    expect(() => parseChatGPTCallback('http://127.0.0.1/cb?code=c&state=other', 's')).toThrow(
      ChatGPTLoginError,
    );
    expect(() =>
      parseChatGPTCallback('http://127.0.0.1/cb?error=access_denied&state=s', 's'),
    ).toThrow(/access_denied/);
  });

  it('completes the loopback flow, exchanges the code with PKCE and validates the ID token', async () => {
    const { result, url, page } = await login((u) => ({
      code: 'auth-code',
      state: u.searchParams.get('state') ?? '',
      client_id: 'oaiapp_issued',
      scope: 'openid chatgpt.tokens.use.direct',
    }));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Ya puedes cerrar esta ventana');
    const outcome = await result;
    expect(outcome.clientId).toBe('oaiapp_issued');
    expect(outcome.account).toBe('ana@example.com');
    // The verified ID token, for our key server (D12).
    expect(outcome.idToken.split('.')).toHaveLength(3);
    expect(outcome.credential).toMatchObject({
      type: 'oauth',
      access: 'access-1',
      refresh: 'refresh-1',
      clientId: 'oaiapp_issued',
      scopes: [
        'openid',
        'profile',
        'email',
        'offline_access',
        'resource.invoke',
        'chatgpt.tokens.use.direct',
      ],
    });
    const expires = outcome.credential.expires as number;
    expect(expires).toBeGreaterThan(Date.now() + 50 * 60_000);
    expect(expires).toBeLessThan(Date.now() + 58 * 60_000);

    const form = auth.tokenRequests[0];
    expect(form?.get('grant_type')).toBe('authorization_code');
    expect(form?.get('client_id')).toBe('oaiapp_issued');
    expect(form?.get('code')).toBe('auth-code');
    expect(form?.get('resource')).toBe('https://api.openai.com/v1');
    expect(form?.get('redirect_uri')).toBe(url.searchParams.get('redirect_uri'));
    const challenge = createHash('sha256')
      .update(form?.get('code_verifier') ?? '')
      .digest('base64url');
    expect(challenge).toBe(url.searchParams.get('code_challenge'));
    expect(url.searchParams.get('redirect_uri')).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
    );
  });

  it('rejects ID tokens with the wrong nonce or audience', async () => {
    const wrongAudience = await login((u) => {
      auth.idTokenAudience = 'someone-else';
      return { code: 'c', state: u.searchParams.get('state') ?? '', client_id: 'oaiapp_issued' };
    });
    await expect(wrongAudience.result).rejects.toMatchObject({ code: 'invalid_id_token' });

    let resolveUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const result = loginChatGPT({ deviceId, onAuthUrl: resolveUrl, endpoints: auth.endpoints });
    result.catch(() => {});
    const url = new URL(await authUrl);
    auth.nonce = 'tampered';
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    redirect.search = new URLSearchParams({
      code: 'c',
      state: url.searchParams.get('state') ?? '',
      client_id: 'oaiapp_issued',
    }).toString();
    await fetch(redirect);
    await expect(result).rejects.toMatchObject({ code: 'invalid_id_token' });
  });

  it('requires the chatgpt.tokens.use.direct scope', async () => {
    auth.scope = 'openid profile email offline_access';
    const { result } = await login((u) => ({
      code: 'c',
      state: u.searchParams.get('state') ?? '',
      client_id: 'oaiapp_issued',
    }));
    await expect(result).rejects.toMatchObject({ code: 'missing_scope' });
  });

  it('reports accounts that cannot use their plan (invalid_grant on the code exchange)', async () => {
    auth.tokenStatus = 400;
    const { result } = await login((u) => ({
      code: 'c',
      state: u.searchParams.get('state') ?? '',
      client_id: 'oaiapp_issued',
    }));
    await expect(result).rejects.toMatchObject({
      code: 'not_eligible',
      oauthError: 'invalid_grant',
    });
  });

  it('ignores stale callbacks, reports denials and supports cancel', async () => {
    let resolveUrl!: (url: string) => void;
    const authUrl = new Promise<string>((resolve) => {
      resolveUrl = resolve;
    });
    const controller = new AbortController();
    const result = loginChatGPT({
      deviceId,
      onAuthUrl: resolveUrl,
      endpoints: auth.endpoints,
      signal: controller.signal,
    });
    result.catch(() => {});
    const url = new URL(await authUrl);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    redirect.search = 'code=x&state=stale';
    expect((await fetch(redirect)).status).toBe(400);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });

    const denied = await login((u) => ({
      error: 'access_denied',
      state: u.searchParams.get('state') ?? '',
    }));
    await expect(denied.result).rejects.toMatchObject({ code: 'denied' });
  });

  it('accepts a pasted redirect URL when the port is busy', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await expect(
        loginChatGPT({
          deviceId,
          onAuthUrl: () => {},
          endpoints: { ...auth.endpoints, callbackPort: port },
        }),
      ).rejects.toMatchObject({ code: 'port_in_use' });

      let resolvePasted!: (url: string) => void;
      const pasted = new Promise<string>((resolve) => {
        resolvePasted = resolve;
      });
      const result = loginChatGPT({
        deviceId,
        endpoints: { ...auth.endpoints, callbackPort: port },
        manualRedirectUrl: pasted,
        onAuthUrl: (u) => {
          const url = new URL(u);
          auth.nonce = url.searchParams.get('nonce') ?? undefined;
          resolvePasted(
            `${url.searchParams.get('redirect_uri')}?code=c&state=${url.searchParams.get('state')}&client_id=oaiapp_pasted`,
          );
        },
      });
      expect((await result).clientId).toBe('oaiapp_pasted');
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('refreshes with the issued client id and keeps the credential shape', async () => {
    const credential = {
      type: 'oauth' as const,
      access: 'old',
      refresh: 'refresh-old',
      expires: Date.now() - 1000,
      clientId: 'oaiapp_issued',
      scopes: ['chatgpt.tokens.use.direct'],
    };
    expect(credentialNeedsRefresh(credential)).toBe(true);
    const refreshed = await refreshOAuthCredential('openai', credential, {
      endpoints: auth.endpoints,
    });
    const form = auth.tokenRequests.at(-1);
    expect(form?.get('grant_type')).toBe('refresh_token');
    expect(form?.get('refresh_token')).toBe('refresh-old');
    expect(form?.get('client_id')).toBe('oaiapp_issued');
    expect(refreshed).toMatchObject({ type: 'oauth', clientId: 'oaiapp_issued' });
    expect(refreshed.refresh).not.toBe('refresh-old');
    expect(credentialNeedsRefresh(refreshed)).toBe(false);

    auth.tokenStatus = 400;
    await expect(
      refreshOAuthCredential('openai', credential, { endpoints: auth.endpoints }),
    ).rejects.toThrow(/invalid_grant/);
    await expect(refreshOAuthCredential('anthropic', credential)).rejects.toThrow(/not supported/);
  });

  it('revokes the session on sign out with the refresh token and issued client id', async () => {
    const credential = {
      type: 'oauth' as const,
      access: 'access-x',
      refresh: 'refresh-x',
      expires: Date.now() + 3_600_000,
      clientId: 'oaiapp_issued',
      scopes: ['chatgpt.tokens.use.direct'],
    };
    await revokeChatGPTCredential(credential, { endpoints: auth.endpoints });
    expect(auth.revocations.map((form) => Object.fromEntries(form))).toEqual([
      { token: 'refresh-x', token_type_hint: 'refresh_token', client_id: 'oaiapp_issued' },
    ]);

    // Server errors are retried; client errors are final.
    auth.revocations.length = 0;
    auth.revocationStatuses.push(503, 502);
    await revokeChatGPTCredential(credential, { endpoints: auth.endpoints, retryDelaysMs: [0, 0] });
    expect(auth.revocations).toHaveLength(3);

    auth.revocations.length = 0;
    auth.revocationStatuses.push(503, 503);
    await expect(
      revokeChatGPTCredential(credential, { endpoints: auth.endpoints, retryDelaysMs: [0] }),
    ).rejects.toThrow(/503/);
    expect(auth.revocations).toHaveLength(2);

    auth.revocations.length = 0;
    auth.revocationStatuses.push(400);
    await expect(
      revokeChatGPTCredential(credential, { endpoints: auth.endpoints, retryDelaysMs: [0, 0] }),
    ).rejects.toThrow(/400/);
    expect(auth.revocations).toHaveLength(1);

    await expect(
      revokeChatGPTCredential(
        { ...credential },
        {
          endpoints: { ...auth.endpoints, revocationUrl: 'http://127.0.0.1:1/revoke' },
          retryDelaysMs: [],
        },
      ),
    ).rejects.toThrow(/Could not reach ChatGPT/);
    await expect(revokeChatGPTCredential({ type: 'api_key', key: 'k' })).rejects.toThrow(
      /Not a ChatGPT credential/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Key server / LiteLLM gateway
// ---------------------------------------------------------------------------------------------

describe('vouchers, credit and models', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (req.url === '/v1/vouchers/redeem') {
          const { code } = JSON.parse(body) as { code: string };
          if (code === 'SA-7K3Q9X') {
            const topUp = req.headers.authorization === 'Bearer sk-litellm-test';
            return json(200, {
              provider: 'litellm',
              baseUrl: 'https://llm.example.org/v1',
              apiKey: 'sk-litellm-test',
              limitUsd: topUp ? 8 : 5,
              usageUsd: topUp ? 2 : 0,
              addedUsd: topUp ? 3 : 5,
              searchTools: ['parallel'],
            });
          }
          if (code === 'SA-OLD-SHAPE') {
            return json(200, { provider: 'openrouter', baseUrl: base, apiKey: 'k', limitUsd: 5 });
          }
          return json(404, { error: { code: 'invalid_code', message: 'Unknown voucher' } });
        }
        if (req.url === '/v1/chatgpt-keys') {
          const { idToken } = JSON.parse(body) as { idToken: string };
          if (idToken === 'aaa.bbb.ccc' && !req.headers.authorization) {
            return json(200, {
              provider: 'litellm',
              baseUrl: 'https://llm.example.org/v1',
              apiKey: 'sk-litellm-chatgpt',
              deciderModel: 'perplexity/pplx-decider-v1.1-27b',
              dailyLimitUsd: 0.1,
              monthlyLimitUsd: 0.5,
            });
          }
          return json(401, { error: { code: 'invalid_identity', message: 'Sign in again.' } });
        }
        if (req.url === '/v1/vouchers/credit') {
          if (req.headers.authorization !== 'Bearer sk-litellm-test') {
            return json(401, { error: { code: 'unauthorized', message: 'Not a voucher key.' } });
          }
          return json(200, {
            limitUsd: 5,
            spendUsd: 1.25,
            maxBudgetUsd: 4.89,
            expiresAt: '2027-04-07T09:00:00.000Z',
          });
        }
        if (req.url === '/old-shape/v1/vouchers/credit') {
          return json(200, { info: { spend: 2, max_budget: 5 } });
        }
        json(404, {});
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('redeems vouchers and maps key-server errors', async () => {
    const voucher = await redeemVoucher(`${base}/`, '  SA-7K3Q9X ');
    expect(voucher).toMatchObject({
      provider: 'litellm',
      baseUrl: 'https://llm.example.org/v1',
      apiKey: 'sk-litellm-test',
      limitUsd: 5,
      usageUsd: 0,
      addedUsd: 5,
      searchTools: ['parallel'],
    });
    // The current key goes in the Authorization header: the voucher tops it up.
    expect(await redeemVoucher(base, 'SA-7K3Q9X', 'sk-litellm-test')).toMatchObject({
      apiKey: 'sk-litellm-test',
      limitUsd: 8,
      usageUsd: 2,
      addedUsd: 3,
    });
    await expect(redeemVoucher(base, 'SA-OLD-SHAPE')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const error = await redeemVoucher(base, 'SA-BAD-CODE').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeyServerError);
    expect(error).toMatchObject({ code: 'invalid_code', status: 404, message: 'Unknown voucher' });
    await expect(redeemVoucher('http://127.0.0.1:9', 'x')).rejects.toMatchObject({
      code: 'network',
    });
  });

  it('trades a ChatGPT ID token for the account scan key (no other credential sent)', async () => {
    expect(await getChatGPTKey(base, 'aaa.bbb.ccc')).toEqual({
      provider: 'litellm',
      baseUrl: 'https://llm.example.org/v1',
      apiKey: 'sk-litellm-chatgpt',
      deciderModel: 'perplexity/pplx-decider-v1.1-27b',
      dailyLimitUsd: 0.1,
      monthlyLimitUsd: 0.5,
    });
    await expect(getChatGPTKey(base, 'xxx.yyy.zzz')).rejects.toMatchObject({
      code: 'invalid_identity',
      status: 401,
    });
  });

  it('reads the spend and cap of a LiteLLM key from the headers of an LLM call', () => {
    expect(
      parseLiteLLMSpendHeaders({
        'x-litellm-key-spend': '1.25',
        'x-litellm-key-max-budget': '5.0',
      }),
    ).toEqual({ spendUsd: 1.25, maxBudgetUsd: 5 });
    // Keys without a cap have no balance to show.
    expect(parseLiteLLMSpendHeaders({ 'x-litellm-key-spend': '0.0' })).toBeUndefined();
    expect(
      parseLiteLLMSpendHeaders({ 'x-litellm-key-spend': '2', 'x-litellm-key-max-budget': 'None' }),
    ).toBeUndefined();
    expect(parseLiteLLMSpendHeaders({ 'content-type': 'text/event-stream' })).toBeUndefined();
    expect(
      parseLiteLLMSpendHeaders({ 'x-litellm-key-spend': 'None', 'x-litellm-key-max-budget': '5' }),
    ).toBeUndefined();
  });

  it('reads the balance and expiry of a voucher key from the key server', async () => {
    expect(await getVoucherCredit(`${base}/`, 'sk-litellm-test')).toEqual({
      limitUsd: 5,
      spendUsd: 1.25,
      maxBudgetUsd: 4.89,
      expiresAt: '2027-04-07T09:00:00.000Z',
    });
    const error = await getVoucherCredit(base, 'sk-bad-key').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401 });
    expect((error as Error).message).not.toContain('sk-bad-key');
    await expect(getVoucherCredit(`${base}/old-shape`, 'k')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(getVoucherCredit(`${base}/missing`, 'k')).rejects.toMatchObject({
      code: 'http_error',
      status: 404,
    });
  });
});

describe('provider catalogue', () => {
  it('lists the models of one provider, including the legacy Codex one', () => {
    const codex = listProviderModels('openai-codex');
    expect(codex.map((m) => m.id)).toContain(DEFAULT_MODELS.chatgpt);
    expect(new Set(codex.map((m) => m.provider))).toEqual(new Set(['openai-codex']));
    expect(listProviderModels('no-such-provider')).toEqual([]);
  });
});

describe('BYOK catalogue', () => {
  it('lists pi providers with API keys and their models', () => {
    const providers = listByokProviders();
    const ids = providers.map((p) => p.id);
    expect(ids.slice(0, 3)).toEqual(['openrouter', 'openai', 'anthropic']);
    expect(ids).not.toContain('openai-codex');
    const anthropic = providers.find((p) => p.id === 'anthropic');
    expect(anthropic?.envVar).toBe('ANTHROPIC_API_KEY');
    expect(anthropic?.models.length).toBeGreaterThan(0);
    const kimi = providers
      .find((p) => p.id === 'openrouter')
      ?.models.find((m) => m.id === 'openai/gpt-6-luna');
    expect(kimi).toMatchObject({ provider: 'openrouter', supportsImages: true });
  });
});
