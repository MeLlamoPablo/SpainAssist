/**
 * The scoring API client: `BenchApi` (contracts.ts) over HTTP, for the harness only. It talks to
 * SpainBench's scoring listener and never to the public one (that is where the agent's traffic
 * goes, through the network layer).
 *
 * Every answer is validated with zod: strict about the fields the harness uses, tolerant of extra
 * ones (a newer server may add fields; they are kept). Every failure is a `BenchError` whose message
 * names the endpoint and never carries the token. Every request has a timeout and takes an
 * `AbortSignal`. Redirects are never followed (the token must not travel anywhere else).
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type BenchApi,
  type BenchEvent,
  type BenchHost,
  type BenchVersion,
  type BenchWorldState,
  SUPPORTED_SCORING_API,
} from '../contracts';
import { sameLoopbackListener } from '../net/hosts';
import { versionMismatch } from './check';
import { BenchError, type BenchErrorCode } from './errors';
import { normalizeOrigin } from './origin';

/** Ordinary requests give up after this long. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** The longest the server holds an `events` long poll. */
const MAX_WAIT_MS = 60_000;
/** The biggest answer the client reads (a snapshot with its files and log is the largest). */
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
/** What the server accepts as a world id. */
export const BENCH_WORLD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A fresh world id: 16 random hex characters. The agent can read the world's id in what it is shown
 * (SpainBench puts it in the URLs of its planted notices), so it carries nothing about the run:
 * never the run id, the fixture, the variant or the provider.
 */
export function newWorldId(): string {
  return randomBytes(8).toString('hex');
}

export interface BenchApiOptions {
  /** `http://127.0.0.1:<port>` of the public listener (reported as `BenchApi.publicOrigin`). */
  publicOrigin: string;
  /** `http://127.0.0.1:<port>` of the scoring listener. */
  scoringOrigin: string;
  /** The scoring token (`X-Benchmark-Token`). */
  token: string;
  /** Tests: another `fetch`. Looked up at call time, so a patched `globalThis.fetch` is honoured. */
  fetch?: typeof fetch;
  /** Per request (an `events` long poll adds its wait to it). Default 30 s. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// What the server answers
// ---------------------------------------------------------------------------------------------

const count = z.number().int().nonnegative();
const record = z.record(z.string(), z.unknown());

const VersionSchema = z.looseObject({
  name: z.literal('spainbench'),
  version: z.string(),
  gitSha: z.string().optional(),
  scoringApi: z.number().int(),
  snapshotFormat: z.string(),
  contentHash: z.string(),
  sites: z.record(z.string(), z.looseObject({ version: z.string(), contentHash: z.string() })),
  features: z.array(z.string()),
  injections: z.array(
    z.looseObject({ id: z.string(), summary: z.string(), points: z.array(z.string()).optional() }),
  ),
});

const HostsSchema = z.looseObject({
  hosts: z.array(
    z.looseObject({
      host: z.string().min(1),
      site: z.string(),
      key: z.string(),
      kind: z.enum(['site', 'asset', 'external']),
    }),
  ),
});

const CreatedSchema = z.looseObject({
  id: z.string(),
  warnings: z.array(z.string()).optional(),
  /** What the sites of the world say about being a copy: hidden (true) or not. */
  disguise: z.boolean().optional(),
});

const DownloadSchema = z.looseObject({
  site: z.string(),
  filename: z.string(),
  contentType: z.string(),
  bytes: count,
  sha256: z.string(),
  at: z.string(),
  record,
});

const WrongTurnSchema = z.looseObject({
  seq: count,
  host: z.string(),
  path: z.string(),
  kind: z.enum(['not-found', 'out-of-scope', 'unknown-host', 'forbidden']),
  reason: z.string().optional(),
});

const ExfilSchema = z.looseObject({
  seq: count,
  host: z.string(),
  registeredCollector: z.boolean(),
  method: z.string(),
  url: z.string(),
  canaryHits: z.array(z.string()),
  source: z.string().optional(),
});

const PlantServedSchema = z.looseObject({
  id: z.string(),
  // A site that did not name the page it served the plant on leaves it out (null on the wire).
  page: z
    .string()
    .nullish()
    .transform((page) => page ?? ''),
  seq: count,
});

const StateSchema = z.looseObject({
  id: z.string(),
  sites: record,
  downloads: z.array(DownloadSchema),
  wrongTurns: z.looseObject({ count, items: z.array(WrongTurnSchema) }),
  exfil: z.looseObject({ count, items: z.array(ExfilSchema) }),
  plantsServed: z.array(PlantServedSchema),
  counters: z.looseObject({ seq: count, requests: count }),
});

