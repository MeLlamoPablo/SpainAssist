import { describe, expect, it } from 'vitest';
import {
  CODEX_ENDPOINTS,
  type CodexDeviceCode,
  codexAccountId,
  loginCodexDevice,
  refreshCodexCredential,
} from '../src/providers/codex';

function jwt(payload: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

const ACCESS = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' } });
const ID_TOKEN = jwt({ email: 'dev@example.com' });

interface Call {
  url: string;
  body: string;
}

/** Fake auth.openai.com: answers `pending` this many times before approving the code. */
function fakeAuth(options: { pending?: number; deviceStatus?: number; deviceError?: string } = {}) {
  const calls: Call[] = [];
  let pending = options.pending ?? 1;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');
    calls.push({ url, body });
    if (url === CODEX_ENDPOINTS.userCodeUrl) {
      return json(200, { device_auth_id: 'dev-auth-1', user_code: 'ABCD-1234', interval: '1' });
    }
    if (url === CODEX_ENDPOINTS.deviceTokenUrl) {
      if (options.deviceStatus) {
        return json(options.deviceStatus, { error: { code: options.deviceError } });
      }
      if (pending-- > 0) return json(403, { error: { code: 'deviceauth_authorization_pending' } });
      return json(200, { authorization_code: 'auth-code', code_verifier: 'verifier' });
    }
    if (url === CODEX_ENDPOINTS.tokenUrl) {
      return json(200, {
        access_token: ACCESS,
        refresh_token: 'refresh-2',
        id_token: ID_TOKEN,
        expires_in: 3600,
      });
    }
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const noSleep = async () => {};

describe('OpenAI Codex device code (dev only)', () => {
  it('reads the ChatGPT account id from the access token', () => {
    expect(codexAccountId(ACCESS)).toBe('acct-123');
    expect(codexAccountId('not-a-jwt')).toBeUndefined();
  });

  it('shows the code, polls until approved and exchanges the code', async () => {
    const { calls, fetchImpl } = fakeAuth({ pending: 2 });
    const codes: CodexDeviceCode[] = [];
    const result = await loginCodexDevice({
      onUserCode: (code) => codes.push(code),
      fetchImpl,
      sleep: noSleep,
    });

    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    });
    expect(JSON.parse(calls[0]!.body)).toEqual({ client_id: CODEX_ENDPOINTS.clientId });
    const polls = calls.filter((c) => c.url === CODEX_ENDPOINTS.deviceTokenUrl);
    expect(polls).toHaveLength(3);
    expect(JSON.parse(polls[0]!.body)).toEqual({
      device_auth_id: 'dev-auth-1',
      user_code: 'ABCD-1234',
    });
    const exchange = new URLSearchParams(calls.at(-1)!.body);
    expect(Object.fromEntries(exchange)).toEqual({
      grant_type: 'authorization_code',
      client_id: CODEX_ENDPOINTS.clientId,
      code: 'auth-code',
      code_verifier: 'verifier',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
    });

    expect(result.account).toBe('dev@example.com');
    expect(result.credential).toMatchObject({
      type: 'oauth',
      access: ACCESS,
      refresh: 'refresh-2',
      accountId: 'acct-123',
    });
    expect(result.credential.expires).toBeGreaterThan(Date.now());
  });

  it('reports a denied code', async () => {
    const { fetchImpl } = fakeAuth({ deviceStatus: 400, deviceError: 'access_denied' });
    await expect(
      loginCodexDevice({ onUserCode: () => {}, fetchImpl, sleep: noSleep }),
    ).rejects.toMatchObject({ code: 'denied' });
  });

  it('can be cancelled while waiting', async () => {
    const { fetchImpl } = fakeAuth({ pending: 1_000 });
    const controller = new AbortController();
    const login = loginCodexDevice({
      onUserCode: () => setTimeout(() => controller.abort(), 20),
      fetchImpl,
      signal: controller.signal,
    });
    await expect(login).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('times out', async () => {
    const { fetchImpl } = fakeAuth({ pending: 1_000 });
    await expect(
      loginCodexDevice({ onUserCode: () => {}, fetchImpl, timeoutMs: 50 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('refreshes with the Codex client id and keeps the account id', async () => {
    const { calls, fetchImpl } = fakeAuth();
    const fresh = await refreshCodexCredential(
      { type: 'oauth', access: 'old', refresh: 'refresh-1', expires: 0, accountId: 'acct-123' },
      { fetchImpl },
    );
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      grant_type: 'refresh_token',
      client_id: CODEX_ENDPOINTS.clientId,
      refresh_token: 'refresh-1',
    });
    expect(fresh).toMatchObject({ access: ACCESS, refresh: 'refresh-2', accountId: 'acct-123' });
  });
});
