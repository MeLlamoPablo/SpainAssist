import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { extractText, getDocumentProxy } from 'unpdf';

/**
 * fetch_url core: download a page or PDF and turn it into compact Markdown/text for the model.
 * - http(s) only, private/local hosts blocked (unless allowed for dev/e2e), manual redirects
 *   (each hop re-checked), timeouts and byte caps. run_script's fetch shares the host checks and
 *   redirects (`fetchPublic`).
 * - Explicit charset decoding (header, BOM, <meta>, XML declaration; heuristic fallback to
 *   windows-1252, which many Spanish government sites still serve as ISO-8859-1).
 * - HTML: main content via Readability (linkedom DOM), fallback to <main>/body; tables keep
 *   their structure as GFM tables. PDF: text per page via unpdf.
 */

export type FetchErrorCode =
  | 'invalid_url'
  | 'blocked'
  | 'network'
  | 'timeout'
  | 'http'
  | 'redirects'
  | 'too_large'
  | 'unsupported'
  | 'parse';

export class FetchError extends Error {
  readonly code: FetchErrorCode;
  readonly status?: number;
  constructor(code: FetchErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Total time budget in ms. Default 20 s. */
  timeoutMs?: number;
  /** Byte cap for HTML/text (default 6 MB). PDFs get `maxPdfBytes` (default 25 MB). */
  maxBytes?: number;
  maxPdfBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Dev/e2e only: allow localhost and private networks. */
  allowPrivateHosts?: boolean;
  /** "auto": main content (Readability, with fallback). "full": the whole page body. */
  mode?: 'auto' | 'full';
  fetchImpl?: typeof fetch;
}

export interface FetchedDocument {
  requestedUrl: string;
  /** Final URL after redirects. */
  url: string;
  status: number;
  kind: 'html' | 'pdf' | 'text';
  contentType: string;
  title?: string;
  /** Markdown (HTML), text per page (PDF) or raw text. */
  text: string;
  pages?: number;
  /** The body was cut at the byte cap. */
  truncatedBytes: boolean;
  charset?: string;
}

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------------------------------
// Host safety
// ---------------------------------------------------------------------------------------------

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped?.[1] ? isPrivateIPv4(mapped[1]) : false;
}

export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return false;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new FetchError('blocked', `Blocked: ${host} is a local address`);
  }
  if (isIP(host)) {
    if (isPrivateAddress(host))
      throw new FetchError('blocked', `Blocked: ${host} is a private address`);
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new FetchError('network', `Could not resolve ${host}`);
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchError('blocked', `Blocked: ${host} resolves to a private address`);
  }
}

// ---------------------------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------------------------

function supportedCharset(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const clean = label.trim().toLowerCase();
  try {
    new TextDecoder(clean);
    return clean;
  } catch {
    return undefined;
  }
}

export function detectCharset(
  contentType: string,
  bytes: Uint8Array,
): {
  charset: string;
  declared: boolean;
} {
  const fromHeader = supportedCharset(/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1]);
  if (fromHeader) return { charset: fromHeader, declared: true };
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { charset: 'utf-8', declared: true };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { charset: 'utf-16be', declared: true };
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { charset: 'utf-16le', declared: true };
  const head = decodeWindows1252(bytes.subarray(0, 8192));
  const fromMeta = supportedCharset(
    /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
      /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1],
  );
  if (fromMeta) return { charset: fromMeta, declared: true };
  return { charset: 'utf-8', declared: false };
}

const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** windows-1252 code points for bytes 0x80–0x9F (WHATWG index; undefined bytes map to C1). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
  0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
  0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
];

/**
 * windows-1252 decoder. Node's TextDecoder maps "windows-1252" (and the latin1 / iso-8859-1 /
 * ascii labels WHATWG folds into it) byte-for-byte, so € and curly quotes in 0x80–0x9F would
 * come out as C1 control characters.
 */
export function decodeWindows1252(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunk = 8192;
  for (let start = 0; start < bytes.length; start += chunk) {
    const codes = Array.from(bytes.subarray(start, start + chunk), (b) =>
      b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] ?? b) : b,
    );
    parts.push(String.fromCharCode(...codes));
  }
  return parts.join('');
}

