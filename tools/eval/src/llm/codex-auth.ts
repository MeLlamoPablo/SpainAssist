import { rmSync } from 'node:fs';
import type { LoginStage } from '@sa/agent';
import { ChatGPTLoginError, type PiCredential } from '@sa/agent';
import {
  CODEX_PROVIDER_ID,
  type CodexDeviceCode,
  type CodexEndpoints,
  loginCodexDevice,
  refreshCodexCredential,
} from '@sa/agent/codex';
import { type CodexFile, homePaths, readCodexFile, shownPath, writeCodexFile } from './home';
import { type LockOptions, withFileLock } from './lock';

/**
 * DEVELOPMENT ONLY. The eval's own Codex login: the device-code flow of `@sa/agent/codex` with
 * the tokens kept in `codex.json` of the credentials home (`evalHome`) instead of the app's vault (the eval never
 * reads the app's credential). `@sa/agent/codex` presents the tool as Codex CLI, which OpenAI's
 * terms do not allow for a shipped app; here it is a developer tool that stays out of the product,
 * needs an explicit consent flag or `SA_EVAL_CODEX_CONSENT=1`, refuses to run in CI (a CI variable
 * is set) unless `SA_EVAL_CODEX_ALLOW_CI=1`, and is meant for low volume.
 *
 * Refresh tokens rotate (the answer to a refresh kills the old one), so the rotated token is the
 * most valuable thing in the store. Every refresh happens under a cross-process lock, re-reads the
 * file under the lock (another process may have refreshed), refreshes only when under five minutes
 * of validity remain, and saves the new refresh token the moment OpenAI's answer has one, before
 * the answer is validated, and the whole new login before anyone uses it. If the write fails
 * (disk full, permissions) the new login is kept in memory for this process, written again on the
 * next use and reported on stderr: the process goes on, and nothing is lost unless it ends before
 * the write works. The e-mail of the account is never stored or printed.
 */

export const CODEX_CONSENT_ENV = 'SA_EVAL_CODEX_CONSENT';
export const CODEX_CONSENT_FLAG = '--codex-consent';
/** Set to `1` to let a CI job (any of `CI_ENV_VARS` set) use the Codex login anyway. */
export const CODEX_CI_OVERRIDE_ENV = 'SA_EVAL_CODEX_ALLOW_CI';

/** The variables CI systems set; any of them (other than empty, `0` or `false`) means CI. */
const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'JENKINS_URL',
  'TF_BUILD',
];

export const CODEX_TERMS_WARNING = [
  'DEVELOPMENT ONLY: this signs in with the Codex CLI client id and uses a ChatGPT plan through',
  "chatgpt.com/backend-api/codex. OpenAI's terms do not allow that route for a shipped app: keep",
  'it for your own plan, at low volume, never in CI and never with a production account.',
].join(' ');

/** Same rule as the app: refresh when this little validity remains. */
const REFRESH_MARGIN_MS = 5 * 60_000;

/** OAuth errors that mean the refresh token is dead: only a new login helps. */
const DEAD_REFRESH_TOKEN_ERRORS = new Set([
  'invalid_grant',
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
]);

/** Why Codex is refused: no consent given, or a CI variable is set (`ci` names it). */
export class CodexConsentError extends Error {
  constructor(ci?: string) {
    super(
      ci
        ? `Codex is not used in CI (${ci} is set): OpenAI's terms do not allow this route in a shipped app, and a CI job would spend a person's plan. Set ${CODEX_CI_OVERRIDE_ENV}=1 only if you really mean it.`
        : `Codex needs your explicit consent (OpenAI's terms do not allow this route in a shipped app): pass ${CODEX_CONSENT_FLAG} or set ${CODEX_CONSENT_ENV}=1.`,
    );
    this.name = 'CodexConsentError';
  }
}

/**
 * `missing`: no login stored. `relogin`: OpenAI rejected the refresh token, only a new login
 * helps. `refresh_failed`: OpenAI answered the refresh with something unusable.
 */
export type CodexAuthErrorCode = 'missing' | 'relogin' | 'refresh_failed';

