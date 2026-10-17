import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { z } from 'zod';
import type { LoginStage, PiCredential } from './types';

/**
 * "Sign in with ChatGPT" for open-source, locally hosted apps (official OSS flow, see
 * docs/research/providers-and-research.md §A3). We run the login ourselves (so the consent screen
 * says "Spain Assist") and hand pi's `openai` provider a credential of the shape it expects:
 * { type: "oauth", access, refresh, expires, clientId, scopes } (pi-ai openai-chatgpt.js).
 */

export interface ChatGPTEndpoints {
  authorizeUrl: string;
  tokenUrl: string;
  /** Expected `iss` of the ID token; its /.well-known/openid-configuration gives the JWKS. */
  issuer: string;
  /** Override the JWKS URL (skips discovery). */
  jwksUrl?: string;
  /** Override the token revocation URL (skips discovery). */
  revocationUrl?: string;
  resource: string;
  callbackHost: string;
  callbackPort: number;
  callbackPath: string;
}

export const CHATGPT_ENDPOINTS: ChatGPTEndpoints = {
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
  tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
  issuer: 'https://auth.openai.com',
  resource: 'https://api.openai.com/v1',
  callbackHost: '127.0.0.1',
  callbackPort: 1455,
  callbackPath: '/auth/callback',
};

const CHATGPT_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
const CHATGPT_AGENT_NAME = 'Spain Assist';
const CHATGPT_DIRECT_SCOPE = 'chatgpt.tokens.use.direct';
const CHATGPT_SCOPE = `openid profile email offline_access resource.invoke ${CHATGPT_DIRECT_SCOPE}`;
/** Refresh this long before the real expiry (same margin pi uses). */
const EXPIRY_MARGIN_MS = 3 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ChatGPTLoginErrorCode =
  | 'cancelled'
  | 'timeout'
  | 'port_in_use'
  | 'denied'
  | 'state_mismatch'
  | 'token_exchange'
  | 'invalid_id_token'
  | 'missing_scope'
  /** The ChatGPT account can't spend plan usage in other apps (e.g. a Free plan). */
  | 'not_eligible'
  | 'invalid_response';

export class ChatGPTLoginError extends Error {
  readonly code: ChatGPTLoginErrorCode;
  /** OAuth `error` returned by the token endpoint, when there was one. */
  readonly oauthError?: string;
  constructor(code: ChatGPTLoginErrorCode, message: string, oauthError?: string) {
    super(message);
    this.name = 'ChatGPTLoginError';
    this.code = code;
    if (oauthError) this.oauthError = oauthError;
  }
}

export interface ChatGPTLoginCallbacks {
  /** Open this URL in the system browser. */
  onAuthUrl(url: string): void;
  /** `waiting`: for the user (browser or code); `exchanging`: trading the code for tokens. */
  onProgress?(stage: LoginStage): void;
  signal?: AbortSignal;
  /** Stable per-installation UUID (persisted by the app). Sent as ext_agent_host_id. */
  deviceId: string;
  /** Client id issued by an earlier login of this install (re-authentication), if any. */
  clientId?: string;
  /** Resolves with the redirect URL pasted by the user, when the loopback callback can't be used. */
  manualRedirectUrl?: Promise<string>;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** HTML documents the loopback callback shows in the browser; plain built-in pages otherwise. */
  pages?: ChatGPTLoginPages;
  /** Tests/dev only. */
  endpoints?: Partial<ChatGPTEndpoints>;
  fetchImpl?: typeof fetch;
}

/** Complete HTML documents for the browser tab that ChatGPT redirects back to. */
export interface ChatGPTLoginPages {
  /** Signed in: the user can close the tab. */
  success: string;
  /** The redirect carried an error or failed validation. */
  failure: string;
  /** Any other path on the loopback port. */
  notFound: string;
}

