import { randomBytes } from 'node:crypto';

/** Random id with a prefix, e.g. "p_3f2a9c0d1e4b5a6f". Safe for file names. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export type IdFactory = (prefix: string) => string;

/** Ids created by `newId` (used to validate ids that become paths). */
const SAFE_ID = /^[a-z]{1,8}_[a-f0-9]{16}$/;

export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

/** Serializes async operations (one at a time, FIFO). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** Per-key serial queues. */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/** Resolves with the promise's value, or rejects after `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message = 'Timed out'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Host of a URL, or the input when it is not a URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** First line of a message, trimmed to `max` characters (placeholder procedure titles). */
export function titleFromMessage(message: string, max = 60): string {
  const line =
    message
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const clean = line.replace(/\s+/g, ' ');
  if (clean.length === 0) return 'Nuevo trámite';
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
