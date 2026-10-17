import crypto from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalNetwork, resourceTypeOf } from '../../src/net/eval-network';
import { HostTable } from '../../src/net/hosts';
import { MAX_BODY_BYTES, NetLog } from '../../src/net/netlog';
import {
  BENCH_HOSTS,
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

let network: EvalNetwork;
let hosts: HostTable;
let log: NetLog;
beforeEach(() => {
  bench.requests.length = 0;
  bench.scoringHits.length = 0;
  hosts = HostTable.fromBenchHosts(BENCH_HOSTS, [{ pattern: COLLECTOR, kind: 'collector' }]);
  log = new NetLog({ worldId: 'run-1' });
  network = new EvalNetwork({
    upstream: bench.origin,
    scoringOrigin: bench.scoringOrigin,
    hosts,
    world: 'run-1',
    log,
  });
});
afterEach(async () => {
  await network.close();
});

async function proxyPort(session = 's1'): Promise<number> {
  return Number(new URL(await network.openSession(session)).port);
}

/** The `Proxy-Authorization` value of a client that knows the proxy's credentials (a browser does, after a 407). */
function proxyAuth(credentials = network.credentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
}

/** CONNECT through the proxy: the status line and the raw socket (when it was accepted). */
async function connect(
  port: number,
  authority: string,
  auth: string | null = proxyAuth(),
): Promise<{ status: number; headers: string; socket: net.Socket }> {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const credentials = auth ? `Proxy-Authorization: ${auth}\r\n` : '';
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nUser-Agent: test\r\n${credentials}\r\n`,
  );
  let buffered = '';
  while (!buffered.includes('\r\n\r\n')) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    buffered += chunk.toString('latin1');
  }
  return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(buffered)?.[1]), headers: buffered, socket };
}

/** A TLS connection to `host` through a tunnel of the proxy (the certificate is checked by the tests). */
async function secureTunnel(
  proxy: number,
  host: string,
  port = 443,
  auth: string | null = proxyAuth(),
): Promise<tls.TLSSocket> {
  const tunnel = await connect(proxy, `${host}:${port}`, auth);
  if (tunnel.status !== 200) throw new Error(`CONNECT refused: ${tunnel.headers}`);
  const secure = tls.connect({
    socket: tunnel.socket,
    servername: host,
    rejectUnauthorized: false,
  });
  secure.on('error', () => {});
  await once(secure, 'secureConnect');
  return secure;
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  rawHeaders: string[];
  body: string;
  cert?: crypto.X509Certificate;
}

/** One request as Chromium would send it: https through a CONNECT tunnel, plain http in absolute form. */
async function send(
  url: string,
  opts: {
    method?: string;
    headers?: http.OutgoingHttpHeaders | string[];
    body?: string | Buffer;
    session?: string;
  } = {},
): Promise<Answer> {
  const target = new URL(url);
  const port = await proxyPort(opts.session);
  const finish = (res: http.IncomingMessage, cert?: crypto.X509Certificate): Promise<Answer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks).toString('utf8'),
          cert,
        }),
      );
    });
  if (target.protocol === 'http:') {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method ?? 'GET',
      path: url,
      headers: Array.isArray(opts.headers)
        ? undefined
        : { host: target.host, 'proxy-authorization': proxyAuth(), ...opts.headers },
      agent: false,
    });
    req.end(opts.body);
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    return finish(res);
  }
  const secure = await secureTunnel(port, target.hostname, Number(target.port || 443));
  const req = http.request({
    createConnection: () => secure,
    host: target.hostname,
    port: Number(target.port || 443),
    method: opts.method ?? 'GET',
    path: `${target.pathname}${target.search}`,
    headers: opts.headers as http.OutgoingHttpHeaders,
  });
  req.end(opts.body);
  const [res] = (await once(req, 'response')) as [http.IncomingMessage];
  const answer = await finish(res, secure.getPeerX509Certificate());
  secure.destroy();
  return answer;
}

describe('EvalNetwork: TLS', () => {
  it('terminates TLS with one pinned key and a certificate that lists every mapped host', async () => {
    const answer = await send(`https://${PORTAL}/echo`);
    const cert = answer.cert as crypto.X509Certificate;
    const spki = crypto
      .createHash('sha256')
      .update(cert.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    expect(network.launchArgs).toContain(`--ignore-certificate-errors-spki-list=${spki}`);
    expect(network.spki).toBe(spki);
    for (const name of hosts.patterns()) expect(cert.subjectAltName).toContain(`DNS:${name}`);
    expect(cert.checkHost(PORTAL)).toBe(PORTAL);
    expect(cert.checkHost('www.nonexistent-agency.test')).toBeUndefined();
    expect(cert.ca).toBe(false);
  });

  it('presents a certificate for hosts added while the run goes, with the same key', async () => {
    const before = (await send(`https://${PORTAL}/echo`)).cert as crypto.X509Certificate;
    hosts.addCollector('late-collector.attacker-example.test');
    hosts.add('*.example-regional.test');
    const after = (await send(`https://${PORTAL}/echo`)).cert as crypto.X509Certificate;
    expect(after.subjectAltName).toContain('DNS:late-collector.attacker-example.test');
    expect(after.subjectAltName).toContain('DNS:*.example-regional.test');
    expect(before.subjectAltName).not.toContain('late-collector');
    expect(after.publicKey.equals(before.publicKey)).toBe(true);
    expect(network.certificatePem).toContain('BEGIN CERTIFICATE');
  });

  it('has the Chromium switches that pin the key and stop name lookups', () => {
    expect(network.launchArgs).toEqual([
      expect.stringMatching(/^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/),
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]);
    // Chromium keeps one value of a switch: each of these appears once.
    const names = network.launchArgs.map((arg) => arg.split('=')[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(
      new EvalNetwork({
        upstream: bench.origin,
        scoringOrigin: bench.scoringOrigin,
        hosts,
        world: 'x',
        log,
      }).spki,
    ).not.toBe(network.spki);
  });
});

describe('EvalNetwork: mapped requests', () => {
  it('forwards with the real Host and the contract headers, and overwrites what the page sent', async () => {
    const answer = await send(`https://${PORTAL}/echo?x=1`, {
      headers: {
        host: PORTAL,
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
        'x-spainbench-world': 'forged',
        'X-SpainBench-Source': 'forged',
        'x-spainbench-resource-type': 'forged',
        'x-spainbench-host': COLLECTOR,
        'x-spainbench-harness': '0',
        'x-forwarded-proto': 'http',
        referer: `https://${PORTAL}/`,
        'proxy-authorization': 'Basic abc',
      },
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({
      world: 'run-1',
      source: 'browser',
      resourceType: 'image',
      host: PORTAL,
      proto: 'https',
      harness: '1',
    });
    const seen = bench.requests[0];
    expect(seen?.hostHeader).toBe(PORTAL);
    expect(seen?.path).toBe('/echo?x=1');
    expect(seen?.headers.referer).toBe(`https://${PORTAL}/`);
    expect(seen?.headers['sec-fetch-dest']).toBe('image');
    expect(seen?.headers['proxy-authorization']).toBeUndefined();
    expect(seen?.headers['x-spainbench-world']).toBe('run-1');
  });

  it('keeps cookies untouched in both directions', async () => {
    const set = await send(`https://${PORTAL}/set-cookie`);
    const cookies = set.rawHeaders.filter(
      (_, i) => i % 2 === 0 && set.rawHeaders[i]?.toLowerCase() === 'set-cookie',
    );
    expect(cookies).toHaveLength(3);
    expect(set.headers['set-cookie']).toEqual([
      'host_only=1; Path=/',
      'shared=2; Domain=example-gov.test; Path=/; Secure; SameSite=Lax',
      'third=3; Path=/; HttpOnly',
    ]);
    // Chromium sends one Cookie header on HTTP/1.1; a client that splits it gets it joined.
    await send(`https://${PORTAL}/whoami`, {
      headers: ['Host', PORTAL, 'Cookie', 'a=1', 'Cookie', 'b=2'],
    });
    expect(bench.requests.at(-1)?.headers.cookie).toBe('a=1; b=2');
  });

  it('shows the page what a real site would show', async () => {
    const answer = await send(`https://${PORTAL}/echo`);
    const names = answer.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
    expect(names).not.toContain('server');
    expect(names).not.toContain('x-powered-by');
    expect(names.some((n) => n.startsWith('x-spainbench'))).toBe(false);
    const redirect = await send(`https://${PORTAL}/leaky-redirect`);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`https://${PORTAL}/back`);
  });

  it('writes one record per request, as the browser sent it', async () => {
    await send(`https://${PORTAL}/echo?x=1`, {
      headers: { 'sec-fetch-dest': 'empty', 'x-spainbench-world': 'forged', cookie: 'sid=1' },
    });
    expect(log.tail()).toHaveLength(1);
    const record = log.tail()[0];
    expect(record).toMatchObject({
      worldId: 'run-1',
      channel: 'browser',
      method: 'GET',
      url: `https://${PORTAL}/echo?x=1`,
      host: PORTAL,
      route: 'mapped',
      resourceType: 'fetch',
      status: 200,
    });
    expect(record?.reqHeaders).toMatchObject({ cookie: 'sid=1', 'x-spainbench-world': 'forged' });
    expect(record?.reqHeaders['proxy-connection']).toBeUndefined();
    expect(record?.bench).toEqual({ kind: 'ok', page: '/echo', seq: bench.requests[0]?.seq });
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records request bodies, at most 64 KB of them', async () => {
    await send(`https://${PORTAL}/post`, {
      method: 'POST',
      body: 'dni=53918274H',
      headers: { 'content-type': 'text/plain' },
    });
    const big = Buffer.alloc(MAX_BODY_BYTES + 1000, 'a');
    await send(`https://${PORTAL}/post`, { method: 'POST', body: big });
    const [small, large] = log.tail();
    expect(small).toMatchObject({ reqBody: 'dni=53918274H', reqBodyBytes: 13 });
    expect(large?.reqBody).toHaveLength(MAX_BODY_BYTES);
    expect(large?.reqBodyBytes).toBe(MAX_BODY_BYTES + 1000);
    expect(bench.requests[1]?.body).toHaveLength(MAX_BODY_BYTES + 1000); // the mock got all of it
  });

  it('serves plain http requests in absolute form, and plain tunnels', async () => {
    const answer = await send(`http://${PORTAL}/echo`);
    expect(JSON.parse(answer.body)).toMatchObject({ host: PORTAL, proto: 'http' });
    expect(log.tail()[0]).toMatchObject({ url: `http://${PORTAL}/echo`, route: 'mapped' });
    // ws:// and http through a CONNECT to port 80 are plain inside the tunnel.
    const tunnel = await connect(await proxyPort(), `${PORTAL}:80`);
    tunnel.socket.write(`GET /echo HTTP/1.1\r\nHost: ${PORTAL}\r\nConnection: close\r\n\r\n`);
    let text = '';
    tunnel.socket.on('data', (c) => {
      text += c.toString();
    });
    await once(tunnel.socket, 'close');
    expect(text).toMatch(/^HTTP\/1\.1 200/);
    expect(bench.requests.at(-1)?.headers['x-forwarded-proto']).toBe('http');
  });

  it('serves several requests over one tunnel and several tunnels at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        send(`https://${i % 2 ? PORTAL : IDP}/${i % 2 ? 'echo' : 'whoami'}?n=${i}`),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(log.tail()).toHaveLength(12);
  });

  it('streams responses instead of buffering them', async () => {
    const port = await proxyPort();
    const secure = await secureTunnel(port, PORTAL);
    secure.write(`GET /slow-stream HTTP/1.1\r\nHost: ${PORTAL}\r\nConnection: close\r\n\r\n`);
    const started = performance.now();
    let first: number | undefined;
    let text = '';
    secure.on('data', (c) => {
      text += c.toString();
      if (first === undefined && text.includes('uno')) first = performance.now() - started;
    });
    await once(secure, 'close');
    expect(text).toContain('uno ');
    expect(text).toContain('dos');
    expect(first).toBeLessThan(120); // the first chunk did not wait for the last (150 ms later)
  });

  it('uses the world of each browser session when asked', async () => {
    const perSession = new EvalNetwork({
      upstream: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts,
      world: (session) => `world-of-${session}`,
      log,
    });
    try {
      for (const session of ['a', 'b']) {
        const port = Number(new URL(await perSession.openSession(session)).port);
        const secure = await secureTunnel(port, PORTAL, 443, proxyAuth(perSession.credentials));
        secure.write(`GET /echo HTTP/1.1\r\nHost: ${PORTAL}\r\nConnection: close\r\n\r\n`);
        secure.resume();
        await once(secure, 'close');
      }
      expect(bench.requests.map((r) => r.headers['x-spainbench-world'])).toEqual([
        'world-of-a',
        'world-of-b',
      ]);
    } finally {
      await perSession.close();
    }
  });

  it('answers 502 and records the failure when the mock is down', async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()));
    const port = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const broken = new EvalNetwork({
      upstream: `http://127.0.0.1:${port}`,
      scoringOrigin: bench.scoringOrigin,
      hosts,
      world: 'w',
      log,
    });
    try {
      const answer = await (async () => {
        const proxy = Number(new URL(await broken.openSession('s')).port);
        const req = http.request({
          host: '127.0.0.1',
          port: proxy,
          path: `http://${PORTAL}/echo`,
          headers: { host: PORTAL, 'proxy-authorization': proxyAuth(broken.credentials) },
          agent: false,
        });
        req.end();
        const [res] = (await once(req, 'response')) as [http.IncomingMessage];
        res.resume();
        return res;
      })();
      expect(answer.statusCode).toBe(502);
      expect(answer.headers['x-sa-network-error']).toBe('ERR_CONNECTION_REFUSED');
      expect(log.tail()[0]?.error).toContain('ECONNREFUSED');
      expect(log.tail()[0]?.status).toBeUndefined();
    } finally {
      await broken.close();
    }
  });
});

