import { decodeJwt } from 'jose';
import { z } from 'zod';
import { ChatGPTLoginError } from './chatgpt';
import type { LoginStage, PiCredential } from './types';

/**
 * DEVELOPMENT ONLY. Legacy "OpenAI Codex" device-code login (docs/research/providers-and-research.md
 * §A3, "Legacy Codex OAuth route"). It presents the app as Codex CLI (Codex's own client id) and
 * pi's `openai-codex` provider then calls chatgpt.com/backend-api/codex. That is against OpenAI's
 * terms for a third-party app, so this module must never ship: it is only reachable through the
 * `@sa/agent/codex` subpath, which the desktop app imports behind `import.meta.env.DEV`.
 *
 * Flow (same as `codex login --device-auth` and pi-ai openai-codex.js):
 * 1. POST /api/accounts/deviceauth/usercode {client_id} -> {device_auth_id, user_code, interval}
 * 2. The user opens /codex/device and types the code.
 * 3. Poll POST /api/accounts/deviceauth/token {device_auth_id, user_code} until it returns
 *    {authorization_code, code_verifier} (403/404 = still pending).
 * 4. Exchange the code at /oauth/token (redirect_uri /deviceauth/callback, PKCE verifier).
 */

export const CODEX_PROVIDER_ID = 'openai-codex';

export interface CodexEndpoints {
  /** Codex CLI's public OAuth client id. */
  clientId: string;
  userCodeUrl: string;
  deviceTokenUrl: string;
  tokenUrl: string;
  /** Page where the user types the code. */
  verificationUrl: string;
  redirectUri: string;
}

const AUTH_BASE_URL = 'https://auth.openai.com';

