import '../llm/helpers/no-network';
import { createServer } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BenchError, BenchVersionError, createBenchApi } from '../../src/bench';
import type { BenchApi } from '../../src/contracts';
import { FakeBench, HOSTS, json, TOKEN, text, until } from './fake-server';

let bench: FakeBench;
let api: BenchApi;

beforeEach(async () => {
  bench = await FakeBench.start();
  api = createBenchApi({
    publicOrigin: bench.publicOrigin,
    scoringOrigin: bench.scoringOrigin,
    token: TOKEN,
  });
});

afterEach(async () => {
  await bench.close();
});

async function failure(promise: Promise<unknown>): Promise<BenchError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BenchError);
    return error as BenchError;
  }
  throw new Error('Expected the call to reject');
}

/** Answers `when` with a JSON body once or always. */
function answer(when: string | RegExp, body: unknown, status = 200) {
  return bench.intercept({
    when: (call) =>
      typeof when === 'string'
        ? `${call.method} ${call.path}` === when
        : when.test(`${call.method} ${call.path}`),
    reply: (_call, res) => json(res, status, body),
  });
}

describe('reading', () => {
  it('reads the version, keeping what a newer server adds', async () => {
    const version = await api.version();
    expect(version.name).toBe('spainbench');
    expect(version.scoringApi).toBe(1);
    expect(version.sites['seg-social-es']?.version).toBe('4');
    expect(version.injections.map((i) => i.id)).toEqual(['page-title', 'hidden-text']);
    expect((version as unknown as { node: string }).node).toBe('v24.9.0');
  });

  it('reads the host table as BenchHost entries', async () => {
    expect(await api.hosts()).toEqual(HOSTS);
  });

  it('reads the state and keeps the extra fields of the server', async () => {
    const world = bench.world('w1');
    world.download('vida_laboral.pdf', '%PDF-1.4 hello');
    world.wrongTurn('portal.seg-social.gob.es', '/nope');
    world.exfilHit('colaborador.example', '/c?x=1', ['53918274H']);
    const state = await api.state('w1');
    expect(state.id).toBe('w1');
    expect(state.downloads).toHaveLength(1);
    expect(state.downloads[0]?.record.csv).toBe('ABCDEF0123456789');
    expect(state.wrongTurns.count).toBe(1);
    expect(state.wrongTurns.items[0]).toMatchObject({ kind: 'not-found', method: 'GET' });
    expect(state.exfil.items[0]).toMatchObject({
      registeredCollector: true,
      canaryHits: ['53918274H'],
      headers: {},
      bodyBytes: 0,
    });
    expect(state.counters.seq).toBe(world.seq);
  });

  it('keeps unknown top-level fields of the state', async () => {
    bench.world('w1');
    const real = bench.world('w1').state();
    answer('GET /worlds/w1/state', { ...real, futureField: { a: 1 } });
    expect(await api.state('w1')).toMatchObject({ futureField: { a: 1 } });
  });

  it('gives a plant served on an unnamed page an empty page', async () => {
    const world = bench.world('w1');
    world.plantsServed.push(
      { id: 'page-title', page: null, seq: 3 },
      { id: 'page-title', page: 'vl', seq: 9 },
    );
    const state = await api.state('w1');
    expect(state.plantsServed).toEqual([
      { id: 'page-title', page: '', seq: 3 },
      { id: 'page-title', page: 'vl', seq: 9 },
    ]);
  });

  it('pages the request log by the cursor and limit it was given', async () => {
    const world = bench.world('w1');
    for (let i = 0; i < 5; i++) world.request(`/p${i}`);
    const first = await api.requests('w1', 0, 2);
    expect(first.requests).toHaveLength(2);
    expect(first).toMatchObject({ next: 2, truncated: false, total: 5 });
    const rest = await api.requests('w1', first.next);
    expect(rest.requests).toHaveLength(3);
    expect(rest.next).toBe(5);
    const last = bench.callsTo(/requests/).at(-1);
    expect(last?.query.get('since')).toBe('2');
    expect(last?.query.has('limit')).toBe(false);
    expect(bench.callsTo(/requests/)[0]?.query.get('limit')).toBe('2');
  });

  it('asks for the request log in the snapshot only when told to', async () => {
    const world = bench.world('w1');
    world.request('/a');
    const plain = (await api.snapshot('w1')) as Record<string, unknown>;
    expect(plain.format).toBe('spainbench-world/1');
    expect(plain.log).toBeUndefined();
    const withLog = (await api.snapshot('w1', { keepLog: true })) as { log: unknown[] };
    expect(withLog.log).toHaveLength(1);
    expect(bench.callsTo(/snapshot/).map((c) => c.query.get('log'))).toEqual([null, '1']);
  });

  it('never touches the public listener', async () => {
    bench.world('w1').download('a.pdf', 'x');
    await api.version();
    await api.hosts();
    await api.state('w1');
    await api.requests('w1');
    await api.snapshot('w1');
    await api.download('w1', 0);
    await api.events('w1', 0);
    await api.deleteWorld('w1');
    expect(bench.publicHits).toEqual([]);
    expect(api.publicOrigin).toBe(bench.publicOrigin);
    expect(api.scoringOrigin).toBe(bench.scoringOrigin);
  });

  it('sends the token on every call that needs it, and only as a header', async () => {
    bench.world('w1');
    await api.hosts();
    await api.state('w1');
    for (const call of bench.calls) {
      expect(call.headers['x-benchmark-token']).toBe(TOKEN);
      expect(call.path + call.query.toString()).not.toContain(TOKEN);
    }
  });
});

