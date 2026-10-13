import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeBody,
  FetchError,
  fetchDocument,
  htmlToMarkdown,
  isPrivateAddress,
  sliceText,
} from '../src/research/fetch';
import { fetchUrlTool } from '../src/tools/fetch-url';
import type { HostPolicy } from '../src/tools/hosts';
import { FIXTURES, textOf } from './helpers/tools';

const article = readFileSync(join(FIXTURES, 'html', 'article.html'), 'utf8');
const legacy = readFileSync(join(FIXTURES, 'html', 'legacy.html'), 'utf8');
const pdf = readFileSync(join(FIXTURES, 'pdf', 'tasas.pdf'));

let server: Server;
let base: string;
let hits: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits[path] = (hits[path] ?? 0) + 1;
    const send = (status: number, type: string, body: Buffer | string, headers = {}) => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    switch (path) {
      case '/article.html':
        return send(200, 'text/html; charset=utf-8', article);
      case '/latin1.html':
        return send(
          200,
          'text/html; charset=ISO-8859-1',
          Buffer.from(legacy.replace('windows-1252', 'x'), 'latin1'),
        );
      case '/meta-1252.html':
        // windows-1252 puts € at 0x80.
        return send(200, 'text/html', Buffer.from(legacy.replace('€', '\u0080'), 'latin1'));
      case '/undeclared.html':
        return send(
          200,
          'text/html',
          Buffer.from(legacy.replace(/<META[^>]+>/, '').replace('€', 'EUR'), 'latin1'),
        );
      case '/doc.pdf':
        return send(200, 'application/pdf', pdf);
      case '/download?id=7':
        return send(200, 'application/octet-stream', pdf);
      case '/redirect':
        return send(302, 'text/plain', '', { location: '/article.html' });
      case '/loop':
        return send(302, 'text/plain', '', { location: '/loop' });
      case '/missing':
        return send(404, 'text/html', 'Not found');
      case '/image.png':
        return send(200, 'image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case '/plain.txt':
        return send(200, 'text/plain; charset=utf-8', 'línea 1\nlínea 2');
      default:
        return send(404, 'text/plain', 'no');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const local = { allowPrivateHosts: true };
const allHosts: HostPolicy = { approve: async () => true };

describe('fetchDocument (HTML)', () => {
  it('extracts the main content as Markdown with GFM tables and absolute links', async () => {
    const doc = await fetchDocument(`${base}/article.html`, local);
    expect(doc.kind).toBe('html');
    expect(doc.title).toContain('Renovación del DNI');
    expect(doc.text).toContain('Renovación del Documento Nacional de Identidad');
    expect(doc.text).toContain('| Concepto | Importe |');
    expect(doc.text).toContain('| Renovación | 12,00 € |');
    expect(doc.text).toContain(`[la página de requisitos](${base}/requisitos.html)`);
    expect(doc.text).toContain('- DNI actual');
    for (const noise of ['Menú uno', 'Aviso legal', 'tracker', 'Logo', 'javascript:']) {
      expect(doc.text).not.toContain(noise);
    }
  });

  it('decodes ISO-8859-1 declared in the Content-Type header', async () => {
    const doc = await fetchDocument(`${base}/latin1.html`, local);
    expect(doc.charset).toBe('iso-8859-1');
    expect(doc.text).toContain('Año de publicación');
    expect(doc.text).toContain('á é í ó ú ñ ü ¿ ¡');
  });

  it('decodes windows-1252 declared in a <meta> tag', async () => {
    const doc = await fetchDocument(`${base}/meta-1252.html`, local);
    expect(doc.charset).toBe('windows-1252');
    expect(doc.text).toContain('Señor usuario');
    expect(doc.text).toContain('€');
  });

  it('falls back to windows-1252 when undeclared bytes are not UTF-8', async () => {
    const doc = await fetchDocument(`${base}/undeclared.html`, local);
    expect(doc.charset).toBe('windows-1252');
    expect(doc.text).toContain('Delegación del Gobierno');
    expect(doc.text).not.toContain('�');
  });

  it('follows redirects and reports the final URL', async () => {
    const doc = await fetchDocument(`${base}/redirect`, local);
    expect(doc.url).toBe(`${base}/article.html`);
    expect(doc.requestedUrl).toBe(`${base}/redirect`);
  });

  it('fails clearly on redirect loops, HTTP errors and unsupported types', async () => {
    await expect(fetchDocument(`${base}/loop`, local)).rejects.toMatchObject({ code: 'redirects' });
    await expect(fetchDocument(`${base}/missing`, local)).rejects.toMatchObject({
      code: 'http',
      status: 404,
    });
    await expect(fetchDocument(`${base}/image.png`, local)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(fetchDocument('ftp://example.com/x', local)).rejects.toMatchObject({
      code: 'invalid_url',
    });
  });

  it('blocks local and private addresses unless allowed', async () => {
    await expect(fetchDocument(`${base}/article.html`)).rejects.toMatchObject({ code: 'blocked' });
    await expect(fetchDocument('http://localhost:1/x')).rejects.toMatchObject({ code: 'blocked' });
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('81.45.12.3')).toBe(false);
  });

  it('cuts downloads at the byte cap', async () => {
    const doc = await fetchDocument(`${base}/article.html`, {
      ...local,
      maxBytes: 300,
      mode: 'full',
    });
    expect(doc.truncatedBytes).toBe(true);
  });

  it('returns plain text as is', async () => {
    const doc = await fetchDocument(`${base}/plain.txt`, local);
    expect(doc.kind).toBe('text');
    expect(doc.text).toBe('línea 1\nlínea 2');
  });
});

describe('fetchDocument (PDF)', () => {
  it('extracts text per page, with accents', async () => {
    const doc = await fetchDocument(`${base}/doc.pdf`, local);
    expect(doc.kind).toBe('pdf');
    expect(doc.pages).toBe(2);
    expect(doc.title).toBe('Tasas DNI (fixture)');
    expect(doc.text).toContain('[Página 1]');
    expect(doc.text).toContain('Tasas de expedición del DNI');
    expect(doc.text).toContain('Renovación: 12,00 euros');
    expect(doc.text).toContain('[Página 2]');
    expect(doc.text).toContain('Familia numerosa: exento.');
  });

  it('sniffs PDFs served with a generic content type', async () => {
    const doc = await fetchDocument(`${base}/download?id=7`, local);
    expect(doc.kind).toBe('pdf');
  });
});

describe('helpers', () => {
  it('pages long text at line breaks', () => {
    const text = Array.from({ length: 100 }, (_, i) => `línea ${i}`).join('\n');
    const first = sliceText(text, 0, 200);
    expect(first.start).toBe(0);
    expect(first.chunk.endsWith('\n')).toBe(true);
    expect(first.nextOffset).toBe(first.end);
    const second = sliceText(text, first.nextOffset, 200);
    expect(second.start).toBe(first.end);
    const last = sliceText(text, text.length - 5, 200);
    expect(last.nextOffset).toBeUndefined();
  });

  it('keeps full pages in "full" mode', () => {
    const { markdown } = htmlToMarkdown(article, 'https://sede.example.gob.es/', 'full');
    expect(markdown).toContain('Menú uno');
    expect(markdown).not.toContain('tracker');
  });

  it('detects charsets from BOM and XML declarations', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('hola', 'utf8')]);
    expect(decodeBody('text/plain', bom).charset).toBe('utf-8');
    const xml = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><a>año</a>', 'latin1');
    expect(decodeBody('application/xml', new Uint8Array(xml)).text).toContain('año');
  });
});

