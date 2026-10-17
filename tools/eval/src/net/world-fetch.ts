/**
 * `createWorldFetch`: the `fetch` the agent host process uses in evaluation runs. It keeps the URL
 * the agent believes it requested (the real one) and changes only where the socket goes: every
 * mapped host is served by SpainBench's public listener, with the real `Host` and the contract
 * headers of docs/EVAL.md. Every other host fails like a dead domain.
 *
 * It is built on `node:http` because undici's `fetch` silently drops a `Host` override. Redirects
 * follow `fetch`'s own semantics (manual / error / follow, with the method and header rules of the
 * spec), each hop is routed again and each hop is one `NetRecord`.
 *
 * Plain Node: bundled into the eval host (`dist/eval-host.js`); it must not import `@sa/agent`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import { isIP } from 'node:net';
import { PassThrough, Readable, type Transform } from 'node:stream';
import zlib from 'node:zlib';
import type { HostEvalConfig, NetChannel, NetRecord } from '../contracts';
import { HostTable, isLoopbackHost, sameLoopbackListener } from './hosts';
import { bodyFields, headersToRecord, type NetLog } from './netlog';
import {
  CONNECT_TIMEOUT_MS,
  declaredLength,
  fetchFailed,
  HEADER_HARNESS,
  HEADER_HOST,
  HEADER_SOURCE,
  HEADER_WORLD,
  HOP_BY_HOP,
  isBenchHeader,
  type NetworkFailure,
  readRequestBody,
  sanitizeResponseHeaders,
  statusText,
  withDate,
} from './wire';

// ---------------------------------------------------------------------------------------------
// Which tool call a request belongs to
// ---------------------------------------------------------------------------------------------

/** The agent tool call that makes the requests running inside `withCallContext`. */
export interface CallContext {
  toolCallId?: string;
  tool?: string;
}

const calls = new AsyncLocalStorage<CallContext>();

/**
 * Runs `fn` with `ctx` as the call context of every request it makes (also through QuickJS host
 * callbacks and concurrent tool calls: the store follows the async chain). The host entry wraps
 * each tool's `execute` with it.
 */
export function withCallContext<T>(ctx: CallContext, fn: () => T): T {
  return calls.run(ctx, fn);
}

export function currentCallContext(): CallContext | undefined {
  return calls.getStore();
}

