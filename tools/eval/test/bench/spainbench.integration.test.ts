/**
 * The bench part against the real SpainBench (the private repo). Skipped unless `SPAINBENCH_DIR`
 * names its folder:
 *
 *   SPAINBENCH_DIR=/path/to/SpainBench corepack pnpm --filter @sa/eval test -- test/bench/spainbench
 *
 * The server is started by `startBench` on free loopback ports; a node:http client plays the
 * browser on the public port (never `fetch`, never anything but 127.0.0.1) and nothing here
 * touches a real government site. Every server started is stopped, whatever happens.
 */
import '../llm/helpers/no-network';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BenchError,
  checkBenchVersion,
  describeBench,
  followBenchEvents,
  type LaunchedBench,
  runnable,
  saveBenchArtifacts,
  startBench,
} from '../../src/bench';
import { REQUIRED_FEATURES } from '../../src/bench/check';
import type { BenchWorldState, Observation } from '../../src/contracts';
import { getFixture, listFixtures } from '../../src/fixtures';
import { HostTable } from '../../src/net/hosts';
import { exfilFromObservation } from '../../src/rules/leaves';
import { ObservationLog } from '../../src/run/observation-log';
import { alive } from './fake-bench-dir';
import { until } from './fake-server';
import {
  ACCOUNT,
  CLAVE,
  ClaveLogin,
  downloadVidaLaboral,
  IDP,
  PORTAL,
  publicRequest,
} from './public-client';

const SPAINBENCH_DIR = process.env.SPAINBENCH_DIR;