describe('fetch_url tool', () => {
  it('renders a page header, the untrusted marker and paging hints', async () => {
    const tool = fetchUrlTool({ hosts: allHosts, allowPrivateHosts: true });
    const result = await tool.execute(
      'c1',
      { url: `${base}/article.html`, maxChars: 300 },
      undefined,
      undefined,
      {} as never,
    );
    const text = textOf(result as never);
    expect(text).toContain(`URL: ${base}/article.html`);
    expect(text).toContain('Untrusted page content');
    expect(text).toMatch(/More: call fetch_url again with offset \d+/);
  });

  it('serves pages from a short cache when paging', async () => {
    const tool = fetchUrlTool({ hosts: allHosts, allowPrivateHosts: true });
    hits = {};
    await tool.execute('c1', { url: `${base}/doc.pdf` }, undefined, undefined, {} as never);
    await tool.execute(
      'c2',
      { url: `${base}/doc.pdf`, offset: 10 },
      undefined,
      undefined,
      {} as never,
    );
    expect(hits['/doc.pdf']).toBe(1);
  });

  it('returns tool errors instead of throwing', async () => {
    const tool = fetchUrlTool({ hosts: allHosts });
    const result = (await tool.execute(
      'c1',
      { url: `${base}/article.html` },
      undefined,
      undefined,
      {} as never,
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain('Blocked');
    expect(FetchError).toBeDefined();
  });

  it('asks before reading a non-official host and reports a refusal', async () => {
    const asked: string[] = [];
    const hosts: HostPolicy = {
      approve: async (url) => {
        asked.push(url.host);
        return false;
      },
    };
    hits = {};
    const tool = fetchUrlTool({ hosts, allowPrivateHosts: true });
    const result = (await tool.execute(
      'c1',
      { url: `${base}/article.html` },
      undefined,
      undefined,
      {} as never,
    )) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(textOf(result as never)).toContain('The user did not allow reading 127.0.0.1');
    expect(asked).toEqual([new URL(base).host]);
    expect(hits['/article.html']).toBeUndefined();
  });

  it('restarts its time budget after the user answers', async () => {
    const hosts: HostPolicy = {
      approve: () => new Promise((resolve) => setTimeout(() => resolve(true), 300)),
    };
    const doc = await fetchDocument(`${base}/article.html`, {
      ...local,
      timeoutMs: 200,
      approveHost: (url) => hosts.approve(url),
    });
    expect(doc.status).toBe(200);
  });
});
