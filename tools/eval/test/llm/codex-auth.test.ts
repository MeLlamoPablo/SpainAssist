import './helpers/no-network';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexAccountId } from '@sa/agent/codex';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_CI_OVERRIDE_ENV,
  CODEX_CONSENT_ENV,
  CODEX_TERMS_WARNING,
  CodexAuthError,
  CodexConsentError,
  codexStatus,
  forgetCodexCredential,
  hasCodexConsent,
  isReplayCodexCredential,
  loadCodexCredential,
  refreshCodexCredentialIfNeeded,
  replayCodexCredential,
  runCodexLogin,
} from '../../src/llm/codex-auth';
import { createCredentialSource, credentialSecrets } from '../../src/llm/credentials';
import { EvalHomeError, readCodexFile, writeCodexFile } from '../../src/llm/home';
import { type FakeAuth, jwt, type RefreshAnswer, startFakeAuth } from './helpers/fake-codex-auth';
import { makeHome, type TestHome } from './helpers/tmp-home';

/**
 * Every write of `codex.json` goes through here, so a test can see the order of things (what was
 * saved before the call returned) and make the next writes fail (a disk that fills up).
 */
const writes = vi.hoisted(() => ({
  log: [] as { refresh: string; access: string }[],
  failNext: 0,
}));
vi.mock('../../src/llm/home', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/llm/home')>();
  return {
    ...actual,
    writeCodexFile: (file: Parameters<typeof actual.writeCodexFile>[0], home?: string) => {
      if (writes.failNext > 0) {
        writes.failNext--;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      writes.log.push({ refresh: file.credential.refresh, access: file.credential.access });
      return actual.writeCodexFile(file, home);
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const evalDir = join(here, '..', '..');
const mode = (path: string) => statSync(path).mode & 0o777;

/** The error a promise rejects with; the test fails when it resolves instead. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the promise to reject');
}
const noSleep = async () => {};

describe('Codex login and credential store (dev only)', () => {
  let t: TestHome;
  let auth: FakeAuth;
  beforeEach(async () => {
    t = makeHome();
    auth = await startFakeAuth();
    writes.log = [];
    writes.failNext = 0;
  });
  afterEach(async () => {
    await auth.close();
    t.cleanup();
  });

  const login = (options: Parameters<typeof runCodexLogin>[0] = {}) =>
    runCodexLogin({
      home: t.home,
      consent: true,
      endpoints: auth.endpoints,
      sleep: noSleep,
      print: () => {},
      ...options,
    });

  /** Stores a login that expires in `ms` from `now`. */
  const store = (ms: number, now = Date.now()) =>
    writeCodexFile(
      {
        v: 1,
        provider: 'openai-codex',
        loginAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        credential: {
          type: 'oauth',
          access: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-fake-1' } }),
          refresh: auth.currentRefreshToken() || 'refresh-1',
          expires: now + ms,
          accountId: 'acct-fake-1',
        },
      },
      t.home,
    );

  describe('consent', () => {
    it('is required to log in, to read the login and to refresh it', async () => {
      await expect(login({ consent: false })).rejects.toBeInstanceOf(CodexConsentError);
      expect(() => loadCodexCredential({ home: t.home, env: {} })).toThrow(CodexConsentError);
      await expect(
        refreshCodexCredentialIfNeeded({ home: t.home, env: {} }),
      ).rejects.toBeInstanceOf(CodexConsentError);
      expect(() => createCredentialSource({ provider: 'codex', home: t.home, env: {} })).toThrow(
        CodexConsentError,
      );
      expect(auth.calls).toHaveLength(0);
      expect(existsSync(join(t.home, 'codex.json'))).toBe(false);
    });

    it('accepts the flag or SA_EVAL_CODEX_CONSENT=1, nothing else', () => {
      expect(hasCodexConsent({ consent: true, env: {} })).toBe(true);
      expect(hasCodexConsent({ env: { [CODEX_CONSENT_ENV]: '1' } })).toBe(true);
      expect(hasCodexConsent({ env: { [CODEX_CONSENT_ENV]: 'yes' } })).toBe(false);
      expect(hasCodexConsent({ consent: false, env: {} })).toBe(false);
      expect(new CodexConsentError().message).toContain('--codex-consent');
      expect(new CodexConsentError().message).toContain(`${CODEX_CONSENT_ENV}=1`);
    });

    describe('in CI', () => {
      const withConsent = (env: Record<string, string | undefined>) => ({
        home: t.home,
        consent: true,
        env,
      });

      it('refuses the login, the stored credential and a refresh when a CI variable is set', async () => {
        for (const env of [
          { CI: 'true' },
          { CI: '1' },
          { GITHUB_ACTIONS: 'true' },
          { GITLAB_CI: 'true' },
          { BUILDKITE: 'true' },
          { JENKINS_URL: 'https://ci.example.test/' },
        ]) {
          const options = withConsent(env);
          await expect(runCodexLogin({ ...options, print: () => {} })).rejects.toThrow(
            /not used in CI/,
          );
          expect(() => loadCodexCredential(options)).toThrow(CodexConsentError);
          await expect(refreshCodexCredentialIfNeeded(options)).rejects.toThrow(/not used in CI/);
          expect(() => createCredentialSource({ ...options, provider: 'codex' })).toThrow(
            /not used in CI/,
          );
        }
        expect(auth.calls).toHaveLength(0);
        expect(existsSync(join(t.home, 'codex.json'))).toBe(false);
      });

      it('names the variable and the override, and is a refusal to start like any other', async () => {
        const error = await rejection(
          runCodexLogin({ ...withConsent({ CI: 'true' }), print: () => {} }),
        );
        expect(error).toBeInstanceOf(CodexConsentError);
        expect(error.name).toBe('CodexConsentError');
        expect(error.message).toContain('CI is set');
        expect(error.message).toContain(`${CODEX_CI_OVERRIDE_ENV}=1`);
      });

      it('prints nothing and contacts nobody before it refuses', async () => {
        const lines: string[] = [];
        await expect(
          runCodexLogin({
            ...withConsent({ CI: 'true' }),
            endpoints: auth.endpoints,
            print: (line) => lines.push(line),
          }),
        ).rejects.toBeInstanceOf(CodexConsentError);
        expect(lines).toEqual([]);
        expect(auth.calls).toHaveLength(0);
      });

      it('is not fooled by a consent in the ambient environment, only by the explicit override', async () => {
        const ambient = { [CODEX_CONSENT_ENV]: '1', CI: 'true' };
        expect(hasCodexConsent({ env: ambient })).toBe(true);
        await expect(
          refreshCodexCredentialIfNeeded({ home: t.home, env: ambient }),
        ).rejects.toThrow(/not used in CI/);
        // With the override the CI variable no longer refuses (there is simply no login yet).
        await expect(
          refreshCodexCredentialIfNeeded({
            home: t.home,
            env: { ...ambient, [CODEX_CI_OVERRIDE_ENV]: '1' },
          }),
        ).rejects.toMatchObject({ code: 'missing' });
        await login({ env: { CI: 'true', [CODEX_CI_OVERRIDE_ENV]: '1' } });
        expect(readCodexFile(t.home)).toBeDefined();
      });

      it('ignores variables that are empty, 0 or false, and replay runs need no consent at all', () => {
        for (const value of ['', '0', 'false', 'FALSE', '  ']) {
          expect(() =>
            loadCodexCredential({ ...withConsent({ CI: value, GITHUB_ACTIONS: value }) }),
          ).toThrow(CodexAuthError); // past the CI check: only the login is missing
        }
        expect(() =>
          createCredentialSource({
            provider: 'codex',
            home: t.home,
            cache: 'replay',
            env: { CI: 'true' },
          }),
        ).not.toThrow();
      });
    });
  });

  describe('login', () => {
    it('prints the warning, the URL and the code, polls, and stores the tokens privately', async () => {
      await auth.close();
      auth = await startFakeAuth({ pending: 2 });
      const lines: string[] = [];
      const summary = await login({ print: (line) => lines.push(line) });
      expect(lines[0]).toBe(CODEX_TERMS_WARNING);
      expect(lines[1]).toContain(auth.endpoints.verificationUrl);
      expect(lines[1]).toContain('ABCD-1234');
      // Never the e-mail of the account (the fake's id token carries one): not printed, not stored.
      expect(lines.at(-1)).toMatch(/^Signed in to Codex\. Tokens saved to /);
      expect(lines.join('\n')).not.toContain('dev@example.test');

      const file = join(t.home, 'codex.json');
      expect(mode(file)).toBe(0o600);
      expect(mode(t.home)).toBe(0o700);
      const stored = readCodexFile(t.home)!;
      expect(stored).toMatchObject({ v: 1, provider: 'openai-codex' });
      expect(readFileSync(file, 'utf8')).not.toContain('dev@example.test');
      expect(readFileSync(file, 'utf8')).not.toContain('account"');
      expect(stored.credential).toMatchObject({
        type: 'oauth',
        refresh: 'refresh-1',
        accountId: 'acct-fake-1',
      });
      expect(codexAccountId(stored.credential.access)).toBe('acct-fake-1');
      expect(stored.credential.expires).toBeGreaterThan(Date.now());

      // The summary and the printed lines never carry a token.
      expect(summary).toEqual({
        accountId: 'acct-fake-1',
        expiresAt: new Date(stored.credential.expires).toISOString(),
        file,
      });
      expect(JSON.stringify(summary)).not.toContain(stored.credential.refresh);
      expect(JSON.stringify(summary)).not.toContain(stored.credential.access);
      expect(lines.join('\n')).not.toContain(stored.credential.access);
      // Polling happened: pending twice, then approved, then one code exchange.
      expect(auth.calls).toEqual([{ grant: 'authorization_code' }]);
      expect(readdirSync(t.home).sort()).toEqual(['codex.json']);
    });

    it('stores the real lifetime: a ten-day access token, expiring three minutes early', async () => {
      const before = Date.now();
      await login();
      const stored = readCodexFile(t.home)!;
      const tenDays = 864_000 * 1000;
      const margin = 3 * 60_000;
      expect(stored.credential.expires).toBeGreaterThanOrEqual(before + tenDays - margin);
      expect(stored.credential.expires).toBeLessThanOrEqual(Date.now() + tenDays - margin);
      // The access token's own expiry is the margin later; the plan travels in its claim.
      const claims = decodeJwt(stored.credential.access);
      expect(claims.exp! * 1000 - stored.credential.expires).toBeGreaterThan(margin - 1500);
      expect(claims.exp! * 1000 - stored.credential.expires).toBeLessThanOrEqual(margin);
      expect(claims['https://api.openai.com/auth']).toMatchObject({
        chatgpt_plan_type: 'plus',
        chatgpt_account_id: 'acct-fake-1',
      });
      // Nothing to refresh for days; a refresh forced right after the login still works and
      // rotates the token (`earliest_refresh_at` is advice).
      expect(
        (
          await refreshCodexCredentialIfNeeded({
            home: t.home,
            consent: true,
            endpoints: auth.endpoints,
          })
        ).refresh,
      ).toBe('refresh-1');
      const forced = await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
        minValidityMs: 11 * 86_400_000,
      });
      expect(forced.refresh).toBe('refresh-2');
      expect(readCodexFile(t.home)!.credential.refresh).toBe('refresh-2');
    });

    it('stores nothing when the code is denied', async () => {
      await auth.close();
      auth = await startFakeAuth({ deviceError: 'access_denied' });
      await expect(login()).rejects.toMatchObject({ code: 'denied' });
      expect(existsSync(join(t.home, 'codex.json'))).toBe(false);
    });

    it('can be cancelled while waiting', async () => {
      await auth.close();
      auth = await startFakeAuth({ pending: 1000 });
      const controller = new AbortController();
      const run = login({
        sleep: undefined,
        signal: controller.signal,
        onUserCode: () => setTimeout(() => controller.abort(), 20),
      });
      await expect(run).rejects.toMatchObject({ code: 'cancelled' });
      expect(existsSync(join(t.home, 'codex.json'))).toBe(false);
    });

    it('replaces an earlier login', async () => {
      await login();
      const first = readCodexFile(t.home)!;
      await login();
      expect(readCodexFile(t.home)!.credential.refresh).not.toBe(first.credential.refresh);
    });
  });

  describe('status and logout', () => {
    it('shows what is stored without tokens, and forgets it', async () => {
      expect(codexStatus({ home: t.home })).toEqual({ loggedIn: false });
      expect(forgetCodexCredential(t.home)).toBe(false);
      await login();
      const status = codexStatus({ home: t.home });
      expect(status).toMatchObject({ loggedIn: true, accountId: 'acct-fake-1' });
      expect(status.expiresInMs).toBeGreaterThan(30 * 60_000);
      expect(JSON.stringify(status)).not.toContain('refresh-1');
      expect(JSON.stringify(status)).not.toContain('dev@example.test');
      expect(forgetCodexCredential(t.home)).toBe(true);
      expect(codexStatus({ home: t.home })).toEqual({ loggedIn: false });
    });
  });

  describe('loading', () => {
    it('explains a missing login and refuses an unsafe file', async () => {
      expect(() => loadCodexCredential({ home: t.home, consent: true })).toThrow(CodexAuthError);
      await login();
      expect(loadCodexCredential({ home: t.home, consent: true })).toMatchObject({
        type: 'oauth',
        accountId: 'acct-fake-1',
      });
      chmodSync(join(t.home, 'codex.json'), 0o644);
      expect(() => loadCodexCredential({ home: t.home, consent: true })).toThrow(EvalHomeError);
    });
  });

  describe('refresh', () => {
    it('does not call OpenAI while more than five minutes of validity remain', async () => {
      store(10 * 60_000);
      const credential = await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
      });
      expect(credential.refresh).toBe('refresh-1');
      expect(auth.calls).toHaveLength(0);
    });

    it('refreshes under five minutes, persisting the rotated tokens before returning them', async () => {
      await login();
      store(4 * 60_000);
      const before = readCodexFile(t.home)!;
      const fresh = await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
      });
      expect(auth.calls).toEqual([
        { grant: 'authorization_code' },
        { grant: 'refresh_token', refreshToken: 'refresh-1' },
      ]);
      expect(fresh.refresh).toBe('refresh-2');
      // What is on disk is exactly what was returned: nothing was used before it was saved.
      const after = readCodexFile(t.home)!;
      expect(after.credential.refresh).toBe('refresh-2');
      expect(after.credential.access).toBe(fresh.access);
      expect(after.credential.accountId).toBe('acct-fake-1');
      expect(after.credential.expires).toBeGreaterThan(Date.now() + 30 * 60_000);
      expect(after.loginAt).toBe(before.loginAt);
      expect(mode(join(t.home, 'codex.json'))).toBe(0o600);
      // The next caller finds it fresh and does not refresh again.
      await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
      });
      expect(auth.calls).toHaveLength(2);
      expect(existsSync(join(t.home, 'codex.json.lock'))).toBe(false);
    });

    it('refreshes more eagerly for a preflight that needs a longer validity', async () => {
      await login();
      await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
        minValidityMs: 11 * 86_400_000,
      });
      expect(auth.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
    });

    it('uses the injected clock', async () => {
      await login();
      const later = Date.now() + 10 * 86_400_000;
      await refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
        now: () => later,
      });
      expect(auth.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
    });

    it('serializes concurrent callers in one process: one refresh, same result', async () => {
      await auth.close();
      auth = await startFakeAuth({ tokenDelayMs: 40 });
      await login();
      store(60_000);
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          refreshCodexCredentialIfNeeded({
            home: t.home,
            consent: true,
            endpoints: auth.endpoints,
          }),
        ),
      );
      expect(auth.calls.filter((c) => c.grant === 'refresh_token')).toHaveLength(1);
      expect(new Set(results.map((r) => r.refresh)).size).toBe(1);
    });

    it('serializes refreshes across processes (single-use refresh tokens never fail)', async () => {
      await auth.close();
      auth = await startFakeAuth({ tokenDelayMs: 150 });
      await login();
      store(60_000);
      const spawnChild = () =>
        new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
          const child = spawn(
            process.execPath,
            [
              '--import',
              'tsx',
              join(here, 'helpers', 'refresh-child.ts'),
              t.home,
              JSON.stringify(auth.endpoints),
            ],
            { cwd: evalDir, env: { ...process.env, [CODEX_CONSENT_ENV]: '1' } },
          );
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => {
            out += d;
          });
          child.stderr.on('data', (d) => {
            err += d;
          });
          child.on('close', (code) => resolve({ code, out, err }));
        });
      const children = await Promise.all([spawnChild(), spawnChild(), spawnChild()]);
      for (const child of children) expect(child, child.err).toMatchObject({ code: 0 });
      const refreshes = auth.calls.filter((c) => c.grant === 'refresh_token');
      expect(refreshes).toHaveLength(1);
      const results = children.map((c) => JSON.parse(c.out) as { refresh: string });
      expect(new Set(results.map((r) => r.refresh))).toEqual(new Set(['refresh-2']));
      expect(readCodexFile(t.home)!.credential.refresh).toBe('refresh-2');
    }, 60_000);

    it('asks for a new login when the refresh token is dead, and keeps the file', async () => {
      await login();
      store(60_000);
      auth.revoke();
      const before = readFileSync(join(t.home, 'codex.json'), 'utf8');
      await expect(
        refreshCodexCredentialIfNeeded({ home: t.home, consent: true, endpoints: auth.endpoints }),
      ).rejects.toMatchObject({ name: 'CodexAuthError', code: 'relogin' });
      await expect(
        refreshCodexCredentialIfNeeded({ home: t.home, consent: true, endpoints: auth.endpoints }),
      ).rejects.toThrow(/eval login codex/);
      expect(readFileSync(join(t.home, 'codex.json'), 'utf8')).toBe(before);
      expect(existsSync(join(t.home, 'codex.json.lock'))).toBe(false);
    });

    it('fails clearly without a login', async () => {
      await expect(
        refreshCodexCredentialIfNeeded({ home: t.home, consent: true, endpoints: auth.endpoints }),
      ).rejects.toMatchObject({ code: 'missing' });
    });
  });

  describe('a refresh that rotates the token and then fails', () => {
    /** Stores a login about to expire, whose refresh token is the fake's current one. */
    async function stored(): Promise<{ oldAccess: string; oldRefresh: string; expires: number }> {
      await login();
      store(60_000);
      writes.log = [];
      const file = readCodexFile(t.home)!;
      return {
        oldAccess: file.credential.access,
        oldRefresh: file.credential.refresh,
        expires: file.credential.expires,
      };
    }
    const refresh = (extra: Partial<Parameters<typeof refreshCodexCredentialIfNeeded>[0]> = {}) =>
      refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
        ...extra,
      });

    for (const answer of ['no-account', 'no-expires', 'wrong-types'] as RefreshAnswer[]) {
      it(`keeps the rotated refresh token when the answer is unusable (${answer})`, async () => {
        const before = await stored();
        auth.setRefreshAnswer(answer);
        const error = await rejection(refresh());
        expect(error).toMatchObject({ name: 'CodexAuthError', code: 'refresh_failed' });
        expect(error.message).toContain('new refresh token is saved');
        // The server rotated: the old token is dead, and the file holds the NEW one, with the
        // old access token (valid until it expires) and its expiry.
        const after = readCodexFile(t.home)!.credential;
        expect(auth.calls.at(-1)).toEqual({
          grant: 'refresh_token',
          refreshToken: before.oldRefresh,
        });
        expect(after.refresh).toBe(auth.currentRefreshToken());
        expect(after.refresh).not.toBe(before.oldRefresh);
        expect(after.access).toBe(before.oldAccess);
        expect(after.expires).toBe(before.expires);
        expect(after.accountId).toBe('acct-fake-1');
        // And the login is recoverable: the next refresh works from the saved token.
        auth.setRefreshAnswer(undefined);
        const fresh = await refresh({ minValidityMs: 11 * 86_400_000 });
        expect(auth.calls.at(-1)?.refreshToken).toBe(after.refresh);
        expect(fresh.refresh).toBe(auth.currentRefreshToken());
        expect(readCodexFile(t.home)!.credential.refresh).toBe(fresh.refresh);
      });
    }

    for (const answer of ['not-json', 'cut-off'] as RefreshAnswer[]) {
      it(`says what is lost when the answer cannot be read at all (${answer})`, async () => {
        const before = await stored();
        auth.setRefreshAnswer(answer);
        const error = await rejection(refresh());
        expect(error).toMatchObject({ name: 'CodexAuthError', code: 'refresh_failed' });
        expect(error.message).toContain('may already be used up');
        expect(error.message).toContain('eval login codex');
        // Nothing to save: the answer had no token we could read. The file is as it was.
        expect(readCodexFile(t.home)!.credential.refresh).toBe(before.oldRefresh);
        // The server did rotate, so the next try finds the old token dead and asks for a login.
        auth.setRefreshAnswer(undefined);
        await expect(refresh()).rejects.toMatchObject({ code: 'relogin' });
      });
    }

    it('says that a refresh timed out, not that a sign-in was cancelled', async () => {
      await stored();
      // A server that never answers; like fetch, the stand-in gives up when it is aborted.
      const hung = ((_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })) as unknown as typeof fetch;
      const error = await rejection(refresh({ fetchImpl: hung, signal: AbortSignal.timeout(30) }));
      expect(error.message).toContain('refresh was cancelled or timed out');
      expect(error.message).not.toContain('Sign-in');
      expect(readCodexFile(t.home)!.credential.refresh).toBe(auth.currentRefreshToken());
    });

    it('saves the new refresh token before it validates, and the whole login before it returns', async () => {
      const before = await stored();
      const events: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const response = await fetch(input, init);
        events.push('answered');
        return response;
      };
      writes.log = [];
      const done = refresh({ fetchImpl }).then((credential) => {
        events.push('returned');
        return credential;
      });
      const credential = await done;
      // The refresh token alone first (old access token), then the new pair, then the caller gets it.
      expect(writes.log).toEqual([
        { refresh: auth.currentRefreshToken(), access: before.oldAccess },
        { refresh: auth.currentRefreshToken(), access: credential.access },
      ]);
      expect(events).toEqual(['answered', 'returned']);
      expect(credential.access).not.toBe(before.oldAccess);
      // What is on disk when the call returns is what the caller got: nothing was used unsaved.
      expect(readCodexFile(t.home)!.credential.access).toBe(credential.access);
    });

    it('never puts a token or the e-mail of the account into a failure message', async () => {
      const before = await stored();
      const tokens = (): string[] => [
        before.oldRefresh,
        before.oldAccess,
        auth.currentRefreshToken(),
        auth.lastAccessToken(),
        'dev@example.test',
      ];
      const failures: Error[] = [];
      for (const answer of [
        'no-account',
        'no-expires',
        'wrong-types',
        'not-json',
        'cut-off',
      ] as const) {
        store(60_000);
        auth.setRefreshAnswer(answer);
        failures.push(await rejection(refresh()));
        for (const failure of failures) {
          for (const token of tokens()) {
            if (!token) continue;
            expect(failure.message).not.toContain(token);
            expect(JSON.stringify(failure)).not.toContain(token);
            expect(String(failure.stack)).not.toContain(token);
          }
        }
      }
      // A dead token, a server error and an unreachable server too.
      auth.setRefreshAnswer(undefined);
      store(60_000);
      auth.revoke();
      failures.push(await rejection(refresh()));
      const unreachable = await rejection(
        refresh({
          endpoints: { tokenUrl: 'http://127.0.0.1:1/oauth/token' },
        }),
      );
      const serverError = await rejection(
        refresh({
          fetchImpl: (async () =>
            new Response('{"error":"server_error"}', { status: 500 })) as never,
        }),
      );
      failures.push(unreachable, serverError);
      expect(failures.every((failure) => failure instanceof Error)).toBe(true);
      for (const failure of failures) {
        for (const token of [before.oldRefresh, before.oldAccess, 'dev@example.test']) {
          expect(failure.message).not.toContain(token);
          expect(JSON.stringify(failure)).not.toContain(token);
        }
      }
    });
  });

  describe('a refreshed login that cannot be written', () => {
    const refresh = (warn: (line: string) => void, extra: object = {}) =>
      refreshCodexCredentialIfNeeded({
        home: t.home,
        consent: true,
        endpoints: auth.endpoints,
        warn,
        ...extra,
      });

    it('is kept in memory, said out loud, written on the next use, and the process goes on', async () => {
      await login();
      store(60_000);
      const warnings: string[] = [];
      const diskBefore = readFileSync(join(t.home, 'codex.json'), 'utf8');
      writes.failNext = 2; // the refresh token alone, then the whole login
      const fresh = await refresh((line) => warnings.push(line));
      // The caller got the working login even though nothing could be saved...
      expect(fresh.refresh).toBe(auth.currentRefreshToken());
      // ... the file still holds the dead token, and the process says what to do.
      expect(readFileSync(join(t.home, 'codex.json'), 'utf8')).toBe(diskBefore);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('could not be saved');
      expect(warnings[0]).toContain('EACCES');
      expect(warnings[0]).toContain('eval login codex');
      for (const line of warnings) {
        expect(line).not.toContain(fresh.refresh as string);
        expect(line).not.toContain(fresh.access as string);
      }
      // Every other reader in this process sees the new login, not the dead one.
      expect(loadCodexCredential({ home: t.home, consent: true }).refresh).toBe(fresh.refresh);
      expect(codexStatus({ home: t.home }).loggedIn).toBe(true);
      expect(
        (
          await createCredentialSource({
            provider: 'codex',
            home: t.home,
            consent: true,
          }).credential('openai-codex')
        )?.refresh,
      ).toBe(fresh.refresh);
      // The lock was released although the write failed.
      expect(existsSync(join(t.home, 'codex.json.lock'))).toBe(false);

      // Next use: the write works now, and OpenAI is not asked again.
      const callsBefore = auth.calls.length;
      const again = await refresh((line) => warnings.push(line));
      expect(again.refresh).toBe(fresh.refresh);
      expect(auth.calls).toHaveLength(callsBefore);
      expect(readCodexFile(t.home)!.credential.refresh).toBe(fresh.refresh);
      expect(readCodexFile(t.home)!.credential.access).toBe(fresh.access);
      expect(warnings).toHaveLength(2);
    });

    it('is saved by the second write when only the first one failed', async () => {
      await login();
      store(60_000);
      const warnings: string[] = [];
      writes.failNext = 1;
      const fresh = await refresh((line) => warnings.push(line));
      expect(warnings).toHaveLength(1);
      expect(readCodexFile(t.home)!.credential.refresh).toBe(fresh.refresh);
      expect(readCodexFile(t.home)!.credential.access).toBe(fresh.access);
    });

    it('gives way to a login made afterwards', async () => {
      await login();
      store(60_000);
      writes.failNext = 2;
      const stale = await refresh(() => {});
      expect(loadCodexCredential({ home: t.home, consent: true }).refresh).toBe(stale.refresh);
      // A new login (this or any other process) writes the file: what this process kept is stale.
      await login();
      const loggedIn = readCodexFile(t.home)!.credential;
      expect(loggedIn.refresh).not.toBe(stale.refresh);
      expect(loadCodexCredential({ home: t.home, consent: true }).refresh).toBe(loggedIn.refresh);
    });

    it('is forgotten by logout', async () => {
      await login();
      store(60_000);
      writes.failNext = 2;
      await refresh(() => {});
      expect(forgetCodexCredential(t.home)).toBe(true);
      expect(() => loadCodexCredential({ home: t.home, consent: true })).toThrow(CodexAuthError);
      expect(codexStatus({ home: t.home })).toEqual({ loggedIn: false });
    });
  });

  describe('the credential source the run loop gives the bridge', () => {
    it("serves the stored login only for openai-codex, like the app's ProviderManager", async () => {
      await login();
      const source = createCredentialSource({
        provider: 'codex',
        home: t.home,
        consent: true,
        codex: { endpoints: auth.endpoints },
      });
      expect(source.providerId).toBe('openai-codex');
      expect(await source.credential('litellm')).toBeNull();
      expect(await source.refreshCredential('anthropic')).toBeNull();
      const credential = await source.credential('openai-codex');
      expect(credential).toMatchObject({ type: 'oauth', accountId: 'acct-fake-1' });
      expect(credentialSecrets(credential!).sort()).toEqual(
        [credential!.access, credential!.refresh].sort(),
      );
    });

    it('refreshes through the lock when asked, and the next credential() sees the rotation', async () => {
      await login();
      store(60_000);
      const source = createCredentialSource({
        provider: 'codex',
        home: t.home,
        consent: true,
        codex: { endpoints: auth.endpoints },
      });
      const fresh = await source.refreshCredential('openai-codex');
      expect(fresh?.refresh).toBe('refresh-2');
      expect((await source.credential('openai-codex'))?.refresh).toBe('refresh-2');
    });

    it('fails before any agent starts when there is no login', () => {
      expect(() =>
        createCredentialSource({ provider: 'codex', home: t.home, consent: true }),
      ).toThrow(CodexAuthError);
    });

    it('needs no login, no consent and no network in replay mode', async () => {
      const source = createCredentialSource({
        provider: 'codex',
        home: t.home,
        cache: 'replay',
        env: {},
      });
      const credential = await source.credential('openai-codex');
      expect(credential).toMatchObject({ type: 'oauth', accountId: 'acct-replay' });
      expect(isReplayCodexCredential(credential!)).toBe(true);
      expect(credentialSecrets(credential!)).toEqual([]);
      expect(codexAccountId(credential!.access as string)).toBe('acct-replay');
      expect(credential!.expires as number).toBeGreaterThan(Date.now() + 3_600_000);
      expect(await source.refreshCredential('openai-codex')).toEqual(credential);
      expect(await source.credential('litellm')).toBeNull();
      expect(replayCodexCredential(() => 0).expires).toBe(24 * 3_600_000);
    });
  });
});
