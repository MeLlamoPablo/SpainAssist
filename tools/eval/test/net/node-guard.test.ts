/**
 * The process-level guard of the eval host (src/net/node-guard.ts, installed by
 * `createEgressGuard().install()`): sockets, DNS, UDP and child processes. Everything here runs on
 * loopback: a canary server stands for "somewhere else" and counts what reaches it, and a refusal
 * means it never does.
 */
import { type ChildProcess, exec, execFileSync, execSync, fork, spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { lookup as esmLookup } from 'node:dns/promises';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetRecord } from '../../src/contracts';
import { createEgressGuard } from '../../src/net/egress-guard';
import { NetLog } from '../../src/net/netlog';
import { withCallContext } from '../../src/net/world-fetch';

interface Listener {
  origin: string;
  port: number;
  hits: string[];
  close(): Promise<void>;
}

async function listen(): Promise<Listener> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '/');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('reached');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
}

async function failureOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected a failure');
}

let allowed: Listener;
let canary: Listener;
beforeAll(async () => {
  allowed = await listen();
  canary = await listen();
  return async () => {
    await allowed.close();
    await canary.close();
  };
});

let log: NetLog;
let restore: (() => void) | undefined;
const originals = {
  connect: net.Socket.prototype.connect,
  lookup: dns.lookup,
  resolve4: dns.resolve4,
  spawn,
  send: dgram.Socket.prototype.send,
};

function install(options: { allow?: string[]; sockets?: string[] } = {}) {
  const guard = createEgressGuard({
    allowOrigins: options.allow ?? [allowed.origin],
    socketOrigins: options.sockets ?? [],
    log,
  });
  restore = guard.install();
  return guard;
}

beforeEach(() => {
  allowed.hits.length = 0;
  canary.hits.length = 0;
  log = new NetLog({ worldId: 'w' });
});
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

const denied = (): NetRecord[] => log.tail().filter((r) => r.route === 'denied');

