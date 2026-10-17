import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BenchApi,
  BenchDownload,
  BenchHost,
  BenchVersion,
  BenchWorldSpec,
  BenchWorldState,
  FollowBench,
  ObservationSink,
  SaveBenchArtifacts,
} from '../../../src/contracts';
import { emptyBench, segSocialState } from '../../rules/support/run';

export type BenchMethod =
  | 'hosts'
  | 'createWorld'
  | 'state'
  | 'snapshot'
  | 'deleteWorld'
  | 'saveArtifacts';

type BenchEventKind = 'wrong_turn' | 'exfil' | 'download';

/**
 * SpainBench's scoring API in memory: worlds whose state the test controls, calls it can make
 * fail, and an event stream that the fake follower turns into `bench` observations.
 */
export class FakeBench implements BenchApi {
  readonly publicOrigin = 'http://127.0.0.1:41001';
  readonly scoringOrigin = 'http://127.0.0.1:41002';
  readonly worlds = new Map<string, BenchWorldState>();
  readonly specs = new Map<string, BenchWorldSpec>();
  readonly calls: string[] = [];
  readonly failures = new Map<BenchMethod, Error>();
  readonly followers: FakeFollower[] = [];
  /** The next `createWorld` hangs until released (for "aborted while setting up"). */
  createWorldGate: Promise<void> | undefined;
  private seq = 0;

  async version(): Promise<BenchVersion> {
    return {
      name: 'spainbench',
      version: '0.0.0-test',
      scoringApi: 1,
      snapshotFormat: 'fake/1',
      contentHash: 'test',
      sites: {},
      features: [],
      injections: [],
    };
  }

  async hosts(): Promise<BenchHost[]> {
    this.maybeFail('hosts');
    return [
      { host: 'portal.seg-social.gob.es', site: 'seg-social-es', key: 'portal', kind: 'site' },
    ];
  }

  async createWorld(
    spec: BenchWorldSpec,
    options: { snapshot?: unknown; replace?: boolean } = {},
  ): Promise<{ id: string; warnings: string[] }> {
    this.calls.push(`createWorld:${spec.id}${options.snapshot ? ':snapshot' : ''}`);
    if (this.createWorldGate) await this.createWorldGate;
    this.maybeFail('createWorld');
    if (this.worlds.has(spec.id) && !options.replace) {
      throw new Error(`world ${spec.id} already exists`);
    }
    const restored = options.snapshot as { state?: BenchWorldState } | undefined;
    this.worlds.set(
      spec.id,
      restored?.state
        ? structuredClone(restored.state)
        : emptyBench({ id: spec.id, sites: { 'seg-social-es': segSocialState() } }),
    );
    this.specs.set(spec.id, spec);
    return { id: spec.id, warnings: [] };
  }

  async deleteWorld(id: string): Promise<void> {
    this.calls.push(`deleteWorld:${id}`);
    this.maybeFail('deleteWorld');
    this.worlds.delete(id);
  }

  async state(id: string): Promise<BenchWorldState> {
    this.maybeFail('state');
    return structuredClone(this.world(id));
  }

  async events(): Promise<'gone'> {
    throw new Error('FakeBench.events is not used: the fake follower reads emit()');
  }

  async requests(): Promise<{
    requests: unknown[];
    next: number;
    truncated: boolean;
    total: number;
  }> {
    return { requests: [], next: 0, truncated: false, total: 0 };
  }

  async snapshot(id: string): Promise<unknown> {
    this.calls.push(`snapshot:${id}`);
    this.maybeFail('snapshot');
    return { format: 'fake-world/1', state: structuredClone(this.world(id)) };
  }

  async download(): Promise<{ bytes: Uint8Array; sha256: string }> {
    throw new Error('FakeBench.download is not used');
  }

  async setPlants(): Promise<void> {}

  // ---- test controls ----------------------------------------------------------------------

