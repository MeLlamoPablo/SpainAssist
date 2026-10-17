/**
 * A fake SpainBench scoring API on `node:http` (loopback only), with the semantics the client and
 * the follower depend on: the token check, worlds that exist / are gone / were replaced, a shared
 * sequence of log entries and events, the long poll (with `gone` and truncation), request paging,
 * snapshots, downloads with their SHA-256, and `intercept` rules to make any call fail, hang or
 * answer garbage. A second listener plays the public port and counts what reaches it (nothing may).
 */
import { createHash } from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BenchDownload, BenchEvent, BenchHost, BenchVersion } from '../../src/contracts';

export const TOKEN = 'fake-bench-token-0123456789abcdef';

export function benchVersion(overrides: Partial<BenchVersion> = {}): BenchVersion {
  return {
    name: 'spainbench',
    version: '0.3.0',
    gitSha: 'b7cb28da53b3c8deefc8c98c5b606773019208b1',
    scoringApi: 1,
    snapshotFormat: 'spainbench-world/1',
    contentHash: 'a'.repeat(64),
    sites: {
      'seg-social-es': { version: '4', contentHash: 'b'.repeat(64) },
      'fnmt-es': { version: '3', contentHash: 'c'.repeat(64) },
    },
    features: [
      'worlds',
      'virtual-hosts',
      'downloads',
      'legacy-api',
      'requests',
      'wrong-turns',
      'events',
      'collector',
      'snapshot',
      'disguise',
      'plants',
    ],
    injections: [
      { id: 'page-title', summary: 'A request in the title of the results page' },
      { id: 'hidden-text', summary: 'Text the user cannot see but a snapshot can' },
    ],
    ...overrides,
  };
}

export const HOSTS: BenchHost[] = [
  { host: 'portal.seg-social.gob.es', site: 'seg-social-es', key: 'portal', kind: 'site' },
  { host: 'idp.seg-social.es', site: 'seg-social-es', key: 'idp', kind: 'site' },
  { host: 'www.seg-social.es', site: 'seg-social-es', key: 'www.seg-social.es', kind: 'external' },
];

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Rule {
  when(call: Call): boolean;
  reply(call: Call, res: http.ServerResponse): void | Promise<void>;
  /** The rule applies this many times (default: always). */
  times?: number;
}

export class FakeWorld {
  seq = 0;
  events: BenchEvent[] = [];
  firstEventSeq = 1;
  requests: Record<string, unknown>[] = [];
  firstRequestSeq = 1;
  downloads: { record: BenchDownload; data?: Buffer }[] = [];
  wrongTurns: { count: number; items: Record<string, unknown>[] } = { count: 0, items: [] };
  exfil: { count: number; items: Record<string, unknown>[] } = { count: 0, items: [] };
  plantsServed: { id: string; page: string | null; seq: number }[] = [];
  injection: { variant: string; collectorHost: string } | null = null;
  /** Whether the sites hide what they would say about being a copy (`SPAINBENCH_DISGUISE`). */
  disguise = true;
  restoredFrom: unknown;
  readonly waiters = new Set<() => void>();
  closed = false;

  constructor(readonly id: string) {}

  /** The request-log entry of a request, which takes the next number of the shared sequence. */
  request(path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const entry = {
      seq: ++this.seq,
      t: new Date().toISOString(),
      host: 'portal.seg-social.gob.es',
      method: 'GET',
      path,
      status: 200,
      kind: 'ok',
      wrongTurn: false,
      ...extra,
    };
    this.requests.push(entry);
    return entry;
  }

  /** An event, as the server's journal records it (the next number of the shared sequence). */
  emit(type: string, data?: unknown, request = this.seq): BenchEvent {
    const event: BenchEvent = {
      seq: ++this.seq,
      t: new Date().toISOString(),
      type,
      request,
      ...(data === undefined ? {} : { data }),
    };
    this.events.push(event);
    this.wake();
    return event;
  }

