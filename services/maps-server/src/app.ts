import { getConnInfo } from '@hono/node-server/conninfo';
import {
  bearerKey,
  type KeyChecker,
  KeyCheckUnavailableError,
  KeyQuota,
  keyId,
} from '@sa/gateway-keys';
import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { clientKey, RateLimiter } from './limits';

export interface AppDeps {
  /** Mapbox token: only sent to Mapbox, never logged or returned. */
  mapboxToken: string;
  checkKey: KeyChecker;
  /** Geocoding requests per user key per UTC day (default 250). */
  dailyLimit?: number;
  /** Geocoding requests per user key per UTC week, from Monday (default 500). */
  weeklyLimit?: number;
  /** Requests per client IP per minute (default 60; 0 disables). */
  perIpPerMinute?: number;
  /** Trust X-Forwarded-For / X-Real-IP (only behind your own reverse proxy). */
  trustProxy?: boolean;
  /** Overrides how the client address is found (tests). */
  clientIp?: (c: Context) => string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  /** Access log sink: method, path, status and duration only (never the query). */
  log?: (line: string) => void;
}

const MAPBOX_GEOCODE = 'https://api.mapbox.com/search/geocode/v6/forward';
const Query = z.object({ q: z.string().trim().min(1).max(500) });

/**
 * Proxies address lookups to Mapbox for the desktop app, so no Mapbox token ships in the app.
 * Callers prove they are users with their LiteLLM gateway key, which must be active and have
 * credit; each key gets a daily and a weekly quota. Results are passed straight through:
 * Mapbox temporary geocodes may not be cached or stored, and queries (personal addresses) are
 * never logged.
 */
export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? ((...args) => fetch(...args));
  const quota = new KeyQuota({ day: deps.dailyLimit ?? 250, week: deps.weeklyLimit ?? 500 }, now);
  const perIp = new RateLimiter(deps.perIpPerMinute ?? 60, 60_000, now);

  const clientAddress = (c: Context): string | undefined => {
    if (deps.clientIp) return deps.clientIp(c);
    if (deps.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
      const real = c.req.header('x-real-ip')?.trim();
      if (real) return real;
    }
    try {
      return getConnInfo(c).remote.address;
    } catch {
      return undefined;
    }
  };

  const app = new Hono();
  if (deps.log) {
    const log = deps.log;
    app.use(async (c, next) => {
      const start = performance.now();
      await next();
      log(
        `${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - start)}ms`,
      );
    });
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.get('/v1/geocode', async (c) => {
    c.header('Cache-Control', 'no-store');
    const ipWait = perIp.hit(clientKey(clientAddress(c) ?? 'unknown'));
    if (ipWait) return fail(c, 429, 'rate_limited', 'Too many requests.', ipWait);
    const key = bearerKey(c.req.header('authorization'));
    if (!key) return fail(c, 401, 'unauthorized', 'A gateway key is required.');
    const query = Query.safeParse(c.req.query());
    if (!query.success) return fail(c, 400, 'bad_request', 'q must be 1 to 500 characters.');

    let status: Awaited<ReturnType<KeyChecker>>;
    try {
      status = await deps.checkKey(key);
    } catch (err) {
      if (err instanceof KeyCheckUnavailableError)
        return fail(c, 503, 'unavailable', 'Try again later.');
      throw err;
    }
    if (status === 'invalid') return fail(c, 401, 'unauthorized', 'The key is not valid.');
    if (status === 'no_credit') return fail(c, 403, 'no_credit', 'The key has no credit left.');
    const wait = quota.take(keyId(key));
    if (wait) return fail(c, 429, 'quota_exceeded', 'Map lookups used up.', wait);

    const url = new URL(MAPBOX_GEOCODE);
    url.searchParams.set('q', query.data.q);
    url.searchParams.set('country', 'es');
    url.searchParams.set('language', 'es');
    url.searchParams.set('types', 'address,street');
    url.searchParams.set('autocomplete', 'false');
    url.searchParams.set('limit', '5');
    url.searchParams.set('access_token', deps.mapboxToken);
    let upstream: Response;
    try {
      upstream = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
    } catch {
      // Fetch errors can include the URL: the address and the token.
      return fail(c, 502, 'upstream', 'Map lookup unavailable.');
    }
    if (!upstream.ok) return fail(c, 502, 'upstream', 'Map lookup unavailable.');
    const body = await upstream.json().catch(() => undefined);
    if (!body || typeof body !== 'object')
      return fail(c, 502, 'upstream', 'Map lookup unavailable.');
    return c.json(body);
  });

  app.notFound((c) => fail(c, 404, 'not_found', 'Not found.'));
  app.onError((_err, c) => fail(c, 500, 'internal', 'Internal error.'));
  return app;
}

function fail(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
  retryAfterSeconds?: number,
) {
  if (retryAfterSeconds) c.header('Retry-After', String(retryAfterSeconds));
  return c.json({ error: { code, message } }, status);
}
