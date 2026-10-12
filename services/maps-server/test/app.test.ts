import { createKeyChecker } from '@sa/gateway-keys';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';

const KEY = 'sk-user-key-1234567890';
const MAPBOX = { features: [{ properties: { feature_type: 'address' } }] };

/** Fake LiteLLM (/key/info) and Mapbox, answering by host. */
function upstream(keyInfo: { status: number; info?: Record<string, unknown> }) {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'litellm.test')
      return new Response(JSON.stringify({ info: keyInfo.info ?? {} }), { status: keyInfo.status });
    return new Response(JSON.stringify(MAPBOX));
  });
}

function setup(
  keyInfo: { status: number; info?: Record<string, unknown> } = {
    status: 200,
    info: { spend: 1, max_budget: 5 },
  },
  extra: Partial<Parameters<typeof createApp>[0]> = {},
) {
  let time = Date.parse('2026-10-10T12:00:00Z');
  const now = () => time;
  const fetchImpl = upstream(keyInfo);
  const lines: string[] = [];
  const app = createApp({
    mapboxToken: 'sk.mapbox-secret',
    checkKey: createKeyChecker({ litellmUrl: 'https://litellm.test', fetch: fetchImpl, now }),
    fetch: fetchImpl,
    now,
    clientIp: () => '203.0.113.7',
    log: (line) => lines.push(line),
    ...extra,
  });
  const get = (q = 'Calle Feria 1, Sevilla', key: string | undefined = KEY) =>
    app.request(`/v1/geocode?q=${encodeURIComponent(q)}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
  const calls = (host: string) =>
    fetchImpl.mock.calls.filter(([input]) => new URL(String(input)).hostname === host);
  return { app, get, calls, lines, advance: (ms: number) => (time += ms) };
}

describe('maps server', () => {
  it('passes an address lookup through to Mapbox with fixed parameters', async () => {
    const { get, calls, lines } = setup();
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MAPBOX);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const [[input, init]] = calls('api.mapbox.com');
    const url = new URL(String(input));
    expect(url.pathname).toBe('/search/geocode/v6/forward');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'Calle Feria 1, Sevilla',
      country: 'es',
      language: 'es',
      types: 'address,street',
      autocomplete: 'false',
      limit: '5',
      access_token: 'sk.mapbox-secret',
    });
    expect(init?.redirect).toBe('error');
    // The user's key goes to LiteLLM as its own credential, never to Mapbox.
    const [[, keyInit]] = calls('litellm.test');
    expect(new Headers(keyInit?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
    // Queries are personal addresses: the access log has the path only.
    expect(lines.join('\n')).not.toContain('Feria');
  });

  it('needs a valid gateway key with credit left', async () => {
    expect((await setup().get(undefined, '')).status).toBe(401);
    expect((await setup().get(undefined, 'not-a-key')).status).toBe(401);
    expect((await setup({ status: 401 }).get()).status).toBe(401);
    expect((await setup({ status: 200, info: { blocked: true } }).get()).status).toBe(401);
    expect((await setup({ status: 200, info: { status: 'revoked' } }).get()).status).toBe(401);
    const expired = setup({ status: 200, info: { expires: '2026-01-01T00:00:00Z' } });
    expect((await expired.get()).status).toBe(401);
    const spent = setup({ status: 200, info: { spend: 5, max_budget: 5 } });
    const res = await spent.get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: 'no_credit', message: expect.any(String) } });
    expect(spent.calls('api.mapbox.com')).toHaveLength(0);
    // Keys without a cap (e.g. capped by windows or a team) are accepted.
    expect((await setup({ status: 200, info: { spend: 9 } }).get()).status).toBe(200);
  });

  it('reuses a key check for a few minutes', async () => {
    const { get, calls, advance } = setup();
    await get();
    await get();
    expect(calls('litellm.test')).toHaveLength(1);
    advance(6 * 60_000);
    await get();
    expect(calls('litellm.test')).toHaveLength(2);
  });

  it('limits each key per UTC day and each address per minute', async () => {
    const { get, advance } = setup(undefined, { dailyLimit: 2 });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe(String(12 * 3600));
    expect(await over.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
    advance(12 * 3600 * 1000);
    expect((await get()).status).toBe(200);

    const busy = setup(undefined, { perIpPerMinute: 1 });
    expect((await busy.get()).status).toBe(200);
    expect((await busy.get()).status).toBe(429);
  });

  it('limits each key per UTC week from Monday', async () => {
    // Saturday noon UTC: the week ends 36 hours later.
    const { get, advance } = setup(undefined, { dailyLimit: 2, weeklyLimit: 3 });
    expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(200);
    advance(12 * 3600 * 1000);
    expect((await get()).status).toBe(200);
    const over = await get();
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe(String(24 * 3600));
    advance(24 * 3600 * 1000);
    expect((await get()).status).toBe(200);
  });

  it('never exposes the address or token when a service fails', async () => {
    const down = setup({ status: 500 });
    expect((await down.get()).status).toBe(503);
    const failing = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (new URL(String(input)).hostname === 'litellm.test')
        return new Response(JSON.stringify({ info: {} }));
      throw new Error(`fetch failed: ${String(input)}`);
    });
    const app = createApp({
      mapboxToken: 'sk.mapbox-secret',
      checkKey: createKeyChecker({ litellmUrl: 'https://litellm.test', fetch: failing }),
      fetch: failing,
      clientIp: () => '203.0.113.7',
    });
    const res = await app.request('/v1/geocode?q=Calle%20Feria%201', {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain('mapbox-secret');
    expect(text).not.toContain('Feria');
  });

  it('rejects empty or long queries', async () => {
    const { get } = setup();
    expect((await get(' ')).status).toBe(400);
    expect((await get('x'.repeat(501))).status).toBe(400);
  });
});

describe('maps server config', () => {
  it('needs the Mapbox token and the LiteLLM URL', () => {
    expect(() => loadConfig({ LITELLM_URL: 'https://llm.test' })).toThrow('MAPBOX_TOKEN');
    expect(() => loadConfig({ MAPBOX_TOKEN: 'sk.x' })).toThrow('LITELLM_URL');
    expect(loadConfig({ MAPBOX_TOKEN: 'sk.x', LITELLM_URL: 'http://litellm:4000/' })).toMatchObject(
      {
        port: 8793,
        litellmUrl: 'http://litellm:4000',
        dailyLimit: 250,
        weeklyLimit: 500,
        trustProxy: false,
      },
    );
  });
});