describe('sockets', () => {
  it('lets the allowed origin through and refuses every other port, for http, net and tls', async () => {
    install();
    expect(await get(`${allowed.origin}/ok`)).toBe(200);
    expect(allowed.hits).toEqual(['/ok']);

    const viaHttp = await failureOf(get(`${canary.origin}/via-http`));
    expect(viaHttp.code).toBe('ECONNREFUSED');

    const socket = net.connect(canary.port, '127.0.0.1');
    const viaNet = (await once(socket, 'error')) as [Error & { code?: string }];
    expect(viaNet[0].code).toBe('ECONNREFUSED');

    const viaTls = tls.connect({ host: '127.0.0.1', port: canary.port, rejectUnauthorized: false });
    const tlsError = (await once(viaTls, 'error')) as [Error & { code?: string }];
    expect(tlsError[0].code).toBe('ECONNREFUSED');

    const named = net.connect({ host: 'localhost', port: canary.port });
    expect(((await once(named, 'error')) as [Error & { code?: string }])[0].code).toBe(
      'ECONNREFUSED',
    );

    expect(canary.hits).toEqual([]);
    expect(denied().map((r) => [r.method, r.url, r.host])).toEqual([
      ['CONNECT', `tcp://127.0.0.1:${canary.port}/`, '127.0.0.1'],
      ['CONNECT', `tcp://127.0.0.1:${canary.port}/`, '127.0.0.1'],
      ['CONNECT', `tcp://127.0.0.1:${canary.port}/`, '127.0.0.1'],
      ['CONNECT', `tcp://localhost:${canary.port}/`, 'localhost'],
    ]);
  });

  it('treats the loopback names of an allowed origin as the same place', async () => {
    install();
    for (const host of ['localhost', '127.0.0.1', '::ffff:127.0.0.1']) {
      const socket = net.connect({ host, port: allowed.port });
      await once(socket, 'connect').catch(() => undefined);
      socket.destroy();
    }
    expect(denied()).toEqual([]);
  });

  it('refuses an address as a closed port and a name as an unknown domain, without resolving it', async () => {
    install();
    const address = net.connect(80, '203.0.113.9');
    const refused = (await once(address, 'error')) as [Error & { code?: string; address?: string }];
    expect(refused[0].code).toBe('ECONNREFUSED');
    expect(refused[0].message).toBe('connect ECONNREFUSED 203.0.113.9:80');

    const named = net.connect(443, 'www.boe.es');
    const unknown = (await once(named, 'error')) as [Error & { code?: string; hostname?: string }];
    expect(unknown[0].code).toBe('ENOTFOUND');
    expect(unknown[0].hostname).toBe('www.boe.es');
    // The name was never looked up: refusing the connection came first.
    expect(denied().map((r) => r.method)).toEqual(['CONNECT', 'CONNECT']);
  });

  it('refuses unix sockets and named pipes', async () => {
    install();
    const socket = net.connect('/tmp/spainassist-test.sock');
    await once(socket, 'error');
    expect(denied()[0]).toMatchObject({ method: 'CONNECT', host: '/tmp/spainassist-test.sock' });
    expect(denied()[0]?.url).toBe('unix:/tmp/spainassist-test.sock');
  });

  it('opens sockets to the origins that are only reachable by socket (the mock, the bridge), not by fetch', async () => {
    const guard = install({ sockets: [canary.origin] });
    expect(await get(`${canary.origin}/by-socket`)).toBe(200);
    expect(canary.hits).toEqual(['/by-socket']);
    expect(denied()).toEqual([]);
    // The global fetch still goes to the gateway only.
    const error = await failureOf(guard.fetch(`${canary.origin}/by-fetch`));
    expect(error.message).toBe('fetch failed');
    expect(canary.hits).toEqual(['/by-socket']);
    expect(denied()).toHaveLength(1);
  });

  it('allows an origin added later with allow()', async () => {
    const guard = install({ allow: [] });
    await failureOf(get(`${allowed.origin}/early`));
    guard.allow(allowed.origin);
    expect(await get(`${allowed.origin}/late`)).toBe(200);
    expect(allowed.hits).toEqual(['/late']);
  });

  it('judges a connection by the host and port it was asked for: a hostname origin, any spelling of the call', () => {
    const calls: unknown[][] = [];
    vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
      ...args: unknown[]
    ) {
      calls.push(args);
      return this;
    });
    install({ allow: ['https://chatgpt.com', 'wss://api.example.test:8443'] });
    const open = (...args: unknown[]) => {
      const socket = new net.Socket();
      socket.on('error', () => undefined);
      return (net.Socket.prototype.connect as (...a: unknown[]) => net.Socket).apply(socket, args);
    };
    open({ host: 'chatgpt.com', port: 443 });
    open(443, 'ChatGPT.com');
    open([{ host: 'chatgpt.com', port: '443' }, () => undefined]); // Node's own normalised form
    open({ host: 'api.example.test', port: 8443 });
    expect(calls).toHaveLength(4);
    open({ host: 'chatgpt.com', port: 80 });
    open({ host: 'api.example.test', port: 443 });
    open({ host: 'files.chatgpt.com', port: 443 });
    expect(calls).toHaveLength(4);
    expect(denied().map((r) => r.host)).toEqual([
      'chatgpt.com',
      'api.example.test',
      'files.chatgpt.com',
    ]);
  });

  it('refuses a fetch that was captured before the guard went in (undici opens its sockets through net)', async () => {
    const captured = globalThis.fetch;
    install();
    const error = await failureOf(captured(`${canary.origin}/captured`));
    expect(error.message).toBe('fetch failed');
    expect((error.cause as { code?: string }).code).toBe('ECONNREFUSED');
    expect(canary.hits).toEqual([]);
    expect(denied()).toHaveLength(1);
  });

  it('names the tool call that made the attempt', async () => {
    install();
    await withCallContext({ tool: 'run_script', toolCallId: 'call-3' }, () =>
      failureOf(get(`${canary.origin}/x`)),
    );
    expect(denied()[0]).toMatchObject({ channel: 'run_script', toolCallId: 'call-3' });
  });
});