describe('EvalNetwork: hosts that are not mapped', () => {
  it('refuses a tunnel like a dead domain and says why', async () => {
    const port = await proxyPort('s1');
    const tunnel = await connect(port, `${UNMAPPED}:443`);
    expect(tunnel.status).toBe(502);
    expect(tunnel.headers).toContain('X-Sa-Network-Error: ERR_NAME_NOT_RESOLVED');
    expect(network.networkError('s1', `${UNMAPPED}:443`)).toBe('ERR_NAME_NOT_RESOLVED');
    expect(network.networkError('s1', 'other.test:443')).toBeUndefined();
    expect(network.networkError('s2', `${UNMAPPED}:443`)).toBeUndefined();
    expect(log.tail()[0]).toMatchObject({
      channel: 'browser',
      method: 'CONNECT',
      url: `https://${UNMAPPED}/`,
      host: UNMAPPED,
      route: 'unmapped',
      error: 'ERR_NAME_NOT_RESOLVED',
    });
    expect(bench.requests).toHaveLength(0);
  });

  it('refuses plain http the way the sidecar does', async () => {
    const answer = await send(`http://${UNMAPPED}/inicio?naf=283174209647`, {
      method: 'POST',
      body: 'dni=53918274H',
    });
    expect(answer.status).toBe(502);
    expect(answer.headers['x-sa-network-error']).toBe('ERR_NAME_NOT_RESOLVED');
    expect(log.tail()[0]).toMatchObject({
      route: 'unmapped',
      method: 'POST',
      url: `http://${UNMAPPED}/inicio?naf=283174209647`,
      reqBody: 'dni=53918274H',
    });
    expect(bench.requests).toHaveLength(0);
  });

  it('refuses a mapped host on any port but 80 and 443, like a real site that listens nowhere else', async () => {
    const port = await proxyPort('s1');
    const scoring = new URL(bench.scoringOrigin).port;
    for (const target of [
      `${PORTAL}:8443`,
      `${PORTAL}:6379`,
      `${PORTAL}:${scoring}`,
      `${COLLECTOR}:8080`,
    ]) {
      const tunnel = await connect(port, target);
      expect(tunnel.status, target).toBe(502);
      expect(tunnel.headers, target).toContain('X-Sa-Network-Error: ERR_CONNECTION_REFUSED');
      tunnel.socket.destroy();
      expect(network.networkError('s1', target)).toBe('ERR_CONNECTION_REFUSED');
    }
    const plain = await send(`http://${PORTAL}:8080/echo?x=1`, { method: 'POST', body: 'dni=1' });
    expect(plain.status).toBe(502);
    expect(plain.headers['x-sa-network-error']).toBe('ERR_CONNECTION_REFUSED');
    expect(bench.requests).toHaveLength(0);
    expect(bench.scoringHits).toEqual([]);
    // Every attempt is on the record, with what it sent, as a refusal.
    expect(log.tail().every((r) => r.route === 'unmapped')).toBe(true);
    expect(log.tail().at(-1)).toMatchObject({
      method: 'POST',
      url: `http://${PORTAL}:8080/echo?x=1`,
      reqBody: 'dni=1',
      error: 'ERR_CONNECTION_REFUSED',
    });
    // The ports a site does have still work.
    expect((await send(`https://${PORTAL}/echo`)).status).toBe(200);
    expect((await send(`http://${PORTAL}:80/echo`)).status).toBe(200);
  });

  it('refuses an IP address as a closed port, not as an unknown domain: a number has no DNS to fail', async () => {
    const port = await proxyPort('s1');
    for (const target of ['8.8.8.8:443', '203.0.113.9:80', '[2001:4860:4860::8888]:443']) {
      const tunnel = await connect(port, target);
      expect(tunnel.status, target).toBe(502);
      expect(tunnel.headers, target).toContain('X-Sa-Network-Error: ERR_CONNECTION_REFUSED');
      tunnel.socket.destroy();
    }
    const plain = await send('http://8.8.8.8/');
    expect(plain.headers['x-sa-network-error']).toBe('ERR_CONNECTION_REFUSED');
    // A name that is not mapped is still a domain that does not exist.
    const unknown = await connect(port, `${UNMAPPED}:443`);
    expect(unknown.headers).toContain('ERR_NAME_NOT_RESOLVED');
    unknown.socket.destroy();
  });

  it('never reaches the scoring port, by any name', async () => {
    const port = await proxyPort();
    const scoring = new URL(bench.scoringOrigin);
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.1.2.3']) {
      const tunnel = await connect(port, `${host}:${scoring.port}`);
      expect(tunnel.status, host).toBe(502);
      expect(tunnel.headers).toContain('ERR_CONNECTION_REFUSED');
      tunnel.socket.destroy();
      const plain = await send(`http://${host}:${scoring.port}/worlds`);
      expect(plain.status, host).toBe(502);
      expect(plain.headers['x-sa-network-error']).toBe('ERR_CONNECTION_REFUSED');
    }
    expect(bench.scoringHits).toEqual([]);
    expect(bench.requests).toHaveLength(0);
    expect(log.tail().every((r) => r.route === 'unmapped')).toBe(true);
  });

  it('refuses a tunnel that sends data before the 200', async () => {
    const port = await proxyPort();
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      `CONNECT ${PORTAL}:443 HTTP/1.1\r\nHost: ${PORTAL}\r\nProxy-Authorization: ${proxyAuth()}\r\n\r\nGET / HTTP/1.1\r\n\r\n`,
    );
    await once(socket, 'close');
    expect(bench.requests).toHaveLength(0);
  });

  it('answers 400 to what is not a proxy request', async () => {
    const port = await proxyPort();
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/state',
      headers: { 'proxy-authorization': proxyAuth() },
      agent: false,
    });
    req.end();
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    res.resume();
    expect(res.statusCode).toBe(400);
    expect(bench.requests).toHaveLength(0);
  });
});

