/**
 * Helpers shared by the browser proxy, the host process transport and the egress guard: the error
 * shapes of a dead network, the SpainBench request headers, request bodies and the scrubbing of
 * response headers. Plain Node (bundled into the eval host).
 */
import { createHash } from 'node:crypto';
import { type IncomingHttpHeaders, STATUS_CODES } from 'node:http';
import { isIP } from 'node:net';
import os from 'node:os';

// ---------------------------------------------------------------------------------------------
// The SpainBench contract (docs/EVAL.md, "SpainBench HTTP contract")
// ---------------------------------------------------------------------------------------------

export const HEADER_HOST = 'x-spainbench-host';
export const HEADER_WORLD = 'x-spainbench-world';
export const HEADER_SOURCE = 'x-spainbench-source';
export const HEADER_RESOURCE_TYPE = 'x-spainbench-resource-type';
export const HEADER_HARNESS = 'x-spainbench-harness';
const HEADER_KIND = 'x-spainbench-kind';
const HEADER_PAGE = 'x-spainbench-page';
const HEADER_SEQ = 'x-spainbench-seq';

/** Headers that describe one hop, never forwarded. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
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

/** True for every header of the harness' own contract: a client must never choose them. */
export function isBenchHeader(name: string): boolean {
  return name.toLowerCase().startsWith('x-spainbench-');
}

// ---------------------------------------------------------------------------------------------
// Errors of a network that does not answer
// ---------------------------------------------------------------------------------------------

/**
 * A stable address from the documentation ranges (RFC 5737) for a hostname. The host process'
 * DNS stand-in answers it, so the product's SSRF guard works offline, and errors name it where a
 * real error would name the server's address.
 */
export function docAddress(host: string): string {
  const h = createHash('sha256').update(host.toLowerCase()).digest();
  const range = ['192.0.2', '198.51.100', '203.0.113'][(h[0] as number) % 3];
  return `${range}.${1 + ((h[1] as number) % 253)}`;
}

export type NetworkFailure =
  | 'ENOTFOUND'
  | 'ECONNREFUSED'
  | 'ECONNRESET'
  | 'UND_ERR_CONNECT_TIMEOUT';

/** Node's default connect timeout, in ms (undici's). */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * What Node's `fetch` throws when the network fails: `TypeError: fetch failed` with a system error
 * as `cause`, whose `code` is what the tools show the model. Messages carry no loopback address,
 * port or file path.
 */
export function fetchFailed(
  code: NetworkFailure,
  host: string,
  opts: { port?: number; connectTimeoutMs?: number } = {},
): TypeError {
  const port = opts.port ?? 443;
  const cause = new Error() as Error & Record<string, unknown>;
  switch (code) {
    case 'ENOTFOUND':
      cause.message = `getaddrinfo ENOTFOUND ${host}`;
      cause.errno = -3008;
      cause.syscall = 'getaddrinfo';
      cause.hostname = host;
      break;
    case 'ECONNREFUSED': {
      // An address that was asked for by number is the address in the error; a name's address is
      // one the DNS stand-in would have given it.
      const address = isIP(host.replace(/^\[|\]$/g, ''))
        ? host.replace(/^\[|\]$/g, '')
        : docAddress(host);
      cause.message = `connect ECONNREFUSED ${address}:${port}`;
      cause.errno = -os.constants.errno.ECONNREFUSED;
      cause.syscall = 'connect';
      cause.address = address;
      cause.port = port;
      break;
    }
    case 'ECONNRESET':
      cause.message = 'read ECONNRESET';
      cause.errno = -os.constants.errno.ECONNRESET;
      cause.syscall = 'read';
      break;
    case 'UND_ERR_CONNECT_TIMEOUT':
      cause.name = 'ConnectTimeoutError';
      cause.message = `Connect Timeout Error (attempted address: ${host}:${port}, timeout: ${opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS}ms)`;
      break;
  }
  cause.code = code;
  return new TypeError('fetch failed', { cause });
}

/** `resBytes` of a record from the declared length, when the body is sent as it is. */
export function declaredLength(headers: IncomingHttpHeaders): { resBytes?: number } {
  const length = headers['content-length'];
  return length && /^\d+$/.test(length) && !headers['content-encoding']
    ? { resBytes: Number(length) }
    : {};
}

// ---------------------------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------------------------

/** The bytes of a fetch body (any `BodyInit`, streams included) and the content type fetch implies for it. */
export async function readRequestBody(
  body: BodyInit | null | undefined,
): Promise<{ bytes: Buffer; contentType?: string } | undefined> {
  if (body === null || body === undefined) return undefined;
  const probe = new Request('http://localhost/', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
  const bytes = Buffer.from(await probe.arrayBuffer());
  return { bytes, contentType: probe.headers.get('content-type') ?? undefined };
}

// ---------------------------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------------------------

export interface BenchHeaders {
  kind?: string;
  page?: string;
  seq?: number;
}

export interface Disguise {
  /** SpainBench's public listener (where responses are fetched from). */
  mock: URL;
  /** The origin the agent believes it requested (`https://portal.seg-social.gob.es`). */
  realOrigin: string;
}

/**
 * `headers` with `Date` set to the world's clock: the mock answers with the real time of the
 * machine, which would not agree with the date the agent is told. Without a clock the headers stay.
 */
export function withDate(
  headers: [string, string][],
  now: (() => Date) | undefined,
): [string, string][] {
  if (!now) return headers;
  return [
    ...headers.filter(([name]) => name.toLowerCase() !== 'date'),
    ['date', now().toUTCString()],
  ];
}

const TELL_TALE_SERVER = /spainbench|mock|node|express|localhost|127\.0\.0\.1/i;

/** The reason phrase of a status, as HTTP/1.1 servers send it (never the mock's own). */
export function statusText(status: number): string {
  return STATUS_CODES[status] ?? '';
}

/**
 * Response headers as the agent may see them. Dropped: the hop-by-hop headers, every
 * `X-SpainBench-*` header (kept apart in `bench`), `X-Powered-By`, and a `Server` that names the
 * mock. Any mention of SpainBench's own origin (`Location`, `Link`...) becomes the real origin.
 * Repeated headers (several `Set-Cookie`) stay separate.
 */
export function sanitizeResponseHeaders(
  raw: readonly string[],
  disguise: Disguise,
): { headers: [string, string][]; bench?: BenchHeaders } {
  const mockOrigin = mockOriginPattern(disguise.mock);
  const real = new URL(disguise.realOrigin);
  const headers: [string, string][] = [];
  const bench: BenchHeaders = {};
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const value = raw[i + 1] as string;
    const key = name.toLowerCase();
    if (isBenchHeader(key)) {
      if (key === HEADER_KIND) bench.kind = value;
      else if (key === HEADER_PAGE) bench.page = value;
      else if (key === HEADER_SEQ && /^\d+$/.test(value)) bench.seq = Number(value);
      continue;
    }
    if (HOP_BY_HOP.has(key) || key === 'x-powered-by') continue;
    if (key === 'server' && TELL_TALE_SERVER.test(value)) continue;
    headers.push([
      name,
      value.replace(mockOrigin, (_m, scheme: string | undefined) =>
        scheme ? real.origin : `//${real.host}`,
      ),
    ]);
  }
  return { headers, bench: Object.keys(bench).length ? bench : undefined };
}

function mockOriginPattern(mock: URL): RegExp {
  const names = new Set([mock.hostname, '127.0.0.1', 'localhost', '[::1]']);
  const port = mock.port ? `:${mock.port}` : '';
  const alternatives = [...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(https?:)?//(?:${alternatives})${port}(?![\\w.:-])`, 'gi');
}