/** The `NetChannel` (and `X-SpainBench-Source`) of the requests of a tool. */
export function channelOfTool(tool: string | undefined): NetChannel {
  switch (tool) {
    case 'fetch_url':
    case 'run_script':
    case 'boe_search':
    case 'web_research':
      return tool;
    case 'exa_search':
    case 'exa_fetch':
      return 'exa';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------------------------
// The transport
// ---------------------------------------------------------------------------------------------

export interface WorldFetchConfig {
  worldId: string;
  /** Loopback origin of SpainBench's public listener: the only upstream this fetch connects to. */
  mockOrigin: string;
  /** The scoring listener's origin: refused as the upstream (the agent must never reach it). */
  scoringOrigin: string;
  /** Real hosts served by SpainBench: a table, or the patterns of `HostEvalConfig.routes`. */
  routes: HostTable | readonly string[];
  /** What a host that is not mapped looks like. */
  unmapped: HostEvalConfig['unmapped'];
}

export interface WorldFetchOptions {
  /** Time before a `timeout` unmapped host gives up, in ms. Default Node's 10 s. */
  connectTimeoutMs?: number;
  /** The world's clock (the frozen instant, moving at real speed): responses get its time as `Date`. */
  now?(): Date;
}

const MAX_REDIRECTS = 20;
const NOT_FOUND_PAGE =
  '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body><h1>Not Found</h1>' +
  '<p>The requested URL was not found on this server.</p></body></html>\n';

interface Hop {
  url: URL;
  method: string;
  /** What the agent sent (lower-case names). */
  headers: Record<string, string>;
  body?: Buffer;
}

interface HopResult {
  status: number;
  headers: [string, string][];
  /** The (decoded) body; null when the response has none. */
  stream: Readable | null;
}

export function createWorldFetch(
  cfg: WorldFetchConfig,
  log: NetLog,
  opts: WorldFetchOptions = {},
): typeof fetch {
  const hosts = cfg.routes instanceof HostTable ? cfg.routes : new HostTable(cfg.routes);
  const mock = new URL(cfg.mockOrigin);
  if (mock.protocol !== 'http:' || !isLoopbackHost(mock.hostname))
    throw new Error(`The mock origin must be a plain http loopback origin (got ${cfg.mockOrigin})`);
  if (sameLoopbackListener(mock, cfg.scoringOrigin))
    throw new Error('The mock origin is the scoring listener: the agent must never reach it');
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

  async function sendHop(hop: Hop, signal: AbortSignal | undefined): Promise<HopResult> {
    const ctx = currentCallContext();
    const channel = channelOfTool(ctx?.tool);
    const url = hop.url;
    const seq = log.nextSeq();
    const t = log.stamp();
    const started = performance.now();
    const base = {
      seq,
      t,
      channel,
      ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
      method: hop.method,
      url: url.href,
      host: url.hostname,
      reqHeaders: hop.headers,
      ...bodyFields(hop.body, hop.body?.length ?? 0),
    };
    let written = false;
    const write = (rest: Pick<NetRecord, 'route'> & Partial<NetRecord>) => {
      if (written) return;
      written = true;
      log.append({ ...base, durationMs: Math.round(performance.now() - started), ...rest });
    };
    const failWith = (code: NetworkFailure, why: string): never => {
      write({ route: 'unmapped', error: `${code}: ${why}` });
      throw fetchFailed(code, url.hostname, { port: portOf(url), connectTimeoutMs });
    };

    // A mapped host answers on the ports of a real site (80, 443) and nowhere else; a number is
    // not a name, so an address that is not mapped cannot fail as an unknown domain.
    const bareHost = url.hostname.replace(/^\[|\]$/g, '');
    if (hosts.has(url.hostname) && url.port !== '')
      return failWith('ECONNREFUSED', `${url.hostname} does not listen on port ${url.port}`);
    if (!hosts.has(url.hostname)) {
      const mode =
        isIP(bareHost) && cfg.unmapped.mode === 'enotfound'
          ? ({ mode: 'econnrefused' } as const)
          : cfg.unmapped;
      if (mode.mode === 'status') {
        const body = mode.status === 404 ? NOT_FOUND_PAGE : `${statusText(mode.status)}\n`;
        write({ route: 'unmapped', status: mode.status, resBytes: Buffer.byteLength(body) });
        return {
          status: mode.status,
          headers: [['content-type', 'text/html; charset=utf-8']],
          stream: Readable.from([Buffer.from(body)]),
        };
      }
      if (mode.mode === 'timeout') {
        await abortableDelay(connectTimeoutMs, signal).catch((err) => {
          write({ route: 'unmapped', error: 'aborted while waiting for an unmapped host' });
          throw err;
        });
        return failWith('UND_ERR_CONNECT_TIMEOUT', 'host is not mapped');
      }
      return failWith(
        mode.mode === 'econnrefused' ? 'ECONNREFUSED' : 'ENOTFOUND',
        'host is not mapped',
      );
    }

    const upstreamHeaders = upstreamRequestHeaders(hop, channel, cfg.worldId);
    const upstream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      let responded = false;
      const req = http.request({
        agent,
        host: mock.hostname.replace(/^\[|\]$/g, ''),
        port: mock.port || 80,
        method: hop.method,
        path: `${url.pathname}${url.search}`,
        headers: upstreamHeaders,
        signal,
      });
      req.once('response', (res) => {
        responded = true;
        resolve(res);
      });
      // After the response, failures reach the body stream (responseBody), not here.
      req.on('error', (err: NodeJS.ErrnoException) => {
        if (responded) return;
        if (signal?.aborted) {
          write({ route: 'mapped', error: 'aborted' });
          reject(signal.reason ?? err);
          return;
        }
        const code = err.code === 'ECONNREFUSED' ? 'ECONNREFUSED' : 'ECONNRESET';
        write({ route: 'mapped', error: `${err.code ?? err.name}: ${err.message}` });
        reject(fetchFailed(code, url.hostname, { port: portOf(url) }));
      });
      req.end(hop.body);
    });

    const { headers, bench } = sanitizeResponseHeaders(upstream.rawHeaders, {
      mock,
      realOrigin: url.origin,
    });
    const status = upstream.statusCode ?? 502;
    const noBody = hop.method === 'HEAD' || [101, 204, 205, 304].includes(status);
    // Written as soon as the answer is known: whether and when the agent reads the body is its own
    // business, and an attempt must be on the record even if it never does.
    write({
      route: 'mapped',
      status,
      ...(bench ? { bench } : {}),
      ...(noBody ? { resBytes: 0 } : declaredLength(upstream.headers)),
    });
    if (noBody) upstream.resume();
    return {
      status,
      headers: withDate(headers, opts.now),
      stream: noBody ? null : responseBody(upstream, signal),
    };
  }

  return async function worldFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const request = await normalizeRequest(input, init);
    const redirectMode = request.redirect;
    let hop: Hop = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.body,
    };
    let redirected = false;
    for (let count = 0; ; count++) {
      const result = await sendHop(hop, request.signal);
      const location = redirectLocation(result);
      if (location === undefined || redirectMode === 'manual')
        return toResponse(result, hop, redirected);
      result.stream?.resume();
      if (redirectMode === 'error')
        throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      if (count >= MAX_REDIRECTS)
        throw new TypeError('fetch failed', { cause: new Error('redirect count exceeded') });
      let next: URL;
      try {
        next = new URL(location, hop.url);
      } catch {
        throw new TypeError('fetch failed', { cause: new Error('invalid URL') });
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:')
        throw new TypeError('fetch failed', { cause: new Error('unknown scheme') });
      hop = redirectHop(hop, next, result.status);
      redirected = true;
    }
  } as typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// Request side