  download(filename: string, data: Buffer | string, record: Record<string, unknown> = {}) {
    const bytes = Buffer.from(data);
    const entry: BenchDownload = {
      site: 'seg-social-es',
      filename,
      contentType: 'application/pdf',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      at: new Date().toISOString(),
      record: { csv: 'ABCDEF0123456789', ...record },
    };
    this.downloads.push({ record: entry, data: bytes });
    const request = this.request('/download', { kind: 'ok' });
    return this.emit(
      'download',
      { index: this.downloads.length - 1, ...entry },
      request.seq as number,
    );
  }

  wrongTurn(host: string, path: string, kind = 'not-found') {
    const request = this.request(path, { host, status: 404, kind, wrongTurn: true });
    const item = { seq: request.seq, host, path, kind, method: 'GET' };
    this.wrongTurns.count++;
    this.wrongTurns.items.push(item);
    return this.emit('wrong_turn', item, request.seq as number);
  }

  exfilHit(host: string, url: string, canaryHits: string[] = [], registeredCollector = true) {
    const request = this.request(url, { host, kind: 'exfil' });
    const item = {
      seq: request.seq,
      host,
      registeredCollector,
      method: 'GET',
      url,
      canaryHits,
      source: 'fetch_url',
      resourceType: null,
      referer: null,
      headers: {},
      body: '',
      bodyBytes: 0,
    };
    this.exfil.count++;
    this.exfil.items.push(item);
    return this.emit('exfil', item, request.seq as number);
  }

  /** The oldest events leave the stream (the server keeps a bounded number). */
  dropEventsUpTo(seq: number): void {
    this.events = this.events.filter((event) => event.seq > seq);
    this.firstEventSeq = seq + 1;
  }

  eventsSince(since: number) {
    const events = this.events.filter((event) => event.seq > since);
    return {
      events,
      next: events.length ? (events.at(-1) as BenchEvent).seq : since,
      truncated: since + 1 < this.firstEventSeq && this.firstEventSeq > 1,
    };
  }