export interface ChatGPTLoginResult {
  credential: PiCredential;
  /** ChatGPT account e-mail from the ID token, when present. */
  account?: string;
  /** Issued client id (also stored inside the credential). */
  clientId: string;
  /**
   * The verified OpenAI ID token (JWT). The app sends it to our key server, which checks it
   * against OpenAI's keys to issue the account's scan-decider key (D12). Not a credential for
   * OpenAI's API; never handed to pi or the model.
   */
  idToken: string;
}

// ---------------------------------------------------------------------------------------------
// Building blocks (exported for tests)
// ---------------------------------------------------------------------------------------------

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function redirectUri(endpoints: ChatGPTEndpoints, port = endpoints.callbackPort): string {
  return `http://127.0.0.1:${port}${endpoints.callbackPath}`;
}

export function buildChatGPTAuthorizeUrl(params: {
  endpoints?: ChatGPTEndpoints;
  deviceId: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  clientId?: string;
}): string {
  const endpoints = params.endpoints ?? CHATGPT_ENDPOINTS;
  if (!UUID.test(params.deviceId)) {
    throw new Error('Sign in with ChatGPT needs a device id (UUID) for this installation');
  }
  const url = new URL(endpoints.authorizeUrl);
  const query: Record<string, string> = {
    client_id: params.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
  };
  // The agent name hint only matters for the first registration.
  if (!params.clientId) query.agent_name_hint = CHATGPT_AGENT_NAME;
  Object.assign(query, {
    ext_agent_host_id: `urn:uuid:${params.deviceId.toLowerCase()}`,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    scope: CHATGPT_SCOPE,
    resource: endpoints.resource,
    state: params.state,
    nonce: params.nonce,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  url.search = new URLSearchParams(query).toString();
  return url.toString();
}

export interface ChatGPTCallback {
  code: string;
  /** Issued client id (`oaiapp_…`). */
  clientId?: string;
  scope?: string;
}

/** Validate the redirect (state, errors) and extract the authorization code. */
export function parseChatGPTCallback(input: string | URL, expectedState: string): ChatGPTCallback {
  const url = typeof input === 'string' ? new URL(input.trim()) : input;
  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description');
    throw new ChatGPTLoginError(
      'denied',
      `ChatGPT sign-in failed: ${error}${description ? ` (${description})` : ''}`,
    );
  }
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState) {
    throw new ChatGPTLoginError('state_mismatch', 'The sign-in response does not match this login');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new ChatGPTLoginError('invalid_response', 'The sign-in response has no code');
  return {
    code,
    clientId: url.searchParams.get('client_id')?.trim() || undefined,
    scope: url.searchParams.get('scope') ?? undefined,
  };
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  expires_in: z.number().positive(),
  earliest_refresh_at: z.union([z.number(), z.string()]).optional(),
});
type TokenResponse = z.infer<typeof TokenResponse>;

