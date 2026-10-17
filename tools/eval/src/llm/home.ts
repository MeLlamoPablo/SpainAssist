import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';

/**
 * The credentials home of the eval suite: its data folder, `spainbench` in the OS's folder for an
 * app's own data (`SPAINBENCH_DATA_DIR` overrides it). It holds the voucher key (`litellm.json`),
 * the Codex login (`codex.json`), the spend ledger, the record/replay cache, the kill-switch file
 * and, by default, the run folders (`runs/`). It lives outside the repo; nothing in it ever
 * reaches run artifacts, logs, the model or the cache's keys. The directory is 0700, files are
 * 0600, writes are atomic, and credential files that other users could read are refused.
 */

const EVAL_HOME_ENV = 'SPAINBENCH_DATA_DIR';
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type EvalHomeErrorCode = 'missing' | 'unsafe_permissions' | 'invalid';

/** Problems with a file of the credentials home. Messages never include file contents. */
export class EvalHomeError extends Error {
  readonly code: EvalHomeErrorCode;
  readonly path: string;
  constructor(code: EvalHomeErrorCode, path: string, message: string) {
    super(message);
    this.name = 'EvalHomeError';
    this.code = code;
    this.path = path;
  }
}

/**
 * The eval suite's data folder: `SPAINBENCH_DATA_DIR`, or `spainbench` in the OS's folder for an
 * app's own data, outside any checkout. macOS `~/Library/Application Support`, Windows
 * `%LOCALAPPDATA%`, elsewhere `$XDG_DATA_HOME` (an absolute path) or `~/.local/share`.
 */
export function evalHome(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env[EVAL_HOME_ENV]?.trim();
  if (override) return resolve(override);
  const absolute = (value: string | undefined) => (value && isAbsolute(value) ? value : undefined);
  const data =
    platform === 'darwin'
      ? join(home, 'Library', 'Application Support')
      : platform === 'win32'
        ? (absolute(env.LOCALAPPDATA) ?? join(home, 'AppData', 'Local'))
        : (absolute(env.XDG_DATA_HOME) ?? join(home, '.local', 'share'));
  return join(data, 'spainbench');
}

/**
 * A path as it is shown in messages and as a shell takes it: under the user's home directory it is
 * written `~/...`, so a message that ends up in a log or a bug report does not carry the OS user
 * name. A path with characters the shell would split on is quoted (and then shown in full).
 */
export function shownPath(path: string): string {
  const user = homedir();
  const shown = path.startsWith(`${user}${sep}`) ? `~${path.slice(user.length)}` : path;
  return /^[\w@%+=:,./~-]+$/.test(shown) ? shown : `'${path.replace(/'/g, "'\\''")}'`;
}

export interface HomePaths {
  home: string;
  /** The voucher key (`{ baseUrl, apiKey, keyServerUrl, limitUsd, expiresAt }`). */
  litellm: string;
  /** The Codex login. */
  codex: string;
  /** Cross-process lock directory of `codex.json` (rotating refresh tokens). */
  codexLock: string;
  ledgerDir: string;
  /** Written by the meter when a Codex usage limit is hit; read by every meter process. */
  codexCooldown: string;
  cacheDir: string;
  /** `touch` it to make every meter answer "out of budget" at once. */
  stopFile: string;
}

export function homePaths(home: string = evalHome()): HomePaths {
  const root = resolve(home);
  const ledgerDir = join(root, 'ledger');
  return {
    home: root,
    litellm: join(root, 'litellm.json'),
    codex: join(root, 'codex.json'),
    codexLock: join(root, 'codex.json.lock'),
    ledgerDir,
    codexCooldown: join(ledgerDir, 'codex-cooldown.json'),
    cacheDir: join(root, 'llm-cache'),
    stopFile: join(root, 'STOP'),
  };
}

const isWindows = process.platform === 'win32';