function decodeAs(label: string, bytes: Uint8Array): string {
  const decoder = new TextDecoder(label);
  return decoder.encoding === 'windows-1252' ? decodeWindows1252(bytes) : decoder.decode(bytes);
}

export function decodeBody(
  contentType: string,
  bytes: Uint8Array,
): { text: string; charset: string } {
  const { charset, declared } = detectCharset(contentType, bytes);
  const text = decodeAs(charset, bytes);
  if (!declared && charset === 'utf-8') {
    const replacements = text.split(REPLACEMENT_CHAR).length - 1;
    if (replacements > 0 && replacements >= text.length / 2000) {
      return { text: decodeWindows1252(bytes), charset: 'windows-1252' };
    }
  }
  return { text, charset };
}

// ---------------------------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------------------------

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '_',
  });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript', 'template', 'iframe', 'button', 'select', 'textarea']);
  td.addRule('inputs', { filter: ['input'], replacement: () => '' });
  // Compact list items ("- item" instead of turndown's "-   item"): fewer tokens.
  td.addRule('compactListItems', {
    filter: 'li',
    replacement: (content, node, options) => {
      const element = node as unknown as {
        parentNode?: { nodeName?: string; children?: ArrayLike<unknown> } | null;
        nextSibling?: unknown;
        getAttribute?: (name: string) => string | null;
      };
      const parent = element.parentNode;
      let prefix = `${options.bulletListMarker ?? '-'} `;
      if (parent?.nodeName === 'OL') {
        const start = Number(attr(parent, 'start') ?? '1') || 1;
        const index = parent.children ? Array.prototype.indexOf.call(parent.children, node) : 0;
        prefix = `${start + Math.max(0, index)}. `;
      }
      const body = content
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n')
        .replace(/\n/gm, `\n${' '.repeat(prefix.length)}`);
      return prefix + body + (element.nextSibling && !/\n$/.test(body) ? '\n' : '');
    },
  });
  td.addRule('images', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = (attr(node, 'alt') ?? '').trim();
      return alt.length >= 20 ? `[Imagen: ${alt}]` : '';
    },
  });
  td.addRule('plainLinks', {
    filter: (node) => {
      if (node.nodeName !== 'A') return false;
      const href = attr(node, 'href') ?? '';
      return href === '' || href.startsWith('#') || href.toLowerCase().startsWith('javascript:');
    },
    replacement: (content) => content,
  });
  return td;
}

let turndown: TurndownService | undefined;

/** Read an attribute without depending on DOM lib types. */
function attr(node: unknown, name: string): string | null {
  const element = node as { getAttribute?: (attribute: string) => string | null };
  return typeof element.getAttribute === 'function' ? element.getAttribute(name) : null;
}

type LinkedomDocument = ReturnType<typeof parseHTML>['document'];

function absolutize(document: LinkedomDocument, baseUrl: string): void {
  for (const [selector, attr] of [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
  ] as const) {
    for (const el of document.querySelectorAll(selector)) {
      const value = el.getAttribute(attr);
      if (!value || value.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(value))
        continue;
      try {
        el.setAttribute(attr, new URL(value, baseUrl).href);
      } catch {
        // keep as is
      }
    }
  }
}

/** Tables without header cells are kept as raw HTML by the GFM plugin: promote the first row. */
function promoteTableHeaders(document: LinkedomDocument): void {
  for (const table of document.querySelectorAll('table')) {
    if (table.querySelector('th') || table.querySelector('table')) continue;
    const firstRow = table.querySelector('tr');
    if (!firstRow) continue;
    const cells = Array.from(firstRow.querySelectorAll('td')) as {
      innerHTML: string;
      replaceWith: (node: unknown) => void;
    }[];
    for (const cell of cells) {
      const th = document.createElement('th');
      th.innerHTML = cell.innerHTML;
      cell.replaceWith(th);
    }
  }
}