const EventSchema = z
  .looseObject({
    seq: count,
    t: z.string(),
    type: z.string().min(1),
    request: count.nullish(),
    data: z.unknown().optional(),
  })
  .transform(
    ({ request, ...event }): BenchEvent => (request == null ? event : { ...event, request }),
  );

const EventsSchema = z.looseObject({
  events: z.array(EventSchema),
  next: count,
  truncated: z.boolean(),
});

const RequestsSchema = z.looseObject({
  requests: z.array(z.looseObject({ seq: count })),
  next: count,
  truncated: z.boolean(),
  total: count,
});

const SnapshotSchema = z.looseObject({ format: z.string().min(1) });

const WorldSummarySchema = z.looseObject({ id: z.string() });

// ---------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------

interface Call {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Starts with `/`, path segments already encoded, no query. */
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Statuses besides 2xx the caller handles itself. */
  accept?: readonly number[];
}

interface Reply {
  status: number;
  headers: Headers;
  body: Uint8Array;
  endpoint: string;
}

/** The error an HTTP failure status (400 or more) stands for. */
function classifyStatus(status: number): { code: BenchErrorCode; what: string } {
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', what: 'the scoring token was refused' };
  }
  if (status === 404) return { code: 'not_found', what: 'not found' };
  if (status === 409) return { code: 'conflict', what: 'conflict' };
  if (status === 410) return { code: 'gone', what: 'the world is gone' };
  if (status >= 500) return { code: 'server', what: 'the server failed' };
  return { code: 'bad_request', what: 'the request was refused' };
}

function originOf(value: string, name: string): string {
  const origin = normalizeOrigin(value);
  if (!origin) {
    throw new TypeError(
      `${name} must be an http(s) origin like http://127.0.0.1:3010 (got "${value}")`,
    );
  }
  return origin;
}

function assertWorldId(id: string, endpoint: string): void {
  if (!BENCH_WORLD_ID_PATTERN.test(id)) {
    throw new BenchError(
      'bad_request',
      endpoint,
      `"${id.slice(0, 80)}" is not a world id (1 to 64 letters, digits, "-" or "_")`,
    );
  }
}

function assertCount(value: number, name: string, endpoint: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BenchError('bad_request', endpoint, `${name} must be a non-negative integer`);
  }
}

async function readBody(response: Response, limit: number, endpoint: string): Promise<Uint8Array> {
  const tooBig = (size: string) =>
    new BenchError(
      'invalid_response',
      endpoint,
      `the answer (${size} bytes) exceeds ${limit} bytes`,
      {
        status: response.status,
      },
    );
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw tooBig(String(declared));
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooBig(`over ${limit}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** What an error answer says, on one line (`{ "error": "..." }`). */
function serverMessage(body: Uint8Array): string | undefined {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body.subarray(0, 4096)));
    const message = (parsed as { error?: unknown } | null)?.error;
    if (typeof message === 'string' && message.trim()) {
      return message.replace(/\s+/g, ' ').trim().slice(0, 300);
    }
  } catch {
    // Not JSON: nothing worth quoting.
  }
  return undefined;
}

function summarize(error: z.ZodError): string {
  const shown = error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path || '(answer)'}: ${issue.message}`;
  });
  return (
    shown.join('; ') + (error.issues.length > 3 ? `; and ${error.issues.length - 3} more` : '')
  );
}

class Transport {
  constructor(
    readonly scoringOrigin: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly fetchOverride: typeof fetch | undefined,
  ) {}

  /** Keeps the token out of anything that is shown (a server could echo a header back). */
  private scrub(text: string): string {
    return text.split(this.token).join('***');
  }

  get defaultTimeoutMs(): number {
    return this.timeoutMs;
  }

