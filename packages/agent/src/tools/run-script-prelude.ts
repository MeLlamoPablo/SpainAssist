/**
 * Runs inside QuickJS before each script. QuickJS only has the JavaScript language, so this adds
 * the web APIs scripts expect: fetch/Headers/Response, URL/URLSearchParams, TextEncoder/
 * TextDecoder, atob/btoa, DOMException and console. URL parsing, text encoding and decoding go to
 * the host (Node), so they behave exactly like Node's. The `__host*` functions are removed from
 * the global scope before the script runs.
 *
 * Kept as raw source: no backticks or `${` inside.
 */
export const PRELUDE = String.raw`
const host = {
  fetch: globalThis.__hostFetch,
  log: globalThis.__hostLog,
  url: globalThis.__hostURL,
  urlSet: globalThis.__hostURLSet,
  encode: globalThis.__hostEncode,
  decoderNew: globalThis.__hostDecoderNew,
  decode: globalThis.__hostDecode,
  decodeBody: globalThis.__hostDecodeBody,
};
for (const name of Object.keys(globalThis)) if (name.startsWith('__host')) delete globalThis[name];

const define = (name, value) =>
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });

const toArrayBuffer = (input) => {
  if (input instanceof ArrayBuffer) return input;
  if (ArrayBuffer.isView(input)) {
    return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  }
  throw new TypeError('Expected an ArrayBuffer, a typed array or a DataView');
};

class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    this.name = name;
  }
}
define('DOMException', DOMException);

// --- TextEncoder / TextDecoder ------------------------------------------------------------------

class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input = '') { return new Uint8Array(host.encode(String(input))); }
  encodeInto(source, destination) {
    let read = 0;
    let written = 0;
    for (const char of String(source)) {
      const bytes = this.encode(char);
      if (written + bytes.length > destination.length) break;
      destination.set(bytes, written);
      written += bytes.length;
      read += char.length;
    }
    return { read, written };
  }
}
define('TextEncoder', TextEncoder);

const DECODER = Symbol('decoder');
class TextDecoder {
  constructor(label = 'utf-8', options = {}) {
    const info = JSON.parse(
      host.decoderNew(String(label), Boolean(options.fatal), Boolean(options.ignoreBOM)),
    );
    this[DECODER] = info.id;
    this.encoding = info.encoding;
    this.fatal = Boolean(options.fatal);
    this.ignoreBOM = Boolean(options.ignoreBOM);
  }
  decode(input, options = {}) {
    const buffer = input === undefined ? undefined : toArrayBuffer(input);
    return host.decode(this[DECODER], buffer, Boolean(options.stream));
  }
}
define('TextDecoder', TextDecoder);

// --- atob / btoa -------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
define('btoa', (input) => {
  const s = String(input);
  let out = '';
  for (let i = 0; i < s.length; i += 3) {
    const codes = [s.charCodeAt(i), s.charCodeAt(i + 1), s.charCodeAt(i + 2)];
    for (const c of codes) {
      if (c > 255) throw new DOMException('Invalid character', 'InvalidCharacterError');
    }
    const n = (codes[0] << 16) | ((codes[1] || 0) << 8) | (codes[2] || 0);
    const left = s.length - i;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += left > 1 ? B64[(n >> 6) & 63] : '=';
    out += left > 2 ? B64[n & 63] : '=';
  }
  return out;
});
define('atob', (input) => {
  let s = String(input).replace(/[\t\n\f\r ]/g, '');
  if (s.length % 4 === 0) s = s.replace(/==?$/, '');
  if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) {
    throw new DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
  }
  let out = '';
  let bits = 0;
  let buffer = 0;
  for (const char of s) {
    buffer = (buffer << 6) | B64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((buffer >> bits) & 255);
    }
  }
  return out;
});

// --- URLSearchParams ---------------------------------------------------------------------------

const LIST = Symbol('list');
const ON_CHANGE = Symbol('onChange');
const PARSE = Symbol('parse');
const CHANGED = Symbol('changed');

const formEncode = (s) =>
  encodeURIComponent(s)
    .replace(/%20/g, '+')
    .replace(/[!'()~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const formDecode = (s) => {
  const spaced = s.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    // Invalid escapes stay as they are; bytes that are not UTF-8 become U+FFFD.
    const bytes = [];
    for (let i = 0; i < spaced.length; i++) {
      const hex = spaced.slice(i + 1, i + 3);
      if (spaced[i] === '%' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 2;
      } else {
        const code = spaced.codePointAt(i);
        if (code > 0xffff) i++;
        bytes.push(...new TextEncoder().encode(String.fromCodePoint(code)));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
};

class URLSearchParams {
  constructor(init) {
    this[LIST] = [];
    this[ON_CHANGE] = null;
    if (init == null) return;
    if (typeof init === 'object' && typeof init[Symbol.iterator] === 'function') {
      for (const pair of init) {
        const entry = [...pair];
        if (entry.length !== 2) throw new TypeError('Each pair must have exactly two items');
        this[LIST].push([String(entry[0]), String(entry[1])]);
      }
    } else if (typeof init === 'object') {
      for (const key of Object.keys(init)) this[LIST].push([key, String(init[key])]);
    } else {
      this[PARSE](String(init));
    }
  }
  [PARSE](query) {
    this[LIST] = [];
    const s = query.startsWith('?') ? query.slice(1) : query;
    for (const part of s.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const name = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? '' : part.slice(eq + 1);
      this[LIST].push([formDecode(name), formDecode(value)]);
    }
  }
  [CHANGED]() { if (this[ON_CHANGE]) this[ON_CHANGE](this.toString()); }
  get size() { return this[LIST].length; }
  append(name, value) { this[LIST].push([String(name), String(value)]); this[CHANGED](); }
  delete(name, value) {
    const n = String(name);
    const v = value === undefined ? undefined : String(value);
    this[LIST] = this[LIST].filter(([k, x]) => !(k === n && (v === undefined || x === v)));
    this[CHANGED]();
  }
  get(name) {
    const hit = this[LIST].find(([k]) => k === String(name));
    return hit ? hit[1] : null;
  }
  getAll(name) { return this[LIST].filter(([k]) => k === String(name)).map(([, v]) => v); }
  has(name, value) {
    const n = String(name);
    const v = value === undefined ? undefined : String(value);
    return this[LIST].some(([k, x]) => k === n && (v === undefined || x === v));
  }
  set(name, value) {
    const n = String(name);
    const i = this[LIST].findIndex(([k]) => k === n);
    if (i === -1) this[LIST].push([n, String(value)]);
    else {
      this[LIST][i] = [n, String(value)];
      this[LIST] = this[LIST].filter(([k], j) => k !== n || j === i);
    }
    this[CHANGED]();
  }
  sort() {
    // Stable sort by UTF-16 code units, as the spec says.
    this[LIST] = this[LIST]
      .map((entry, i) => [entry, i])
      .sort((a, b) => (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]))
      .map(([entry]) => entry);
    this[CHANGED]();
  }
  forEach(callback, thisArg) {
    for (const [k, v] of this[LIST]) callback.call(thisArg, v, k, this);
  }
  *keys() { for (const [k] of this[LIST]) yield k; }
  *values() { for (const [, v] of this[LIST]) yield v; }
  *entries() { for (const [k, v] of this[LIST]) yield [k, v]; }
  [Symbol.iterator]() { return this.entries(); }
  toString() { return this[LIST].map(([k, v]) => formEncode(k) + '=' + formEncode(v)).join('&'); }
  get [Symbol.toStringTag]() { return 'URLSearchParams'; }
}
define('URLSearchParams', URLSearchParams);

// --- URL ---------------------------------------------------------------------------------------

const PARTS = Symbol('parts');
const PARAMS = Symbol('params');
const SET = Symbol('set');

class URL {
  constructor(url, base) {
    this[PARTS] = JSON.parse(host.url(String(url), base === undefined ? undefined : String(base)));
    this[PARAMS] = null;
  }
  static canParse(url, base) {
    try { new URL(url, base); return true; } catch { return false; }
  }
  static parse(url, base) {
    try { return new URL(url, base); } catch { return null; }
  }
  [SET](part, value) {
    this[PARTS] = JSON.parse(host.urlSet(this[PARTS].href, part, String(value)));
    if (this[PARAMS]) this[PARAMS][PARSE](this[PARTS].search);
  }
  get searchParams() {
    if (!this[PARAMS]) {
      this[PARAMS] = new URLSearchParams(this[PARTS].search);
      this[PARAMS][ON_CHANGE] = (query) => {
        this[PARTS] = JSON.parse(host.urlSet(this[PARTS].href, 'search', query));
      };
    }
    return this[PARAMS];
  }
  get origin() { return this[PARTS].origin; }
  toString() { return this[PARTS].href; }
  toJSON() { return this[PARTS].href; }
  get [Symbol.toStringTag]() { return 'URL'; }
}
for (const part of ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']) {
  Object.defineProperty(URL.prototype, part, {
    get() { return this[PARTS][part]; },
    set(value) { this[SET](part, value); },
    configurable: true,
  });
}
define('URL', URL);

// --- fetch / Headers / Response ----------------------------------------------------------------

class Headers {
  constructor(init) {
    this._map = new Map();
    const entries =
      init instanceof Headers ? init.entries() : Array.isArray(init) ? init : Object.entries(init ?? {});
    for (const [k, v] of entries) this._map.set(String(k).toLowerCase(), String(v));
  }
  get(k) { return this._map.get(String(k).toLowerCase()) ?? null; }
  has(k) { return this._map.has(String(k).toLowerCase()); }
  set(k, v) { this._map.set(String(k).toLowerCase(), String(v)); }
  append(k, v) {
    const key = String(k).toLowerCase();
    const old = this._map.get(key);
    this._map.set(key, old === undefined ? String(v) : old + ', ' + String(v));
  }
  delete(k) { this._map.delete(String(k).toLowerCase()); }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  forEach(cb) { this._map.forEach((v, k) => cb(v, k, this)); }
  [Symbol.iterator]() { return this._map.entries(); }
}
define('Headers', Headers);

class Response {
  constructor(meta, body) {
    this.status = meta.status;
    this.statusText = meta.statusText;
    this.ok = meta.status >= 200 && meta.status < 300;
    this.url = meta.url;
    this.redirected = meta.redirected;
    this.truncated = meta.truncated;
    this.headers = new Headers(meta.headers);
    this._body = body;
  }
  async arrayBuffer() { return this._body.slice(0); }
  async bytes() { return new Uint8Array(this._body.slice(0)); }
  async text() { return host.decodeBody(this._body, this.headers.get('content-type') ?? ''); }
  async json() { return JSON.parse(await this.text()); }
}
define('Response', Response);

define('fetch', async (input, init = {}) => {
  const url = input instanceof URL ? input.href : typeof input === 'object' && input?.url ? String(input.url) : String(input);
  const headers = new Headers(init.headers);
  let text;
  let binary;
  const body = init.body;
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    text = body.toString();
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    binary = toArrayBuffer(body);
  } else if (body != null) {
    text = String(body);
  }
  const meta = JSON.stringify({ url, method: init.method, headers: Object.fromEntries(headers.entries()), body: text });
  const result = await host.fetch(meta, binary);
  return new Response(JSON.parse(result.meta), result.body);
});

// --- console -----------------------------------------------------------------------------------

const show = (v) => {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack ? v.name + ': ' + v.message + '\n' + v.stack : String(v);
  if (v instanceof URL || v instanceof URLSearchParams) return v.toString();
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};
// Clipped here so the host never copies a huge line out of the engine.
const MAX_LOG_LINE = 32768;
const log = (...args) => {
  const line = args.map(show).join(' ');
  host.log(line.length > MAX_LOG_LINE ? line.slice(0, MAX_LOG_LINE) : line);
};
define('console', { log, info: log, warn: log, error: log, debug: log });
`;