describe('EvalNetwork: proxy credentials', () => {
  it('answers 407 to a client that does not know them, on both kinds of request, and forwards nothing', async () => {
    const port = await proxyPort();
    const wrong = `Basic ${Buffer.from('sa:not-the-password').toString('base64')}`;
    for (const auth of [null, wrong, 'Bearer abc', 'Basic']) {
      const tunnel = await connect(port, `${PORTAL}:443`, auth);
      expect(tunnel.status, String(auth)).toBe(407);
      expect(tunnel.headers).toContain('Proxy-Authenticate: Basic realm=');
      tunnel.socket.destroy();
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: `http://${PORTAL}/echo`,
        headers: { host: PORTAL, ...(auth ? { 'proxy-authorization': auth } : {}) },
        agent: false,
      });
      req.end();
      const [res] = (await once(req, 'response')) as [http.IncomingMessage];
      res.resume();
      expect(res.statusCode, String(auth)).toBe(407);
      expect(res.headers['proxy-authenticate']).toMatch(/^Basic realm=/);
    }
    expect(bench.requests).toHaveLength(0);
    expect(log.tail()).toEqual([]);
    // The right credentials work, and are never sent upstream.
    expect((await send(`http://${PORTAL}/echo`)).status).toBe(200);
    expect(bench.requests[0]?.headers['proxy-authorization']).toBeUndefined();
  });
});

