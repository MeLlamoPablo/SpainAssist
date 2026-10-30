/** File helpers: private permissions, atomic writes, best-effort secure deletion. */
import { randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { VaultError } from './errors';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Temp files are "<target>.tmp-<random>"; leftovers from a crash are removed on open. */
export const TEMP_MARK = '.tmp-';

const isWindows = process.platform === 'win32';

function errnoCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

function ioError(action: string, e: unknown): VaultError {
  return new VaultError('io', `Could not ${action} (${errnoCode(e) ?? String(e)})`, { cause: e });
}

/** Creates `dir` (and parents) and restricts it to the current user. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
    if (!isWindows) await fsp.chmod(dir, DIR_MODE);
  } catch (e) {
    throw ioError(`create the folder ${basename(dir)}`, e);
  }
}

export async function readIfExists(path: string): Promise<Buffer | undefined> {
  try {
    return await fsp.readFile(path);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return undefined;
    throw ioError(`read ${basename(path)}`, e);
  }
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return [];
    throw ioError(`list ${basename(dir)}`, e);
  }
}

/**
 * What a rename, delete or open fails with on Windows while another process holds the file:
 * antivirus, the search indexer, and backup and sync tools open new and changed files for a
 * moment, often without letting others delete them (ERROR_ACCESS_DENIED is EPERM,
 * ERROR_SHARING_VIOLATION EBUSY).
 */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Pauses before each retry: 3.3 s in all. A scanner holds a small file for milliseconds to a few
 * hundred; graceful-fs waits up to a minute, which suits npm, but here a vault commit holds the
 * vault's lock and a settings save holds the UI. A lock that outlasts this isn't a passing one.
 */
const LOCK_RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640, 1000, 1000];

/**
 * Runs a file operation, and on Windows retries it with backoff while it fails because another
 * process holds the file for a moment (see LOCKED). Any other error, a lock that doesn't go away,
 * and every failure on other systems are thrown as they are.
 */
export async function retryWhileLocked<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (e) {
      const delay = LOCK_RETRY_DELAYS_MS[attempt];
      if (process.platform !== 'win32' || delay === undefined || !LOCKED.has(errnoCode(e) ?? ''))
        throw e;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

async function fsyncDir(dir: string): Promise<void> {
  if (isWindows) return; // directories cannot be opened for fsync on Windows
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch {
    // Best effort: some file systems do not support fsync on directories.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Writes `data` to `path` atomically: a private temp file in the same directory is written and
 * fsynced, then renamed over the target (retried while Windows has either locked), then the
 * directory is fsynced. A crash at any point leaves either the old or the new file, never a mix,
 * and a failure leaves no temp file.
 */
export async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}${TEMP_MARK}${randomBytes(6).toString('hex')}`;
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(tmp, 'wx', FILE_MODE);
    if (!isWindows) await handle.chmod(FILE_MODE);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await retryWhileLocked(() => fsp.rename(tmp, path));
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await retryWhileLocked(() => fsp.rm(tmp, { force: true })).catch(() => undefined);
    throw ioError(`save ${basename(path)}`, e);
  }
  await fsyncDir(dirname(path));
}

/**
 * Overwrites a file with random bytes, flushes and unlinks it. Missing files are ignored.
 * On SSDs and copy-on-write file systems (APFS, btrfs) overwriting cannot guarantee the old
 * blocks are gone: the real protection is that every file is encrypted and its key destroyed.
 */
export async function secureDelete(path: string): Promise<void> {
  let handle: fsp.FileHandle | undefined;
  try {
    // Never follow a symlink planted in the vault directory: just unlink it.
    if (!(await fsp.lstat(path)).isFile())
      throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
    handle = await fsp.open(path, 'r+');
    const { size } = await handle.stat();
    const chunk = 1 << 20;
    for (let offset = 0; offset < size; offset += chunk) {
      const length = Math.min(chunk, size - offset);
      await handle.write(randomBytes(length), 0, length, offset);
    }
    await handle.sync();
  } catch (e) {
    if (errnoCode(e) === 'ENOENT') return;
    // Could not overwrite (e.g. read-only): still unlink below.
  } finally {
    await handle?.close().catch(() => undefined);
  }
  try {
    await retryWhileLocked(() => fsp.unlink(path));
  } catch (e) {
    if (errnoCode(e) !== 'ENOENT') throw ioError(`delete ${basename(path)}`, e);
  }
}

export async function removeEmptyDir(dir: string): Promise<void> {
  await fsp.rmdir(dir).catch(() => undefined);
}

/** Serializes async operations (one at a time, in call order). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