/** Creates the directory (and its parents) as 0700 and tightens an existing one that we own. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (isWindows) return;
  const stats = statSync(dir);
  const owned = typeof process.getuid !== 'function' || stats.uid === process.getuid();
  if (owned && (stats.mode & 0o077) !== 0) chmodSync(dir, PRIVATE_DIR_MODE);
}

/** Writes `data` to a new 0600 temp file, syncs it and renames it over `path`. */
export function writeFileAtomic(path: string, data: string): void {
  const dir = dirname(path);
  ensurePrivateDir(dir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', PRIVATE_FILE_MODE);
  try {
    // Not `writeSync(fd, data)`: it returns the bytes it wrote, and a short write would be synced
    // and renamed over the good file. `writeFileSync` writes it all.
    writeFileSync(fd, data);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  if (isWindows) return;
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is a durability nicety; the rename already happened.
  }
}

/**
 * Reads a credential file. Returns undefined when it does not exist; refuses (throws) one that
 * is not a regular file of ours or that group/others can read: a leaked key must not depend on
 * how the file was created.
 */
export function readPrivateFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new EvalHomeError('invalid', path, `${shownPath(path)} is not a regular file`);
    }
    if (!isWindows) {
      if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
        throw new EvalHomeError(
          'unsafe_permissions',
          path,
          `${shownPath(path)} is not owned by this user`,
        );
      }
      if ((stats.mode & 0o077) !== 0) {
        throw new EvalHomeError(
          'unsafe_permissions',
          path,
          `${shownPath(path)} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}); run: chmod 600 ${shownPath(path)}`,
        );
      }
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Reads and validates a private JSON file; undefined when it does not exist. */
function readPrivateJson<T>(path: string, schema: z.ZodType<T>): T | undefined {
  const text = readPrivateFile(path);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EvalHomeError('invalid', path, `${shownPath(path)} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new EvalHomeError(
      'invalid',
      path,
      `${shownPath(path)} is invalid: ${describeIssues(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function writePrivateJson(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------------
// litellm.json: the voucher key
// ---------------------------------------------------------------------------------------------

const LitellmFile = z.looseObject({
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  keyServerUrl: z.url(),
  limitUsd: z.number().nonnegative().optional(),
  expiresAt: z.string().nullable().optional(),
});

export interface VoucherCredential {
  /** Gateway base URL as the app uses it (ends in `/v1`), without a trailing slash. */
  baseUrl: string;
  apiKey: string;
  keyServerUrl: string;
  limitUsd?: number;
  expiresAt?: string | null;
}

/** Set to `1` to accept a gateway or key server given as an IP address (the voucher key goes there). */
export const ALLOW_IP_GATEWAY_ENV = 'SA_EVAL_ALLOW_IP_GATEWAY';

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

/**
 * Why the voucher key must not be sent to `value`, or undefined when it may be. The key goes to
 * this address with every request, so it must travel over https (plain http only to this machine),
 * to a name a certificate can vouch for (a bare IP address needs an explicit override), and the
 * URL must not carry anything else that would be printed or logged with it.
 */
function gatewayProblem(field: string, value: string, env: Record<string, string | undefined>) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `${field} must be an http(s) URL`;
  }
  if (url.username || url.password) {
    return `${field} must not contain a user name or password`;
  }
  if (url.search || url.hash) return `${field} must not have a query or a fragment`;
  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === 'http:' && !loopback) {
    return `${field} uses plain http to ${url.host}: the voucher key would cross the network in clear text (use https; plain http is only for localhost)`;
  }
  if (!loopback && isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    if (env[ALLOW_IP_GATEWAY_ENV] !== '1') {
      return `${field} is the IP address ${url.hostname}: a certificate cannot tie an address to the gateway you expect (set ${ALLOW_IP_GATEWAY_ENV}=1 if the voucher key really goes there)`;
    }
  }
  return undefined;
}

/**
 * The voucher key of `litellm.json`. Throws `EvalHomeError('missing')` when there is none: get one
 * by redeeming a voucher and writing the file by hand (see tools/eval/README.md). The file is
 * refused when other users can read it (the message has the `chmod`) and when it sends the key
 * somewhere it should not go (see `gatewayProblem`).
 */
export function loadVoucherCredential(
  options: { home?: string; env?: Record<string, string | undefined> } = {},
): VoucherCredential {
  const path = homePaths(options.home).litellm;
  const file = readPrivateJson(path, LitellmFile);
  if (!file) {
    throw new EvalHomeError(
      'missing',
      path,
      `No voucher key: ${shownPath(path)} does not exist. Create it (mode 600) with baseUrl, apiKey and keyServerUrl.`,
    );
  }
  for (const field of ['baseUrl', 'keyServerUrl'] as const) {
    const problem = gatewayProblem(field, file[field], options.env ?? process.env);
    if (problem) throw new EvalHomeError('invalid', path, `${shownPath(path)}: ${problem}`);
  }
  return {
    baseUrl: file.baseUrl.replace(/\/+$/, ''),
    apiKey: file.apiKey,
    keyServerUrl: file.keyServerUrl.replace(/\/+$/, ''),
    ...(file.limitUsd !== undefined ? { limitUsd: file.limitUsd } : {}),
    ...(file.expiresAt !== undefined ? { expiresAt: file.expiresAt } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// codex.json: the Codex login (dev only, see codex-auth.ts)
// ---------------------------------------------------------------------------------------------

export const CodexFile = z.looseObject({
  v: z.literal(1),
  provider: z.literal('openai-codex'),
  loginAt: z.string(),
  updatedAt: z.string(),
  credential: z.looseObject({
    type: z.literal('oauth'),
    access: z.string().min(1),
    refresh: z.string().min(1),
    expires: z.number().finite(),
    accountId: z.string().optional(),
  }),
});
export type CodexFile = z.infer<typeof CodexFile>;

export function readCodexFile(home?: string): CodexFile | undefined {
  return readPrivateJson(homePaths(home).codex, CodexFile);
}

export function writeCodexFile(file: CodexFile, home?: string): void {
  writePrivateJson(homePaths(home).codex, file);
}