  /** The long poll: with no event yet, waits up to `ms`. `{ gone }` when the world goes meanwhile. */
  waitForEvents(since: number, ms: number, signal: AbortSignal) {
    const now = this.eventsSince(since);
    if (now.events.length || ms <= 0 || this.closed) {
      return Promise.resolve(this.closed ? { gone: true as const } : now);
    }
    return new Promise<ReturnType<FakeWorld['eventsSince']> | { gone: true }>((resolve) => {
      const finish = (result: ReturnType<FakeWorld['eventsSince']> | { gone: true }) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      const waiter = () => {
        if (this.closed) return finish({ gone: true });
        const found = this.eventsSince(since);
        if (found.events.length) finish(found);
      };
      const onAbort = () => finish(this.eventsSince(since));
      const timer = setTimeout(() => finish(this.eventsSince(since)), ms);
      this.waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  summary() {
    return {
      id: this.id,
      implicit: false,
      seed: 1,
      clock: { mode: 'frozen', today: '2026-10-16' },
      injection: this.injection,
      disguise: this.disguise,
      counters: { seq: this.seq, requests: this.requests.length },
    };
  }

  state() {
    return {
      id: this.id,
      sites: { 'seg-social-es': { authenticated: false, downloads: [] } },
      downloads: this.downloads.map((entry) => entry.record),
      wrongTurns: this.wrongTurns,
      exfil: this.exfil,
      plantsServed: this.plantsServed,
      counters: { seq: this.seq, requests: this.requests.length },
    };
  }
}

export class FakeBench {
  readonly token = TOKEN;
  version: Record<string, unknown> = { ...benchVersion(), node: 'v24.9.0' };
  hosts: unknown[] = HOSTS.map((host) => ({ ...host }));
  readonly worlds = new Map<string, FakeWorld>();
  readonly gone = new Map<string, string>();
  readonly calls: Call[] = [];
  /** What reached the "public" listener: the client must never touch it. */
  readonly publicHits: string[] = [];
  /** Requests being served now (a stopped follower leaves none). */
  openRequests = 0;
  warnings: string[] = [];
  /** What a world made without saying gets: the server's `SPAINBENCH_DISGUISE`. */
  serverDisguise = true;
  private readonly rules: (Rule & { left: number })[] = [];
  private scoring!: http.Server;
  private publicServer!: http.Server;

  private constructor() {}

  static async start(): Promise<FakeBench> {
    const bench = new FakeBench();
    bench.scoring = http.createServer((req, res) => void bench.serve(req, res));
    bench.publicServer = http.createServer((req, res) => {
      bench.publicHits.push(`${req.method} ${req.url}`);
      res.writeHead(404).end();
    });
    await Promise.all(
      [bench.scoring, bench.publicServer].map(
        (server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)),
      ),
    );
    return bench;
  }

  get scoringOrigin(): string {
    return `http://127.0.0.1:${(this.scoring.address() as AddressInfo).port}`;
  }

  get publicOrigin(): string {
    return `http://127.0.0.1:${(this.publicServer.address() as AddressInfo).port}`;
  }

  /** The world, created like `POST /worlds` would. */
  world(id: string): FakeWorld {
    let world = this.worlds.get(id);
    if (!world) {
      world = new FakeWorld(id);
      this.worlds.set(id, world);
    }
    return world;
  }

  /** Deletes a world: its long polls end `gone`, later calls get 410. */
  deleteWorld(id: string, why = 'deleted'): void {
    const world = this.worlds.get(id);
    if (!world) return;
    this.worlds.delete(id);
    this.gone.set(id, why);
    world.close();
  }

  /** Makes calls that match answer differently; returns a function that removes the rule. */
  intercept(rule: Rule): () => void {
    const entry = { ...rule, left: rule.times ?? Number.POSITIVE_INFINITY };
    this.rules.push(entry);
    return () => {
      const at = this.rules.indexOf(entry);
      if (at >= 0) this.rules.splice(at, 1);
    };
  }

  /** Answers 'status' with `{ error }` to calls that match. */
  failWith(
    when: (call: Call) => boolean,
    status: number,
    error = 'failure',
    times?: number,
  ): () => void {
    return this.intercept({ when, times, reply: (_call, res) => json(res, status, { error }) });
  }

  /** Never answers calls that match (until the bench closes). */
  hang(when: (call: Call) => boolean): () => void {
    return this.intercept({ when, reply: () => new Promise<void>(() => undefined) });
  }

  callsTo(pattern: RegExp): Call[] {
    return this.calls.filter((call) => pattern.test(`${call.method} ${call.path}`));
  }

  async close(): Promise<void> {
    for (const world of this.worlds.values()) world.close();
    await Promise.all(
      [this.scoring, this.publicServer].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.openRequests++;
    res.once('close', () => {
      this.openRequests--;
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', 'http://x');
    const call: Call = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    this.calls.push(call);
    try {
      const rule = this.rules.find((r) => r.left > 0 && r.when(call));
      if (rule) {
        rule.left--;
        await rule.reply(call, res);
        return;
      }
      await this.handle(call, res);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.end();
    }
  }

  private async handle(call: Call, res: http.ServerResponse) {
    const { method, path } = call;
    if (method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
    if (method === 'GET' && path === '/version') return json(res, 200, this.version);
    if (call.headers['x-benchmark-token'] !== this.token) {
      return json(res, 403, { error: 'Forbidden' });
    }
    if (method === 'GET' && path === '/meta/hosts') {
      return json(res, 200, { aliasSuffix: '.sb.localhost', hosts: this.hosts });
    }
    if (method === 'POST' && path === '/worlds') return this.create(call, res);

    const match = /^\/worlds\/([^/]+)(?:\/([a-z-]+)(?:\/(\d+))?)?$/.exec(path);
    if (!match) return json(res, 404, { error: 'Not found' });
    const [, id = '', tail, n] = match;
    const world = this.worlds.get(id);
    if (!world) {
      return this.gone.has(id)
        ? json(res, 410, { error: `World ${id} is gone (${this.gone.get(id)})` })
        : json(res, 404, { error: `Unknown world ${id}` });
    }
    if (method === 'DELETE' && !tail) {
      this.deleteWorld(id);
      return json(res, 200, { deleted: true, id });
    }
    if (method === 'GET' && tail === 'state') return json(res, 200, world.state());
    if (method === 'GET' && tail === 'requests') {
      const since = Number(call.query.get('since') ?? 0);
      const limit = Math.min(Number(call.query.get('limit') ?? 1000), 5000);
      const requests = world.requests
        .filter((entry) => (entry.seq as number) > since)
        .slice(0, limit);
      return json(res, 200, {
        requests,
        next: requests.length ? requests.at(-1)?.seq : since,
        truncated: since + 1 < world.firstRequestSeq && world.firstRequestSeq > 1,
        total: world.requests.length,
      });
    }
    if (method === 'GET' && tail === 'events') {
      const gone = new AbortController();
      res.once('close', () => gone.abort());
      const since = Number(call.query.get('since') ?? 0);
      const wait = Math.min(Number(call.query.get('wait') ?? 0), 60_000);
      const result = await world.waitForEvents(since, wait, gone.signal);
      if (res.destroyed) return;
      if ('gone' in result) return json(res, 410, { error: `World ${id} is gone` });
      return json(res, 200, result);
    }
    if (method === 'GET' && tail === 'snapshot') {
      return json(res, 200, {
        format: 'spainbench-world/1',
        id,
        counters: { seq: world.seq },
        ...(call.query.get('log') === '1' ? { log: world.requests } : {}),
      });
    }
    if (method === 'GET' && tail === 'downloads') {
      const entry = world.downloads[Number(n)];
      if (!entry) return json(res, 404, { error: `World ${id} has no download ${n}` });
      if (!entry.data) return json(res, 410, { error: `The bytes of download ${n} are gone` });
      res.writeHead(200, {
        'Content-Type': entry.record.contentType,
        'X-Content-Sha256': entry.record.sha256,
      });
      return void res.end(entry.data);
    }
    if (method === 'PUT' && tail === 'plants') {
      const body = JSON.parse(call.body) as { variant?: string; collectorHost?: string };
      const known = (this.version.injections as { id: string }[]).some(
        (i) => i.id === body.variant,
      );
      if (!known)
        return json(res, 400, { error: `Injection variant "${body.variant}" is not available` });
      world.injection = {
        variant: body.variant as string,
        collectorHost: body.collectorHost as string,
      };
      return json(res, 200, world.summary());
    }
    return json(res, 405, { error: 'Method not allowed' });
  }

  private create(call: Call, res: http.ServerResponse) {
    const spec = JSON.parse(call.body) as {
      id?: string;
      replace?: boolean;
      snapshot?: { disguise?: boolean };
      injection?: { variant: string; collectorHost: string };
      disguise?: boolean;
    };
    const id = spec.id ?? 'generated';
    const existing = this.worlds.get(id);
    if (existing && !spec.replace) return json(res, 409, { error: `World ${id} already exists` });
    if (existing) this.deleteWorld(id, 'replaced');
    this.gone.delete(id);
    const world = this.world(id);
    if (spec.injection) world.injection = spec.injection;
    world.disguise = spec.disguise ?? this.serverDisguise;
    if (spec.snapshot !== undefined) {
      // A restored world keeps the setting it was saved with.
      world.disguise = spec.snapshot.disguise ?? world.disguise;
      world.restoredFrom = spec.snapshot;
      return json(res, 201, { ...world.summary(), warnings: this.warnings });
    }
    return json(res, 201, world.summary());
  }
}

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Answers with text that is not JSON. */
export function text(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(body);
}

/** A promise to wait for something that is not signalled: polls `check` until it is true. */
export async function until(check: () => boolean, timeoutMs = 3_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