export const CODEX_ENDPOINTS: CodexEndpoints = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  userCodeUrl: `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
  deviceTokenUrl: `${AUTH_BASE_URL}/api/accounts/deviceauth/token`,
  tokenUrl: `${AUTH_BASE_URL}/oauth/token`,
  verificationUrl: `${AUTH_BASE_URL}/codex/device`,
  redirectUri: `${AUTH_BASE_URL}/deviceauth/callback`,
};

/** Codex CLI gives up after 15 minutes. */
const DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_MS = 1000;
/** Refresh this long before the real expiry (same margin as Sign in with ChatGPT). */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';

export interface CodexDeviceCode {
  userCode: string;
  verificationUrl: string;
  /** Epoch ms after which the code is no longer accepted. */
  expiresAt: number;
}

export interface CodexLoginCallbacks {
  /** Show the code and the page where the user types it. */
  onUserCode(code: CodexDeviceCode): void;
  onProgress?(stage: LoginStage): void;
  signal?: AbortSignal;
  /** Default 15 minutes. */
  timeoutMs?: number;
  /** Tests only. */
  endpoints?: Partial<CodexEndpoints>;
  fetchImpl?: typeof fetch;
  /** Tests only: replaces the wait between polls. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CodexLoginResult {
  /** pi `openai-codex` credential: { type: 'oauth', access, refresh, expires, accountId }. */
  credential: PiCredential;
  /** ChatGPT account e-mail from the ID token, when present. */
  account?: string;
}

const UserCodeResponse = z.object({
  device_auth_id: z.string().min(1),
  // Codex CLI accepts both spellings.
  user_code: z.string().min(1).optional(),
  usercode: z.string().min(1).optional(),
  interval: z.union([z.number(), z.string()]).optional(),
});

const DeviceTokenResponse = z.object({
  authorization_code: z.string().min(1),
  code_verifier: z.string().min(1),
});

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});
type TokenResponse = z.infer<typeof TokenResponse>;

function cancelled(): ChatGPTLoginError {
  return new ChatGPTLoginError('cancelled', 'Sign-in cancelled');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) throw cancelled();
    throw new ChatGPTLoginError(
      'token_exchange',
      `Could not reach OpenAI: ${(error as Error).message}`,
    );
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What an OAuth error code looks like (`invalid_grant`): short, lower-case snake case. */
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * `error` of an OAuth ({ error: "x" }) or API-style ({ error: { code: "x" } }) error body. Only a
 * short identifier is returned: it ends up in messages and logs, so a server that put something
 * else in that field (a token, a page of HTML) is not repeated.
 */
function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  const code = typeof error === 'string' ? error : (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/** The ChatGPT account id pi's openai-codex provider sends as `chatgpt-account-id`. */
export function codexAccountId(accessToken: string): string | undefined {
  try {
    const auth = decodeJwt(accessToken)[JWT_AUTH_CLAIM] as
      | { chatgpt_account_id?: unknown }
      | undefined;
    const id = auth?.chatgpt_account_id;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

function emailFrom(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const email = decodeJwt(idToken).email;
    return typeof email === 'string' ? email : undefined;
  } catch {
    return undefined;
  }
}

function credentialFrom(token: TokenResponse, previous?: PiCredential): PiCredential {
  const refresh =
    token.refresh_token ?? (typeof previous?.refresh === 'string' ? previous.refresh : undefined);
  if (!refresh) throw new ChatGPTLoginError('invalid_response', 'OpenAI returned no refresh token');
  const accountId = codexAccountId(token.access_token);
  if (!accountId) {
    throw new ChatGPTLoginError('invalid_response', 'The access token has no ChatGPT account id');
  }
  return {
    type: 'oauth',
    access: token.access_token,
    refresh,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
    accountId,
  };
}

async function postToken(
  endpoints: CodexEndpoints,
  form: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  onRotatedRefreshToken?: (refreshToken: string) => void | Promise<void>,
): Promise<TokenResponse> {
  const res = await request(
    fetchImpl,
    endpoints.tokenUrl,
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    },
    signal,
  );
  let text: string;
  try {
    text = await res.text();
  } catch {
    if (signal.aborted) throw cancelled();
    // The connection broke while the body arrived; OpenAI may already have rotated the token.
    throw new ChatGPTLoginError(
      'invalid_response',
      `The answer of OpenAI to the token request (${res.status}) could not be read`,
    );
  }
  const body = safeJson(text);
  if (!res.ok) {
    const code = errorCode(body);
    throw new ChatGPTLoginError(
      'token_exchange',
      `Token request failed (${res.status})${code ? `: ${code}` : ''}`,
      code,
    );
  }
  // Before anything else is checked: the answer rotated the refresh token, so this is the only
  // copy of a token that works, whatever else is wrong with the answer.
  const rotated = (body as { refresh_token?: unknown } | undefined)?.refresh_token;
  if (typeof rotated === 'string' && rotated) await onRotatedRefreshToken?.(rotated);
  const parsed = TokenResponse.safeParse(body);
  if (!parsed.success) {
    throw new ChatGPTLoginError('invalid_response', 'Unexpected token response from OpenAI');
  }
  return parsed.data;
}

/** Step 1: ask for a user code. */
export async function requestCodexDeviceCode(
  options: { endpoints?: CodexEndpoints; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<{ deviceAuthId: string; userCode: string; intervalMs: number }> {
  const endpoints = options.endpoints ?? CODEX_ENDPOINTS;
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  const res = await request(
    options.fetchImpl ?? fetch,
    endpoints.userCodeUrl,
    {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: endpoints.clientId }),
    },
    signal,
  );
  const body = safeJson(await res.text());
  if (!res.ok) {
    throw new ChatGPTLoginError(
      res.status === 404 ? 'denied' : 'token_exchange',
      res.status === 404
        ? 'Device code login is not enabled for this account or workspace'
        : `Device code request failed (${res.status})`,
      errorCode(body),
    );
  }
  const parsed = UserCodeResponse.safeParse(body);
  const userCode = parsed.data?.user_code ?? parsed.data?.usercode;
  if (!parsed.success || !userCode) {
    throw new ChatGPTLoginError('invalid_response', 'Unexpected device code response from OpenAI');
  }
  const interval = Number(parsed.data.interval ?? DEFAULT_INTERVAL_S);
  return {
    deviceAuthId: parsed.data.device_auth_id,
    userCode,
    intervalMs: Math.max(
      MIN_INTERVAL_MS,
      (Number.isFinite(interval) && interval >= 0 ? interval : DEFAULT_INTERVAL_S) * 1000,
    ),
  };
}

/**
 * Runs the whole device-code login: user code, polling, code exchange. The app must persist the
 * returned credential (encrypted) and serve it to agent hosts via `agent.credential`.
 */
export async function loginCodexDevice(cb: CodexLoginCallbacks): Promise<CodexLoginResult> {
  const endpoints: CodexEndpoints = { ...CODEX_ENDPOINTS, ...cb.endpoints };
  const fetchImpl = cb.fetchImpl ?? fetch;
  const wait = cb.sleep ?? sleep;
  const timeoutMs = cb.timeoutMs ?? DEVICE_CODE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cb.signal ? AbortSignal.any([cb.signal, timeout]) : timeout;
  const abortError = () =>
    cb.signal?.aborted ? cancelled() : new ChatGPTLoginError('timeout', 'Sign-in timed out');

  try {
    const device = await requestCodexDeviceCode({ endpoints, fetchImpl, signal });
    const deadline = Date.now() + timeoutMs;
    cb.onUserCode({
      userCode: device.userCode,
      verificationUrl: endpoints.verificationUrl,
      expiresAt: deadline,
    });
    cb.onProgress?.('waiting');

    let intervalMs = device.intervalMs;
    let code: z.infer<typeof DeviceTokenResponse> | undefined;
    while (!code) {
      if (Date.now() >= deadline) throw new ChatGPTLoginError('timeout', 'Sign-in timed out');
      const res = await request(
        fetchImpl,
        endpoints.deviceTokenUrl,
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        },
        signal,
      );
      const body = safeJson(await res.text());
      if (res.ok) {
        const parsed = DeviceTokenResponse.safeParse(body);
        if (!parsed.success) {
          throw new ChatGPTLoginError('invalid_response', 'Unexpected device token response');
        }
        code = parsed.data;
        break;
      }
      const error = errorCode(body);
      const pending =
        res.status === 403 || res.status === 404 || error === 'deviceauth_authorization_pending';
      if (error === 'slow_down')
        intervalMs += 5000; // RFC 8628 §3.5
      else if (!pending) {
        throw new ChatGPTLoginError(
          error === 'access_denied' ? 'denied' : 'token_exchange',
          `Device code login failed (${res.status})${error ? `: ${error}` : ''}`,
          error,
        );
      }
      await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    }

    cb.onProgress?.('exchanging');
    const token = await postToken(
      endpoints,
      {
        grant_type: 'authorization_code',
        client_id: endpoints.clientId,
        code: code.authorization_code,
        code_verifier: code.code_verifier,
        redirect_uri: endpoints.redirectUri,
      },
      signal,
      fetchImpl,
    );
    const account = emailFrom(token.id_token);
    return { credential: credentialFrom(token), ...(account ? { account } : {}) };
  } catch (error) {
    if (signal.aborted) throw abortError();
    throw error;
  }
}

/**
 * Refresh a Codex credential. Refresh tokens rotate: the app must serialize calls and persist the
 * result before using it (same rules as `refreshOAuthCredential`).
 *
 * The rotated refresh token is the one thing that cannot be fetched again, so it is handed to
 * `onRotatedRefreshToken` (awaited) as soon as OpenAI's answer has one, before the rest of the
 * answer is validated. If the answer is then unusable (no ChatGPT account id in the access token,
 * no `expires_in`) this function throws, and the caller has already saved the new token: pair it
 * with the old access token and the next refresh recovers. An answer that cannot be read at all
 * carries no token to save: the old one may then be dead too.
 */
export async function refreshCodexCredential(
  credential: PiCredential,
  options: {
    endpoints?: Partial<CodexEndpoints>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    onRotatedRefreshToken?: (refreshToken: string) => void | Promise<void>;
  } = {},
): Promise<PiCredential> {
  if (credential.type !== 'oauth' || typeof credential.refresh !== 'string') {
    throw new Error('Not an OAuth credential');
  }
  const endpoints: CodexEndpoints = { ...CODEX_ENDPOINTS, ...options.endpoints };
  const token = await postToken(
    endpoints,
    {
      grant_type: 'refresh_token',
      client_id: endpoints.clientId,
      refresh_token: credential.refresh,
    },
    options.signal ?? AbortSignal.timeout(30_000),
    options.fetchImpl ?? fetch,
    options.onRotatedRefreshToken,
  );
  return credentialFrom(token, credential);
}
