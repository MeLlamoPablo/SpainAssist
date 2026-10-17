/**
 * The SSRF guard of fetch_url and run_script (`research/fetch.ts`): which addresses it refuses, in
 * every spelling a URL, a resolver or an attacker can produce. WHATWG URL turns
 * `[::ffff:127.0.0.1]` into `[::ffff:7f00:1]`, so the dotted spelling alone is not enough, and
 * IPv6 has several other ways to carry an IPv4 address (NAT64, 6to4, IPv4-compatible, SIIT).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchDocument,
  fetchPublic,
  type HostResolver,
  isPrivateAddress,
} from '../src/research/fetch';

// The system resolver must never run in this file: any call is a leak.
const system = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: system.lookup }));

beforeEach(() => {
  system.lookup.mockReset();
  system.lookup.mockRejectedValue(new Error('real DNS must not be used'));
});

const PRIVATE_IPV4 = [
  '0.0.0.0',
  '10.1.2.3',
  '100.64.0.1',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.8',
  '192.168.1.1',
  '198.18.0.1',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
];

const PUBLIC_IPV4 = [
  '1.1.1.1',
  '8.8.8.8',
  '81.45.12.3',
  '100.63.255.255',
  '100.128.0.1',
  '172.15.0.1',
  '172.32.0.1',
  '192.0.2.10',
  '198.17.255.255',
  '198.20.0.1',
  '203.0.113.10',
];

/** IPv4 spellings a URL normalises and `getaddrinfo` accepts: all of them are 127.0.0.1. */
const LOOPBACK_SPELLINGS = [
  '2130706433',
  '0x7f000001',
  '0x7F.0.0.1',
  '0177.0.0.1',
  '0177.0.1',
  '127.1',
  '127.0.1',
  '0x7f.1',
  '127.0.0.1.',
  '0177.00.00.01',
];

/** IPv6 spellings of private IPv4 addresses (or of private IPv6 ones), hex forms included. */
const PRIVATE_IPV6 = [
  // loopback, unspecified
  '::1',
  '::',
  '0:0:0:0:0:0:0:1',
  // IPv4-mapped: dotted, hex (what a parsed URL gives), long and mixed-case spellings
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::FFFF:7F00:1',
  '0:0:0:0:0:ffff:7f00:1',
  '0000:0000:0000:0000:0000:ffff:7f00:0001',
  '::ffff:a00:1',
  '::ffff:c0a8:101',
  '::ffff:a9fe:a9fe',
  '::ffff:10.0.0.1',
  '::ffff:0:0',
  // SIIT (RFC 2765): ::ffff:0:a.b.c.d
  '::ffff:0:7f00:1',
  '::ffff:0:10.1.2.3',
  // IPv4-compatible (deprecated): the whole ::/96
  '::7f00:1',
  '::127.0.0.1',
  '::a00:1',
  '::cb00:710a',
  // NAT64 well-known prefix with a private IPv4, and the local-use prefix (RFC 8215)
  '64:ff9b::7f00:1',
  '64:ff9b::127.0.0.1',
  '64:ff9b::a9fe:a9fe',
  '64:ff9b:1::1',
  '64:ff9b:1:2:3:4:5:6',
  // 6to4 of a private IPv4
  '2002:7f00:1::',
  '2002:7f00:1::1',
  '2002:a00:1::',
  '2002:c0a8:101:abcd::1',
  '2002:a9fe:a9fe::',
  // Teredo, discard-only, unique local, link local, site local, multicast
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '100::1',
  'fc00::1',
  'fd12:3456:789a::1',
  'fe80::1',
  'fe80::1%en0',
  'febf::1',
  'fec0::1',
  'ff02::1',
  'ff05::2',
];

const PUBLIC_IPV6 = [
  '2606:4700:4700::1111',
  '2a00:1450:4003:80f::200e',
  // mapped / NAT64 / 6to4 of a public IPv4 is a public address
  '::ffff:cb00:710a',
  '::ffff:203.0.113.10',
  '64:ff9b::cb00:710a',
  '2002:cb00:710a::1',
  '2001:db8::1',
];

