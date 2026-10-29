import '../llm/helpers/no-network';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BenchError,
  benchObservation,
  createBenchApi,
  type FollowBenchOptions,
  followBenchEvents,
} from '../../src/bench';
import type {
  BenchApi,
  BenchEvent,
  BenchFollower,
  FollowBench,
  Observation,
  ObservationSink,
} from '../../src/contracts';
import { exfilFromObservation } from '../../src/rules/leaves';
import { ObservationLog } from '../../src/run/observation-log';
import { FakeBench, type FakeWorld, json, TOKEN, until } from './fake-server';

let bench: FakeBench;
let api: BenchApi;
let world: FakeWorld;
let dir: string;
/** Requests the client has sent and not seen finish (its own view, not the server's). */
let inFlight = 0;
const followers: BenchFollower[] = [];

beforeEach(async () => {
  bench = await FakeBench.start();
  inFlight = 0;
  api = createBenchApi({
    publicOrigin: bench.publicOrigin,
    scoringOrigin: bench.scoringOrigin,
    token: TOKEN,
    fetch: async (input, init) => {
      inFlight++;
      try {
        return await fetch(input, init);
      } finally {
        inFlight--;
      }
    },
  });
  world = bench.world('w1');
  dir = mkdtempSync(join(tmpdir(), 'bench-events-'));
});

afterEach(async () => {
  await Promise.all(followers.splice(0).map((follower) => follower.stop()));
  await bench.close();
  rmSync(dir, { recursive: true, force: true });
});

function follow(options: Partial<FollowBenchOptions> = {}, sink?: ObservationSink) {
  const log = new ObservationLog();
  const errors: Error[] = [];
  const warnings: Error[] = [];
  const follower = followBenchEvents(api, 'w1', sink ?? log, {
    since: 0,
    waitMs: 100,
    backoff: { minMs: 10, maxMs: 40 },
    onError: (error) => errors.push(error),
    onWarning: (error) => warnings.push(error),
    ...options,
  });
  followers.push(follower);
  return { log, errors, warnings, follower };
}

const benchObservations = (log: ObservationLog) =>
  log.all().filter((o): o is Extract<Observation, { type: 'bench' }> => o.type === 'bench');

const eventCalls = () => bench.callsTo(/GET \/worlds\/w1\/events/);

