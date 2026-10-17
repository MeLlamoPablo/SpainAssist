/**
 * The SSRF guard's DNS is injectable (`resolveHost`): with a stand-in resolver and a stand-in
 * `fetchImpl` nothing reaches the network, the guard still blocks what it blocks in production
 * (IP literals, localhost, private answers) with the same messages, and every other hostname
 * reaches `fetchImpl` with its real URL.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDocument, type HostResolver } from '../src/research/fetch';
import { fetchUrlTool } from '../src/tools/fetch-url';
import { runScript, runScriptTool } from '../src/tools/run-script';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { textOf, toolHarness } from './helpers/tools';

// The system resolver must never run when a stand-in is given: any call is a leak.
const system = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: system.lookup }));

const PUBLIC = [{ address: '203.0.113.10' }];
const page = `<html><head><title>Sede</title></head><body><main><h1>Trámite</h1><p>Contenido de la sede.</p></main></body></html>`;

function html(body = page, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers },
  });
}

interface Recorder {
  urls: string[];
  resolved: string[];
  fetchImpl: typeof fetch;
  resolveHost: HostResolver;
}

function recorder(
  answer: (url: URL) => Response | Promise<Response> = () => html(),
  resolve: HostResolver = async () => PUBLIC,
): Recorder {
  const urls: string[] = [];
  const resolved: string[] = [];
  return {
    urls,
    resolved,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
      urls.push(url.href);
      return answer(url);
    }) as typeof fetch,
    resolveHost: async (hostname) => {
      resolved.push(hostname);
      return resolve(hostname);
    },
  };
}

beforeEach(() => {
  system.lookup.mockReset();
  system.lookup.mockRejectedValue(new Error('real DNS must not be used'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveHost in the fetch guard', () => {
  it('resolves hostnames only through the resolver and passes the real URL to fetchImpl', async () => {
    const rec = recorder();
    const doc = await fetchDocument('https://Sede.Spain.test/tramite?id=7', rec);
    expect(doc.text).toContain('Contenido de la sede.');
    expect(doc.url).toBe('https://sede.spain.test/tramite?id=7');
    expect(rec.urls).toEqual(['https://sede.spain.test/tramite?id=7']);
    // Lower-cased, as the guard normalises hosts.
    expect(rec.resolved).toEqual(['sede.spain.test']);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('blocks IP literals and local names with the production messages, before any resolver or fetch', async () => {
    const rec = recorder();
    const blocked: [string, string][] = [
      ['http://localhost:8790/x', 'Blocked: localhost is a local address'],
      ['http://sede.localhost/x', 'Blocked: sede.localhost is a local address'],
      ['http://impresora.local/x', 'Blocked: impresora.local is a local address'],
      ['http://wiki.internal/x', 'Blocked: wiki.internal is a local address'],
      ['http://127.0.0.1/x', 'Blocked: 127.0.0.1 is a private address'],
      ['http://10.0.0.5:8080/x', 'Blocked: 10.0.0.5 is a private address'],
      ['http://169.254.169.254/latest', 'Blocked: 169.254.169.254 is a private address'],
      ['http://[::1]/x', 'Blocked: ::1 is a private address'],
    ];
    for (const [url, message] of blocked) {
      await expect(fetchDocument(url, rec)).rejects.toMatchObject({ code: 'blocked', message });
    }
    expect(rec.resolved).toEqual([]);
    expect(rec.urls).toEqual([]);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('keeps the other guard messages (scheme, credentials in the URL)', async () => {
    const rec = recorder();
    await expect(fetchDocument('ftp://x.es/a', rec)).rejects.toThrow(
      'Only http(s) URLs are supported: ftp://x.es/a',
    );
    await expect(fetchDocument('http://user:pw@a.es/', rec)).rejects.toThrow(
      'URLs with embedded credentials are not allowed',
    );
    expect(rec.urls).toEqual([]);
  });

  it('blocks a name the resolver answers with a private address', async () => {
    const rec = recorder(undefined, async (host) =>
      host === 'intranet.spain.test' ? [{ address: '10.0.0.5' }] : PUBLIC,
    );
    await expect(fetchDocument('https://intranet.spain.test/', rec)).rejects.toThrow(
      'Blocked: intranet.spain.test resolves to a private address',
    );
    // One private answer among public ones is enough to block it.
    const mixed = recorder(undefined, async () => [...PUBLIC, { address: '192.168.1.9' }]);
    await expect(fetchDocument('https://mixed.spain.test/', mixed)).rejects.toThrow(
      'Blocked: mixed.spain.test resolves to a private address',
    );
    expect(rec.urls).toEqual([]);
    expect(mixed.urls).toEqual([]);
  });

  it('reports a name the resolver cannot resolve like the system resolver does', async () => {
    const rec = recorder(undefined, async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(fetchDocument('https://nada.spain.test/', rec)).rejects.toMatchObject({
      code: 'network',
      message: 'Could not resolve nada.spain.test',
    });
    expect(rec.urls).toEqual([]);
  });

  it('checks every redirect hop again: a hop to a private address never reaches fetchImpl', async () => {
    const rec = recorder((url) => {
      if (url.hostname === 'a.spain.test') {
        return new Response(null, { status: 302, headers: { location: 'https://b.spain.test/x' } });
      }
      if (url.hostname === 'b.spain.test') {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8790/' } });
      }
      return html();
    });
    await expect(fetchDocument('https://a.spain.test/', rec)).rejects.toThrow(
      'Blocked: 127.0.0.1 is a private address',
    );
    expect(rec.urls).toEqual(['https://a.spain.test/', 'https://b.spain.test/x']);
    expect(rec.resolved).toEqual(['a.spain.test', 'b.spain.test']);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('falls back to the system resolver without a stand-in, with the production lookup options', async () => {
    system.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const urls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      urls.push(String(input));
      return html();
    }) as typeof fetch;
    await fetchDocument('https://sede.spain.test/', { fetchImpl });
    expect(system.lookup).toHaveBeenCalledWith('sede.spain.test', { all: true, verbatim: true });
    expect(urls).toEqual(['https://sede.spain.test/']);
    // And the system resolver's private answers still block.
    system.lookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
    await expect(fetchDocument('https://otra.spain.test/', { fetchImpl })).rejects.toThrow(
      'Blocked: otra.spain.test resolves to a private address',
    );
  });

  it('lets allowPrivateHosts skip the guard, and with it the resolver', async () => {
    const rec = recorder();
    await fetchDocument('http://localhost:8790/', { ...rec, allowPrivateHosts: true });
    expect(rec.urls).toEqual(['http://localhost:8790/']);
    expect(rec.resolved).toEqual([]);
  });
});

describe('resolveHost in the tools', () => {
  it('fetch_url reads a page through the stand-in and shows the production guard messages', async () => {
    const rec = recorder();
    const tool = fetchUrlTool({ fetchImpl: rec.fetchImpl, resolveHost: rec.resolveHost });
    const ok = await tool.execute(
      'c1',
      { url: 'https://sede.spain.test/a' },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(ok)).toContain('URL: https://sede.spain.test/a');
    expect(textOf(ok)).toContain('Contenido de la sede.');
    const blocked = await tool.execute(
      'c2',
      { url: 'http://127.0.0.1/x' },
      undefined,
      undefined,
      {} as never,
    );
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toBe(
      'Could not read http://127.0.0.1/x: Blocked: 127.0.0.1 is a private address',
    );
    const local = await tool.execute(
      'c3',
      { url: 'http://localhost:8790/x' },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(local)).toBe(
      'Could not read http://localhost:8790/x: Blocked: localhost is a local address',
    );
    expect(rec.urls).toEqual(['https://sede.spain.test/a']);
    expect(rec.resolved).toEqual(['sede.spain.test']);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('run_script fetches through the stand-in and the script sees the guard errors', async () => {
    const rec = recorder(
      () => new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
    );
    const run = await runScript(
      `
      const data = await (await fetch('https://api.spain.test/v1/x')).json();
      let blocked;
      try { await fetch('http://127.0.0.1:8790/'); } catch (e) { blocked = e.message; }
      return { data, blocked };
    `,
      { fetchImpl: rec.fetchImpl, resolveHost: rec.resolveHost },
    );
    expect(run.ok).toBe(true);
    expect(JSON.parse(run.result ?? '')).toEqual({
      data: { ok: true },
      blocked: 'Blocked: 127.0.0.1 is a private address',
    });
    expect(rec.urls).toEqual(['https://api.spain.test/v1/x']);
    expect(rec.resolved).toEqual(['api.spain.test']);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('runScriptTool passes the stand-in on to every script', async () => {
    const rec = recorder(() => new Response('hola'));
    const tool = runScriptTool({ fetchImpl: rec.fetchImpl, resolveHost: rec.resolveHost });
    const result = await tool.execute(
      'c1',
      { code: `return await (await fetch('https://api.spain.test/')).text();` },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(result)).toContain('hola');
    expect(rec.resolved).toEqual(['api.spain.test']);
  });
});

describe('resolveHost in the tool list (ToolDeps)', () => {
  let bridge: FakeBridge;

  beforeEach(async () => {
    bridge = await createFakeBridge();
  });

  afterEach(async () => {
    await bridge.close();
  });

  it('reaches fetch_url and run_script; boe_search takes fetchImpl only (it has no guard)', async () => {
    const rec = recorder((url) =>
      url.hostname === 'www.boe.es'
        ? new Response(JSON.stringify({ status: { code: '200', text: 'ok' }, data: [] }), {
            headers: { 'content-type': 'application/json' },
          })
        : html(),
    );
    const harness = toolHarness(bridge, {
      fetchImpl: rec.fetchImpl,
      resolveHost: rec.resolveHost,
    });
    await harness.run('fetch_url', { url: 'https://sede.spain.test/uno' });
    await harness.run('run_script', {
      code: `return (await fetch('https://api.spain.test/dos')).status;`,
    });
    const boe = await harness.run('boe_search', { query: 'documento nacional de identidad' });
    expect(textOf(boe)).toContain('No legislation found');
    expect(rec.urls.map((u) => new URL(u).hostname)).toEqual([
      'sede.spain.test',
      'api.spain.test',
      'www.boe.es',
    ]);
    expect(rec.urls[2]).toMatch(
      /^https:\/\/www\.boe\.es\/datosabiertos\/api\/legislacion-consolidada\?query=/,
    );
    expect(rec.resolved).toEqual(['sede.spain.test', 'api.spain.test']);
    expect(system.lookup).not.toHaveBeenCalled();
  });

  it('leaves allowPrivateHosts false: IP literals stay blocked next to a stand-in', async () => {
    const rec = recorder();
    const harness = toolHarness(bridge, {
      fetchImpl: rec.fetchImpl,
      resolveHost: rec.resolveHost,
      allowPrivateHosts: false,
    });
    const result = await harness.run('fetch_url', { url: 'http://127.0.0.1:8790/' });
    expect(result.isError).toBe(true);
    expect(rec.urls).toEqual([]);
  });
});