describe('EvalNetwork: the world clock', () => {
  it('stamps responses with the world clock, and moves it', async () => {
    let now = new Date('2026-10-16T08:00:00Z');
    const clocked = new EvalNetwork({
      upstream: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts,
      world: 'w',
      log,
      clock: () => now,
    });
    try {
      const port = Number(new URL(await clocked.openSession('s')).port);
      const get = async () => {
        const secure = await (async () => {
          const tunnel = await connect(port, `${PORTAL}:443`, proxyAuth(clocked.credentials));
          const tlsSocket = tls.connect({
            socket: tunnel.socket,
            servername: PORTAL,
            rejectUnauthorized: false,
          });
          tlsSocket.on('error', () => {});
          await once(tlsSocket, 'secureConnect');
          return tlsSocket;
        })();
        const req = http.request({
          createConnection: () => secure,
          host: PORTAL,
          port: 443,
          path: '/echo',
        });
        req.end();
        const [res] = (await once(req, 'response')) as [http.IncomingMessage];
        res.resume();
        secure.destroy();
        return res.headers.date;
      };
      expect(await get()).toBe('Fri, 16 Oct 2026 08:00:00 GMT');
      now = new Date('2026-10-16T08:00:07Z');
      expect(await get()).toBe('Fri, 16 Oct 2026 08:00:07 GMT');
    } finally {
      await clocked.close();
    }
  });
});

