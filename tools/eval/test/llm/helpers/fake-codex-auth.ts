import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CodexEndpoints } from '@sa/agent/codex';

export function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

/**
 * How the fake answers a refresh (after it has rotated the token, as the real server does):
 * `no-account` an access token without the ChatGPT account claim, `no-expires` no `expires_in`,
 * `wrong-types` an `expires_in` that is not a number, `not-json` a body that is not JSON,
 * `cut-off` a body that breaks off in the middle.
 */
export type RefreshAnswer = 'no-account' | 'no-expires' | 'wrong-types' | 'not-json' | 'cut-off';

export interface FakeAuthOptions {
  /** Device-token polls answered "pending" before approval. */
  pending?: number;
  /** Fail the device-token poll with this error code (HTTP 400). */
  deviceError?: string;
  /** Lifetime of the access tokens in seconds (default 864000: the real ones last ten days). */
  expiresIn?: number;
  /** Milliseconds each token request takes (to overlap concurrent refreshes). */
  tokenDelayMs?: number;
}

export interface FakeAuth {
  endpoints: CodexEndpoints;
  /** Token-endpoint calls by grant type. */
  calls: { grant: string; refreshToken?: string }[];
  /** The refresh token that is valid now (each one works once: they rotate). */
  currentRefreshToken(): string;
  /** Marks the current refresh token as revoked. */
  revoke(): void;
  /** From now on answer refreshes in this broken way (`undefined`: well-formed again). */
  setRefreshAnswer(answer: RefreshAnswer | undefined): void;
  /** The access token of the answer to the last refresh, even when the answer was broken. */
  lastAccessToken(): string;
  close(): Promise<void>;
}

/**
 * A local fake of auth.openai.com for the Codex device flow: user code, pending polls, code
 * exchange, and a `/oauth/token` that ROTATES refresh tokens (a token works once; replaying an
 * old one answers `invalid_grant`), which is what makes unserialized refreshes fail. The shapes
 * are the real ones seen in October 2026: a numeric `interval` and `expires_at` on the user code,
 * a 403 `{ error: { code: 'deviceauth_authorization_pending' } }` while waiting, and a token
 * response with `token_type`, `scope`, `earliest_refresh_at` (nine days after the issue, only
 * advice: an earlier refresh works) and an access token that is a JWT with the plan in its claim.
 */
export async function startFakeAuth(options: FakeAuthOptions = {}): Promise<FakeAuth> {
  const calls: FakeAuth['calls'] = [];
  let pending = options.pending ?? 1;
  let generation = 0;
  let valid = new Set<string>();
  let refreshAnswer: RefreshAnswer | undefined;
  let lastAccess = '';
  const issue = () => {
    generation++;
    const refresh = `refresh-${generation}`;
    valid = new Set([refresh]);
    const expiresIn = options.expiresIn ?? 864_000;
    const iat = Math.floor(Date.now() / 1000);
    const access = jwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-fake-1',
        chatgpt_plan_type: 'plus',
      },
      iat,
      exp: iat + expiresIn,
      gen: generation,
    });
    lastAccess = access;
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'openid profile email offline_access',
      id_token: jwt({ email: 'dev@example.test' }),
      earliest_refresh_at: iat + 9 * 86_400,
      refresh_token: refresh,
    };
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const path = req.url ?? '';
      if (path === '/api/accounts/deviceauth/usercode') {
        return json(200, {
          device_auth_id: 'dev-1',
          user_code: 'ABCD-1234',
          interval: 1,
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString().replace('Z', '+00:00'),
        });
      }
      if (path === '/api/accounts/deviceauth/token') {
        if (options.deviceError) return json(400, { error: { code: options.deviceError } });
        if (pending-- > 0)
          return json(403, { error: { code: 'deviceauth_authorization_pending' } });
        return json(200, { authorization_code: 'auth-code', code_verifier: 'verifier' });
      }
      if (path === '/oauth/token') {
        const form = new URLSearchParams(text);
        const grant = form.get('grant_type') ?? '';
        calls.push({
          grant,
          ...(form.get('refresh_token') ? { refreshToken: form.get('refresh_token')! } : {}),
        });
        if (options.tokenDelayMs) await new Promise((r) => setTimeout(r, options.tokenDelayMs));
        if (grant === 'authorization_code') return json(200, issue());
        if (grant === 'refresh_token') {
          const token = form.get('refresh_token') ?? '';
          if (!valid.has(token)) return json(400, { error: 'invalid_grant' });
          const answer = issue(); // the token is rotated whatever the answer looks like
          switch (refreshAnswer) {
            case 'no-account':
              return json(200, { ...answer, access_token: jwt({ sub: 'someone' }) });
            case 'no-expires': {
              const { expires_in: _, ...rest } = answer;
              return json(200, rest);
            }
            case 'wrong-types':
              return json(200, { ...answer, expires_in: 'soon' });
            case 'not-json':
              res.writeHead(200, { 'content-type': 'text/html' });
              return res.end('<html>502 Bad Gateway</html>');
            case 'cut-off': {
              const text = JSON.stringify(answer);
              res.writeHead(200, {
                'content-type': 'application/json',
                'content-length': text.length,
              });
              res.write(text.slice(0, 40));
              return setTimeout(() => res.destroy(), 20);
            }
            default:
              return json(200, answer);
          }
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: {
      clientId: 'app_fake_client',
      userCodeUrl: `${base}/api/accounts/deviceauth/usercode`,
      deviceTokenUrl: `${base}/api/accounts/deviceauth/token`,
      tokenUrl: `${base}/oauth/token`,
      verificationUrl: `${base}/codex/device`,
      redirectUri: `${base}/deviceauth/callback`,
    },
    calls,
    currentRefreshToken: () => [...valid][0] ?? '',
    revoke: () => {
      valid = new Set();
    },
    setRefreshAnswer: (answer) => {
      refreshAnswer = answer;
    },
    lastAccessToken: () => lastAccess,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
