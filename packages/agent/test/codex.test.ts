import { describe, expect, it } from 'vitest';
import {
  CODEX_ENDPOINTS,
  type CodexDeviceCode,
  codexAccountId,
  loginCodexDevice,
  refreshCodexCredential,
} from '../src/providers/codex';
import type { PiCredential } from '../src/providers/types';

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

  describe('a refresh whose answer cannot be used', () => {
    const OLD: PiCredential = {
      type: 'oauth',
      access: 'old',
      refresh: 'refresh-old-1',
      expires: 0,
      accountId: 'a',
    };
    const NEW_ACCESS_NO_ACCOUNT = jwt({ sub: 'someone' });

    /** A token endpoint that answers every request with `answer`. */
    const answering = (answer: () => Response | Promise<Response>) =>
      (async () => answer()) as unknown as typeof fetch;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    async function refresh(fetchImpl: typeof fetch) {
      const saved: string[] = [];
      const events: string[] = [];
      let error: unknown;
      try {
        await refreshCodexCredential(OLD, {
          fetchImpl,
          onRotatedRefreshToken: async (token) => {
            events.push('saved');
            saved.push(token);
          },
        });
        events.push('returned');
      } catch (e) {
        events.push('threw');
        error = e;
      }
      return { saved, events, error: error as Error | undefined };
    }

    it('hands the rotated refresh token to the caller before it validates the answer', async () => {
      const { saved, events, error } = await refresh(
        answering(() =>
          json(200, {
            access_token: NEW_ACCESS_NO_ACCOUNT,
            refresh_token: 'refresh-new-2',
            expires_in: 3600,
          }),
        ),
      );
      expect(saved).toEqual(['refresh-new-2']);
      expect(events).toEqual(['saved', 'threw']);
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('does so when the answer has no expires_in', async () => {
      const { saved, error } = await refresh(
        answering(() => json(200, { access_token: ACCESS, refresh_token: 'refresh-new-3' })),
      );
      expect(saved).toEqual(['refresh-new-3']);
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('does so when the answer has no access token at all', async () => {
      const { saved, error } = await refresh(
        answering(() => json(200, { refresh_token: 'refresh-new-4', expires_in: 3600 })),
      );
      expect(saved).toEqual(['refresh-new-4']);
      expect(error).toMatchObject({ code: 'invalid_response' });
    });

    it('waits for the caller to finish saving before it goes on', async () => {
      const order: string[] = [];
      await expect(
        refreshCodexCredential(OLD, {
          fetchImpl: answering(() =>
            json(200, { access_token: ACCESS, refresh_token: 'refresh-new-5' }),
          ),
          onRotatedRefreshToken: async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            order.push('saved');
          },
        }).catch(() => order.push('threw')),
      ).resolves.toBeDefined();
      expect(order).toEqual(['saved', 'threw']);
    });

    it('has nothing to hand over when the answer is not JSON or has no refresh token', async () => {
      for (const answer of [
        () => new Response('<html>bad gateway</html>', { status: 200 }),
        () => new Response('{"access_token": "x", "refresh_tok', { status: 200 }),
        () => json(200, { access_token: ACCESS, expires_in: 3600, refresh_token: '' }),
        () => json(200, ['not', 'an', 'object']),
      ]) {
        const { saved, events, error } = await refresh(answering(answer));
        expect(saved).toEqual([]);
        expect(events).toEqual(['threw']);
        expect(error).toMatchObject({ code: 'invalid_response' });
      }
    });

    it('does not report a body that breaks off as a plain network error', async () => {
      const broken = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('terminated'));
          },
        }),
        { status: 200 },
      );
      const { saved, error } = await refresh(answering(() => broken));
      expect(saved).toEqual([]);
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(error?.message).toContain('could not be read');
    });

    it('does not hand over anything when OpenAI refuses the refresh', async () => {
      const { saved, error } = await refresh(
        answering(() => json(400, { error: 'invalid_grant', refresh_token: 'refresh-echo' })),
      );
      expect(saved).toEqual([]);
      expect(error).toMatchObject({ code: 'token_exchange', oauthError: 'invalid_grant' });
    });

    it('works without a callback, as the app calls it', async () => {
      const { calls, fetchImpl } = fakeAuth();
      expect((await refreshCodexCredential(OLD, { fetchImpl })).refresh).toBe('refresh-2');
      expect(calls).toHaveLength(1);
    });

    it('never puts a token, or whatever the server wrote in its error field, into a message', async () => {
      const tokens = ['refresh-old-1', 'refresh-new-9', ACCESS, NEW_ACCESS_NO_ACCOUNT];
      const answers: (() => Response | Promise<Response>)[] = [
        () => json(200, { access_token: NEW_ACCESS_NO_ACCOUNT, refresh_token: 'refresh-new-9' }),
        () => json(200, { access_token: ACCESS, refresh_token: 'refresh-new-9' }),
        () => json(200, { refresh_token: 'refresh-new-9', expires_in: 'soon' }),
        () => new Response(`oops ${ACCESS} refresh-new-9`, { status: 200 }),
        () => json(400, { error: ACCESS }),
        () => json(400, { error: { code: 'refresh-old-1 and more words' } }),
        () => json(500, { error: 'refresh-new-9' }),
        () => {
          throw new Error('socket hang up');
        },
      ];
      for (const answer of answers) {
        const { error } = await refresh(answering(answer));
        expect(error).toBeInstanceOf(Error);
        for (const token of tokens) {
          expect(error?.message).not.toContain(token);
          expect(JSON.stringify(error)).not.toContain(token);
        }
      }
    });
  });
});