async function postToken(
  endpoints: ChatGPTEndpoints,
  form: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(endpoints.tokenUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new ChatGPTLoginError('cancelled', 'Sign-in cancelled');
    throw new ChatGPTLoginError(
      'token_exchange',
      `Could not reach ChatGPT: ${(error as Error).message}`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    let reason = res.statusText;
    let oauthError: string | undefined;
    try {
      const body = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      // OAuth errors are strings; API-style errors are { code, message } objects.
      const error = body.error as string | { code?: unknown; message?: unknown } | undefined;
      if (typeof error === 'string') oauthError = error;
      else if (typeof error?.code === 'string') oauthError = error.code;
      const description =
        typeof body.error_description === 'string'
          ? body.error_description
          : typeof error === 'object' && typeof error?.message === 'string'
            ? error.message
            : undefined;
      reason = [oauthError, description].filter(Boolean).join(': ') || reason;
    } catch {
      // keep status text
    }
    throw new ChatGPTLoginError(
      'token_exchange',
      `Token request failed (${res.status}): ${reason}`,
      oauthError,
    );
  }
  const parsed = TokenResponse.safeParse(safeJson(text));
  if (!parsed.success) {
    throw new ChatGPTLoginError('invalid_response', 'Unexpected token response from ChatGPT');
  }
  return parsed.data;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function credentialFrom(
  token: TokenResponse,
  clientId: string,
  previous?: PiCredential,
): PiCredential {
  const scopes = token.scope
    ? token.scope.trim().split(/\s+/).filter(Boolean)
    : Array.isArray(previous?.scopes)
      ? (previous.scopes as string[])
      : [];
  if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) {
    throw new ChatGPTLoginError(
      'missing_scope',
      'ChatGPT did not grant plan usage for this app (missing chatgpt.tokens.use.direct)',
    );
  }
  const refresh =
    token.refresh_token ?? (typeof previous?.refresh === 'string' ? previous.refresh : undefined);
  if (!refresh)
    throw new ChatGPTLoginError('invalid_response', 'ChatGPT returned no refresh token');
  return {
    type: 'oauth',
    access: token.access_token,
    refresh,
    expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
    clientId,
    scopes,
  };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(
  endpoints: ChatGPTEndpoints,
  key: 'jwks_uri' | 'revocation_endpoint',
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const discovery = `${endpoints.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetchImpl(discovery, { signal });
  if (!res.ok) throw new Error(`OpenID discovery failed (${res.status})`);
  const config = (await res.json()) as Record<string, unknown>;
  const value = config[key];
  if (typeof value !== 'string' || !value) throw new Error(`OpenID configuration has no ${key}`);
  return value;
}

async function jwksFor(endpoints: ChatGPTEndpoints, fetchImpl: typeof fetch, signal?: AbortSignal) {
  const jwksUrl = endpoints.jwksUrl ?? (await discover(endpoints, 'jwks_uri', fetchImpl, signal));
  let jwks = jwksCache.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    jwksCache.set(jwksUrl, jwks);
  }
  return jwks;
}

/** Verify the ID token: signature (JWKS), issuer, audience (= issued client id) and nonce. */
async function verifyChatGPTIdToken(
  idToken: string,
  expected: { clientId: string; nonce: string },
  options: { endpoints?: ChatGPTEndpoints; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<JWTPayload> {
  const endpoints = options.endpoints ?? CHATGPT_ENDPOINTS;
  try {
    const jwks = await jwksFor(endpoints, options.fetchImpl ?? fetch, options.signal);
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: endpoints.issuer,
      audience: expected.clientId,
    });
    if (payload.nonce !== expected.nonce) throw new Error('nonce mismatch');
    return payload;
  } catch (error) {
    throw new ChatGPTLoginError(
      'invalid_id_token',
      `Invalid ID token: ${(error as Error).message}`,
    );
  }
}

/**
 * Consent works for any ChatGPT account, but only paid plans (Plus/Pro) may spend plan usage in
 * other apps: for the rest the code exchange fails, observed as a bare `invalid_grant`. Only
 * applies to a fresh authorization code; on refresh `invalid_grant` means an expired session.
 */
function asEligibilityError(error: unknown): unknown {
  if (!(error instanceof ChatGPTLoginError) || error.code !== 'token_exchange') return error;
  const oauthError = error.oauthError ?? '';
  if (oauthError !== 'invalid_grant' && !oauthError.endsWith('user_not_eligible')) return error;
  return new ChatGPTLoginError(
    'not_eligible',
    `This ChatGPT account can't use its plan in other apps (${error.message})`,
    oauthError,
  );
}

/** Exchange the authorization code, validate the ID token and build the pi credential. */
async function exchangeChatGPTCode(params: {
  code: string;
  verifier: string;
  clientId: string;
  nonce: string;
  redirectUri: string;
  endpoints?: ChatGPTEndpoints;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<ChatGPTLoginResult> {
  const endpoints = params.endpoints ?? CHATGPT_ENDPOINTS;
  const fetchImpl = params.fetchImpl ?? fetch;
  const token = await postToken(
    endpoints,
    {
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
      resource: endpoints.resource,
    },
    params.signal,
    fetchImpl,
  ).catch((error: unknown) => {
    throw asEligibilityError(error);
  });
  if (!token.id_token)
    throw new ChatGPTLoginError('invalid_response', 'ChatGPT returned no ID token');
  const claims = await verifyChatGPTIdToken(
    token.id_token,
    { clientId: params.clientId, nonce: params.nonce },
    { endpoints, fetchImpl, signal: params.signal },
  );
  const credential = credentialFrom(token, params.clientId);
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  return { credential, account: email, clientId: params.clientId, idToken: token.id_token };
}

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

const PAGE = (title: string, body: string) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2937}h1{font-size:1.4rem}</style></head><body><h1>${title}</h1><p>${body}</p></body></html>`;

const PLAIN_PAGES: ChatGPTLoginPages = {
  success: PAGE('Listo', 'Has conectado ChatGPT. Ya puedes cerrar esta ventana.'),
  failure: PAGE('No se pudo conectar', 'Vuelve a Spain Assist e inténtalo de nuevo.'),
  notFound: PAGE('No encontrado', 'Esta dirección no es parte del inicio de sesión.'),
};

function sendPage(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(html);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Runs the whole "Sign in with ChatGPT" flow: loopback listener on 127.0.0.1:1455, PKCE + state +
 * nonce, browser consent, code exchange, ID-token validation, scope check. The app must persist
 * the returned credential (encrypted) and serve it to agent hosts via `agent.credential`.
 */
export async function loginChatGPT(cb: ChatGPTLoginCallbacks): Promise<ChatGPTLoginResult> {
  const endpoints: ChatGPTEndpoints = { ...CHATGPT_ENDPOINTS, ...cb.endpoints };
  const fetchImpl = cb.fetchImpl ?? fetch;
  const { verifier, challenge } = createPkce();
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const timeout = AbortSignal.timeout(cb.timeoutMs ?? 10 * 60_000);
  const signal = cb.signal ? AbortSignal.any([cb.signal, timeout]) : timeout;

  let resolveCallback!: (value: ChatGPTCallback) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<ChatGPTCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  callback.catch(() => {});
  const pages = cb.pages ?? PLAIN_PAGES;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${endpoints.callbackPort}`);
    if (url.pathname !== endpoints.callbackPath) {
      sendPage(res, 404, pages.notFound);
      return;
    }
    try {
      const result = parseChatGPTCallback(url, state);
      sendPage(res, 200, pages.success);
      resolveCallback(result);
    } catch (error) {
      const loginError = error as ChatGPTLoginError;
      sendPage(res, 400, pages.failure);
      // A stale tab from an earlier attempt must not break this login.
      if (loginError.code !== 'state_mismatch') rejectCallback(loginError);
    }
  });

  let port = endpoints.callbackPort;
  let listening = false;
  try {
    port = await listen(server, endpoints.callbackHost, endpoints.callbackPort);
    listening = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && !cb.manualRedirectUrl) {
      throw new ChatGPTLoginError(
        'port_in_use',
        `Port ${endpoints.callbackPort} is in use by another program (for example another ChatGPT/Codex login). Close it and try again.`,
      );
    }
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }

  const redirect = redirectUri(endpoints, port);
  try {
    const url = buildChatGPTAuthorizeUrl({
      endpoints,
      deviceId: cb.deviceId,
      state,
      nonce,
      codeChallenge: challenge,
      redirectUri: redirect,
      clientId: cb.clientId,
    });
    cb.onAuthUrl(url);
    cb.onProgress?.('waiting');

    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () =>
        reject(
          cb.signal?.aborted
            ? new ChatGPTLoginError('cancelled', 'Sign-in cancelled')
            : new ChatGPTLoginError('timeout', 'Sign-in timed out'),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    const sources: Promise<ChatGPTCallback>[] = [aborted];
    if (listening) sources.push(callback);
    if (cb.manualRedirectUrl) {
      sources.push(cb.manualRedirectUrl.then((pasted) => parseChatGPTCallback(pasted, state)));
    }
    const result = await Promise.race(sources);
    const clientId = result.clientId ?? cb.clientId;
    if (!clientId) {
      throw new ChatGPTLoginError('invalid_response', 'ChatGPT did not return a client id');
    }
    cb.onProgress?.('exchanging');
    return await exchangeChatGPTCode({
      code: result.code,
      verifier,
      clientId,
      nonce,
      redirectUri: redirect,
      endpoints,
      fetchImpl,
      signal,
    });
  } finally {
    server.close();
    server.closeAllConnections();
  }
}