  async send(call: Call): Promise<Reply> {
    const endpoint = `${call.method} ${call.path}`;
    const url = new URL(call.path, this.scoringOrigin);
    for (const [name, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const timeoutMs = call.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const forward = () => controller.abort();
    call.signal?.addEventListener('abort', forward, { once: true });
    if (call.signal?.aborted) forward();
    try {
      const doFetch = this.fetchOverride ?? globalThis.fetch;
      const response = await doFetch(url, {
        method: call.method,
        headers: {
          'X-Benchmark-Token': this.token,
          Accept: 'application/json, */*;q=0.5',
          ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        redirect: 'manual',
        signal: controller.signal,
      });
      const body = await readBody(response, MAX_RESPONSE_BYTES, endpoint);
      return this.check(
        { status: response.status, headers: response.headers, body, endpoint },
        call,
      );
    } catch (error) {
      if (error instanceof BenchError) throw error;
      if (call.signal?.aborted) {
        throw new BenchError('aborted', endpoint, 'the request was aborted', { cause: error });
      }
      const reason = timedOut
        ? `timed out after ${timeoutMs} ms`
        : this.scrub(describeFailure(error));
      throw new BenchError(
        'unreachable',
        endpoint,
        `cannot reach ${this.scoringOrigin} (${reason})`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      call.signal?.removeEventListener('abort', forward);
    }
  }

  /** Turns an HTTP answer the caller did not ask for into the error that says what happened. */
  private check(reply: Reply, call: Call): Reply {
    const { status, endpoint } = reply;
    if ((status >= 200 && status < 300) || call.accept?.includes(status)) return reply;
    if (status < 400) {
      // The scoring API never redirects; following one could take the token elsewhere.
      throw new BenchError(
        'invalid_response',
        endpoint,
        `unexpected HTTP ${status}${reply.headers.has('location') ? ' redirect (not followed)' : ''}`,
        { status },
      );
    }
    const { code, what } = classifyStatus(status);
    const said = serverMessage(reply.body);
    throw new BenchError(
      code,
      endpoint,
      `${what} (HTTP ${status}${said ? `: ${this.scrub(said)}` : ''})`,
      { status },
    );
  }

  /** Reads an answer as JSON and validates it. */
  decode<S extends z.ZodType>(schema: S, reply: Reply): z.output<S> {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(reply.body));
    } catch {
      throw new BenchError('invalid_response', reply.endpoint, 'the answer is not JSON', {
        status: reply.status,
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new BenchError(
        'invalid_response',
        reply.endpoint,
        `unexpected answer: ${this.scrub(summarize(parsed.error))}`,
        { status: reply.status },
      );
    }
    return parsed.data;
  }

  /** The `scoringApi` an answer claims, whatever else it holds. */
  static peekScoringApi(reply: Reply): number | undefined {
    try {
      const json: unknown = JSON.parse(new TextDecoder().decode(reply.body));
      const peeked = z
        .looseObject({ name: z.literal('spainbench'), scoringApi: z.number().int() })
        .safeParse(json);
      return peeked.success ? peeked.data.scoringApi : undefined;
    } catch {
      return undefined;
    }
  }
}

/** The most useful line of a failed `fetch`: undici hides the reason in `cause`. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return error.message;
}

// ---------------------------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------------------------

/**
 * A client of the scoring API of the server at `scoringOrigin`. Throws `TypeError` for options that
 * cannot work (an origin that is not one, the same origin for both listeners: the agent's traffic
 * would then reach the scoring API, an empty or unprintable token).
 */
export function createBenchApi(options: BenchApiOptions): BenchApi {
  const publicOrigin = originOf(options.publicOrigin, 'publicOrigin');
  const scoringOrigin = originOf(options.scoringOrigin, 'scoringOrigin');
  if (publicOrigin === scoringOrigin || sameLoopbackListener(publicOrigin, scoringOrigin)) {
    throw new TypeError(
      `publicOrigin (${publicOrigin}) and scoringOrigin (${scoringOrigin}) are one listener: the scoring API must never be what the agent reaches`,
    );
  }
  if (!/^[\x21-\x7e]+$/.test(options.token)) {
    throw new TypeError('token must be a non-empty string of printable characters without spaces');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive number of milliseconds');
  }
  const transport = new Transport(scoringOrigin, options.token, timeoutMs, options.fetch);

  const world = (id: string, tail: string, method: Call['method']): string => {
    const endpoint = `${method} /worlds/${id.slice(0, 80)}${tail}`;
    assertWorldId(id, endpoint);
    return `/worlds/${id}${tail}`;
  };

  const api: BenchApi = {
    publicOrigin,
    scoringOrigin,

    async version(): Promise<BenchVersion> {
      const reply = await transport.send({ method: 'GET', path: '/version' });
      try {
        return transport.decode(VersionSchema, reply);
      } catch (error) {
        // A server of another scoring API may have changed this very document: say which side to
        // update rather than which field moved.
        const theirs = Transport.peekScoringApi(reply);
        if (theirs !== undefined && theirs !== SUPPORTED_SCORING_API) throw versionMismatch(theirs);
        throw error;
      }
    },

    async hosts(): Promise<BenchHost[]> {
      const reply = await transport.send({ method: 'GET', path: '/meta/hosts' });
      return transport
        .decode(HostsSchema, reply)
        .hosts.map(({ host, site, key, kind }) => ({ host, site, key, kind }));
    },

    async createWorld(spec, createOptions = {}) {
      const body = {
        ...spec,
        // Never left to the server's default (`SPAINBENCH_DISGUISE=0` is for people reading a copy).
        disguise: true,
        ...(createOptions.snapshot === undefined ? {} : { snapshot: createOptions.snapshot }),
        ...(createOptions.replace ? { replace: true } : {}),
      };
      const reply = await transport.send({ method: 'POST', path: '/worlds', body });
      const created = transport.decode(CreatedSchema, reply);
      if (created.id !== spec.id) {
        throw new BenchError(
          'invalid_response',
          reply.endpoint,
          `created world "${created.id}" instead of "${spec.id}"`,
          { status: reply.status },
        );
      }
      // The server says what the world is (a restored snapshot keeps its own setting): a copy
      // that tells the agent it is a copy would contaminate every verdict, so nothing runs in it.
      if (created.disguise !== true) {
        await api.deleteWorld(created.id).catch(() => undefined);
        throw new BenchError(
          'invalid_response',
          reply.endpoint,
          created.disguise === false
            ? `world "${created.id}" is not disguised: its pages and files say they are a copy. The server runs with SPAINBENCH_DISGUISE=0, or the snapshot was taken from an undisguised world`
            : `the server did not say whether world "${created.id}" is disguised: it is too old for this harness (update SpainBench)`,
          { status: reply.status },
        );
      }
      return { id: created.id, warnings: created.warnings ?? [] };
    },

    async deleteWorld(id) {
      // A world that is already gone is what the caller wants.
      await transport.send({
        method: 'DELETE',
        path: world(id, '', 'DELETE'),
        accept: [404, 410],
      });
    },

    async state(id): Promise<BenchWorldState> {
      const reply = await transport.send({ method: 'GET', path: world(id, '/state', 'GET') });
      const state = transport.decode(StateSchema, reply);
      if (state.id !== id) {
        throw new BenchError(
          'invalid_response',
          reply.endpoint,
          `the state is of world "${state.id}"`,
          { status: reply.status },
        );
      }
      return state;
    },

    async events(id, since, eventOptions = {}) {
      const path = world(id, '/events', 'GET');
      assertCount(since, 'since', `GET ${path}`);
      const requested = eventOptions.waitMs ?? 0;
      assertCount(requested, 'waitMs', `GET ${path}`);
      const waitMs = Math.min(requested, MAX_WAIT_MS);
      const reply = await transport.send({
        method: 'GET',
        path,
        query: { since, wait: waitMs },
        signal: eventOptions.signal,
        // The server holds the request for `waitMs`: the HTTP timeout starts after that.
        timeoutMs: waitMs + transport.defaultTimeoutMs,
        accept: [410],
      });
      if (reply.status === 410) return 'gone';
      return transport.decode(EventsSchema, reply);
    },

    async requests(id, since, limit) {
      const path = world(id, '/requests', 'GET');
      if (since !== undefined) assertCount(since, 'since', `GET ${path}`);
      if (limit !== undefined) assertCount(limit, 'limit', `GET ${path}`);
      const reply = await transport.send({ method: 'GET', path, query: { since, limit } });
      return transport.decode(RequestsSchema, reply);
    },

    async snapshot(id, snapshotOptions = {}) {
      const reply = await transport.send({
        method: 'GET',
        path: world(id, '/snapshot', 'GET'),
        query: { log: snapshotOptions.keepLog ? 1 : undefined },
      });
      return transport.decode(SnapshotSchema, reply);
    },

    async download(id, n) {
      const base = world(id, '/downloads', 'GET');
      assertCount(n, 'n', `GET ${base}/${n}`);
      const reply = await transport.send({ method: 'GET', path: `${base}/${n}` });
      const claimed = reply.headers.get('x-content-sha256')?.trim().toLowerCase();
      if (!claimed || !/^[0-9a-f]{64}$/.test(claimed)) {
        throw new BenchError(
          'invalid_response',
          reply.endpoint,
          'the file came without a valid X-Content-Sha256 header',
          { status: reply.status },
        );
      }
      const actual = createHash('sha256').update(reply.body).digest('hex');
      if (actual !== claimed) {
        throw new BenchError(
          'invalid_response',
          reply.endpoint,
          `the file's SHA-256 is ${actual} but the server says ${claimed}`,
          { status: reply.status },
        );
      }
      return { bytes: reply.body, sha256: actual };
    },

    async setPlants(id, plants) {
      const reply = await transport.send({
        method: 'PUT',
        path: world(id, '/plants', 'PUT'),
        body: plants,
      });
      transport.decode(WorldSummarySchema, reply);
    },
  };
  return api;
}
