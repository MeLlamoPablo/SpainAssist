/** Requests per key per UTC day and/or UTC week (from Monday), counted together. */
export interface QuotaLimits {
  day?: number;
  week?: number;
}

type Period = keyof QuotaLimits;
const PERIODS: readonly Period[] = ['day', 'week'];
const DAY_MS = 86_400_000;

/** Start of the UTC day or week (Monday 00:00) that contains `ms`. */
function periodStart(period: Period, ms: number): number {
  const day = Math.floor(ms / DAY_MS) * DAY_MS;
  if (period === 'day') return day;
  // 1970-01-01 was a Thursday: shift so that weeks start on Monday.
  const weekday = (new Date(day).getUTCDay() + 6) % 7;
  return day - weekday * DAY_MS;
}

const periodEnd = (period: Period, start: number) =>
  start + (period === 'day' ? DAY_MS : 7 * DAY_MS);

/**
 * Per-key request limits, in memory (a restart resets the counts). A request counts against
 * every window only when all of them allow it.
 */
export class KeyQuota {
  private readonly counts = new Map<
    string,
    Partial<Record<Period, { start: number; n: number }>>
  >();

  constructor(
    readonly limits: QuotaLimits,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request; returns 0 if allowed, else the seconds until it would be allowed. */
  take(key: string): number {
    const now = this.now();
    if (this.counts.size > 100_000) this.prune(now);
    const entry = this.counts.get(key) ?? {};
    let waitMs = 0;
    for (const period of PERIODS) {
      const limit = this.limits[period];
      if (limit === undefined) continue;
      const start = periodStart(period, now);
      const used = entry[period]?.start === start ? entry[period].n : 0;
      if (used >= limit) waitMs = Math.max(waitMs, periodEnd(period, start) - now);
    }
    if (waitMs) return Math.max(1, Math.ceil(waitMs / 1000));
    for (const period of PERIODS) {
      if (this.limits[period] === undefined) continue;
      const start = periodStart(period, now);
      const used = entry[period]?.start === start ? entry[period].n : 0;
      entry[period] = { start, n: used + 1 };
    }
    this.counts.set(key, entry);
    return 0;
  }

  private prune(now: number) {
    for (const [key, entry] of this.counts) {
      const current = PERIODS.some((p) => entry[p]?.start === periodStart(p, now));
      if (!current) this.counts.delete(key);
    }
  }
}