describe('what becomes an observation', () => {
  it('maps download, wrong_turn and exfil in order, and nothing else', async () => {
    world.emit('login', { ok: true, method: 'clave-permanente' });
    const download = world.download('vida_laboral.pdf', '%PDF-1.4');
    const turn = world.wrongTurn('portal.seg-social.gob.es', '/nobody-links-here');
    const exfil = world.exfilHit('validacion-seguridad-social.com', '/c?naf=283174209647', [
      '283174209647',
    ]);
    // SpainBench never sends these two as events (plants are read from the world's state): they
    // are not observations, only lines of the raw copy.
    world.emit('plant_served', { id: 'hidden-text', page: 'vida-laboral', seq: 9 });
    world.emit('booking', { status: 'confirmed' });
    const { log, follower } = follow();
    await follower.drain();

    const observed = benchObservations(log);
    expect(observed.map((o) => o.what)).toEqual(['download', 'wrong_turn', 'exfil']);
    expect(observed.map((o) => o.data)).toEqual([download.data, turn.data, exfil.data]);
    expect(log.all().map((o) => o.type)).toEqual(['bench', 'bench', 'bench']);
    // Stamped by the one sequencer of the run.
    expect(log.all().map((o) => o.seq)).toEqual([1, 2, 3]);
  });

  it('gives the exfil observation the shape the rules read', async () => {
    world.exfilHit('colaborador.example', '/x?d=53918274H', ['53918274H'], false);
    const { log, follower } = follow();
    await follower.drain();
    const [observation] = benchObservations(log);
    expect(observation && exfilFromObservation(observation)).toMatchObject({
      host: 'colaborador.example',
      registeredCollector: false,
      method: 'GET',
      url: '/x?d=53918274H',
      canaryHits: ['53918274H'],
      source: 'fetch_url',
    });
  });

  it('maps by type alone', () => {
    const event = (type: string, data?: unknown): BenchEvent => ({ seq: 1, t: 'x', type, data });
    expect(benchObservation(event('download', { index: 0 }))).toEqual({
      type: 'bench',
      what: 'download',
      data: { index: 0 },
    });
    expect(benchObservation(event('exfil'))).toEqual({
      type: 'bench',
      what: 'exfil',
      data: undefined,
    });
    expect(benchObservation(event('submission', { registro: 'RE-1' }))).toEqual({
      type: 'bench',
      what: 'submission',
      data: { registro: 'RE-1' },
    });
    for (const other of ['login', 'booking', 'report', 'future_event', '']) {
      expect(benchObservation(event(other, {}))).toBeUndefined();
    }
  });

  it('starts after the cursor it is given', async () => {
    world.emit('exfil', { host: 'old.example' });
    world.emit('exfil', { host: 'older.example' });
    const cursor = world.seq;
    world.emit('exfil', { host: 'new.example' });
    const { log, follower } = follow({ since: cursor });
    await follower.drain();
    expect(benchObservations(log).map((o) => (o.data as { host: string }).host)).toEqual([
      'new.example',
    ]);
  });

  it('delivers an event the moment the server records it', async () => {
    const { log, follower } = follow({ waitMs: 10_000 });
    await until(() => eventCalls().length === 1);
    const began = Date.now();
    world.exfilHit('colaborador.example', '/live');
    await until(() => benchObservations(log).length === 1, 2_000, 'the exfil observation');
    expect(Date.now() - began).toBeLessThan(1_000);
    await follower.stop();
  });

  it('delivers events out of order and twice once, in order', async () => {
    const at = (seq: number, type = 'exfil') => ({ seq, t: 'x', type, data: { seq } });
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      times: 1,
      reply: (_c, res) =>
        json(res, 200, { events: [at(5), at(3), at(5), at(4)], next: 5, truncated: false }),
    });
    const { log, follower } = follow();
    await follower.drain();
    expect(benchObservations(log).map((o) => (o.data as { seq: number }).seq)).toEqual([3, 4, 5]);
  });

  it('refuses a cursor that is not a non-negative integer', () => {
    for (const since of [-1, 1.5, Number.NaN]) {
      expect(() => followBenchEvents(api, 'w1', new ObservationLog(), { since })).toThrow(
        TypeError,
      );
    }
  });

  it('is a FollowBench', () => {
    const follower: FollowBench = followBenchEvents;
    expect(typeof follower).toBe('function');
  });
});

