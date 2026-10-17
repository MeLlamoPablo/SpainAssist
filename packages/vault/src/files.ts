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
 * fsynced, then renamed over the target, then the directory is fsynced. A crash at any point
 * leaves either the old or the new file, never a mix.
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
    await fsp.rename(tmp, path);
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
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
    await fsp.unlink(path);
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