export class CodexAuthError extends Error {
  readonly code: CodexAuthErrorCode;
  constructor(code: CodexAuthErrorCode, message: string) {
    super(message);
    this.name = 'CodexAuthError';
    this.code = code;
  }
}

export interface CodexCommonOptions {
  /** Credentials home (default `evalHome()`). */
  home?: string;
  /** The explicit consent flag of the CLI; `SA_EVAL_CODEX_CONSENT=1` does the same. */
  consent?: boolean;
  env?: Record<string, string | undefined>;
  /** Lines the library itself has to say (a refreshed login that could not be saved); default stderr. */
  warn?: (line: string) => void;
}

export function hasCodexConsent(
  options: Pick<CodexCommonOptions, 'consent' | 'env'> = {},
): boolean {
  return options.consent === true || (options.env ?? process.env)[CODEX_CONSENT_ENV] === '1';
}

/** The CI variable that is set, if any. */
function ciVariable(env: Record<string, string | undefined>): string | undefined {
  return CI_ENV_VARS.find((name) => {
    const value = env[name]?.trim().toLowerCase();
    return !!value && value !== '0' && value !== 'false';
  });
}

/**
 * Consent given, and not in CI (unless that was overridden on purpose). Every use of the login
 * (login, load, refresh, the meter's Codex runs) goes through it.
 */
export function requireCodexConsent(
  options: Pick<CodexCommonOptions, 'consent' | 'env'> = {},
): void {
  if (!hasCodexConsent(options)) throw new CodexConsentError();
  const env = options.env ?? process.env;
  const ci = ciVariable(env);
  if (ci && env[CODEX_CI_OVERRIDE_ENV] !== '1') throw new CodexConsentError(ci);
}

// ---------------------------------------------------------------------------------------------
// Keeping the login
// ---------------------------------------------------------------------------------------------

/**
 * A rotated login that could not be written, by path of its `codex.json`: the old refresh token in
 * the file is dead, so this process keeps the new one until a write works. A later write (or a new
 * login) replaces it; a file written by someone else after it wins.
 */
const unsaved = new Map<string, CodexFile>();

/** The stored login, or the one this process could not write yet when that is the newer. */
function currentLogin(home?: string): CodexFile | undefined {
  const path = homePaths(home).codex;
  const disk = readCodexFile(home);
  const memory = unsaved.get(path);
  if (memory && (!disk || disk.updatedAt <= memory.updatedAt)) return memory;
  unsaved.delete(path);
  return disk;
}

function fileFor(
  previous: Pick<CodexFile, 'loginAt'>,
  credential: CodexFile['credential'],
  at: number,
): CodexFile {
  // Only the known fields: whatever else an older file carried (an e-mail) is not copied forward.
  return {
    v: 1,
    provider: CODEX_PROVIDER_ID,
    loginAt: previous.loginAt,
    updatedAt: new Date(at).toISOString(),
    credential,
  };
}

/**
 * Writes the login. Never throws: a failed write keeps the login in memory and says so, because the
 * caller holds the only valid refresh token and must be able to go on with it.
 */