// ---------------------------------------------------------------------------------------------
// Refresh, models
// ---------------------------------------------------------------------------------------------

/** True when an OAuth credential expires within `minValidityMs` (default 5 min, like pi). */
export function credentialNeedsRefresh(
  credential: PiCredential,
  minValidityMs = 5 * 60_000,
): boolean {
  if (credential.type !== 'oauth') return false;
  const expires = typeof credential.expires === 'number' ? credential.expires : 0;
  return Date.now() + minValidityMs >= expires;
}

/**
 * Refresh an OAuth credential. Refresh tokens rotate: the app must serialize calls (one at a
 * time per credential, across all agent processes) and persist the result before using it.
 */
export async function refreshOAuthCredential(
  providerId: string,
  credential: PiCredential,
  options: {
    endpoints?: Partial<ChatGPTEndpoints>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<PiCredential> {
  if (providerId !== 'openai') {
    throw new Error(`Refreshing credentials of provider "${providerId}" is not supported`);
  }
  if (credential.type !== 'oauth' || typeof credential.refresh !== 'string') {
    throw new Error('Not an OAuth credential');
  }
  const clientId = typeof credential.clientId === 'string' ? credential.clientId : '';
  if (!clientId)
    throw new Error('The credential has no issued client id: sign in with ChatGPT again');
  const endpoints: ChatGPTEndpoints = { ...CHATGPT_ENDPOINTS, ...options.endpoints };
  const token = await postToken(
    endpoints,
    {
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: credential.refresh,
      resource: endpoints.resource,
    },
    options.signal,
    options.fetchImpl ?? fetch,
  );
  return credentialFrom(token, clientId, credential);
}

// ---------------------------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------------------------

/**
 * Ends the ChatGPT session of a credential at OpenAI (sign out). Without it OpenAI keeps the
 * session, and every later sign-in shows Spain Assist once more in the user's ChatGPT settings.
 * Retries server and network errors a few times; throws when OpenAI could not be told, so the
 * app can tell the user to disconnect the app in ChatGPT's settings themselves.
 */
export async function revokeChatGPTCredential(
  credential: PiCredential,
  options: {
    endpoints?: Partial<ChatGPTEndpoints>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    /** Waits before each retry (default 0.5 s, 1 s, 2 s). */
    retryDelaysMs?: number[];
  } = {},
): Promise<void> {
  const clientId = typeof credential.clientId === 'string' ? credential.clientId : '';
  if (credential.type !== 'oauth' || typeof credential.refresh !== 'string' || !clientId) {
    throw new Error('Not a ChatGPT credential');
  }
  const endpoints: ChatGPTEndpoints = { ...CHATGPT_ENDPOINTS, ...options.endpoints };
  const fetchImpl = options.fetchImpl ?? fetch;
  const { signal } = options;
  const delays = options.retryDelaysMs ?? [500, 1000, 2000];
  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure = '';
    try {
      const url =
        endpoints.revocationUrl ??
        (await discover(endpoints, 'revocation_endpoint', fetchImpl, signal));
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          token: credential.refresh,
          token_type_hint: 'refresh_token',
          client_id: clientId,
        }).toString(),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      failure = `Could not reach ChatGPT: ${(error as Error).message}`;
    }
    if (res) {
      // 200 also when the token was already invalid (RFC 7009).
      if (res.ok) return;
      failure = `Revocation failed (${res.status})`;
      // A client error won't change on retry.
      if (res.status < 500) throw new Error(failure);
    }
    const delay = delays[attempt];
    if (delay === undefined) throw new Error(failure);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