describe('what the server must answer', () => {
  it.each([
    [
      'not JSON',
      (res: Parameters<typeof text>[0]) => text(res, 200, '<html>hi</html>'),
      /not JSON/,
    ],
    ['a list', (res: Parameters<typeof json>[0]) => json(res, 200, []), /answer/],
  ])('a state that is %s is an invalid_response', async (_name, reply, message) => {
    bench.world('w1');
    bench.intercept({ when: (c) => c.path === '/worlds/w1/state', reply: (_c, res) => reply(res) });
    const error = await failure(api.state('w1'));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toMatch(message);
    expect(error.message).toContain('GET /worlds/w1/state');
    expect(error.retryable).toBe(false);
  });

  it.each([
    ['name', { name: 'other-bench' }],
    ['features', { features: 'all' }],
    ['sites', { sites: { 'seg-social-es': { version: '4' } } }],
    ['scoringApi', { scoringApi: 'one' }],
  ])('a version with a bad %s is an invalid_response', async (_field, patch) => {
    answer('GET /version', { ...bench.version, ...patch });
    expect((await failure(api.version())).code).toBe('invalid_response');
  });

  it('a host with an unknown kind is an invalid_response', async () => {
    answer('GET /meta/hosts', {
      hosts: [{ host: 'a.example', site: 's', key: 'k', kind: 'mirror' }],
    });
    const error = await failure(api.hosts());
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('kind');
  });

  it.each([
    [
      'a download without its hash',
      {
        downloads: [{ site: 's', filename: 'f', contentType: 't', bytes: 1, at: 'x', record: {} }],
      },
    ],
    ['a negative counter', { counters: { seq: -1, requests: 0 } }],
    [
      'a wrong turn of an unknown kind',
      { wrongTurns: { count: 1, items: [{ seq: 1, host: 'h', path: '/', kind: 'weird' }] } },
    ],
    [
      'an exfil item without canaryHits',
      {
        exfil: {
          count: 1,
          items: [{ seq: 1, host: 'h', registeredCollector: true, method: 'GET', url: '/' }],
        },
      },
    ],
    ['another world', { id: 'w2' }],
  ])('%s is an invalid_response', async (_name, patch) => {
    const world = bench.world('w1');
    answer('GET /worlds/w1/state', { ...world.state(), ...patch });
    const error = await failure(api.state('w1'));
    expect(error.code).toBe('invalid_response');
    expect(error.status).toBe(200);
  });

  it('a malformed event is an invalid_response', async () => {
    bench.world('w1');
    answer(/events$/, {
      events: [{ seq: 'one', t: 'x', type: 'download' }],
      next: 1,
      truncated: false,
    });
    expect((await failure(api.events('w1', 0))).code).toBe('invalid_response');
  });

  it('a request log without a cursor is an invalid_response', async () => {
    bench.world('w1');
    answer(/requests$/, { requests: [], truncated: false, total: 0 });
    expect((await failure(api.requests('w1'))).code).toBe('invalid_response');
  });

  it('a snapshot without a format is an invalid_response', async () => {
    bench.world('w1');
    answer(/snapshot$/, { id: 'w1' });
    expect((await failure(api.snapshot('w1'))).code).toBe('invalid_response');
  });

  it('does not follow a redirect (the token would travel with it)', async () => {
    bench.world('w1');
    bench.intercept({
      when: (c) => c.path === '/worlds/w1/state',
      reply: (_c, res) => {
        res.writeHead(302, { Location: `${bench.publicOrigin}/steal` }).end();
      },
    });
    const error = await failure(api.state('w1'));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('redirect');
    expect(bench.publicHits).toEqual([]);
  });

  it('refuses a version of a scoring API it does not speak with the side to update', async () => {
    // A future server may have changed the document itself: the error says which side is older.
    answer('GET /version', { name: 'spainbench', scoringApi: 2, sites: [] });
    const error = await api.version().catch((e) => e);
    expect(error).toBeInstanceOf(BenchVersionError);
    expect(error.older).toBe('harness');
  });
});

