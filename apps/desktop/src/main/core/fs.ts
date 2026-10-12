import { randomBytes } from 'node:crypto';
import {
  chmod,
  type FileHandle,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { extname, join } from 'node:path';

/** Creates a directory only the current user can access (0700). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700).catch(() => {});
}

/** Atomic write: temp file in the same directory + rename. Files are 0600. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, { mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Writes a new file in `dir` (e.g. the user's Downloads) without overwriting anything: while
 * `name` is taken it tries "name (1).ext", "name (2).ext"... Exclusive creation never follows a
 * symlink. A failed write removes the incomplete file. Returns the file name used.
 */
export async function writeNewFile(
  dir: string,
  name: string,
  write: (file: FileHandle) => Promise<void>,
): Promise<string> {
  const ext = extname(name);
  const base = name.slice(0, name.length - ext.length);
  await mkdir(dir, { recursive: true });
  for (let suffix = 0; ; suffix++) {
    const candidate = suffix === 0 ? name : `${base} (${suffix})${ext}`;
    const path = join(dir, candidate);
    const file = await open(path, 'wx', 0o600).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    });
    if (!file) continue;
    try {
      await write(file);
      await file.sync();
    } catch (err) {
      await file.close();
      await rm(path, { force: true });
      throw err;
    }
    await file.close();
    return candidate;
  }
}

/** Reads and parses a JSON file; undefined when it does not exist. Throws on invalid JSON. */
export async function readJsonFile(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(raw) as unknown;
}

interface PendingWrite {
  timer?: ReturnType<typeof setTimeout>;
  write?: () => Promise<void>;
  running?: Promise<void>;
}

/**
 * Coalesces frequent writes per key (e.g. a transcript receiving streaming deltas): only the
 * latest write function runs, at most once per `delayMs`, never concurrently for the same key.
 */
export class DebouncedWriter {
  private readonly pending = new Map<string, PendingWrite>();

  constructor(
    private readonly delayMs: number,
    private readonly onError: (key: string, err: unknown) => void = () => {},
  ) {}

  schedule(key: string, write: () => Promise<void>): void {
    const entry = this.pending.get(key) ?? {};
    entry.write = write;
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        void this.run(key);
      }, this.delayMs);
      entry.timer.unref?.();
    }
    this.pending.set(key, entry);
  }

  private async run(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.running) await entry.running.catch(() => {});
    const write = entry.write;
    entry.write = undefined;
    if (!write) return;
    entry.running = write()
      .catch((err) => this.onError(key, err))
      .finally(() => {
        entry.running = undefined;
        if (!entry.write && !entry.timer) this.pending.delete(key);
      });
    await entry.running;
  }

  /** Runs pending writes now (all keys, or the keys starting with `prefix`). */
  async flush(prefix?: string): Promise<void> {
    const keys = [...this.pending.keys()].filter((k) => !prefix || k.startsWith(prefix));
    await Promise.all(
      keys.map(async (key) => {
        const entry = this.pending.get(key);
        if (!entry) return;
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
        await this.run(key);
        await entry.running?.catch(() => {});
      }),
    );
  }

  /** Drops pending writes (e.g. the procedure was deleted). Waits for in-flight ones. */
  async cancel(prefix: string): Promise<void> {
    const running: Promise<void>[] = [];
    for (const [key, entry] of this.pending) {
      if (!key.startsWith(prefix)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.write = undefined;
      if (entry.running) running.push(entry.running.catch(() => {}));
      this.pending.delete(key);
    }
    await Promise.all(running);
  }
}
