import { isIP } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  declaredLength,
  docAddress,
  fetchFailed,
  isBenchHeader,
  readRequestBody,
  sanitizeResponseHeaders,
  statusText,
} from '../../src/net/wire';

const mock = new URL('http://127.0.0.1:3010');
const real = 'https://portal.seg-social.gob.es';

function sanitize(raw: string[], origin = mock) {
  return sanitizeResponseHeaders(raw, { mock: origin, realOrigin: real });
}

describe('sanitizeResponseHeaders', () => {
  it('drops hop-by-hop, SpainBench and tell-tale headers and keeps the rest in order', () => {
    const { headers, bench } = sanitize([
      'Content-Type',
      'text/html',
      'Connection',
      'keep-alive',
      'Keep-Alive',
      'timeout=5',
      'Transfer-Encoding',
      'chunked',
      'X-Powered-By',
      'Express',
      'Server',
      'SpainBench/0.2',
      'X-SpainBench-Debug',
      'on',
      'X-Frame-Options',
      'DENY',
      'Set-Cookie',
      'a=1',
      'Set-Cookie',
      'b=2',
    ]);
    expect(headers).toEqual([
      ['Content-Type', 'text/html'],
      ['X-Frame-Options', 'DENY'],
      ['Set-Cookie', 'a=1'],
      ['Set-Cookie', 'b=2'],
    ]);
    expect(bench).toBeUndefined();
  });

  it('keeps a server header that does not give the mock away', () => {
    expect(sanitize(['Server', 'nginx']).headers).toEqual([['Server', 'nginx']]);
    for (const tell of [
      'node',
      'Express',
      'mock-server',
      'SpainBench',
      'localhost:3010',
      'x 127.0.0.1',
    ])
      expect(sanitize(['Server', tell]).headers, tell).toEqual([]);
  });

  it('keeps SpainBench own classification apart', () => {
    const { headers, bench } = sanitize([
      'X-SpainBench-Kind',
      'wrong-turn',
      'X-SpainBench-Page',
      '/vida-laboral',
      'X-SpainBench-Seq',
      '42',
      'Date',
      'x',
    ]);
    expect(bench).toEqual({ kind: 'wrong-turn', page: '/vida-laboral', seq: 42 });
    expect(headers).toEqual([['Date', 'x']]);
    expect(sanitize(['X-SpainBench-Seq', 'not a number']).bench).toBeUndefined();
  });

  it('turns every mention of the mock origin into the real one', () => {
    const { headers } = sanitize([
      'Location',
      'http://127.0.0.1:3010/back?x=1',
      'Content-Location',
      'http://localhost:3010/a',
      'Link',
      '<http://127.0.0.1:3010/style.css>; rel=preload, <//127.0.0.1:3010/app.js>; rel=preload',
      'Refresh',
      '0; url=http://[::1]:3010/x',
      'Access-Control-Allow-Origin',
      'https://127.0.0.1:3010',
    ]);
    expect(headers.map(([, v]) => v)).toEqual([
      `${real}/back?x=1`,
      `${real}/a`,
      `<${real}/style.css>; rel=preload, <//portal.seg-social.gob.es/app.js>; rel=preload`,
      `0; url=${real}/x`,
      real,
    ]);
  });

  it('does not touch another port or a host that merely starts like the mock', () => {
    const { headers } = sanitize([
      'Location',
      'http://127.0.0.1:30100/x',
      'Link',
      '<http://127.0.0.10:3010/x>',
      'X-Other',
      'http://127.0.0.1:3011/',
    ]);
    expect(headers.map(([, v]) => v)).toEqual([
      'http://127.0.0.1:30100/x',
      '<http://127.0.0.10:3010/x>',
      'http://127.0.0.1:3011/',
    ]);
  });

  it('knows the mock by its own name too', () => {
    const origin = new URL('http://127.0.0.1:8123');
    expect(sanitize(['Location', 'http://127.0.0.1:8123/x'], origin).headers[0]?.[1]).toBe(
      `${real}/x`,
    );
    expect(sanitize(['Location', 'http://127.0.0.1:3010/x'], origin).headers[0]?.[1]).toBe(
      'http://127.0.0.1:3010/x',
    );
  });
});