describe('the raw file', () => {
  it('has every event of every type, in order, owner-only', async () => {
    world.emit('login', { ok: true });
    world.download('a.pdf', 'x');
    world.emit('booking', { status: 'confirmed' });
    world.exfilHit('colaborador.example', '/x');
    const file = join(dir, 'bench', 'events.raw.jsonl');
    const { follower } = follow({ rawFile: file });
    await follower.drain();
    await follower.stop();
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    const events = lines.map((line) => JSON.parse(line) as BenchEvent);
    expect(events.map((e) => e.type)).toEqual(['login', 'download', 'booking', 'exfil']);
    expect(events).toEqual(world.events);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('keeps writing across polls and appends to what is there', async () => {
    const file = join(dir, 'raw.jsonl');
    writeFileSync(file, '{"seq":0,"type":"earlier"}\n', { mode: 0o644 });
    const { follower } = follow({ rawFile: file });
    world.emit('login', { n: 1 });
    await until(() => readFileSync(file, 'utf8').split('\n').length >= 3, 2_000, 'the first event');
    world.emit('login', { n: 2 });
    await follower.drain();
    await follower.stop();
    const events = readFileSync(file, 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['earlier', 'login', 'login']);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('masks what the scrub says, in the raw file only', async () => {
    world.exfilHit('colaborador.example', '/x?pin=SpainBench2026!', ['SpainBench2026!']);
    const file = join(dir, 'raw.jsonl');
    const { log, follower } = follow({
      rawFile: file,
      scrub: (text) => text.replaceAll('SpainBench2026!', '***'),
    });
    await follower.drain();
    await follower.stop();
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('SpainBench2026!');
    expect(raw).toContain('/x?pin=***');
    // The observation log applies the run's own scrub when it writes: the data is untouched here.
    expect(JSON.stringify(benchObservations(log)[0]?.data)).toContain('SpainBench2026!');
  });

  it('reports a file it cannot open and goes on delivering', async () => {
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, 'x');
    world.exfilHit('colaborador.example', '/x');
    const { log, errors, warnings, follower } = follow({
      rawFile: join(blocker, 'inside', 'raw.jsonl'),
    });
    await follower.drain();
    expect(warnings).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(benchObservations(log)).toHaveLength(1);
  });
});

describe('truncation', () => {
  it('pushes one note and one synthetic download so the state is read again', async () => {
    for (let i = 0; i < 6; i++) world.emit('login', { i });
    world.dropEventsUpTo(4);
    world.exfilHit('colaborador.example', '/after');
    const { log, follower } = follow();
    await follower.drain();
    const types = log.all().map((o) => (o.type === 'bench' ? `bench:${o.what}` : o.type));
    expect(types).toEqual(['note', 'bench:download', 'bench:exfil']);
    const note = log.all()[0];
    expect(note?.type === 'note' && note.text).toMatch(/dropped events/);
    const synthetic = benchObservations(log)[0];
    expect(synthetic?.data).toMatchObject({ synthetic: true, reason: 'events-truncated' });
  });

  it('says it once even when the server keeps saying it', async () => {
    // A world restored from a snapshot: its events start after `seq` and a cursor of 0 is "behind".
    world.seq = 10;
    world.firstEventSeq = 11;
    const { log, follower } = follow({ waitMs: 20 });
    await until(() => eventCalls().length >= 5, 3_000, 'five polls');
    await follower.drain();
    expect(log.all().filter((o) => o.type === 'note')).toHaveLength(1);
    expect(benchObservations(log)).toHaveLength(1);
    // The next event moves the cursor and ends the truncation.
    world.exfilHit('colaborador.example', '/x');
    await until(() => benchObservations(log).length === 2, 2_000, 'the event');
    await follower.drain();
    expect(log.all().filter((o) => o.type === 'note')).toHaveLength(1);
  });

  it('does not call a restored world truncated when it starts at its sequence', async () => {
    world.seq = 10;
    world.firstEventSeq = 11;
    const { log, follower } = follow({ since: 10 });
    await follower.drain();
    expect(log.all()).toHaveLength(0);
  });
});

describe('a world that is gone', () => {
  it('ends the follower with a note, and drain resolves', async () => {
    const { log, errors, follower } = follow({ waitMs: 5_000 });
    await until(() => eventCalls().length === 1);
    bench.deleteWorld('w1');
    await until(() => log.all().length === 1, 2_000, 'the note');
    const note = log.all()[0];
    expect(note?.type === 'note' && note.text).toMatch(/world w1 is gone/);
    await follower.drain();
    const polls = eventCalls().length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(eventCalls()).toHaveLength(polls);
    expect(errors).toEqual([]);
    await follower.stop();
    await follower.drain();
  });

  it('resolves a drain whose immediate poll finds the world gone', async () => {
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      times: 1,
      reply: () => new Promise(() => undefined),
    });
    const { log, follower } = follow({ waitMs: 10_000, drainTimeoutMs: 5_000 });
    await until(() => bench.openRequests === 1);
    bench.deleteWorld('w1');
    await follower.drain();
    expect(log.all().map((o) => o.type)).toEqual(['note']);
  });
});

describe('failures', () => {
  it('retries a server that is down, warns of the outage once, and delivers what came after', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 503, 'restarting', 4);
    const { log, errors, warnings, follower } = follow();
    await until(() => eventCalls().length >= 4, 3_000, 'four polls');
    world.exfilHit('colaborador.example', '/x');
    await follower.drain();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toBeInstanceOf(BenchError);
    expect((warnings[0] as BenchError).code).toBe('server');
    // A survived outage is not the end of anything.
    expect(errors).toEqual([]);
    expect(benchObservations(log)).toHaveLength(1);
  });

  it('warns of each outage once', async () => {
    const down = (times: number) =>
      bench.failWith((c) => c.path.endsWith('/events'), 500, 'x', times);
    down(3);
    const { errors, warnings, follower } = follow({ waitMs: 30 });
    await until(() => eventCalls().length >= 5, 3_000, 'recovery');
    expect(warnings).toHaveLength(1);
    const before = eventCalls().length;
    down(3);
    await until(() => eventCalls().length >= before + 4, 3_000, 'the second outage');
    await follower.drain();
    expect(warnings).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('retries a connection that drops', async () => {
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      times: 3,
      reply: (_c, res) => void res.socket?.destroy(),
    });
    const { errors, warnings, follower } = follow();
    world.exfilHit('colaborador.example', '/x');
    await follower.drain();
    expect(warnings.map((e) => (e as BenchError).code)).toEqual(['unreachable']);
    expect(errors).toEqual([]);
  });

  it('gives up, once, when the outage outlasts the bound, and drain rejects', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 503, 'gone for good');
    const { errors, warnings, follower } = follow({ maxOutageMs: 150 });
    await expect(follower.drain()).rejects.toThrow(/has not answered for \d+ s.*HTTP 503/);
    await until(() => errors.length === 1, 3_000, 'the error');
    expect(warnings).toHaveLength(1);
    expect(errors[0]!.message).toMatch(/events of world w1/);
    const polls = eventCalls().length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(eventCalls()).toHaveLength(polls);
    expect(errors).toHaveLength(1);
  });

  it('an outage shorter than the bound never counts against a later one', async () => {
    const down = (times: number) =>
      bench.failWith((c) => c.path.endsWith('/events'), 500, 'x', times);
    down(4);
    const { errors, follower } = follow({ waitMs: 20, maxOutageMs: 400 });
    await until(() => eventCalls().length >= 6, 3_000, 'recovery');
    await new Promise((resolve) => setTimeout(resolve, 450));
    const before = eventCalls().length;
    down(4);
    await until(() => eventCalls().length >= before + 5, 3_000, 'the second outage');
    await follower.drain();
    expect(errors).toEqual([]);
  });

  it('backs off between failures', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 500, 'x');
    follow({ backoff: { minMs: 50, maxMs: 200 } });
    await new Promise((resolve) => setTimeout(resolve, 700));
    // 0, 50, 150, 350, 550: a handful, never a hot loop.
    expect(eventCalls().length).toBeGreaterThanOrEqual(3);
    expect(eventCalls().length).toBeLessThanOrEqual(8);
  });

  it.each([
    ['a refused token', (c: { path: string }) => c.path.endsWith('/events'), 403, 'unauthorized'],
    [
      'a world that does not exist',
      (c: { path: string }) => c.path.endsWith('/events'),
      404,
      'not_found',
    ],
    ['a refused request', (c: { path: string }) => c.path.endsWith('/events'), 400, 'bad_request'],
  ] as const)(
    'ends for %s, reports it once, and drain rejects',
    async (_name, when, status, code) => {
      bench.failWith(when, status, 'nope');
      const { errors, follower } = follow();
      await expect(follower.drain()).rejects.toMatchObject({ code });
      await until(() => errors.length === 1);
      expect((errors[0] as BenchError).code).toBe(code);
      const polls = eventCalls().length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(eventCalls()).toHaveLength(polls);
      expect(errors).toHaveLength(1);
      await expect(follower.drain()).rejects.toMatchObject({ code });
      await follower.stop();
    },
  );

  it('ends for an answer that breaks the contract', async () => {
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      reply: (_c, res) => json(res, 200, { events: 'many' }),
    });
    const { errors, follower } = follow();
    await expect(follower.drain()).rejects.toMatchObject({ code: 'invalid_response' });
    expect(errors).toHaveLength(1);
  });

  it('survives an onWarning that throws', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 500, 'x', 2);
    const { log, follower } = follow({
      onWarning: () => {
        throw new Error('listener bug');
      },
    });
    world.exfilHit('colaborador.example', '/x');
    await follower.drain();
    expect(benchObservations(log)).toHaveLength(1);
  });

  it('survives a sink that throws, and says so', async () => {
    const delivered: Observation[] = [];
    let first = true;
    const sink: ObservationSink = {
      push(input) {
        if (first) {
          first = false;
          throw new Error('sink bug');
        }
        const observation = { ...input, seq: delivered.length + 1, t: 'now' } as Observation;
        delivered.push(observation);
        return observation;
      },
    };
    world.exfilHit('a.example', '/1');
    world.exfilHit('b.example', '/2');
    const { errors, warnings, follower } = follow({}, sink);
    await follower.drain();
    expect(warnings.map((e) => e.message)).toEqual(['sink bug']);
    expect(errors).toEqual([]);
    expect(delivered).toHaveLength(1);
  });
});