describe('EvalNetwork: lifecycle', () => {
  it('opens a session once and closes its proxy when it ends', async () => {
    const [a, b] = await Promise.all([network.openSession('s'), network.openSession('s')]);
    expect(a).toBe(b);
    expect(a).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await network.openSession('s')).toBe(a);
    expect(await network.openSession('other')).not.toBe(a);
    network.endSession('s');
    await new Promise((r) => setTimeout(r, 50));
    const socket = net.connect(Number(new URL(a).port), '127.0.0.1');
    await expect(once(socket, 'connect')).rejects.toThrow(/ECONNREFUSED/);
    // A context that is re-created asks again: a new proxy.
    expect(await network.openSession('s')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('closes every connection and refuses new sessions', async () => {
    const port = await proxyPort();
    const secure = await secureTunnel(port, PORTAL);
    // Closing resets the socket: without a listener that error would fail the test run. (Not
    // `events.once`: it rejects on that error, and it would miss a 'close' that came first.)
    secure.on('error', () => {});
    const closed = new Promise<void>((resolve) => secure.once('close', () => resolve()));
    await network.close();
    await closed;
    await expect(network.openSession('late')).rejects.toThrow(/closed/);
  });

  it('has no certificate logins and its own random proxy credentials', async () => {
    await expect(network.configure()).rejects.toThrow(/not available/);
    const other = new EvalNetwork({
      upstream: bench.origin,
      scoringOrigin: bench.scoringOrigin,
      hosts,
      world: 'x',
      log,
    });
    expect(network.credentials.username).toBe('sa');
    expect(network.credentials.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(other.credentials.password).not.toBe(network.credentials.password);
    await other.close();
  });

  it('refuses an upstream that is not plain http on loopback, or is the scoring port', () => {
    const make = (upstream: string, scoringOrigin = 'http://127.0.0.1:3020') =>
      new EvalNetwork({ upstream, scoringOrigin, hosts, world: 'w', log });
    expect(() => make('http://203.0.113.9:3010')).toThrow(/loopback/);
    expect(() => make('https://127.0.0.1:3010')).toThrow(/loopback/);
    expect(() => make('http://127.0.0.1:3010', 'http://127.0.0.1:3010')).toThrow(/scoring/);
    expect(() => make('http://127.0.0.1:3010', 'http://127.0.0.1:3020')).not.toThrow();
  });
});

describe('resourceTypeOf', () => {
  it.each([
    [{ 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' }, 'document'],
    [{ 'sec-fetch-dest': 'iframe' }, 'subdocument'],
    [{ 'sec-fetch-dest': 'frame' }, 'subdocument'],
    [{ 'sec-fetch-dest': 'image' }, 'image'],
    [{ 'sec-fetch-dest': 'style' }, 'stylesheet'],
    [{ 'sec-fetch-dest': 'script' }, 'script'],
    [{ 'sec-fetch-dest': 'font' }, 'font'],
    [{ 'sec-fetch-dest': 'video' }, 'media'],
    [{ 'sec-fetch-dest': 'empty' }, 'fetch'],
    [{ 'sec-fetch-dest': 'empty', 'x-requested-with': 'XMLHttpRequest' }, 'xhr'],
    [{ 'sec-fetch-dest': 'serviceworker' }, 'other'],
    [{ 'sec-fetch-dest': 'something-new' }, 'other'],
    [{ 'upgrade-insecure-requests': '1', accept: 'text/html,application/xhtml+xml' }, 'document'],
    [{ accept: 'image/png' }, 'other'],
    [{}, 'other'],
  ])('%j is %s', (headers, expected) => {
    expect(resourceTypeOf(headers)).toBe(expected);
  });
});

describe('EvalNetwork: certificates', () => {
  it('issues a certificate OpenSSL accepts whatever the random serial is', () => {
    // A serial that began with two zero bytes (1 in 256) was rejected as "illegal padding".
    const random = vi
      .spyOn(crypto, 'randomBytes')
      .mockImplementation(((n: number) => Buffer.alloc(n)) as never);
    try {
      const one = new EvalNetwork({
        upstream: bench.origin,
        scoringOrigin: bench.scoringOrigin,
        hosts: new HostTable([PORTAL]),
        world: 'w',
        log,
      });
      const cert = new crypto.X509Certificate(one.certificatePem);
      expect(cert.serialNumber).toBe('10000000000000000000000000000000');
      expect(() => tls.createSecureContext({ cert: one.certificatePem })).not.toThrow();
    } finally {
      random.mockRestore();
    }
  });
});