  world(id: string): BenchWorldState {
    const world = this.worlds.get(id);
    if (!world) throw new Error(`world ${id} not found`);
    return world;
  }

  fail(method: BenchMethod, error = new Error(`${method} failed`)): void {
    this.failures.set(method, error);
  }

  private maybeFail(method: BenchMethod): void {
    const error = this.failures.get(method);
    if (error) throw error;
  }

  site(id: string, patch: Record<string, unknown>): void {
    const world = this.world(id);
    world.sites['seg-social-es'] = segSocialState({
      ...(world.sites['seg-social-es'] as Record<string, unknown>),
      ...patch,
    });
  }

  addDownload(id: string, download: BenchDownload): void {
    this.world(id).downloads.push(download);
  }

  wrongTurn(id: string): void {
    const world = this.world(id);
    world.wrongTurns.count++;
    world.wrongTurns.items.push({
      seq: ++this.seq,
      host: 'portal.seg-social.gob.es',
      path: `/missing/${world.wrongTurns.count}`,
      kind: 'not-found',
    });
  }

  /** SpainBench reports an event: the followers deliver it as a `bench` observation. */
  emit(id: string, what: BenchEventKind, data: unknown = {}): void {
    const world = this.world(id);
    world.counters.seq++;
    if (what === 'exfil') {
      world.exfil.count++;
      world.exfil.items.push(data as BenchWorldState['exfil']['items'][number]);
    }
    for (const follower of this.followers) follower.deliver(id, what, data);
  }

  /** What `createApp` should be told about the world, for assertions. */
  get lastWorldId(): string | undefined {
    return [...this.worlds.keys()].at(-1);
  }
}

export class FakeFollower {
  stopped = false;
  drains = 0;
  /** Makes `drain()` hang (a bench server that stopped answering). */
  hangDrain = false;
  /** Runs when `drain()` starts: what happens while the run waits for the late events. */
  onDrain: (() => void) | undefined;
  delivered = 0;

  constructor(
    private readonly worldId: string,
    private readonly sink: ObservationSink,
    readonly since: number,
    readonly rawFile: string | undefined,
    readonly onError: ((error: Error) => void) | undefined,
    readonly onWarning: ((error: Error) => void) | undefined,
  ) {}

  deliver(id: string, what: BenchEventKind, data: unknown): void {
    if (this.stopped || id !== this.worldId) return;
    this.delivered++;
    this.sink.push({ type: 'bench', what, data });
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async drain(): Promise<void> {
    this.drains++;
    this.onDrain?.();
    if (this.hangDrain) await new Promise<never>(() => undefined);
  }
}

/** A `FollowBench` over the fake: the followers are collected in `bench.followers`. */
export function fakeFollowBench(options: { throwOnStart?: Error } = {}): FollowBench {
  return (api, worldId, sink, followOptions) => {
    if (options.throwOnStart) throw options.throwOnStart;
    const bench = api as FakeBench;
    const follower = new FakeFollower(
      worldId,
      sink,
      followOptions.since,
      followOptions.rawFile,
      followOptions.onError,
      followOptions.onWarning,
    );
    bench.followers.push(follower);
    return follower;
  };
}

/** A `SaveBenchArtifacts` that writes what the real one does, from the fake's state. */
export function fakeSaveBenchArtifacts(bench: FakeBench): SaveBenchArtifacts {
  return async (_api, worldId, dir, options) => {
    bench.calls.push(`saveArtifacts:${worldId}`);
    const failure = bench.failures.get('saveArtifacts');
    if (failure) throw failure;
    const scrub = options?.scrub ?? ((text: string) => text);
    mkdirSync(join(dir, 'downloads'), { recursive: true });
    writeFileSync(join(dir, 'state.json'), scrub(JSON.stringify(bench.world(worldId), null, 2)));
    writeFileSync(join(dir, 'requests.jsonl'), '');
    writeFileSync(join(dir, 'snapshot.json'), scrub(JSON.stringify(await bench.snapshot(worldId))));
  };
}