describe('isPrivateAddress', () => {
  it.each(PRIVATE_IPV4)('refuses the private IPv4 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(PUBLIC_IPV4)('accepts the public IPv4 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each(LOOPBACK_SPELLINGS)('refuses the IPv4 spelling %s (it is 127.0.0.1)', (spelling) => {
    expect(isPrivateAddress(spelling)).toBe(true);
  });

  it('reads an octal part as octal: 010.0.0.1 is 8.0.0.1', () => {
    expect(isPrivateAddress('010.0.0.1')).toBe(false);
    expect(isPrivateAddress('012.0.0.1')).toBe(true); // 10.0.0.1
  });

  it.each(PRIVATE_IPV6)('refuses the IPv6 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(PUBLIC_IPV6)('accepts the public IPv6 address %s', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it('refuses what is not an address at all (fail closed), brackets included', () => {
    for (const nonsense of [
      '',
      'example.com',
      '1.2.3.4.5',
      '256.1.1.1',
      '::g',
      '1::2::3',
      '[::1]',
    ]) {
      expect(isPrivateAddress(nonsense)).toBe(true);
    }
    expect(isPrivateAddress('[2606:4700:4700::1111]')).toBe(false);
  });
});

describe('the guard on real requests', () => {
  let server: Server;
  let port: number;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '/');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('LOCAL-SECRET-BODY');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  beforeEach(() => {
    hits.length = 0;
  });

  // The URL parser normalises most of these (decimal, hex, octal, short and mapped forms): the guard
  // must see what the parser made of them, and refuse the local service whatever they were.
  const SPELLINGS = [
    `http://127.0.0.1:PORT/a`,
    `http://[::ffff:127.0.0.1]:PORT/b`,
    `http://[::ffff:7f00:1]:PORT/c`,
    `http://[0:0:0:0:0:ffff:7f00:1]:PORT/d`,
    `http://[::FFFF:7F00:1]:PORT/e`,
    `http://[::ffff:0:7f00:1]:PORT/f`,
    `http://[::7f00:1]:PORT/g`,
    `http://[::127.0.0.1]:PORT/h`,
    `http://[64:ff9b::7f00:1]:PORT/i`,
    `http://[64:ff9b::127.0.0.1]:PORT/j`,
    `http://[2002:7f00:1::]:PORT/k`,
    `http://2130706433:PORT/l`,
    `http://0x7f000001:PORT/m`,
    `http://0177.0.0.1:PORT/n`,
    `http://127.1:PORT/o`,
    `http://0x7f.1:PORT/p`,
    `http://127.0.0.1.:PORT/q`,
    `http://localhost.:PORT/r`,
    `http://sede.localhost.:PORT/s`,
    `http://[::1]:PORT/t`,
    `http://[::ffff:a9fe:a9fe]:PORT/u`,
  ];

  it.each(SPELLINGS)('refuses %s before any request is made', async (template) => {
    const url = template.replace('PORT', String(port));
    await expect(fetchDocument(url)).rejects.toMatchObject({ code: 'blocked' });
    expect(hits).toEqual([]);
  });

  it('refuses a POST to a mapped loopback address through fetchPublic (run_script)', async () => {
    const url = new URL(`http://[::ffff:127.0.0.1]:${port}/admin`);
    await expect(
      fetchPublic(url, {
        signal: AbortSignal.timeout(5_000),
        headers: {},
        method: 'POST',
        body: '{"x":1}',
      }),
    ).rejects.toMatchObject({ code: 'blocked' });
    expect(hits).toEqual([]);
  });
});

