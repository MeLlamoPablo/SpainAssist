/// <reference path="../types/turndown-plugin-gfm.d.ts" />
import { type LookupAddress, type LookupOptions, lookup as lookupCallback } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { Agent, fetch as undiciFetch } from 'undici';
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
  /** DNS for the host guard (default: the system resolver). */
  resolveHost?: HostResolver;
  /** Told about every request the host guard refuses, before the error is thrown. */
  onBlocked?: (request: BlockedRequest) => void;
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

/** IPv4 ranges that are not the public internet (RFC 6890 plus multicast and reserved space). */
const PRIVATE_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 3], // multicast, reserved, broadcast
] as const) {
  PRIVATE_IPV4.addSubnet(network, prefix, 'ipv4');
}

/**
 * IPv6 ranges that are never a public host. The ones that carry an IPv4 address inside
 * (`::ffff:0:0/96`, `::ffff:0:0:0/96`, `64:ff9b::/96`, `2002::/16`) are not here: they are as
 * private as the IPv4 address they hold (`embeddedIPv4`).
 */
const PRIVATE_IPV6 = new BlockList();
for (const [network, prefix] of [
  ['::', 96], // unspecified, loopback and the deprecated IPv4-compatible addresses
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo: tunnels to an IPv4 address chosen by the sender
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link local
  ['fec0::', 10], // site local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  PRIVATE_IPV6.addSubnet(network, prefix, 'ipv6');
}

/** One part of an IPv4 address as `inet_aton` and the URL parser read it: decimal, 0x hex or 0 octal. */
function ipv4Part(part: string): number | undefined {
  let digits: string;
  let radix: number;
  if (/^0[xX]/.test(part)) {
    digits = part.slice(2) || '0';
    radix = 16;
  } else if (part.length > 1 && part.startsWith('0')) {
    digits = part.slice(1);
    radix = 8;
  } else {
    digits = part;
    radix = 10;
  }
  const valid = radix === 16 ? /^[0-9a-f]+$/i : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (digits.length > 12 || !valid.test(digits)) return undefined;
  return Number.parseInt(digits, radix);
}

/**
 * The four bytes of an IPv4 address in any spelling the platform's resolver accepts: `127.0.0.1`
 * and also `2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1` and a trailing dot. A URL's
 * hostname is already normalised, but a resolver's answer or another caller's string is not.
 */
function parseIPv4(text: string): [number, number, number, number] | undefined {
  const parts = text.replace(/\.$/, '').split('.');
  if (parts.length > 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = ipv4Part(part);
    if (value === undefined) return undefined;
    numbers.push(value);
  }
  const last = numbers.pop() as number;
  if (numbers.some((n) => n > 255) || last >= 256 ** (4 - numbers.length)) return undefined;
  const bytes: number[] = [...numbers];
  for (let shift = 8 * (3 - numbers.length); shift >= 0; shift -= 8) {
    bytes.push(Math.floor(last / 2 ** shift) % 256);
  }
  return bytes as [number, number, number, number];
}

/** The 16 bytes of an IPv6 address (a zone id is ignored), or undefined when it is not one. */
function parseIPv6(text: string): Uint8Array | undefined {
  if (isIP(text) !== 6) return undefined;
  let address = text.replace(/%.*$/, '');
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  if (dotted) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    address = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, ...extra] = address.split('::');
  if (extra.length > 0) return undefined;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const first = groups(head);
  const last = tail === undefined ? [] : groups(tail);
  if (tail === undefined ? first.length !== 8 : first.length + last.length > 7) return undefined;
  const all = [...first, ...new Array<string>(8 - first.length - last.length).fill('0'), ...last];
  const bytes = new Uint8Array(16);
  all.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[2 * i] = value >> 8;
    bytes[2 * i + 1] = value & 0xff;
  });
  return bytes;
}

/** The IPv4 address an IPv6 address carries inside (mapped, SIIT, NAT64, 6to4), if it does. */
function embeddedIPv4(bytes: Uint8Array): [number, number, number, number] | undefined {
  const head = (n: number) => bytes.subarray(0, n).every((byte) => byte === 0);
  const tail = Array.from(bytes.subarray(12, 16)) as [number, number, number, number];
  // ::ffff:a.b.c.d (mapped) and ::ffff:0:a.b.c.d (SIIT, RFC 2765)
  if (head(10) && bytes[10] === 0xff && bytes[11] === 0xff) return tail;
  if (head(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return tail;
  }
  // 64:ff9b::/96 (NAT64)
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) {
    if (bytes.subarray(4, 12).every((byte) => byte === 0)) return tail;
  }
  // 2002::/16 (6to4): the IPv4 address follows the prefix
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return Array.from(bytes.subarray(2, 6)) as [number, number, number, number];
  }
  return undefined;
}

function isPrivateIPv4Bytes(bytes: readonly number[]): boolean {
  return PRIVATE_IPV4.check(bytes.join('.'), 'ipv4');
}

