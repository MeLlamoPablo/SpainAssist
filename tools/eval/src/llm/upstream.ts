import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import https from 'node:https';
import type { MeterErrorAnswer } from './limits';

/** HTTP plumbing of the meter proxy: routing helpers, body reading, and the upstream hop. */

const MAX_TEED_BYTES = 64 * 1024 * 1024;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

export function basePathOf(baseUrl: string): string {
  return new URL(baseUrl).pathname.replace(/\/+$/, '');
}

/** The path the upstream expects: hosts configured without the base path still get it. */
export function upstreamPathFor(basePath: string, rest: string): string {
  if (basePath === '' || rest === basePath || rest.startsWith(`${basePath}/`)) return rest;
  return `${basePath}${rest}`;
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        req.resume();
        resolve('too_large');
        return;
      }
      if (size <= limit) chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('close', () => {
      if (!req.complete)
        reject(new Error('the client closed the connection before the body ended'));
    });
  });
}

export function send(res: ServerResponse, answer: MeterErrorAnswer): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(answer.status, {
    ...answer.headers,
    'content-length': String(Buffer.byteLength(answer.body)),
  });
  res.end(answer.body);
}

export function sendError(
  res: ServerResponse,
  status: number,
  type: string,
  message: string,
): void {
  send(res, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-sa-eval': type },
    body: JSON.stringify({ error: { message, type, param: null, code: type } }),
  });
}

function requestHeaders(
  headers: IncomingHttpHeaders,
  upstream: URL,
  bodyLength: number,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined ||
      HOP_BY_HOP.has(name) ||
      name === 'host' ||
      name === 'content-length'
    ) {
      continue;
    }
    out[name] = value;
  }
  out.host = upstream.host;
  out['accept-encoding'] = 'identity';
  out['content-length'] = String(bodyLength);
  return out;
}

function flatResponseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (!HOP_BY_HOP.has(raw[i]!.toLowerCase())) out.push(raw[i]!, raw[i + 1]!);
  }
  return out;
}

export function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** What the upstream hop hands back to be settled. */
export interface ForwardResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was not kept whole (too large), so it cannot be cached. */
  truncated: boolean;
  aborted: boolean;
  transportError?: string;
  ttfbMs?: number;
}

/** Sends the request upstream and streams the answer back; resolves when it is over. */
export function forwardToUpstream(options: {
  req: IncomingMessage;
  res: ServerResponse;
  /** The full upstream URL (origin, path and query). */
  target: URL;
  raw: Buffer;
  agent: http.Agent | https.Agent;
  /** Requests in flight, so the proxy can abort them when it closes. */
  active: Set<http.ClientRequest>;
}): Promise<ForwardResult> {
  const { req, res, target, raw, agent, active } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const lib = target.protocol === 'https:' ? https : http;
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    let status = 0;
    let responseHeaders: IncomingHttpHeaders = {};
    let ttfbMs: number | undefined;
    const finish = (extra: Partial<ForwardResult> = {}): void => {
      if (settled) return;
      settled = true;
      resolve({
        status,
        headers: responseHeaders,
        body: Buffer.concat(chunks),
        truncated,
        aborted: false,
        ...(ttfbMs !== undefined ? { ttfbMs } : {}),
        ...extra,
      });
    };
    const upstreamReq = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: requestHeaders(req.headers, target, raw.length),
        agent,
      },
      (upstreamRes) => {
        status = upstreamRes.statusCode ?? 502;
        responseHeaders = upstreamRes.headers;
        ttfbMs = Date.now() - startedAt;
        res.writeHead(status, flatResponseHeaders(upstreamRes.rawHeaders));
        upstreamRes.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_TEED_BYTES) chunks.push(chunk);
          else truncated = true;
          if (!res.write(chunk)) {
            upstreamRes.pause();
            res.once('drain', () => upstreamRes.resume());
          }
        });
        upstreamRes.on('end', () => {
          res.end();
          finish();
        });
        upstreamRes.on('error', (error) => {
          res.destroy();
          finish({ aborted: true, transportError: error.message });
        });
        upstreamRes.on('close', () => {
          if (settled) return;
          res.destroy();
          finish({ aborted: true, transportError: 'the upstream closed the response early' });
        });
      },
    );
    active.add(upstreamReq);
    upstreamReq.on('close', () => active.delete(upstreamReq));
    upstreamReq.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      if (!res.headersSent) {
        sendError(
          res,
          502,
          'upstream_error',
          `Could not reach the model upstream: ${error.code ?? error.message}`,
        );
        finish({ status: 502, transportError: error.code ?? error.message });
      } else {
        res.destroy();
        finish({ aborted: true, transportError: error.message });
      }
    });
    res.on('close', () => {
      if (!settled && !res.writableEnded) {
        upstreamReq.destroy();
        finish({ aborted: true });
      }
    });
    upstreamReq.end(raw);
  });
}
