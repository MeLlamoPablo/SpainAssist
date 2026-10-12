import { describe, expect, it } from 'vitest';
import { runScript, runScriptTool } from '../src/tools/run-script';

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
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
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
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"province":"Madrid"}');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toMatch(/Mozilla/);
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
    expect(JSON.parse(run.result ?? '')).toBe('fetch failed (ENOTFOUND)');
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
    const fetchImpl = (async (_url: string, init: RequestInit) => {
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