describe('error shapes', () => {
  it('docAddress is stable, per host, and outside every range the product guard blocks', () => {
    expect(docAddress('Portal.Seg-Social.gob.es')).toBe(docAddress('portal.seg-social.gob.es'));
    expect(docAddress('a.example')).not.toBe(docAddress('b.example'));
    for (const host of ['a.es', 'b.es', 'c.example', 'portal.seg-social.gob.es', 'x'.repeat(40)]) {
      const address = docAddress(host);
      expect(isIP(address)).toBe(4);
      expect(address).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
    }
  });

  it('fetchFailed has the shape of undici errors, without anything local', () => {
    const refused = fetchFailed('ECONNREFUSED', 'www.boe.es', { port: 8443 });
    expect(refused).toBeInstanceOf(TypeError);
    expect(refused.message).toBe('fetch failed');
    expect(refused.cause).toMatchObject({
      code: 'ECONNREFUSED',
      syscall: 'connect',
      port: 8443,
      address: docAddress('www.boe.es'),
    });
    const reset = fetchFailed('ECONNRESET', 'x.es');
    expect((reset.cause as Error).message).toBe('read ECONNRESET');
    const timeout = fetchFailed('UND_ERR_CONNECT_TIMEOUT', 'x.es', { connectTimeoutMs: 500 });
    expect((timeout.cause as Error).name).toBe('ConnectTimeoutError');
    expect((timeout.cause as Error).message).toContain('timeout: 500ms');
    for (const err of [refused, reset, timeout, fetchFailed('ENOTFOUND', 'x.es')])
      expect(JSON.stringify(err.cause) + String((err.cause as Error).message)).not.toMatch(
        /127\.0\.0\.1|localhost|spainbench/i,
      );
  });
});

describe('small helpers', () => {
  it('recognises the harness own headers', () => {
    expect(isBenchHeader('X-SpainBench-World')).toBe(true);
    expect(isBenchHeader('x-spainbench-')).toBe(true);
    expect(isBenchHeader('x-spain-bench')).toBe(false);
    expect(isBenchHeader('x-sb-world')).toBe(false);
  });

  it('gives standard reason phrases', () => {
    expect(statusText(404)).toBe('Not Found');
    expect(statusText(299)).toBe('');
  });

  it('declares a response size only when the body is sent as is', () => {
    expect(declaredLength({ 'content-length': '120' })).toEqual({ resBytes: 120 });
    expect(declaredLength({ 'content-length': '120', 'content-encoding': 'gzip' })).toEqual({});
    expect(declaredLength({})).toEqual({});
    expect(declaredLength({ 'content-length': 'x' })).toEqual({});
  });

  it('reads any fetch body and the content type fetch implies', async () => {
    expect(await readRequestBody(undefined)).toBeUndefined();
    expect(await readRequestBody(null)).toBeUndefined();
    const text = await readRequestBody('hola');
    expect(text?.bytes.toString()).toBe('hola');
    expect(text?.contentType).toBe('text/plain;charset=UTF-8');
    const bytes = await readRequestBody(new Uint8Array([1, 2, 3]));
    expect([...(bytes?.bytes ?? [])]).toEqual([1, 2, 3]);
    expect(bytes?.contentType).toBeUndefined();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('en '));
        controller.enqueue(new TextEncoder().encode('trozos'));
        controller.close();
      },
    });
    expect((await readRequestBody(stream))?.bytes.toString()).toBe('en trozos');
    const blob = await readRequestBody(new Blob(['x'], { type: 'application/x-test' }));
    expect(blob?.contentType).toBe('application/x-test');
  });
});