describe('failures', () => {
  it.each([
    [400, 'bad_request', false],
    [401, 'unauthorized', false],
    [403, 'unauthorized', false],
    [404, 'not_found', false],
    [405, 'bad_request', false],
    [409, 'conflict', false],
    [410, 'gone', false],
    [415, 'bad_request', false],
    [500, 'server', true],
    [502, 'server', true],
    [503, 'server', true],
  ] as const)('HTTP %i is %s', async (status, code, retryable) => {
    bench.world('w1');
    bench.failWith((c) => c.path === '/worlds/w1/state', status, 'the server says no');
    const error = await failure(api.state('w1'));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
    expect(error.endpoint).toBe('GET /worlds/w1/state');
    expect(error.message).toContain('GET /worlds/w1/state');
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain('the server says no');
  });

  it('names a refused token and a missing world as such', async () => {
    const stranger = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: 'some-other-token',
    });
    const refused = await failure(stranger.hosts());
    expect(refused.code).toBe('unauthorized');
    expect(refused.message).not.toContain('some-other-token');
    expect((await failure(api.state('nobody'))).code).toBe('not_found');
    bench.world('w1');
    bench.deleteWorld('w1');
    expect((await failure(api.state('w1'))).code).toBe('gone');
  });

  it('never shows the token, even when the server echoes it', async () => {
    bench.world('w1');
    bench.failWith((c) => c.path === '/worlds/w1/state', 500, `bad header ${TOKEN} sent`);
    const error = await failure(api.state('w1'));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('bad header *** sent');
    expect(
      JSON.stringify({ ...error, message: error.message, stack: error.stack?.split('\n')[0] }),
    ).not.toContain(TOKEN);
  });

  it('is unreachable when nothing listens, and says where', async () => {
    const closed = await new Promise<number>((resolve) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        server.close(() => resolve(port));
      });
    });
    const lost = createBenchApi({
      publicOrigin: 'http://127.0.0.1:1',
      scoringOrigin: `http://127.0.0.1:${closed}`,
      token: TOKEN,
    });
    const error = await failure(lost.version());
    expect(error.code).toBe('unreachable');
    expect(error.retryable).toBe(true);
    expect(error.status).toBeUndefined();
    expect(error.message).toContain(`127.0.0.1:${closed}`);
    expect(error.message).toContain('GET /version');
    expect(error.message).not.toContain(TOKEN);
  });

  it('is unreachable when the server drops the connection', async () => {
    bench.world('w1');
    bench.intercept({
      when: (c) => c.path === '/worlds/w1/state',
      reply: (_c, res) => void res.socket?.destroy(),
    });
    const error = await failure(api.state('w1'));
    expect(error.code).toBe('unreachable');
  });

  it('times out a request that is never answered', async () => {
    const quick = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: TOKEN,
      timeoutMs: 150,
    });
    bench.world('w1');
    bench.hang((c) => c.path === '/worlds/w1/state');
    const began = Date.now();
    const error = await failure(quick.state('w1'));
    expect(error.code).toBe('unreachable');
    expect(error.message).toContain('timed out after 150 ms');
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('times out an answer that stops half way', async () => {
    const quick = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: TOKEN,
      timeoutMs: 150,
    });
    bench.world('w1');
    bench.intercept({
      when: (c) => c.path === '/worlds/w1/state',
      reply: (_c, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' });
        res.write('{"id":');
      },
    });
    const error = await failure(quick.state('w1'));
    expect(error.code).toBe('unreachable');
  });

  it('refuses ids that are not world ids without calling the server', async () => {
    for (const id of ['', '../x', 'a/b', 'a b', 'x'.repeat(65), 'é']) {
      expect((await failure(api.state(id))).code).toBe('bad_request');
    }
    expect(bench.calls).toHaveLength(0);
  });

  it('refuses cursors and counts that are not non-negative integers', async () => {
    bench.world('w1');
    for (const call of [
      () => api.events('w1', -1),
      () => api.events('w1', 1.5),
      () => api.events('w1', 0, { waitMs: -5 }),
      () => api.requests('w1', Number.NaN),
      () => api.requests('w1', 0, -1),
      () => api.download('w1', -1),
      () => api.download('w1', 0.5),
    ]) {
      expect((await failure(call())).code).toBe('bad_request');
    }
    expect(bench.calls).toHaveLength(0);
  });
});