describe('the resolve step', () => {
  const PUBLIC = [{ address: '203.0.113.10' }];
  const page = '<html><head><title>Sede</title></head><body><main><p>Hola</p></main></body></html>';

  function recorder(resolve: HostResolver) {
    const urls: string[] = [];
    return {
      urls,
      resolveHost: resolve,
      fetchImpl: (async (input: string | URL) => {
        urls.push(String(input));
        return new Response(page, { headers: { 'content-type': 'text/html' } });
      }) as typeof fetch,
    };
  }

  it.each([
    ['a hex IPv4-mapped IPv6 answer', '::ffff:7f00:1'],
    ['a dotted IPv4-mapped IPv6 answer', '::ffff:10.0.0.1'],
    ['a NAT64 answer for a private IPv4', '64:ff9b::a00:1'],
    ['a 6to4 answer for a private IPv4', '2002:c0a8:101::1'],
    ['an IPv4-compatible answer', '::7f00:1'],
    ['an IPv6 answer with a zone id', 'fe80::1%en0'],
    ['a unique local answer', 'fd00::1'],
    ['an IPv4 answer spelled in hex', '0x7f000001'],
    ['an answer that is not an address', 'not-an-address'],
  ])('blocks a name whose resolver answers %s', async (_label, address) => {
    const rec = recorder(async () => [{ address }]);
    await expect(fetchDocument('https://intranet.spain.test/', rec)).rejects.toMatchObject({
      code: 'blocked',
      message: 'Blocked: intranet.spain.test resolves to a private address',
    });
    expect(rec.urls).toEqual([]);
  });

  it('blocks a name when only one of its answers is private, whatever the order', async () => {
    for (const answers of [
      [{ address: '::ffff:7f00:1' }, ...PUBLIC],
      [...PUBLIC, { address: '::ffff:7f00:1' }],
    ]) {
      const rec = recorder(async () => answers);
      await expect(fetchDocument('https://mixed.spain.test/', rec)).rejects.toMatchObject({
        code: 'blocked',
      });
      expect(rec.urls).toEqual([]);
    }
  });

  it('does not let a name with no answers through', async () => {
    const rec = recorder(async () => []);
    await expect(fetchDocument('https://vacio.spain.test/', rec)).rejects.toMatchObject({
      code: 'network',
      message: 'Could not resolve vacio.spain.test',
    });
    expect(rec.urls).toEqual([]);
  });

  it('accepts public IPv4 and IPv6 answers, including the mapped form of a public address', async () => {
    const rec = recorder(async () => [
      ...PUBLIC,
      { address: '2606:4700:4700::1111' },
      { address: '::ffff:cb00:710a' },
    ]);
    const doc = await fetchDocument('https://sede.spain.test/', rec);
    expect(doc.text).toContain('Hola');
    expect(rec.urls).toEqual(['https://sede.spain.test/']);
  });

  it('checks every redirect hop with the same rules: a hop to a mapped loopback never reaches fetchImpl', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input));
      return urls.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: 'http://[::ffff:127.0.0.1]:8790/' },
          })
        : new Response(page, { headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    await expect(
      fetchDocument('https://a.spain.test/', { fetchImpl, resolveHost: async () => PUBLIC }),
    ).rejects.toMatchObject({
      code: 'blocked',
      message: 'Blocked: ::ffff:7f00:1 is a private address',
    });
    expect(urls).toEqual(['https://a.spain.test/']);
  });
});

describe('onBlocked', () => {
  const resolveHost: HostResolver = async (host) =>
    host === 'intranet.spain.test' ? [{ address: '10.0.0.5' }] : [{ address: '203.0.113.10' }];
  const fetchImpl = (async () =>
    new Response('<html><body><main>ok</main></body></html>', {
      headers: { 'content-type': 'text/html' },
    })) as typeof fetch;

  it('is told about each refusal, with the URL, the method and the message', async () => {
    const seen: { url: string; method: string; message: string }[] = [];
    const onBlocked = (info: { url: URL; method: string; message: string }) =>
      seen.push({ url: info.url.href, method: info.method, message: info.message });
    const options = { fetchImpl, resolveHost, onBlocked };
    await expect(fetchDocument('http://[::ffff:7f00:1]:8790/x?q=1', options)).rejects.toThrow();
    await expect(fetchDocument('https://intranet.spain.test/', options)).rejects.toThrow();
    await expect(fetchDocument('http://localhost/', options)).rejects.toThrow();
    await expect(
      fetchPublic(new URL('http://10.0.0.1/p'), {
        signal: AbortSignal.timeout(5_000),
        headers: {},
        method: 'POST',
        onBlocked,
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([
      {
        url: 'http://[::ffff:7f00:1]:8790/x?q=1',
        method: 'GET',
        message: 'Blocked: ::ffff:7f00:1 is a private address',
      },
      {
        url: 'https://intranet.spain.test/',
        method: 'GET',
        message: 'Blocked: intranet.spain.test resolves to a private address',
      },
      { url: 'http://localhost/', method: 'GET', message: 'Blocked: localhost is a local address' },
      {
        url: 'http://10.0.0.1/p',
        method: 'POST',
        message: 'Blocked: 10.0.0.1 is a private address',
      },
    ]);
  });

  it('is not called for a request that passes, nor for a name that does not resolve', async () => {
    const onBlocked = vi.fn();
    await fetchDocument('https://sede.spain.test/', { fetchImpl, resolveHost, onBlocked });
    await expect(
      fetchDocument('https://nada.spain.test/', {
        fetchImpl,
        resolveHost: async () => {
          throw new Error('ENOTFOUND');
        },
        onBlocked,
      }),
    ).rejects.toThrow();
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
