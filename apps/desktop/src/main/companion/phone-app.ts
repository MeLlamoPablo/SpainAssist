import { linkBase } from '@sa/companion';
import type { CompanionPhoneApp } from '@sa/shared';
import { z } from 'zod';
import { type FetchFn, requestJson } from '../remote/http';

/** How long a read of the relay's latest phone app is good for. */
export const PHONE_APP_REFRESH_MS = 6 * 60 * 60 * 1000;
/** After a read that failed (no network, relay down), the next one may come sooner. */
export const PHONE_APP_RETRY_MS = 10 * 60 * 1000;

const Latest = z.object({
  version: z.string().min(1).max(40),
  page: z.url({ protocol: /^https?$/ }),
});

/**
 * The phone app the relay offers outside Google Play (`GET /android/latest.json`,
 * `services/relay-server`). Undefined when it offers none (`{ "store": … }`: the app is on
 * Google Play). Throws when the relay can't be read.
 */
export async function readLatestPhoneApp(
  fetch: FetchFn,
  relayUrl: string,
): Promise<CompanionPhoneApp | undefined> {
  const url = new URL('/android/latest.json', linkBase(relayUrl));
  const latest = Latest.safeParse(await requestJson(fetch, url.href, { timeoutMs: 10_000 }));
  return latest.success ? latest.data : undefined;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): { core: number[]; pre: string[] } | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return { core: [1, 2, 3].map((i) => Number(match[i])), pre: match[4]?.split('.') ?? [] };
}

/** Semver order of two prereleases' identifiers: numbers before words, fewer before more. */
function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i] as string, b[i] as string];
    if (x === y) continue;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Whether phone app `app` is older than `latest`, as semver. False when either doesn't parse. */
export function phoneAppBehind(app: string, latest: string): boolean {
  const [a, b] = [parseVersion(app), parseVersion(latest)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const difference = (a.core[i] as number) - (b.core[i] as number);
    if (difference !== 0) return difference < 0;
  }
  // A prerelease comes before its release.
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length > 0 && b.pre.length === 0;
  return comparePre(a.pre, b.pre) < 0;
}