function saveLogin(file: CodexFile, options: CodexCommonOptions): void {
  const path = homePaths(options.home).codex;
  try {
    writeCodexFile(file, options.home);
    unsaved.delete(path);
  } catch (error) {
    unsaved.set(path, file);
    const reason = (error as NodeJS.ErrnoException).code ?? 'error';
    (options.warn ?? ((line) => process.stderr.write(`${line}\n`)))(
      `Codex: the refreshed login could not be saved to ${shownPath(path)} (${reason}). This process keeps it in memory and tries again on the next use: fix the permissions or the free space. If it ends first, run \`eval login codex ${CODEX_CONSENT_FLAG}\` again.`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

export interface CodexLoginOptions extends CodexCommonOptions {
  /** Lines for the person at the terminal (default: stdout). */
  print?: (line: string) => void;
  onUserCode?: (code: CodexDeviceCode) => void;
  onProgress?: (stage: LoginStage) => void;
  signal?: AbortSignal;
  /** Default 15 minutes. */
  timeoutMs?: number;
  /** Tests: a local fake of auth.openai.com. */
  endpoints?: Partial<CodexEndpoints>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface CodexLoginSummary {
  accountId: string;
  /** ISO time of the stored access token's expiry (minus the refresh margin of `@sa/agent`). */
  expiresAt: string;
  file: string;
}

/**
 * `eval login codex`: prints the verification URL and code, waits, stores the tokens. The e-mail
 * of the account is in the answer of OpenAI and is dropped: it is neither stored nor printed.
 */
export async function runCodexLogin(options: CodexLoginOptions = {}): Promise<CodexLoginSummary> {
  requireCodexConsent(options);
  const paths = homePaths(options.home);
  const print = options.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const now = options.now ?? Date.now;
  print(CODEX_TERMS_WARNING);
  const result = await loginCodexDevice({
    onUserCode: (code) => {
      const until = new Date(code.expiresAt).toTimeString().slice(0, 5);
      print(
        `Open ${code.verificationUrl} and enter the code ${code.userCode} (valid until ${until})`,
      );
      options.onUserCode?.(code);
    },
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.endpoints ? { endpoints: options.endpoints } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const credential = result.credential as CodexFile['credential'];
  const at = new Date(now()).toISOString();
  await withFileLock(paths.codexLock, () => {
    writeCodexFile(
      { v: 1, provider: CODEX_PROVIDER_ID, loginAt: at, updatedAt: at, credential },
      options.home,
    );
    // A new login replaces a refreshed one this process could not write.
    unsaved.delete(paths.codex);
  });
  // Where the tokens are is the one path the person is told (once, here).
  print(`Signed in to Codex. Tokens saved to ${paths.codex}.`);
  return {
    accountId: String(credential.accountId ?? ''),
    expiresAt: new Date(credential.expires).toISOString(),
    file: paths.codex,
  };
}

/** `eval logout codex`: deletes the stored login (no token is revoked at OpenAI). */
export function forgetCodexCredential(home?: string): boolean {
  const { codex } = homePaths(home);
  unsaved.delete(codex);
  try {
    rmSync(codex);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export interface CodexStatus {
  loggedIn: boolean;
  accountId?: string;
  loginAt?: string;
  updatedAt?: string;
  /** ISO time; undefined when not logged in. */
  expiresAt?: string;
  /** Milliseconds until `expiresAt`, negative when it is past. */
  expiresInMs?: number;
}

/** `eval whoami`: what is stored, never the tokens and never the e-mail. */
export function codexStatus(options: { home?: string; now?: () => number } = {}): CodexStatus {
  const stored = currentLogin(options.home);
  if (!stored) return { loggedIn: false };
  const accountId = stored.credential.accountId;
  return {
    loggedIn: true,
    ...(accountId ? { accountId } : {}),
    loginAt: stored.loginAt,
    updatedAt: stored.updatedAt,
    expiresAt: new Date(stored.credential.expires).toISOString(),
    expiresInMs: stored.credential.expires - (options.now ?? Date.now)(),
  };
}

// ---------------------------------------------------------------------------------------------
// Using the stored login
// ---------------------------------------------------------------------------------------------

function missingLogin(home?: string): CodexAuthError {
  return new CodexAuthError(
    'missing',
    `No Codex login in ${shownPath(homePaths(home).codex)}: run \`eval login codex ${CODEX_CONSENT_FLAG}\`.`,
  );
}

/** The stored credential as the hosts get it (`agent.credential`); no refresh. */
export function loadCodexCredential(options: CodexCommonOptions = {}): PiCredential {
  requireCodexConsent(options);
  const stored = currentLogin(options.home);
  if (!stored) throw missingLogin(options.home);
  return stored.credential as PiCredential;
}

export interface CodexRefreshOptions extends CodexCommonOptions {
  /** Refresh unless at least this much validity remains (default 5 minutes, like the app). */
  minValidityMs?: number;
  /** Tests: a local fake of auth.openai.com. */
  endpoints?: Partial<CodexEndpoints>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  lock?: LockOptions;
}

/**
 * What to tell the person (and the run) about a refresh that failed, never with a token in it:
 * the product's errors carry status codes and OAuth error codes only.
 */
function refreshFailure(error: unknown, rotatedAndSaved: boolean): unknown {
  if (!(error instanceof ChatGPTLoginError)) return error;
  if (error.oauthError && DEAD_REFRESH_TOKEN_ERRORS.has(error.oauthError)) {
    return new CodexAuthError(
      'relogin',
      `OpenAI rejected the Codex refresh token (${error.oauthError}): run \`eval login codex ${CODEX_CONSENT_FLAG}\` again.`,
    );
  }
  if (error.code === 'cancelled') {
    return new Error(
      'The Codex token refresh was cancelled or timed out before OpenAI answered. Nothing was changed; if OpenAI did answer, its answer was lost and the next try may say "relogin".',
    );
  }
  if (error.code === 'invalid_response') {
    return new CodexAuthError(
      'refresh_failed',
      rotatedAndSaved
        ? `OpenAI answered the Codex token refresh with something the suite cannot use (${error.message}). The new refresh token is saved, so nothing is lost: try again later, and if it keeps failing OpenAI has changed its token format.`
        : `OpenAI answered the Codex token refresh with something the suite cannot read (${error.message}). Its refresh token may already be used up: if the next try says "relogin", run \`eval login codex ${CODEX_CONSENT_FLAG}\` again.`,
    );
  }
  return error;
}

/**
 * `agent.refreshCredential` (and the preflight before a run: pass a larger `minValidityMs`).
 * Returns the stored credential when it has enough validity left, which is also what happens when
 * another process refreshed while we waited for the lock.
 */
export async function refreshCodexCredentialIfNeeded(
  options: CodexRefreshOptions = {},
): Promise<PiCredential> {
  requireCodexConsent(options);
  const now = options.now ?? Date.now;
  const minValidityMs = options.minValidityMs ?? REFRESH_MARGIN_MS;
  return await withFileLock(
    homePaths(options.home).codexLock,
    async () => {
      const stored = currentLogin(options.home);
      if (!stored) throw missingLogin(options.home);
      // A login that an earlier refresh of this process could not write: try again now.
      if (unsaved.has(homePaths(options.home).codex)) saveLogin(stored, options);
      if (stored.credential.expires - now() > minValidityMs) {
        return stored.credential as PiCredential;
      }
      let rotatedAndSaved = false;
      let fresh: PiCredential;
      try {
        fresh = await refreshCodexCredential(stored.credential as PiCredential, {
          ...(options.endpoints ? { endpoints: options.endpoints } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          signal: options.signal ?? AbortSignal.timeout(30_000),
          // The old refresh token is dead the moment OpenAI answers: keep the new one, with the old
          // access token (still valid until it expires), before anything in the answer is checked.
          onRotatedRefreshToken: (refresh) => {
            rotatedAndSaved = true;
            saveLogin(fileFor(stored, { ...stored.credential, refresh }, now()), options);
          },
        });
      } catch (error) {
        throw refreshFailure(error, rotatedAndSaved);
      }
      // Persist the rotated pair before anyone uses it.
      saveLogin(fileFor(stored, fresh as CodexFile['credential'], now()), options);
      return fresh;
    },
    options.lock,
  );
}

/** The refresh token of the synthetic login of replay runs: not a secret, not a word. */
const REPLAY_REFRESH_TOKEN = 'replay-login-refresh-token-not-a-secret';

function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.replay`;
}

/**
 * A syntactically valid Codex credential for replay runs, which never reach OpenAI: pi reads the
 * account id from the access token's claim, so the token is an unsigned JWT with one.
 */
export function replayCodexCredential(now: () => number = Date.now): PiCredential {
  const expires = now() + 24 * 3_600_000;
  return {
    type: 'oauth',
    access: unsignedJwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-replay' },
      exp: Math.floor(expires / 1000),
    }),
    refresh: REPLAY_REFRESH_TOKEN,
    expires,
    accountId: 'acct-replay',
  };
}

/** Whether this is the synthetic login of `replayCodexCredential` (it holds no secret). */
export function isReplayCodexCredential(credential: PiCredential): boolean {
  return credential.refresh === REPLAY_REFRESH_TOKEN;
}