describe('dns', () => {
  it('resolves loopback, addresses and the hosts of allowed origins, and nothing else', async () => {
    const seen: string[] = [];
    // The real resolver never runs here: a stand-in records what got past the guard.
    dns.lookup = ((hostname: string, ...rest: unknown[]) => {
      seen.push(hostname);
      const callback = rest.at(-1) as (e: null, a: string, f: number) => void;
      callback(null, '127.0.0.1', 4);
    }) as unknown as typeof dns.lookup;
    try {
      install({ allow: ['https://chatgpt.com'] });
      const lookup = (host: string) =>
        new Promise<string>((resolve, reject) =>
          dns.lookup(host, (error, address) => (error ? reject(error) : resolve(address))),
        );
      expect(await lookup('localhost')).toBe('127.0.0.1');
      expect(await lookup('chatgpt.com')).toBe('127.0.0.1');
      expect(await lookup('203.0.113.9')).toBe('127.0.0.1');
      const error = await failureOf(lookup('www.boe.es'));
      expect(error.code).toBe('ENOTFOUND');
      expect(error.message).toBe('getaddrinfo ENOTFOUND www.boe.es');
      expect(seen).toEqual(['localhost', 'chatgpt.com', '203.0.113.9']);
      expect(denied().map((r) => [r.method, r.url, r.host])).toEqual([
        ['DNS', 'dns://www.boe.es/', 'www.boe.es'],
      ]);
    } finally {
      restore?.();
      restore = undefined;
      dns.lookup = originals.lookup;
    }
  });

  it('refuses every way to ask: callbacks, promises, ESM named imports, util.promisify and Resolver', async () => {
    install();
    const refused = (error: Error & { code?: string }) =>
      expect(error.code).toMatch(/ENOTFOUND|ECONNREFUSED/);
    refused(
      await failureOf(
        new Promise((resolve, reject) =>
          dns.lookup('a.example.test', (e, a) => (e ? reject(e) : resolve(a))),
        ),
      ),
    );
    refused(await failureOf(dns.promises.lookup('b.example.test')));
    refused(await failureOf(esmLookup('c.example.test')));
    refused(await failureOf(promisify(dns.lookup)('d.example.test')));
    refused(await failureOf(dns.promises.resolve4('e.example.test')));
    refused(
      await failureOf(
        new Promise((resolve, reject) =>
          dns.resolve4('f.example.test', (e, a) => (e ? reject(e) : resolve(a))),
        ),
      ),
    );
    refused(await failureOf(new dns.promises.Resolver().resolve4('g.example.test')));
    refused(
      await failureOf(
        new Promise((resolve, reject) =>
          new dns.Resolver().resolveTxt('h.example.test', (e, a) => (e ? reject(e) : resolve(a))),
        ),
      ),
    );
    refused(await failureOf(dns.promises.reverse('203.0.113.9')));
    expect(denied().map((r) => r.host)).toEqual([
      'a.example.test',
      'b.example.test',
      'c.example.test',
      'd.example.test',
      'e.example.test',
      'f.example.test',
      'g.example.test',
      'h.example.test',
      '203.0.113.9',
    ]);
  });

  it('keeps the shape of dns.lookup for util.promisify (address and family)', async () => {
    install();
    const found = await promisify(dns.lookup)('localhost');
    expect(found).toEqual({ address: expect.any(String), family: expect.any(Number) });
    expect(denied()).toEqual([]);
  });
});

describe('udp', () => {
  it('sends nothing, even to loopback, and says so through the callback or an error event', async () => {
    const listener = dgram.createSocket('udp4');
    const received: Buffer[] = [];
    listener.on('message', (message) => received.push(message));
    await new Promise<void>((resolve) => listener.bind(0, '127.0.0.1', resolve));
    const { port } = listener.address();
    install();
    const sender = dgram.createSocket('udp4');
    try {
      const error = await new Promise<Error & { code?: string }>((resolve) =>
        sender.send('x', port, '127.0.0.1', (e) => resolve(e as Error & { code?: string })),
      );
      expect(error.code).toBe('EACCES');
      const emitted = new Promise<Error>((resolve) => sender.once('error', resolve));
      sender.send(Buffer.from('y'), port, '127.0.0.1');
      expect((await emitted).message).toContain('EACCES');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toEqual([]);
      expect(denied().map((r) => [r.method, r.host])).toEqual([
        ['UDP', '127.0.0.1'],
        ['UDP', '127.0.0.1'],
      ]);
      expect(denied()[0]?.url).toBe(`udp://127.0.0.1:${port}/`);
    } finally {
      sender.close();
      listener.close();
    }
  });
});