describe('events', () => {
  it('returns the events after the cursor with the server cursor', async () => {
    const world = bench.world('w1');
    world.download('a.pdf', 'x');
    world.wrongTurn('portal.seg-social.gob.es', '/x');
    const result = await api.events('w1', 0);
    if (result === 'gone') throw new Error('gone');
    expect(result.events.map((e) => e.type)).toEqual(['download', 'wrong_turn']);
    expect(result.next).toBe(world.seq);
    expect(result.truncated).toBe(false);
    expect(result.events[0]).toMatchObject({
      request: 2 - 1,
      data: { filename: 'a.pdf', index: 0 },
    });
    const after = await api.events('w1', result.events[0]?.seq ?? 0);
    expect(after === 'gone' ? [] : after.events.map((e) => e.type)).toEqual(['wrong_turn']);
  });

  it('says gone for a world that was deleted, expired or replaced', async () => {
    bench.world('w1');
    bench.deleteWorld('w1');
    expect(await api.events('w1', 0)).toBe('gone');
  });

  it('says gone when the world goes while the poll waits', async () => {
    bench.world('w1');
    const poll = api.events('w1', 0, { waitMs: 5_000 });
    await until(() => bench.callsTo(/events/).length === 1);
    bench.deleteWorld('w1', 'replaced');
    expect(await poll).toBe('gone');
  });

  it('wakes a waiting poll when an event arrives', async () => {
    const world = bench.world('w1');
    const poll = api.events('w1', 0, { waitMs: 5_000 });
    await until(() => bench.callsTo(/events/).length === 1);
    world.emit('login', { ok: true });
    const result = await poll;
    expect(result === 'gone' ? [] : result.events.map((e) => e.type)).toEqual(['login']);
  });

  it('sends the wait to the server, at most the server maximum', async () => {
    bench.world('w1');
    await api.events('w1', 7, { waitMs: 0 });
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      reply: (_c, res) => json(res, 200, { events: [], next: 7, truncated: false }),
    });
    await api.events('w1', 7, { waitMs: 999_999 });
    const [first, second] = bench.callsTo(/events/);
    expect(first?.query.get('since')).toBe('7');
    expect(first?.query.get('wait')).toBe('0');
    expect(second?.query.get('wait')).toBe('60000');
  });

  it('keeps its HTTP timeout longer than the wait', async () => {
    const quick = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: TOKEN,
      timeoutMs: 150,
    });
    bench.world('w1');
    // The server answers after 400 ms, as a long poll that waited for 400 ms: a plain 150 ms
    // timeout would cut it.
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      reply: async (_c, res) => {
        await new Promise((resolve) => setTimeout(resolve, 400));
        json(res, 200, { events: [], next: 0, truncated: false });
      },
    });
    expect(await quick.events('w1', 0, { waitMs: 400 })).toMatchObject({ events: [] });
    // Without a wait the same 150 ms apply.
    const error = await failure(quick.events('w1', 0));
    expect(error.code).toBe('unreachable');
    expect(error.message).toContain('timed out after 150 ms');
  });

  it('times out a long poll that outlasts wait plus the timeout', async () => {
    const quick = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: TOKEN,
      timeoutMs: 100,
    });
    bench.world('w1');
    bench.hang((c) => c.path.endsWith('/events'));
    const began = Date.now();
    const error = await failure(quick.events('w1', 0, { waitMs: 200 }));
    expect(error.message).toContain('timed out after 300 ms');
    expect(Date.now() - began).toBeGreaterThanOrEqual(280);
  });

  it('aborts a poll in flight with the caller signal', async () => {
    bench.world('w1');
    const controller = new AbortController();
    const poll = failure(api.events('w1', 0, { waitMs: 10_000, signal: controller.signal }));
    await until(() => bench.openRequests === 1);
    const began = Date.now();
    controller.abort();
    const error = await poll;
    expect(error.code).toBe('aborted');
    expect(error.retryable).toBe(false);
    expect(Date.now() - began).toBeLessThan(1_000);
    await until(() => bench.openRequests === 0, 3_000, 'the server to see the poll end');
  });

  it('does not call the server with a signal that already fired', async () => {
    bench.world('w1');
    const controller = new AbortController();
    controller.abort();
    expect((await failure(api.events('w1', 0, { signal: controller.signal }))).code).toBe(
      'aborted',
    );
    expect(bench.calls).toHaveLength(0);
  });

  it('treats a missing world as an error, not as gone', async () => {
    expect((await failure(api.events('nobody', 0))).code).toBe('not_found');
  });

  it('passes the truncated flag on and reads a null request as none', async () => {
    const world = bench.world('w1');
    world.emit('login', { ok: true });
    world.emit('login', { ok: false });
    world.dropEventsUpTo(1);
    const result = await api.events('w1', 0);
    expect(result === 'gone' ? undefined : result.truncated).toBe(true);
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      reply: (_c, res) =>
        json(res, 200, {
          events: [{ seq: 4, t: 'now', type: 'login', request: null }],
          next: 4,
          truncated: false,
        }),
    });
    const second = await api.events('w1', 3);
    expect(second === 'gone' ? undefined : second.events[0]).toEqual({
      seq: 4,
      t: 'now',
      type: 'login',
    });
  });
});

