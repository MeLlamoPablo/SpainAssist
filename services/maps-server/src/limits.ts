import { createHash, randomBytes } from 'node:crypto';

/** Fixed-window limiter per client, before any key check. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit; returns 0 if allowed, else the seconds until the window resets. */
  hit(key: string): number {
    if (this.limit <= 0) return 0;
    const now = this.now();
    if (this.windows.size > 50_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    const w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.resetAt - now) / 1000));
    w.count++;
    return 0;
  }
}

const SALT = randomBytes(16);

/** Salted, truncated hash of a client address (the salt changes on every restart). */
export function clientKey(ip: string): string {
  return createHash('sha256').update(SALT).update(ip).digest('base64url').slice(0, 22);
}