describe('child processes', () => {
  it('refuses network clients, interpreters and command lines that name them, and logs the line', () => {
    install();
    const attempts: (() => unknown)[] = [
      () => spawn('curl', [`${canary.origin}/via-curl`]),
      () => spawn('/usr/bin/curl', ['-s', `${canary.origin}/via-path`]),
      () => spawn('WGET.exe', ['x']),
      () => exec(`curl ${canary.origin}/via-exec`),
      () => execSync(`echo hi; wget ${canary.origin}/via-sync`),
      () => execFileSync('nc', ['127.0.0.1', String(canary.port)]),
      () => spawn('sh', ['-c', `curl ${canary.origin}/via-shell`]),
      () => spawn('bash', ['-lc', `echo $(wget ${canary.origin}/nested)`]),
      () => spawn('env', ['curl', `${canary.origin}/via-env`]),
      () => spawn('xargs', ['wget']),
      () => spawn(process.execPath, ['-e', `fetch("${canary.origin}/via-node")`]),
      () => spawn('python3', ['-c', 'print(1)']),
      () => spawn('curl http://x', { shell: true }),
      () => fork('./child.js'),
    ];
    for (const attempt of attempts) {
      expect(attempt).toThrow(expect.objectContaining({ code: 'EACCES' }));
    }
    expect(canary.hits).toEqual([]);
    expect(denied()).toHaveLength(attempts.length);
    expect(denied().every((r) => r.method === 'SPAWN')).toBe(true);
    // The command line is in the record, so a canary in the arguments is seen by the scan.
    expect(denied()[0]).toMatchObject({
      host: 'curl',
      url: 'spawn://curl/',
      reqBody: `curl ${canary.origin}/via-curl`,
    });
    expect(denied()[2]).toMatchObject({ host: 'WGET.exe', url: 'spawn://WGET.exe/' });
  });

  it('lets ordinary programs run', async () => {
    install();
    const echoed = await new Promise<string>((resolve, reject) => {
      const child: ChildProcess = spawn('echo', ['hola']);
      let text = '';
      child.stdout?.on('data', (chunk) => {
        text += chunk;
      });
      child.on('error', reject);
      child.on('close', () => resolve(text.trim()));
    });
    expect(echoed).toBe('hola');
    expect(execSync('echo ok; true').toString().trim()).toBe('ok');
    expect(denied()).toEqual([]);
  });
});

describe('putting everything back', () => {
  it('leaves the process as it was, and a patch made on top of the guard alone', async () => {
    const before = {
      connect: net.Socket.prototype.connect,
      lookup: dns.lookup,
      promisesLookup: dns.promises.lookup,
      spawn: (await import('node:child_process')).spawn,
      send: dgram.Socket.prototype.send,
      fetch: globalThis.fetch,
    };
    const guard = createEgressGuard({ allowOrigins: [allowed.origin], log });
    const off = guard.install();
    expect(net.Socket.prototype.connect).not.toBe(before.connect);
    expect(dns.lookup).not.toBe(before.lookup);
    expect(dgram.Socket.prototype.send).not.toBe(before.send);
    off();
    expect(net.Socket.prototype.connect).toBe(before.connect);
    expect(dns.lookup).toBe(before.lookup);
    expect(dns.promises.lookup).toBe(before.promisesLookup);
    expect(dgram.Socket.prototype.send).toBe(before.send);
    expect(globalThis.fetch).toBe(before.fetch);
    // Reachable again, and the ESM binding is the real function again.
    expect(await get(`${canary.origin}/after`)).toBe(200);
    expect(canary.hits).toEqual(['/after']);
    expect((await esmLookup('localhost')).address).toBeTruthy();

    // Somebody else's patch on top of ours stays when ours is removed.
    const off2 = guard.install();
    const theirs = vi.fn(function (this: net.Socket) {
      return this;
    });
    const guarded = net.Socket.prototype.connect;
    net.Socket.prototype.connect = theirs as unknown as typeof net.Socket.prototype.connect;
    off2();
    expect(net.Socket.prototype.connect).toBe(theirs);
    net.Socket.prototype.connect = guarded;
    net.Socket.prototype.connect = originals.connect;
  });
});