/**
 * Whether `address` (an IP literal in any spelling, IPv6 zone ids and brackets included) is not a
 * public unicast address: loopback, private, link local, multicast, reserved, or an IPv6 form that
 * wraps such an IPv4 address. Anything that is not an IP address counts as private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  const host = address.trim().replace(/^\[|\]$/g, '');
  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4Bytes(v4);
  const v6 = parseIPv6(host);
  if (!v6) return true;
  const embedded = embeddedIPv4(v6);
  if (embedded) return isPrivateIPv4Bytes(embedded);
  const groups = Array.from({ length: 8 }, (_, i) =>
    (((v6[2 * i] as number) << 8) | (v6[2 * i + 1] as number)).toString(16),
  );
  return PRIVATE_IPV6.check(groups.join(':'), 'ipv6');
}

/**
 * Where the guard gets a hostname's addresses. The default asks the system resolver; an
 * embedder (a test, an offline harness) can pass its own so the check never touches real DNS.
 */
export type HostResolver = (hostname: string) => Promise<readonly { address: string }[]>;

const systemResolver: HostResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** What a refused request tells the embedder (`onBlocked`): the URL, its method and the guard's message. */
export interface BlockedRequest {
  url: URL;
  method: string;
  message: string;
}

async function assertPublicHost(
  hostname: string,
  resolve: HostResolver = systemResolver,
): Promise<void> {
  // A trailing dot is the same name (and the same address) to the resolver.
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new FetchError('blocked', `Blocked: ${host} is a local address`);
  }
  if (parseIPv4(host) || parseIPv6(host)) {
    if (isPrivateAddress(host))
      throw new FetchError('blocked', `Blocked: ${host} is a private address`);
    return;
  }
  let addresses: readonly { address: string }[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new FetchError('network', `Could not resolve ${host}`);
  }
  // No answer is no way to know where the name leads.
  if (addresses.length === 0) throw new FetchError('network', `Could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new FetchError('blocked', `Blocked: ${host} resolves to a private address`);
  }
}

/** The error code the connect-time guard fails a connection with (see `guardedFetch`). */
const BLOCKED_AT_CONNECT = 'ESA_BLOCKED_ADDRESS';

/**
 * The DNS lookup of the connections `guardedFetch` opens: the addresses a connection really goes
 * to, checked again. `assertPublicHost` asked the resolver before the request; a name that then
 * answers differently (DNS rebinding: a short TTL, a public address for the check and a private
 * one for the connection) is refused here, on the very answer the socket uses.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  lookupCallback(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const answer = addresses as LookupAddress[];
    const blocked = answer.length === 0 || answer.some((a) => isPrivateAddress(a.address));
    if (blocked) {
      const refused: NodeJS.ErrnoException = new Error(
        `Blocked: ${hostname} resolves to a private address`,
      );
      refused.code = BLOCKED_AT_CONNECT;
      return callback(refused, '');
    }
    if (options.all) return callback(null, answer);
    const first = answer[0] as LookupAddress;
    callback(null, first.address, first.family);
  });
}

let guardedAgent: Agent | undefined;

/**
 * The default fetch of `fetchPublic` when private hosts are not allowed: undici's own fetch over a
 * dispatcher whose connections resolve through `guardedLookup`. (The platform's fetch has no hook
 * at connect time, and a dispatcher of another undici major cannot be handed to it.)
 */
const guardedFetch = ((input: URL, init: RequestInit) => {
  guardedAgent ??= new Agent({ connect: { lookup: guardedLookup } });
  return undiciFetch(input, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: guardedAgent,
  });
}) as unknown as typeof fetch;

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

function detectCharset(
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
function decodeWindows1252(bytes: Uint8Array): string {
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

function tidyMarkdown(markdown: string): string {
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
  body?: string | Uint8Array<ArrayBuffer>;
  /** Default 5. */
  maxRedirects?: number;
  /** Dev/e2e only: allow localhost and private networks. */
  allowPrivateHosts?: boolean;
  fetchImpl?: typeof fetch;
  /** DNS for the host guard (default: the system resolver). */
  resolveHost?: HostResolver;
  /** Told about every request the host guard refuses, before the error is thrown. */
  onBlocked?: (request: BlockedRequest) => void;
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
  const doFetch = options.fetchImpl ?? (options.allowPrivateHosts ? fetch : guardedFetch);
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
    if (!options.allowPrivateHosts) {
      try {
        await assertPublicHost(url.hostname, options.resolveHost);
      } catch (error) {
        if (error instanceof FetchError && error.code === 'blocked') {
          options.onBlocked?.({ url, method, message: error.message });
        }
        throw error;
      }
    }
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
      if (cause?.code === BLOCKED_AT_CONNECT) {
        const message = cause.message ?? `Blocked: ${url.hostname} resolves to a private address`;
        options.onBlocked?.({ url, method, message });
        throw new FetchError('blocked', message);
      }
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
      resolveHost: options.resolveHost,
      onBlocked: options.onBlocked,
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
