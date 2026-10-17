import { describe, expect, it, vi } from 'vitest';
import { runScript, runScriptTool } from '../src/tools/run-script';

// Offline DNS: intranet.example resolves to a private address, every other name to a public one.
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => [
    { address: host === 'intranet.example' ? '10.0.0.5' : '93.184.216.34', family: 4 },
  ],
}));

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? '').join('');
}

describe('runScript', () => {
  it('returns the value as JSON and captures console output', async () => {
    const run = await runScript(`
      console.log('hola', { a: 1 }, [2]);
      const dates = ['2026-03-01', '2026-01-15'].sort();
      return { first: dates[0], count: dates.length };
    `);
    expect(run.ok).toBe(true);
    expect(run.logs).toEqual(['hola {"a":1} [2]']);
    expect(JSON.parse(run.result ?? '')).toEqual({ first: '2026-01-15', count: 2 });
  });

  it('returns nothing when the script returns nothing', async () => {
    const run = await runScript('console.log(1 + 1)');
    expect(run).toMatchObject({ ok: true, logs: ['2'], result: undefined });
  });

  it('fetches through the host with method, headers and body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ offices: ['Madrid', 'Sevilla'] }, { status: 201 });
    }) as unknown as typeof fetch;
    const run = await runScript(
      `
      const res = await fetch('https://api.example.es/oficinas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ province: 'Madrid' }),
      });
      const data = await res.json();
      return { status: res.status, ok: res.ok, type: res.headers.get('Content-Type'), offices: data.offices };
    `,
      { fetchImpl },
    );
    expect(run.ok).toBe(true);
    expect(JSON.parse(run.result ?? '')).toEqual({
      status: 201,
      ok: true,
      type: 'application/json',
      offices: ['Madrid', 'Sevilla'],
    });
    expect(run.fetches).toBe(1);
    expect(calls[0]?.url).toBe('https://api.example.es/oficinas');
    expect(calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(calls[0]?.init.body).toBe('{"province":"Madrid"}');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toMatch(/Mozilla/);
  });

  it('blocks localhost and private networks, also behind a redirect', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: URL) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    }) as unknown as typeof fetch;
    const run = await runScript(
      `
      const urls = [
        'http://localhost:8080/',
        'http://127.0.0.1/',
        'http://192.168.1.1/admin',
        'http://[::1]/',
        'https://intranet.example/',
        'file:///etc/passwd',
        'https://public.example/go',
      ];
      const errors = [];
      for (const url of urls) {
        try { await fetch(url); errors.push('fetched'); } catch (e) { errors.push(e.message); }
      }
      return errors;
    `,
      { fetchImpl },
    );
    expect(JSON.parse(run.result ?? '')).toEqual([
      'Blocked: localhost is a local address',
      'Blocked: 127.0.0.1 is a private address',
      'Blocked: 192.168.1.1 is a private address',
      'Blocked: ::1 is a private address',
      'Blocked: intranet.example resolves to a private address',
      'Only http(s) URLs are supported: file:///etc/passwd',
      'Blocked: 169.254.169.254 is a private address',
    ]);
    // Only the public hop went out.
    expect(calls).toEqual(['https://public.example/go']);
  });

  it('follows public redirects and reports the final URL', async () => {
    const fetchImpl = (async (url: URL) =>
      url.pathname === '/old'
        ? new Response(null, { status: 301, headers: { location: '/new' } })
        : new Response('ok')) as unknown as typeof fetch;
    const run = await runScript(
      `const res = await fetch('https://x.es/old'); return { url: res.url, redirected: res.redirected, text: await res.text() };`,
      { fetchImpl },
    );
    expect(JSON.parse(run.result ?? '')).toEqual({
      url: 'https://x.es/new',
      redirected: true,
      text: 'ok',
    });
  });

  it('follows redirects like fetch: 303 and POST after 301/302 become GET without the body', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown; headers: Headers }> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      calls.push({
        url: String(url),
        method: init.method,
        body: init.body,
        headers: new Headers(init.headers),
      });
      const location = { '/see-other': '/done', '/moved': '/done', '/temporary': '/done' }[
        url.pathname
      ];
      const status = { '/see-other': 303, '/moved': 302, '/temporary': 307 }[url.pathname];
      return location ? new Response(null, { status, headers: { location } }) : new Response('ok');
    }) as unknown as typeof fetch;
    const run = await runScript(
      `
      const init = { headers: { 'Content-Type': 'text/plain' }, body: 'datos' };
      await fetch('https://x.es/see-other', { ...init, method: 'PUT' });
      await fetch('https://x.es/moved', { ...init, method: 'POST' });
      await fetch('https://x.es/temporary', { ...init, method: 'POST' });
    `,
      { fetchImpl },
    );
    expect(run.ok).toBe(true);
    const hops = calls.map(({ url, method, body, headers }) => ({
      url,
      method,
      body,
      type: headers.get('content-type'),
    }));
    expect(hops).toEqual([
      { url: 'https://x.es/see-other', method: 'PUT', body: 'datos', type: 'text/plain' },
      { url: 'https://x.es/done', method: 'GET', body: undefined, type: null },
      { url: 'https://x.es/moved', method: 'POST', body: 'datos', type: 'text/plain' },
      { url: 'https://x.es/done', method: 'GET', body: undefined, type: null },
      { url: 'https://x.es/temporary', method: 'POST', body: 'datos', type: 'text/plain' },
      { url: 'https://x.es/done', method: 'POST', body: 'datos', type: 'text/plain' },
    ]);
  });

  it('drops the authorization header on a redirect to another origin', async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return url.host === 'api.example.es' && url.pathname !== '/here'
        ? new Response(null, {
            status: 302,
            headers: { location: url.pathname === '/away' ? 'https://other.example/' : '/here' },
          })
        : new Response('ok');
    }) as unknown as typeof fetch;
    await runScript(
      `
      const headers = { Authorization: 'Bearer abc' };
      await fetch('https://api.example.es/stay', { headers });
      await fetch('https://api.example.es/away', { headers });
    `,
      { fetchImpl },
    );
    expect(seen).toEqual(['Bearer abc', 'Bearer abc', 'Bearer abc', null]);
  });

  it('reaches private hosts only when allowed (dev/e2e)', async () => {
    const fetchImpl = (async () => new Response('mock sede')) as unknown as typeof fetch;
    const run = await runScript(`return await (await fetch('http://localhost:8790/')).text();`, {
      fetchImpl,
      allowPrivateHosts: true,
    });
    expect(JSON.parse(run.result ?? '')).toBe('mock sede');
  });

  it('decodes ISO-8859-1 responses', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([0x43, 0xe1, 0x63, 0x65, 0x72, 0x65, 0x73]), {
        headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      })) as unknown as typeof fetch;
    const run = await runScript(`return await (await fetch('https://x.es')).text();`, {
      fetchImpl,
    });
    expect(JSON.parse(run.result ?? '')).toBe('Cáceres');
  });

  it('turns failed requests into errors the script can catch', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    const run = await runScript(
      `try { await fetch('https://nope.invalid'); } catch (e) { return e.message; }`,
      { fetchImpl },
    );
    expect(JSON.parse(run.result ?? '')).toBe('Could not fetch nope.invalid: ENOTFOUND');
  });

  it('reports syntax errors and thrown errors', async () => {
    const syntax = await runScript('return {');
    expect(syntax.ok).toBe(false);
    expect(syntax.error).toMatch(/SyntaxError/);

    const thrown = await runScript(`console.log('before'); throw new Error('boom');`);
    expect(thrown).toMatchObject({ ok: false, logs: ['before'] });
    expect(thrown.error).toMatch(/Error: boom\n.*script\.js:1:/);
  });

  it('has no Node or host APIs', async () => {
    const run = await runScript(
      `return {
        node: [typeof require, typeof process, typeof Buffer],
        host: Object.getOwnPropertyNames(globalThis).filter((name) => name.startsWith('__host')),
      };`,
    );
    expect(JSON.parse(run.result ?? '')).toEqual({
      node: ['undefined', 'undefined', 'undefined'],
      host: [],
    });
  });

  describe('the clock of its Date', () => {
    const frozen = () => new Date('2026-10-16T08:00:00Z');

    it('is the real one unless the host gives it another', async () => {
      const before = Date.now();
      const run = await runScript('return [Date.now(), new Date().getTime()];');
      const [now, constructed] = JSON.parse(run.result ?? '') as number[];
      expect(now).toBeGreaterThanOrEqual(before);
      expect(constructed).toBeLessThan(Date.now() + 1);
    });

    it('shows the host’s clock in Date.now, new Date() and Date() when there is one, and keeps moving', async () => {
      const run = await runScript(
        `
        const start = Date.now();
        while (Date.now() < start + 60) { /* no timers in the engine: wait by looking */ }
        return {
          start,
          later: Date.now(),
          iso: new Date().toISOString().slice(0, 10),
          string: Date(),
          year: new Date().getUTCFullYear(),
        };`,
        { now: frozen },
      );
      expect(run.ok, run.error).toBe(true);
      const seen = JSON.parse(run.result ?? '') as Record<string, number | string>;
      expect(seen.start).toBeGreaterThanOrEqual(Date.parse('2026-10-16T08:00:00Z'));
      expect(seen.start).toBeLessThan(Date.parse('2026-10-16T08:00:05Z'));
      expect((seen.later as number) - (seen.start as number)).toBeGreaterThanOrEqual(50);
      expect(seen.iso).toBe('2026-10-16');
      // Date() is the current time as text, in the machine's zone: the year does not depend on it.
      expect(seen.string).toContain('2026');
      expect(seen.year).toBe(2026);
    });

    it('leaves every other use of Date as it is', async () => {
      const run = await runScript(
        `
        const born = new Date(1990, 5, 15, 12);
        return {
          parsed: Date.parse('2000-01-01T00:00:00Z'),
          utc: Date.UTC(2020, 1, 29),
          born: born.getFullYear() + '-' + born.getMonth() + '-' + born.getDate(),
          copy: new Date(born).getTime() === born.getTime(),
          instance: new Date() instanceof Date,
          ctor: new Date().constructor === Date,
          diff: Math.floor((new Date('2026-12-25') - new Date()) / 86400000),
          sorted: ['2026-03-01', '2026-01-15'].map((d) => new Date(d)).sort((a, b) => a - b)[0].toISOString().slice(0, 10),
        };`,
        { now: frozen },
      );
      expect(run.ok, run.error).toBe(true);
      expect(JSON.parse(run.result ?? '')).toEqual({
        parsed: 946684800000,
        utc: Date.UTC(2020, 1, 29),
        born: '1990-5-15',
        copy: true,
        instance: true,
        ctor: true,
        diff: 69,
        sorted: '2026-01-15',
      });
    });

    it('is the clock of the run_script tool when it is given one', async () => {
      const tool = runScriptTool({ now: frozen });
      const result = await tool.execute(
        'c1',
        { code: 'return new Date().toISOString().slice(0, 10);' },
        undefined,
        undefined,
        {} as never,
      );
      expect(textOf(result)).toContain('2026-10-16');
    });
  });

  it('has URL with the same parsing as Node', async () => {
    const run = await runScript(`
      const url = new URL('../tramites/cita?provincia=Madrid&x=1#arriba', 'https://sede.example.es/a/b/c');
      url.searchParams.set('fecha', '2026-10-12 09:00');
      url.searchParams.delete('x');
      const host = new URL('https://EXAMPLE.es:443/ñ');
      host.pathname = '/otra ruta';
      let invalid;
      try { new URL('no es una url'); } catch (error) { invalid = error.name + ': ' + error.message; }
      return {
        href: url.href,
        origin: url.origin,
        search: url.search,
        hash: url.hash,
        host: host.href,
        port: host.port,
        invalid,
        canParse: [URL.canParse('https://x.es'), URL.canParse('x')],
        json: JSON.stringify({ url: new URL('https://x.es/a') }),
      };
    `);
    expect(JSON.parse(run.result ?? '')).toEqual({
      href: 'https://sede.example.es/a/tramites/cita?provincia=Madrid&fecha=2026-10-12+09%3A00#arriba',
      origin: 'https://sede.example.es',
      search: '?provincia=Madrid&fecha=2026-10-12+09%3A00',
      hash: '#arriba',
      host: 'https://example.es/otra%20ruta',
      port: '',
      invalid: 'TypeError: Invalid URL: no es una url',
      canParse: [true, false],
      json: '{"url":"https://x.es/a"}',
    });
  });

  it('has URLSearchParams like Node', async () => {
    const code = `
      const a = new URLSearchParams('?q=a+b%20c&q=d&e=%E2%82%AC&bad=%ZZ&empty');
      const b = new URLSearchParams({ nombre: 'José Ñ', extra: "!'()~*" });
      const c = new URLSearchParams([['z', '1'], ['a', '2'], ['z', '0']]);
      c.sort();
      return {
        all: a.getAll('q'),
        euro: a.get('e'),
        bad: a.get('bad'),
        empty: a.get('empty'),
        missing: a.get('nope'),
        size: a.size,
        b: b.toString(),
        c: c.toString(),
        entries: [...c],
      };
    `;
    const run = await runScript(code);
    const a = new URLSearchParams('?q=a+b%20c&q=d&e=%E2%82%AC&bad=%ZZ&empty');
    const b = new URLSearchParams({ nombre: 'José Ñ', extra: "!'()~*" });
    const c = new URLSearchParams([
      ['z', '1'],
      ['a', '2'],
      ['z', '0'],
    ]);
    c.sort();
    expect(JSON.parse(run.result ?? '')).toEqual({
      all: a.getAll('q'),
      euro: a.get('e'),
      bad: a.get('bad'),
      empty: a.get('empty'),
      missing: null,
      size: a.size,
      b: b.toString(),
      c: c.toString(),
      entries: [...c],
    });
  });

  it('has atob and btoa', async () => {
    const run = await runScript(`
      let error;
      try { atob('###'); } catch (e) { error = e.name; }
      return [btoa('hola'), btoa('ab'), atob('aG9sYQ=='), atob(btoa('\\u00ff\\u0000x')), error];
    `);
    expect(JSON.parse(run.result ?? '')).toEqual([
      'aG9sYQ==',
      'YWI=',
      'hola',
      'ÿ\u0000x',
      'InvalidCharacterError',
    ]);
  });

  it('has TextEncoder and TextDecoder with every encoding Node knows', async () => {
    const run = await runScript(`
      const bytes = new TextEncoder().encode('Cáceres €');
      const latin1 = new TextDecoder('iso-8859-1');
      const stream = new TextDecoder();
      const euro = new TextEncoder().encode('€');
      const streamed = stream.decode(euro.subarray(0, 1), { stream: true }) + stream.decode(euro.subarray(1));
      let fatal;
      try { new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array([0xff])); } catch (e) { fatal = e.name; }
      const into = new Uint8Array(3);
      return {
        bytes: [...bytes],
        back: new TextDecoder().decode(bytes),
        latin1: [latin1.encoding, latin1.decode(new Uint8Array([0x43, 0xe1]))],
        streamed,
        fatal,
        into: [new TextEncoder().encodeInto('añb', into), [...into]],
      };
    `);
    expect(JSON.parse(run.result ?? '')).toEqual({
      bytes: [...new TextEncoder().encode('Cáceres €')],
      back: 'Cáceres €',
      latin1: ['windows-1252', 'Cá'],
      streamed: '€',
      fatal: 'TypeError',
      into: [{ read: 2, written: 3 }, [0x61, 0xc3, 0xb1]],
    });
  });

  it('sends and receives binary bodies', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x80]);
    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      calls.push(init);
      return new Response(pdf, { headers: { 'content-type': 'application/pdf' } });
    }) as unknown as typeof fetch;
    const run = await runScript(
      `
      const upload = await fetch(new URL('https://x.es/subir'), { method: 'PUT', body: new Uint8Array([1, 2, 255]) });
      const form = await fetch('https://x.es/form', { method: 'POST', body: new URLSearchParams({ a: 'b c' }) });
      const bytes = await upload.bytes();
      const buffer = await form.arrayBuffer();
      return { bytes: [...bytes], length: buffer.byteLength, start: (await form.text()).slice(0, 4) };
    `,
      { fetchImpl },
    );
    expect(JSON.parse(run.result ?? '')).toEqual({
      bytes: [...pdf],
      length: pdf.length,
      start: '%PDF',
    });
    expect([...new Uint8Array(calls[0]?.body as Uint8Array)]).toEqual([1, 2, 255]);
    expect(calls[1]?.body).toBe('a=b+c');
    expect(new Headers(calls[1]?.headers).get('content-type')).toBe(
      'application/x-www-form-urlencoded;charset=UTF-8',
    );
  });

  it('stops busy loops, hung promises and hung requests at the timeout', async () => {
    const busy = await runScript('while (true) {}', { timeoutMs: 200 });
    expect(busy).toMatchObject({ ok: false, error: 'Timed out after 1 s' });

    const hung = await runScript('await new Promise(() => {});', { timeoutMs: 200 });
    expect(hung).toMatchObject({ ok: false, error: 'Timed out after 1 s' });

    let aborted = false;
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    const slow = await runScript(`await fetch('https://slow.es');`, { timeoutMs: 200, fetchImpl });
    expect(slow.ok).toBe(false);
    expect(aborted).toBe(true);

    // A later run is unaffected.
    expect((await runScript('return 1')).result).toBe('1');
  });

  it('enforces the memory limit', async () => {
    const run = await runScript(
      `const parts = []; while (true) parts.push(new ArrayBuffer(1024 * 1024));`,
      { memoryLimitBytes: 16 * 1024 * 1024 },
    );
    expect(run.ok).toBe(false);
    expect(run.error).toMatch(/memory/i);
  });

  it('caps the heap for large ArrayBuffers and strings', async () => {
    const options = { memoryLimitBytes: 16 * 1024 * 1024 };
    const buffers = await runScript(
      `const parts = []; for (let i = 0; i < 20; i++) parts.push(new ArrayBuffer(4 * 1024 * 1024)); return parts.length;`,
      options,
    );
    expect(buffers).toMatchObject({ ok: false, error: expect.stringMatching(/memory/i) });
    const strings = await runScript(
      `const parts = []; for (let i = 0; i < 20; i++) parts.push(String(i).repeat(4 * 1024 * 1024)); return parts.length;`,
      options,
    );
    expect(strings).toMatchObject({ ok: false, error: expect.stringMatching(/memory/i) });
  });

  it('refuses fetched bodies that would go over the memory limit', async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array(8 * 1024 * 1024))) as unknown as typeof fetch;
    const run = await runScript(
      `const kept = []; for (let i = 0; i < 6; i++) kept.push(await (await fetch('https://big.es')).arrayBuffer()); return kept.length;`,
      { memoryLimitBytes: 16 * 1024 * 1024, fetchImpl },
    );
    expect(run).toMatchObject({ ok: false, error: expect.stringMatching(/memory/i) });
  });

  it('bounds the total size of logs', async () => {
    const run = await runScript(
      `const s = 'x'.repeat(1024 * 1024); for (let i = 0; i < 1000; i++) console.log(s + i); return 'done';`,
      { maxOutputChars: 30_000 },
    );
    expect(run.ok).toBe(true);
    expect(run.result).toBe('"done"');
    expect(run.logs.join('').length).toBeLessThan(31_000);
    expect(run.logs.at(-1)).toBe('… more log output dropped');
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = runScript('await new Promise(() => {});', { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
  });
});

describe('run_script tool', () => {
  it('renders logs and result, and flags failures as errors', async () => {
    const tool = runScriptTool();
    const ok = await tool.execute(
      '1',
      { code: `console.log('x'); return [1, 2];` },
      undefined,
      undefined,
      {} as never,
    );
    expect(ok.isError).toBeFalsy();
    expect(textOf(ok)).toContain('--- Logs ---\nx');
    expect(textOf(ok)).toContain('--- Result ---\n[\n  1,\n  2\n]');

    const failed = await tool.execute(
      '2',
      { code: `throw new Error('nope')` },
      undefined,
      undefined,
      {} as never,
    );
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('Error: nope');
  });

  it('cuts long output', async () => {
    const tool = runScriptTool({ maxOutputChars: 100 });
    const result = await tool.execute(
      '1',
      { code: `return 'a'.repeat(5000);` },
      undefined,
      undefined,
      {} as never,
    );
    expect(textOf(result)).toMatch(/output cut at 100 characters/);
  });
});