describe('downloads', () => {
  it('returns the bytes and the SHA-256 the server stated', async () => {
    const world = bench.world('w1');
    world.download('vida_laboral.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 10]));
    const file = await api.download('w1', 0);
    expect([...file.bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0, 255, 10]);
    expect(file.sha256).toBe(world.downloads[0]?.record.sha256);
  });

  it('refuses bytes that do not match the SHA-256 header', async () => {
    const world = bench.world('w1');
    world.download('a.pdf', 'real bytes');
    bench.intercept({
      when: (c) => c.path.includes('/downloads/'),
      reply: (_c, res) => {
        res.writeHead(200, { 'X-Content-Sha256': world.downloads[0]?.record.sha256 ?? '' });
        res.end('other bytes');
      },
    });
    const error = await failure(api.download('w1', 0));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('SHA-256');
    expect(error.message).toContain('GET /worlds/w1/downloads/0');
  });

  it.each([
    ['missing', undefined],
    ['not a hash', 'abc'],
  ])('refuses a file whose hash header is %s', async (_name, header) => {
    bench.world('w1').download('a.pdf', 'x');
    bench.intercept({
      when: (c) => c.path.includes('/downloads/'),
      reply: (_c, res) => {
        res.writeHead(200, header ? { 'X-Content-Sha256': header } : {});
        res.end('x');
      },
    });
    expect((await failure(api.download('w1', 0))).code).toBe('invalid_response');
  });

  it('accepts the hash in any case', async () => {
    const world = bench.world('w1');
    world.download('a.pdf', 'x');
    bench.intercept({
      when: (c) => c.path.includes('/downloads/'),
      reply: (_c, res) => {
        res.writeHead(200, {
          'X-Content-Sha256': world.downloads[0]?.record.sha256.toUpperCase() ?? '',
        });
        res.end('x');
      },
    });
    expect((await api.download('w1', 0)).bytes).toHaveLength(1);
  });

  it('says not_found for a download that does not exist and gone for bytes that were not kept', async () => {
    const world = bench.world('w1');
    world.download('a.pdf', 'x');
    expect((await failure(api.download('w1', 5))).code).toBe('not_found');
    (world.downloads[0] as { data?: Buffer }).data = undefined;
    expect((await failure(api.download('w1', 0))).code).toBe('gone');
  });
});

describe('worlds', () => {
  it('creates a world with the spec as it is', async () => {
    const created = await api.createWorld({
      id: 'run-1',
      seed: 1,
      today: '2026-10-16',
      sites: ['seg-social-es'],
      injection: { variant: 'page-title', collectorHost: 'colaborador.example' },
      canaries: ['x'],
    });
    expect(created).toEqual({ id: 'run-1', warnings: [] });
    const call = bench.callsTo(/POST \/worlds$/)[0];
    expect(JSON.parse(call?.body ?? '')).toEqual({
      id: 'run-1',
      seed: 1,
      today: '2026-10-16',
      sites: ['seg-social-es'],
      injection: { variant: 'page-title', collectorHost: 'colaborador.example' },
      canaries: ['x'],
      disguise: true,
    });
    expect(call?.headers['content-type']).toBe('application/json');
    expect(bench.world('run-1').injection?.variant).toBe('page-title');
  });

  describe('the disguise: a copy that says it is a copy contaminates every verdict', () => {
    const bodyOf = () => JSON.parse(bench.callsTo(/POST \/worlds$/).at(-1)?.body ?? '{}');

    it('asks for it in every world, whatever the server defaults to or the caller says', async () => {
      bench.serverDisguise = false; // SPAINBENCH_DISGUISE=0: the mode for people reading a copy
      await api.createWorld({ id: 'run-a' });
      expect(bodyOf().disguise).toBe(true);
      expect(bench.world('run-a').disguise).toBe(true);
      await api.createWorld({ id: 'run-b', disguise: false } as never);
      expect(bodyOf().disguise).toBe(true);
      expect(bench.world('run-b').disguise).toBe(true);
    });

    it('refuses a world the server did not disguise, and does not leave it behind', async () => {
      answer('POST /worlds', { id: 'run-c', disguise: false }, 201);
      const error = await failure(api.createWorld({ id: 'run-c' }));
      expect(error.code).toBe('invalid_response');
      expect(error.message).toContain('is not disguised');
      expect(error.message).toContain('SPAINBENCH_DISGUISE=0');
      expect(bench.callsTo(/DELETE \/worlds\/run-c$/)).toHaveLength(1);
    });

    it('refuses a server that does not say, which is one too old to be trusted with it', async () => {
      answer('POST /worlds', { id: 'run-d' }, 201);
      const error = await failure(api.createWorld({ id: 'run-d' }));
      expect(error.code).toBe('invalid_response');
      expect(error.message).toContain('did not say whether');
      expect(bench.callsTo(/DELETE \/worlds\/run-d$/)).toHaveLength(1);
    });

    it('refuses a snapshot taken from an undisguised world: a restore keeps its own setting', async () => {
      const snapshot = { format: 'spainbench-world/1', id: 'old', disguise: false };
      const error = await failure(api.createWorld({ id: 'run-e' }, { snapshot, replace: true }));
      expect(error.message).toContain('snapshot was taken from an undisguised world');
      expect(bench.worlds.has('run-e')).toBe(false);
      const fine = { format: 'spainbench-world/1', id: 'old', disguise: true };
      expect((await api.createWorld({ id: 'run-f' }, { snapshot: fine })).id).toBe('run-f');
    });
  });

  it('sends a snapshot and replace along, and returns the warnings', async () => {
    bench.warnings = ['site fnmt-es changed since the snapshot'];
    const snapshot = { format: 'spainbench-world/1', id: 'old', big: 'x'.repeat(10_000) };
    const created = await api.createWorld({ id: 'run-2' }, { snapshot, replace: true });
    expect(created).toEqual({ id: 'run-2', warnings: ['site fnmt-es changed since the snapshot'] });
    const body = JSON.parse(bench.callsTo(/POST \/worlds$/)[0]?.body ?? '');
    expect(body).toMatchObject({ id: 'run-2', replace: true, snapshot });
    expect(bench.world('run-2').restoredFrom).toEqual(snapshot);
  });

  it('replaces a world: the old one is gone for the poll that waits on it', async () => {
    await api.createWorld({ id: 'run-3' });
    const poll = api.events('run-3', 0, { waitMs: 5_000 });
    await until(() => bench.callsTo(/events/).length === 1);
    expect((await failure(api.createWorld({ id: 'run-3' }))).code).toBe('conflict');
    await api.createWorld({ id: 'run-3' }, { replace: true });
    expect(await poll).toBe('gone');
  });

  it('refuses a created id that is not the one asked for', async () => {
    answer('POST /worlds', { id: 'another' }, 201);
    expect((await failure(api.createWorld({ id: 'run-4' }))).code).toBe('invalid_response');
  });

  it('puts the server reason in a refused spec', async () => {
    bench.failWith(
      (c) => c.method === 'POST' && c.path === '/worlds',
      400,
      'sites must list each of the loaded sites',
    );
    const error = await failure(api.createWorld({ id: 'run-5', sites: ['nope'] }));
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('sites must list each of the loaded sites');
  });

  it('deletes a world, and a world that is already gone is not an error', async () => {
    bench.world('w1');
    await api.deleteWorld('w1');
    expect(bench.worlds.has('w1')).toBe(false);
    await api.deleteWorld('w1');
    await api.deleteWorld('never-existed');
    expect(bench.callsTo(/DELETE/)).toHaveLength(3);
  });

  it('does not hide other failures of a delete', async () => {
    bench.world('w1');
    bench.failWith((c) => c.method === 'DELETE', 500);
    expect((await failure(api.deleteWorld('w1'))).code).toBe('server');
  });

  it('sets the plants of a world, and says why the server refuses a variant', async () => {
    const world = bench.world('w1');
    await api.setPlants('w1', { variant: 'hidden-text', collectorHost: 'colaborador.example' });
    expect(world.injection).toEqual({
      variant: 'hidden-text',
      collectorHost: 'colaborador.example',
    });
    const error = await failure(
      api.setPlants('w1', { variant: 'v99', collectorHost: 'x.example' }),
    );
    expect(error.code).toBe('bad_request');
    expect(error.message).toContain('v99');
    bench.deleteWorld('w1');
    expect(
      (await failure(api.setPlants('w1', { variant: 'page-title', collectorHost: 'x.example' })))
        .code,
    ).toBe('gone');
  });
});

describe('options', () => {
  it('uses the fetch it is given', async () => {
    const urls: string[] = [];
    const counting = createBenchApi({
      publicOrigin: bench.publicOrigin,
      scoringOrigin: bench.scoringOrigin,
      token: TOKEN,
      fetch: (input, init) => {
        urls.push(String(input));
        return fetch(input, init);
      },
    });
    await counting.version();
    expect(urls).toEqual([`${bench.scoringOrigin}/version`]);
  });

  it('normalises the origins', () => {
    const created = createBenchApi({
      publicOrigin: 'http://127.0.0.1:3010/',
      scoringOrigin: 'http://localhost:3020',
      token: TOKEN,
    });
    expect(created.publicOrigin).toBe('http://127.0.0.1:3010');
    expect(created.scoringOrigin).toBe('http://localhost:3020');
  });

  it.each([
    [
      'the same origin for both listeners',
      { publicOrigin: 'http://127.0.0.1:3010', scoringOrigin: 'http://127.0.0.1:3010/' },
      /never be what the agent reaches/,
    ],
    [
      'the same listener under another name',
      { publicOrigin: 'http://127.0.0.1:3010', scoringOrigin: 'http://localhost:3010' },
      /never be what the agent reaches/,
    ],
    [
      'an origin with a path',
      { publicOrigin: 'http://127.0.0.1:3010/x', scoringOrigin: 'http://127.0.0.1:3020' },
      /publicOrigin/,
    ],
    [
      'credentials in an origin',
      { publicOrigin: 'http://127.0.0.1:3010', scoringOrigin: 'http://user:pw@127.0.0.1:3020' },
      /scoringOrigin/,
    ],
    [
      'a scheme that is not http',
      { publicOrigin: 'ftp://127.0.0.1:3010', scoringOrigin: 'http://127.0.0.1:3020' },
      /publicOrigin/,
    ],
    [
      'an origin that is not one',
      { publicOrigin: 'nope', scoringOrigin: 'http://127.0.0.1:3020' },
      /publicOrigin/,
    ],
    [
      'an empty token',
      { publicOrigin: 'http://127.0.0.1:1', scoringOrigin: 'http://127.0.0.1:2', token: '' },
      /token/,
    ],
    [
      'a token with a space',
      { publicOrigin: 'http://127.0.0.1:1', scoringOrigin: 'http://127.0.0.1:2', token: 'a b' },
      /token/,
    ],
    [
      'a token with a newline',
      { publicOrigin: 'http://127.0.0.1:1', scoringOrigin: 'http://127.0.0.1:2', token: 'a\nb' },
      /token/,
    ],
    [
      'a zero timeout',
      { publicOrigin: 'http://127.0.0.1:1', scoringOrigin: 'http://127.0.0.1:2', timeoutMs: 0 },
      /timeoutMs/,
    ],
  ])('refuses %s', (_name, options, message) => {
    expect(() => createBenchApi({ token: TOKEN, ...options })).toThrow(message);
  });

  it('never puts the token in a refusal of its own options', () => {
    try {
      createBenchApi({ publicOrigin: 'nope', scoringOrigin: 'http://127.0.0.1:2', token: TOKEN });
    } catch (error) {
      expect(String(error)).not.toContain(TOKEN);
    }
  });
});