function cleanText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function tidyMarkdown(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(
  html: string,
  baseUrl: string,
  mode: 'auto' | 'full' = 'auto',
): { title?: string; markdown: string } {
  const { document } = parseHTML(html);
  for (const el of document.querySelectorAll(
    'script, style, noscript, template, iframe, svg, canvas, object, embed, link, meta',
  )) {
    el.remove();
  }
  absolutize(document, baseUrl);
  promoteTableHeaders(document);
  let title = cleanText(document.title) || undefined;
  let contentHtml: string | undefined;

  if (mode === 'auto') {
    try {
      const copy = parseHTML(document.toString()).document;
      const article = new Readability(
        copy as unknown as ConstructorParameters<typeof Readability>[0],
        {
          charThreshold: 250,
        },
      ).parse();
      if (article?.content && cleanText(article.textContent).length >= 250) {
        contentHtml = article.content;
        title = cleanText(article.title) || title;
      }
    } catch {
      // fall back below
    }
  }
  if (!contentHtml) {
    const root =
      (mode === 'auto'
        ? document.querySelector('main, [role="main"], #main, #content, #contenido, article')
        : null) ?? document.body;
    if (mode === 'auto' && root) {
      for (const el of root.querySelectorAll(
        'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]',
      )) {
        el.remove();
      }
    }
    contentHtml = root?.innerHTML ?? document.toString();
  }
  turndown ??= createTurndown();
  return { title, markdown: tidyMarkdown(turndown.turndown(contentHtml)) };
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

export async function pdfToText(
  bytes: Uint8Array,
): Promise<{ text: string; pages: number; title?: string }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  let title: string | undefined;
  try {
    const meta = await pdf.getMetadata();
    const info = meta.info as { Title?: unknown } | undefined;
    title = typeof info?.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined;
  } catch {
    // no metadata
  }
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((page) => tidyMarkdown(page));
  const body =
    pages.length > 1
      ? pages.map((page, i) => `[Página ${i + 1}]\n${page}`).join('\n\n')
      : (pages[0] ?? '');
  return { text: body, pages: totalPages, title };
}

// ---------------------------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------------------------

export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - size));
      size = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46; // %PDF
}

export interface PublicFetchOptions {
  signal: AbortSignal;
  headers: Headers | Record<string, string>;
  /** Default GET. */
  method?: string;
  body?: string | Uint8Array;
  /** Default 5. */
  maxRedirects?: number;
  /** Dev/e2e only: allow localhost and private networks. */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
}

/** Headers that describe the request body: dropped with it when a redirect turns into a GET. */
const BODY_HEADERS = [
  'content-type',
  'content-length',
  'content-encoding',
  'content-language',
  'content-location',
];

/**
 * A request to a public http(s) host. Redirects are followed by hand, so every hop's host is
 * checked again. As in the platform's fetch, a 303 (or a 301/302 after a POST) goes on as a GET
 * without the body, and a hop to another origin drops the authorization header. Returns the
 * response of the last hop (any status) and its URL.
 */
export async function fetchPublic(
  start: URL,
  options: PublicFetchOptions,
): Promise<{ res: Response; url: URL; redirects: number }> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 5;
  const headers = new Headers(options.headers);
  let method = options.method ?? 'GET';
  let body = options.body;
  let url = start;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new FetchError('invalid_url', `Only http(s) URLs are supported: ${url.href}`);
    }
    if (url.username || url.password) {
      throw new FetchError('invalid_url', 'URLs with embedded credentials are not allowed');
    }
    if (!options.allowPrivateHosts) await assertPublicHost(url.hostname);
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        redirect: 'manual',
        signal: options.signal,
        headers,
        body,
      });
    } catch (error) {
      if (options.signal.aborted) throw error;
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      throw new FetchError(
        'network',
        `Could not fetch ${url.host}: ${cause?.code ?? cause?.message ?? (error as Error).message}`,
      );
    }
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) return { res, url, redirects: hop };
    if (hop >= maxRedirects) {
      throw new FetchError('redirects', `Too many redirects (>${maxRedirects})`);
    }
    await res.body?.cancel().catch(() => {});
    const from = url;
    try {
      url = new URL(location, url);
    } catch {
      throw new FetchError('invalid_url', `Invalid redirect target: ${location}`);
    }
    const verb = method.toUpperCase();
    if (
      (res.status === 303 && verb !== 'GET' && verb !== 'HEAD') ||
      ((res.status === 301 || res.status === 302) && verb === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    if (url.origin !== from.origin) headers.delete('authorization');
  }
}