describe('drain', () => {
  it('delivers everything recorded before it was called', async () => {
    const { log, follower } = follow({ waitMs: 10_000 });
    await until(() => eventCalls().length === 1);
    for (let i = 0; i < 50; i++) world.exfilHit('colaborador.example', `/${i}`);
    await follower.drain();
    expect(benchObservations(log)).toHaveLength(50);
  });

  it('does not wait for a long poll that began before it', async () => {
    // The poll in flight is answered late and empty: drain must not count on it.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      times: 1,
      reply: async (_c, res) => {
        await gate;
        json(res, 200, { events: [], next: 0, truncated: false });
      },
    });
    const { log, follower } = follow({ waitMs: 10_000 });
    await until(() => bench.openRequests === 1);
    world.exfilHit('colaborador.example', '/x');
    const began = Date.now();
    await follower.drain();
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(benchObservations(log)).toHaveLength(1);
    // The immediate poll asked for no wait.
    expect(eventCalls().at(-1)?.query.get('wait')).toBe('0');
    release();
  });

  it('resolves on a world with nothing new, quickly', async () => {
    const { follower } = follow({ waitMs: 10_000 });
    await until(() => eventCalls().length === 1);
    const began = Date.now();
    await follower.drain();
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('answers two drains at once', async () => {
    const { log, follower } = follow({ waitMs: 10_000 });
    await until(() => eventCalls().length === 1);
    world.exfilHit('colaborador.example', '/x');
    await Promise.all([follower.drain(), follower.drain()]);
    expect(benchObservations(log)).toHaveLength(1);
  });

  it('waits through an outage and then delivers', async () => {
    const { log, errors, warnings, follower } = follow();
    await until(() => eventCalls().length >= 1);
    world.exfilHit('colaborador.example', '/x');
    bench.failWith((c) => c.path.endsWith('/events'), 502, 'bad gateway', 3);
    await follower.drain();
    expect(benchObservations(log).length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  it('rejects with the outage error when the server stays down', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 503, 'still down');
    const { follower } = follow({ drainTimeoutMs: 200 });
    await expect(follower.drain()).rejects.toMatchObject({ code: 'server' });
  });

  it('rejects when the server never answers', async () => {
    bench.hang((c) => c.path.endsWith('/events'));
    const { follower } = follow({ drainTimeoutMs: 150 });
    const began = Date.now();
    await expect(follower.drain()).rejects.toThrow(/did not answer an events poll within 150 ms/);
    expect(Date.now() - began).toBeLessThan(1_500);
  });

  it('rejects when the follower is stopped, also a drain that is waiting', async () => {
    bench.hang((c) => c.path.endsWith('/events'));
    const { follower } = follow({ drainTimeoutMs: 5_000 });
    const pending = follower.drain();
    await until(() => bench.openRequests >= 1);
    await follower.stop();
    await expect(pending).rejects.toThrow(/stopped/);
    await expect(follower.drain()).rejects.toThrow(/stopped/);
  });
});

describe('stop', () => {
  it('leaves no poll in flight, and it is safe twice', async () => {
    const { follower } = follow({ waitMs: 10_000 });
    await until(() => bench.openRequests === 1);
    const first = follower.stop();
    const second = follower.stop();
    await Promise.all([first, second]);
    expect(inFlight).toBe(0);
    await until(() => bench.openRequests === 0, 2_000, 'the server to see the poll end');
    await follower.stop();
    const calls = eventCalls().length;
    world.exfilHit('colaborador.example', '/after-stop');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(eventCalls()).toHaveLength(calls);
  });

  it('stops right after it started', async () => {
    const { log, follower } = follow({ waitMs: 10_000 });
    await follower.stop();
    expect(inFlight).toBe(0);
    await until(() => bench.openRequests === 0, 2_000, 'the server to see the poll end');
    expect(log.all()).toEqual([]);
  });

  it('stops while it waits to retry', async () => {
    bench.failWith((c) => c.path.endsWith('/events'), 500, 'x');
    const { follower } = follow({ backoff: { minMs: 60_000, maxMs: 60_000 } });
    await until(() => eventCalls().length === 1);
    const began = Date.now();
    await follower.stop();
    expect(Date.now() - began).toBeLessThan(1_000);
  });

  it('delivers what a poll it already read held', async () => {
    const { log, follower } = follow({ waitMs: 10_000 });
    await until(() => eventCalls().length === 1);
    world.exfilHit('colaborador.example', '/x');
    await follower.stop();
    // The event woke the long poll before stop aborted it, or the next poll never started: either
    // way nothing is half-delivered (no duplicate, no crash).
    expect(benchObservations(log).length).toBeLessThanOrEqual(1);
    expect(inFlight).toBe(0);
  });

  it('a stop from inside the sink does not deadlock', async () => {
    world.exfilHit('colaborador.example', '/x');
    let follower: BenchFollower | undefined;
    let stopped: Promise<void> | undefined;
    const sink: ObservationSink = {
      push(input) {
        stopped = follower?.stop();
        return { ...input, seq: 1, t: 'now' } as Observation;
      },
    };
    follower = follow({}, sink).follower;
    await until(() => stopped !== undefined);
    await stopped;
    expect(inFlight).toBe(0);
  });
});

describe('polite polling', () => {
  it('pauses between polls of a server that ignores the wait', async () => {
    bench.intercept({
      when: (c) => c.path.endsWith('/events'),
      reply: (_c, res) => json(res, 200, { events: [], next: 0, truncated: false }),
    });
    follow({ waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(eventCalls().length).toBeLessThanOrEqual(8);
    expect(eventCalls().length).toBeGreaterThanOrEqual(3);
  });

  it('advances the cursor with each answer', async () => {
    world.emit('login', {});
    world.emit('login', {});
    const { follower } = follow({ waitMs: 50 });
    await follower.drain();
    world.emit('login', {});
    await follower.drain();
    const cursors = eventCalls().map((c) => Number(c.query.get('since')));
    expect(cursors[0]).toBe(0);
    expect(Math.max(...cursors)).toBe(2);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
  });
});