// ---------------------------------------------------------------------------------------------

interface NormalizedRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  redirect: RequestRedirect;
  signal?: AbortSignal;
}

const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);
const NORMALIZED_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> {
  const fromRequest = input instanceof Request ? input : undefined;
  let url: URL;
  try {
    url = new URL(fromRequest ? fromRequest.url : String(input));
  } catch (cause) {
    throw new TypeError(`Failed to parse URL from ${String(input)}`, { cause });
  }
  if (url.username || url.password)
    throw new TypeError(
      `Request cannot be constructed from a URL that includes credentials: ${url.href}`,
    );
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError('fetch failed', { cause: new Error('unknown scheme') });
  let method = (init?.method ?? fromRequest?.method ?? 'GET').toString();
  if (NORMALIZED_METHODS.has(method.toUpperCase())) method = method.toUpperCase();
  if (FORBIDDEN_METHODS.has(method.toUpperCase()))
    throw new TypeError(`'${method}' HTTP method is unsupported.`);
  const headers = new Headers(init?.headers ?? fromRequest?.headers);
  let body = await readRequestBody(init?.body as BodyInit | null | undefined);
  if (init?.body === undefined && fromRequest?.body)
    body = { bytes: Buffer.from(await fromRequest.arrayBuffer()) };
  if (body && (method === 'GET' || method === 'HEAD'))
    throw new TypeError('Request with GET/HEAD method cannot have body.');
  if (body?.contentType && !headers.has('content-type'))
    headers.set('content-type', body.contentType);
  return {
    url,
    method,
    headers: headersToRecord(headers),
    body: body?.bytes,
    redirect: init?.redirect ?? fromRequest?.redirect ?? 'follow',
    signal: init?.signal ?? fromRequest?.signal ?? undefined,
  };
}

const DEFAULT_HEADERS: Record<string, string> = {
  accept: '*/*',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
};

function upstreamRequestHeaders(
  hop: Hop,
  channel: NetChannel,
  worldId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(hop.headers)) {
    if (name === 'host' || name === 'content-length' || name === 'accept-encoding') continue;
    if (HOP_BY_HOP.has(name) || isBenchHeader(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(DEFAULT_HEADERS)) out[name] ??= value;
  if (hop.body || hop.method === 'POST' || hop.method === 'PUT')
    out['content-length'] = String(hop.body?.length ?? 0);
  // The mock answers uncompressed bodies: no decoding in the way of what the agent reads.
  out['accept-encoding'] = 'identity';
  out.host = hop.url.host;
  out[HEADER_HOST] = hop.url.host;
  out[HEADER_WORLD] = worldId;
  out[HEADER_SOURCE] = channel;
  out[HEADER_HARNESS] = '1';
  out['x-forwarded-proto'] = hop.url.protocol.slice(0, -1);
  return out;
}

function portOf(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443;
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------------

function redirectLocation(result: HopResult): string | undefined {
  if (![301, 302, 303, 307, 308].includes(result.status)) return undefined;
  return result.headers.find(([name]) => name.toLowerCase() === 'location')?.[1];
}

/** The next request of a redirect chain, with the rules of the fetch spec. */
function redirectHop(previous: Hop, next: URL, status: number): Hop {
  const headers = { ...previous.headers };
  let { method, body } = previous;
  if (
    status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST'
  ) {
    method = 'GET';
    if (body) {
      body = undefined;
      for (const name of [
        'content-type',
        'content-encoding',
        'content-language',
        'content-location',
      ])
        delete headers[name];
    }
  }
  if (next.origin !== previous.url.origin) {
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) delete headers[name];
  }
  return { url: next, method, headers, body };
}

// ---------------------------------------------------------------------------------------------
// Response side
// ---------------------------------------------------------------------------------------------

/**
 * The body as the agent reads it: decoded like `fetch` does. A failure of the exchange (or the
 * caller's abort) is what the reader sees.
 */
function responseBody(upstream: http.IncomingMessage, signal: AbortSignal | undefined): Readable {
  const out = new PassThrough();
  out.on('error', () => {}); // the reader gets it on the web stream
  const fail = (err: Error) => out.destroy(signal?.aborted ? (signal.reason as Error) : err);
  const decoder = decoderFor(upstream.headers['content-encoding']);
  upstream.once('error', fail);
  upstream.once('close', () => {
    if (!upstream.complete) fail(new Error('terminated'));
  });
  decoder?.once('error', fail);
  out.once('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
  (decoder ? upstream.pipe(decoder) : upstream).pipe(out);
  return out;
}

function decoderFor(encoding: string | undefined): Transform | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return undefined;
  }
}

function toResponse(result: HopResult, hop: Hop, redirected: boolean): Response {
  const response = new Response(
    result.stream ? (Readable.toWeb(result.stream) as unknown as ReadableStream) : null,
    {
      status: result.status,
      statusText: statusText(result.status),
      headers: new Headers(result.headers),
    },
  );
  Object.defineProperty(response, 'url', { value: hop.url.href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
}