export async function fetchDocument(
  rawUrl: string,
  options: FetchOptions = {},
): Promise<FetchedDocument> {
  let start: URL;
  try {
    start = new URL(rawUrl.trim());
  } catch {
    throw new FetchError('invalid_url', `Invalid URL: ${rawUrl}`);
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const signal = AbortSignal.any(
    [options.signal, AbortSignal.timeout(timeoutMs)].filter((s): s is AbortSignal => !!s),
  );

  let res: Response;
  let url: URL;
  try {
    ({ res, url } = await fetchPublic(start, {
      signal,
      maxRedirects: options.maxRedirects,
      allowPrivateHosts: options.allowPrivateHosts,
      fetchImpl: options.fetchImpl,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'es-ES,es;q=0.9,en;q=0.5',
      },
    }));
  } catch (error) {
    if (!options.signal?.aborted && signal.aborted) {
      throw new FetchError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)} s`);
    }
    throw error;
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError('http', `HTTP ${res.status} ${res.statusText}`.trim(), res.status);
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  const isPdfType = contentType.includes('application/pdf') || /\.pdf$/i.test(url.pathname);
  const maxBytes = isPdfType
    ? (options.maxPdfBytes ?? 25 * 1024 * 1024)
    : (options.maxBytes ?? 6 * 1024 * 1024);
  const declaredLength = Number(res.headers.get('content-length') ?? '0');
  if (isPdfType && declaredLength > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError('too_large', `PDF too large (${Math.round(declaredLength / 1e6)} MB)`);
  }
  let bytes: Uint8Array;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readCapped(res, maxBytes));
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (signal.aborted)
      throw new FetchError('timeout', `Timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new FetchError('network', `Download failed: ${(error as Error).message}`);
  }

  const base = {
    requestedUrl: rawUrl,
    url: url.href,
    status: res.status,
    contentType,
    truncatedBytes: truncated,
  };

  if (isPdfType || looksLikePdf(bytes)) {
    if (truncated) throw new FetchError('too_large', 'PDF too large to read');
    try {
      const pdf = await pdfToText(bytes);
      return { ...base, kind: 'pdf', text: pdf.text, pages: pdf.pages, title: pdf.title };
    } catch (error) {
      throw new FetchError('parse', `Could not read the PDF: ${(error as Error).message}`);
    }
  }

  const isHtml =
    contentType.includes('html') ||
    (!contentType &&
      /^\s*(<!doctype html|<html)/i.test(new TextDecoder('latin1').decode(bytes.subarray(0, 512))));
  const isText =
    contentType.startsWith('text/') ||
    contentType.includes('json') ||
    contentType.includes('xml') ||
    contentType === '';
  if (!isHtml && !isText) {
    throw new FetchError('unsupported', `Unsupported content type: ${contentType || 'unknown'}`);
  }
  const { text, charset } = decodeBody(contentType, bytes);
  if (isHtml) {
    const { title, markdown } = htmlToMarkdown(text, url.href, options.mode ?? 'auto');
    return { ...base, kind: 'html', text: markdown, title, charset };
  }
  return { ...base, kind: 'text', text: text.trim(), charset };
}

/** Cut `text` into a page that ends at a line break when possible. */
export function sliceText(
  text: string,
  offset = 0,
  maxChars = 20_000,
): { chunk: string; start: number; end: number; total: number; nextOffset?: number } {
  const total = text.length;
  const start = Math.min(Math.max(0, offset), total);
  let end = Math.min(total, start + maxChars);
  if (end < total) {
    const lastBreak = text.lastIndexOf('\n', end);
    if (lastBreak > start + maxChars * 0.8) end = lastBreak + 1;
  }
  return {
    chunk: text.slice(start, end),
    start,
    end,
    total,
    nextOffset: end < total ? end : undefined,
  };
}
