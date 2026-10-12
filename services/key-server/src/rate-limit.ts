export interface BucketSettings {
  /** Burst size: requests allowed back to back. */
  capacity: number;
  /** Tokens added per second (sustained rate). */
  refillPerSecond: number;
}

export interface RateLimitSettings {
  redeem: BucketSettings;
  chatgptKeys: BucketSettings;
}

export const DEFAULT_RATE_LIMITS: RateLimitSettings = {
  // A person redeems once; this leaves room for typos. Codes have only 30 bits, so the slow
  // refill (one try per 5 minutes, ~300 a day per network) is what keeps guessing impractical.
  redeem: { capacity: 10, refillPerSecond: 1 / 300 },
  // A device fetches its key once after sign-in; ID-token checks are the real gate.
  chatgptKeys: { capacity: 10, refillPerSecond: 1 / 60 },
};

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/** In-memory token bucket per key (e.g. per client network). Single-process only. */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly settings: BucketSettings,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  take(key: string): TakeResult {
    const now = this.now();
    const { capacity, refillPerSecond } = this.settings;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSecond);
    bucket.updatedAt = now;
    if (!this.buckets.has(key)) {
      if (this.buckets.size >= this.maxKeys) this.sweep(now);
      this.buckets.set(key, bucket);
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSecond));
    return { ok: false, retryAfterSeconds };
  }

  /**
   * Drops buckets that have refilled completely (they carry no information). If the map is
   * still full (many active clients, likely a flood), evicts the oldest entries (Map iteration
   * follows insertion order) instead of growing without bound.
   */
  private sweep(now: number): void {
    const { capacity, refillPerSecond } = this.settings;
    for (const [key, b] of this.buckets) {
      if (b.tokens + ((now - b.updatedAt) / 1000) * refillPerSecond >= capacity) {
        this.buckets.delete(key);
      }
    }
    const target = Math.floor(this.maxKeys * 0.9);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