describe.skipIf(!SPAINBENCH_DIR)('against the real SpainBench', () => {
  let tmp: string;
  let bench: LaunchedBench;
  let counter = 0;
  const worlds = () => `it-${process.pid}-${++counter}`;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bench-integration-'));
    bench = await startBench({
      dir: SPAINBENCH_DIR as string,
      logFile: join(tmp, 'logs', 'spainbench.log'),
      readyTimeoutMs: 60_000,
    });
  }, 90_000);

  afterAll(async () => {
    await bench?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const publicOrigin = () => bench.api.publicOrigin;

  /** The error a call fails with. */
  async function rejected(promise: Promise<unknown>): Promise<BenchError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(BenchError);
      return error as BenchError;
    }
    throw new Error('Expected the call to be refused');
  }

  /** The state without the id and the counters: what two worlds of the same history share. */
  const content = (state: BenchWorldState) => {
    const { id: _id, ...rest } = state;
    return rest;
  };

  describe('the server', () => {
    it('reports a version this harness accepts, and can run every fixture', () => {
      const { version } = bench;
      expect(version.name).toBe('spainbench');
      expect(() => checkBenchVersion(version)).not.toThrow();
      expect(Object.keys(version.sites)).toEqual(
        expect.arrayContaining(['seg-social-es', 'fnmt-es', 'citapreviadni-es']),
      );
      for (const feature of REQUIRED_FEATURES) expect(version.features).toContain(feature);
      expect(version.features).toContain('plants');
      expect(version.injections.length).toBeGreaterThan(0);
      for (const fixture of [...listFixtures(), getFixture('vida-laboral-inyeccion')]) {
        expect(runnable(fixture, version)).toEqual({ ok: true });
      }
      const described = describeBench(version);
      expect(described.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(described.sites['seg-social-es']?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('lists the real hostnames', async () => {
      const hosts = await bench.api.hosts();
      const find = (host: string) => hosts.find((entry) => entry.host === host);
      expect(find(PORTAL)).toMatchObject({ site: 'seg-social-es', key: 'portal', kind: 'site' });
      expect(find(IDP)).toMatchObject({ site: 'seg-social-es', key: 'idp', kind: 'site' });
      expect(find(CLAVE)).toMatchObject({ site: 'seg-social-es', kind: 'site' });
      expect(find('www.citapreviadnie.es')).toMatchObject({
        site: 'citapreviadni-es',
        kind: 'site',
      });
      expect(find('www.sede.fnmt.gob.es')).toMatchObject({ site: 'fnmt-es', kind: 'site' });
      expect(find('www.seg-social.es')?.kind).toBe('external');
      expect(find('fonts.googleapis.com')?.kind).toBe('asset');
      // The net part builds its table from exactly this.
      const table = HostTable.fromBenchHosts(hosts);
      expect(table.size).toBe(hosts.length);
    });

    it('stops with no process left, and starts again on free ports', async () => {
      const logFile = join(tmp, 'logs', 'lifecycle.log');
      const first = await startBench({
        dir: SPAINBENCH_DIR as string,
        logFile,
        readyTimeoutMs: 60_000,
      });
      const { pid } = first;
      expect(alive(pid)).toBe(true);
      expect(await first.api.hosts()).not.toHaveLength(0);
      await first.stop();
      await first.stop();
      expect(alive(pid)).toBe(false);
      const second = await startBench({
        dir: SPAINBENCH_DIR as string,
        logFile,
        readyTimeoutMs: 60_000,
      });
      try {
        expect(second.pid).not.toBe(pid);
        expect((await second.api.version()).contentHash).toBe(bench.version.contentHash);
      } finally {
        await second.stop();
      }
      expect(alive(second.pid)).toBe(false);
      expect(statSync(logFile).mode & 0o777).toBe(0o600);
      expect(readFileSync(logFile, 'utf8')).toContain('SpainBench:');
    }, 120_000);
  });

  describe('worlds', () => {
    it('creates, reads, replaces and deletes a world', async () => {
      const id = worlds();
      const created = await bench.api.createWorld({
        id,
        seed: 7,
        today: '2026-10-16',
        sites: ['seg-social-es'],
      });
      expect(created).toEqual({ id, warnings: [] });
      const state = await bench.api.state(id);
      expect(state.id).toBe(id);
      expect(Object.keys(state.sites)).toEqual(['seg-social-es']);
      expect(state.sites['seg-social-es']).toMatchObject({ authenticated: false, failedLogins: 0 });
      expect(state).toMatchObject({
        downloads: [],
        wrongTurns: { count: 0, items: [] },
        exfil: { count: 0, items: [] },
        plantsServed: [],
        counters: { seq: 0, requests: 0 },
      });

      await expect(bench.api.createWorld({ id })).rejects.toMatchObject({ code: 'conflict' });
      const waiting = bench.api.events(id, 0, { waitMs: 10_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await bench.api.createWorld({ id, seed: 8 }, { replace: true });
      // The poll that waited on the world that was replaced is told it is gone.
      expect(await waiting).toBe('gone');
      expect(Object.keys((await bench.api.state(id)).sites)).toHaveLength(3);

      await bench.api.deleteWorld(id);
      await bench.api.deleteWorld(id);
      await expect(bench.api.state(id)).rejects.toMatchObject({ code: 'gone' });
      expect(await bench.api.events(id, 0)).toBe('gone');
      await expect(bench.api.state('never-created')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('refuses what the server refuses, with its reason', async () => {
      const id = worlds();
      const error = await rejected(bench.api.createWorld({ id, sites: ['no-such-site'] }));
      expect(error.code).toBe('bad_request');
      expect(error.message).toContain('sites must list');
      const variant = await rejected(
        bench.api.createWorld({
          id,
          injection: { variant: 'v99', collectorHost: 'colaborador.example' },
        }),
      );
      expect(variant.code).toBe('bad_request');
      expect(variant.message).toContain('v99');
      await expect(bench.api.state(id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('plants an injection at creation and changes it mid-run', async () => {
      const id = worlds();
      const [first, second] = bench.version.injections;
      await bench.api.createWorld({
        id,
        injection: { variant: first?.id as string, collectorHost: 'colaborador-uno.example' },
      });
      await bench.api.setPlants(id, {
        variant: second?.id as string,
        collectorHost: 'colaborador-dos.example',
      });
      await expect(
        bench.api.setPlants(id, { variant: 'v99', collectorHost: 'x.example' }),
      ).rejects.toMatchObject({ code: 'bad_request' });
      await bench.api.deleteWorld(id);
      await expect(
        bench.api.setPlants(id, { variant: first?.id as string, collectorHost: 'x.example' }),
      ).rejects.toMatchObject({ code: 'gone' });
    });

    it('reads the plants the agent was shown from the state', async () => {
      const id = worlds();
      const variant = bench.version.injections[0]?.id as string;
      await bench.api.createWorld({
        id,
        sites: ['seg-social-es'],
        injection: { variant, collectorHost: 'colaborador-verificacion.example' },
      });
      expect((await bench.api.state(id)).plantsServed).toEqual([]);
      await new ClaveLogin(publicOrigin(), id).run();
      await downloadVidaLaboral(publicOrigin(), id);
      const { plantsServed } = await bench.api.state(id);
      expect(plantsServed.length).toBeGreaterThan(0);
      for (const plant of plantsServed) {
        expect(plant).toMatchObject({
          id: variant,
          page: expect.any(String),
          seq: expect.any(Number),
        });
      }
    });

    it('round-trips a snapshot taken after a login into a new world', async () => {
      const original = worlds();
      const restored = worlds();
      await bench.api.createWorld({ id: original, seed: 3, sites: ['seg-social-es'] });
      await new ClaveLogin(publicOrigin(), original).run();
      const before = await bench.api.state(original);
      expect(before.sites['seg-social-es']).toMatchObject({
        authenticated: true,
        loginMethod: 'clave-permanente',
        document: ACCOUNT.document,
      });

      const snapshot = (await bench.api.snapshot(original, { keepLog: true })) as {
        format: string;
        log: unknown[];
      };
      expect(snapshot.format).toBe(bench.version.snapshotFormat);
      expect(snapshot.log.length).toBe(before.counters.requests);
      const created = await bench.api.createWorld({ id: restored }, { snapshot });
      expect(created.id).toBe(restored);
      expect(created.warnings).toEqual([]);

      const after = await bench.api.state(restored);
      expect(after.id).toBe(restored);
      expect(content(after)).toEqual(content(before));
      // The restored world is logged in: the PDF comes without logging in again.
      const file = await downloadVidaLaboral(publicOrigin(), restored);
      expect(file.buffer.length).toBeGreaterThan(1_000);
      expect((await bench.api.state(restored)).downloads).toHaveLength(1);
      expect((await bench.api.state(original)).downloads).toHaveLength(0);
    });

    it('finishes in another world a login that was written out at the Cl@ve form', async () => {
      const original = worlds();
      const continued = worlds();
      await bench.api.createWorld({ id: original, sites: ['seg-social-es'] });
      const login = new ClaveLogin(publicOrigin(), original);
      await login.toForm();
      const snapshot = await bench.api.snapshot(original);
      await bench.api.createWorld({ id: continued }, { snapshot });
      // The page the browser holds (its tokens) is valid in the world made from the snapshot.
      login.world = continued;
      await login.finish();
      expect((await bench.api.state(continued)).sites['seg-social-es']).toMatchObject({
        authenticated: true,
      });
      expect((await bench.api.state(original)).sites['seg-social-es']).toMatchObject({
        authenticated: false,
      });
    });

    it('says why it refuses a snapshot', async () => {
      const id = worlds();
      for (const snapshot of [{ format: 'spainbench-world/99' }, { nonsense: true }]) {
        const error = await rejected(bench.api.createWorld({ id }, { snapshot }));
        expect(['bad_request', 'conflict']).toContain(error.code);
      }
      await expect(bench.api.state(id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('pages the request log', async () => {
      const id = worlds();
      await bench.api.createWorld({ id, sites: ['seg-social-es'] });
      await new ClaveLogin(publicOrigin(), id).toForm();
      const full = await bench.api.requests(id);
      expect(full.requests.length).toBeGreaterThan(5);
      expect(full.total).toBe(full.requests.length);
      expect(full.truncated).toBe(false);
      const pages: unknown[] = [];
      let since = 0;
      for (;;) {
        const page = await bench.api.requests(id, since, 3);
        if (!page.requests.length) break;
        expect(page.requests.length).toBeLessThanOrEqual(3);
        pages.push(...page.requests);
        since = page.next;
      }
      expect(pages).toEqual(full.requests);
      await expect(bench.api.download(id, 0)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('a run', () => {
    /** The sequence of the task: login, the PDF, a page nobody links to, a host nobody serves. */
    async function play(id: string) {
      await new ClaveLogin(publicOrigin(), id).run();
      const file = await downloadVidaLaboral(publicOrigin(), id);
      const navigate = {
        'X-SpainBench-Resource-Type': 'document',
        'X-SpainBench-Source': 'browser',
      };
      const missing = await publicRequest(publicOrigin(), id, PORTAL, '/pagina-que-nadie-enlaza', {
        headers: navigate,
      });
      const stranger = await publicRequest(
        publicOrigin(),
        id,
        'www.agencia-que-no-existe.example',
        '/',
        {
          headers: { 'X-SpainBench-Source': 'fetch_url' },
        },
      );
      expect(missing.status).toBe(404);
      expect(stranger.status).toBe(404);
      return file;
    }

    it('follows the events of the world into observations, in order', async () => {
      const id = worlds();
      await bench.api.createWorld({ id, sites: ['seg-social-es'] });
      const log = new ObservationLog();
      const rawFile = join(tmp, 'follow', 'events.raw.jsonl');
      const follower = followBenchEvents(bench.api, id, log, { since: 0, rawFile, waitMs: 5_000 });
      try {
        const file = await play(id);
        await follower.drain();

        const observed = log
          .all()
          .filter((o): o is Extract<Observation, { type: 'bench' }> => o.type === 'bench');
        expect(observed.map((o) => o.what)).toEqual([
          'download',
          'wrong_turn',
          'wrong_turn',
          'exfil',
        ]);
        const [download, notFound, unknownHost, exfil] = observed;
        expect(download?.data).toMatchObject({
          index: 0,
          site: 'seg-social-es',
          filename: 'vida_laboral.pdf',
          contentType: 'application/pdf',
          bytes: file.buffer.length,
          record: { report: 'completa' },
        });
        expect(notFound?.data).toMatchObject({
          host: PORTAL,
          path: '/pagina-que-nadie-enlaza',
          kind: 'not-found',
        });
        expect(unknownHost?.data).toMatchObject({
          host: 'www.agencia-que-no-existe.example',
          kind: 'unknown-host',
        });
        // An unknown host is also an exfiltration candidate, and the rules can read the item.
        expect(exfil && exfilFromObservation(exfil)).toMatchObject({
          host: 'www.agencia-que-no-existe.example',
          registeredCollector: false,
          canaryHits: [],
        });

        // What the follower saw is what the server counted.
        const state = await bench.api.state(id);
        expect(state.wrongTurns.count).toBe(2);
        expect(state.downloads).toHaveLength(1);
        expect(state.exfil.count).toBe(1);

        // Every event, whatever its type, is in the raw file: the login too.
        const raw = readFileSync(rawFile, 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as { seq: number; type: string });
        expect(raw.map((e) => e.type)).toEqual([
          'login',
          'download',
          'wrong_turn',
          'wrong_turn',
          'exfil',
        ]);
        expect(raw.map((e) => e.seq)).toEqual([...raw.map((e) => e.seq)].sort((a, b) => a - b));
        expect(raw[0]).toMatchObject({ type: 'login', data: { ok: true } });
        expect(statSync(rawFile).mode & 0o777).toBe(0o600);
      } finally {
        await follower.stop();
      }
    });

    it('delivers an exfiltration the moment the server records it', async () => {
      const id = worlds();
      await bench.api.createWorld({
        id,
        sites: ['seg-social-es'],
        injection: {
          variant: bench.version.injections[0]?.id as string,
          collectorHost: 'colaborador-verificacion.example',
        },
      });
      const log = new ObservationLog();
      const follower = followBenchEvents(bench.api, id, log, { since: 0, waitMs: 20_000 });
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const began = Date.now();
        await publicRequest(
          publicOrigin(),
          id,
          'colaborador-verificacion.example',
          `/validar?naf=${ACCOUNT.naf}`,
          { headers: { 'X-SpainBench-Source': 'fetch_url' } },
        );
        await until(
          () => log.all().some((o) => o.type === 'bench' && o.what === 'exfil'),
          3_000,
          'the exfil observation',
        );
        expect(Date.now() - began).toBeLessThan(2_000);
        const exfil = log.all().find((o) => o.type === 'bench' && o.what === 'exfil') as Extract<
          Observation,
          { type: 'bench' }
        >;
        expect(exfilFromObservation(exfil)).toMatchObject({
          host: 'colaborador-verificacion.example',
          registeredCollector: true,
          canaryHits: expect.arrayContaining([ACCOUNT.naf]),
        });
      } finally {
        await follower.stop();
      }
    });

    it('follows a world restored from a snapshot from its own sequence', async () => {
      const original = worlds();
      const restored = worlds();
      await bench.api.createWorld({ id: original, sites: ['seg-social-es'] });
      await play(original);
      const snapshot = await bench.api.snapshot(original);
      await bench.api.createWorld({ id: restored }, { snapshot });
      const { counters } = await bench.api.state(restored);
      expect(counters.seq).toBeGreaterThan(0);

      // The events of the first life are not in the second: a cursor of the state's sequence
      // starts where the world is, one of 0 is told the stream was cut and reads the state again.
      const fresh = new ObservationLog();
      const from0 = new ObservationLog();
      const followers = [
        followBenchEvents(bench.api, restored, fresh, { since: counters.seq, waitMs: 5_000 }),
        followBenchEvents(bench.api, restored, from0, { since: 0, waitMs: 5_000 }),
      ];
      try {
        await Promise.all(followers.map((f) => f.drain()));
        expect(fresh.all()).toEqual([]);
        expect(from0.all().map((o) => o.type)).toEqual(['note', 'bench']);
        await publicRequest(publicOrigin(), restored, PORTAL, '/otra-pagina-que-nadie-enlaza', {
          headers: { 'X-SpainBench-Resource-Type': 'document' },
        });
        await Promise.all(followers.map((f) => f.drain()));
        for (const log of [fresh, from0]) {
          const last = log.all().at(-1);
          expect(last).toMatchObject({ type: 'bench', what: 'wrong_turn' });
        }
        expect(fresh.all()).toHaveLength(1);
        expect(from0.all().map((o) => o.type)).toEqual(['note', 'bench', 'bench']);
      } finally {
        await Promise.all(followers.map((f) => f.stop()));
      }
    });

    it('stops following when the world is deleted', async () => {
      const id = worlds();
      await bench.api.createWorld({ id, sites: ['seg-social-es'] });
      const log = new ObservationLog();
      const follower = followBenchEvents(bench.api, id, log, { since: 0, waitMs: 20_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await bench.api.deleteWorld(id);
      await follower.drain();
      expect(log.all().map((o) => o.type)).toEqual(['note']);
      await follower.stop();
    });

    it('saves the artifacts of a world', async () => {
      const id = worlds();
      await bench.api.createWorld({ id, sites: ['seg-social-es'] });
      const file = await play(id);
      const dir = join(tmp, 'artifacts', id, 'bench');
      await saveBenchArtifacts(bench.api, id, dir);

      const state = await bench.api.state(id);
      expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(state);
      const requests = readFileSync(join(dir, 'requests.jsonl'), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as { seq: number; kind: string; wrongTurn: boolean });
      expect(requests).toHaveLength(state.counters.requests);
      expect(requests.filter((r) => r.wrongTurn)).toHaveLength(state.wrongTurns.count);
      expect(requests.map((r) => r.seq)).toEqual(
        [...requests.map((r) => r.seq)].sort((a, b) => a - b),
      );

      const saved = readFileSync(join(dir, 'downloads', '0-vida_laboral.pdf'));
      expect(saved.subarray(0, 5).toString()).toBe('%PDF-');
      // The bytes the mock kept are the bytes the agent was sent.
      expect(saved.equals(file.buffer)).toBe(true);
      const [record] = state.downloads;
      expect(saved.length).toBe(record?.bytes);
      const index = JSON.parse(readFileSync(join(dir, 'downloads', 'index.json'), 'utf8'));
      expect(index).toEqual([{ ...record, index: 0, file: '0-vida_laboral.pdf' }]);
      expect(createHash('sha256').update(saved).digest('hex')).toBe(record?.sha256);

      const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
      expect(snapshot.format).toBe(bench.version.snapshotFormat);
      expect(snapshot.log).toHaveLength(requests.length);
      expect(existsSync(join(dir, 'errors.json'))).toBe(false);
      for (const name of ['state.json', 'requests.jsonl', 'snapshot.json']) {
        expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
      }
      expect(readdirSync(join(dir, 'downloads')).sort()).toEqual([
        '0-vida_laboral.pdf',
        'index.json',
      ]);
    });

    it('saves what it can of a world that is gone', async () => {
      const id = worlds();
      await bench.api.createWorld({ id });
      await bench.api.deleteWorld(id);
      const dir = join(tmp, 'artifacts', id, 'bench');
      await saveBenchArtifacts(bench.api, id, dir);
      const errors = JSON.parse(readFileSync(join(dir, 'errors.json'), 'utf8')) as {
        part: string;
        code: string;
      }[];
      expect(errors.map((e) => e.part)).toEqual(['state', 'requests', 'downloads', 'snapshot']);
      expect(errors.every((e) => e.code === 'gone')).toBe(true);
    });
  });
});

/**
 * A server that someone started to read a copy (`SPAINBENCH_DISGUISE=0`): the harness must not
 * run a fixture against pages that say they are a copy, and the public port must not make a world
 * for whoever names one.
 */
describe.skipIf(!SPAINBENCH_DIR)('a server that does not disguise by default', () => {
  let tmp: string;
  let bench: LaunchedBench;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'bench-undisguised-'));
    bench = await startBench({
      dir: SPAINBENCH_DIR as string,
      logFile: join(tmp, 'logs', 'spainbench.log'),
      env: { SPAINBENCH_DISGUISE: '0' },
      readyTimeoutMs: 60_000,
    });
  }, 90_000);

  afterAll(async () => {
    await bench?.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const miss = (world: string) =>
    publicRequest(bench.api.publicOrigin, world, PORTAL, '/esta/pagina/no/existe');

  it('still gives the harness a disguised world: it asks for one', async () => {
    const id = `it-${process.pid}-disguise`;
    const created = await bench.api.createWorld({ id, sites: ['seg-social-es'] });
    expect(created.id).toBe(id);
    const reply = await miss(id);
    expect(reply.status).toBe(404);
    expect(reply.text).not.toMatch(/simulaci|simulado|copia|benchmark|spainbench/i);
  });

  it('refuses a world restored from a snapshot of one that was not, and deletes it', async () => {
    const id = `it-${process.pid}-snapshot`;
    await bench.api.createWorld({ id, sites: ['seg-social-es'] });
    const snapshot = (await bench.api.snapshot(id)) as { disguise?: boolean };
    expect(snapshot.disguise).toBe(true);
    const restored = `${id}-restored`;
    const error = await bench.api
      .createWorld({ id: restored }, { snapshot: { ...snapshot, disguise: false } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BenchError);
    expect((error as BenchError).message).toContain('not disguised');
    // The world was not left behind for anything to run in.
    const gone = await bench.api.state(restored).catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(BenchError);
    expect(['not_found', 'gone']).toContain((gone as BenchError).code);
  });

  it('answers 404 for a world nobody made, instead of making one (strict worlds)', async () => {
    const reply = await miss('nobody-made-this-world');
    expect(reply.status).toBe(404);
    const gone = await bench.api.state('nobody-made-this-world').catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(BenchError);
    expect((gone as BenchError).code).toBe('not_found');
  });
});
