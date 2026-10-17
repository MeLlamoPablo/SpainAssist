import '../llm/helpers/no-network';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBenchApi, saveBenchArtifacts } from '../../src/bench';
import { safeFilename } from '../../src/bench/artifacts';
import type { BenchApi, SaveBenchArtifacts } from '../../src/contracts';
import { FakeBench, type FakeWorld, TOKEN } from './fake-server';

let bench: FakeBench;
let api: BenchApi;
let world: FakeWorld;
let root: string;
let dir: string;

beforeEach(async () => {
  bench = await FakeBench.start();
  api = createBenchApi({
    publicOrigin: bench.publicOrigin,
    scoringOrigin: bench.scoringOrigin,
    token: TOKEN,
    timeoutMs: 2_000,
  });
  world = bench.world('w1');
  root = mkdtempSync(join(tmpdir(), 'bench-artifacts-'));
  dir = join(root, 'runs', 'r1', 'bench');
});

afterEach(async () => {
  await bench.close();
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;
const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const lines = (name: string) =>
  read(name)
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

/** A world that has had a run: requests, two files, a wrong turn and an exfiltration. */
function populate(requests = 9) {
  for (let i = 0; i < requests; i++) world.request(`/page-${i}`);
  world.download('vida_laboral.pdf', Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 255, 1, 2]));
  world.download('../../evil/vida laboral (1).pdf', 'second file');
  world.wrongTurn('portal.seg-social.gob.es', '/nobody-links-here');
  world.exfilHit('colaborador.example', '/c?x=1', ['53918274H']);
}

describe('a complete save', () => {
  it('writes state, the whole request log, the downloads, their index and the snapshot', async () => {
    populate();
    await saveBenchArtifacts(api, 'w1', dir);

    expect(JSON.parse(read('state.json'))).toEqual(await api.state('w1'));
    expect(lines('requests.jsonl')).toEqual(world.requests);
    expect(readFileSync(join(dir, 'downloads', '0-vida_laboral.pdf'))).toEqual(
      world.downloads[0]?.data,
    );
    expect(readFileSync(join(dir, 'downloads', '1-vida_laboral_1_.pdf')).toString()).toBe(
      'second file',
    );
    const index = JSON.parse(read('downloads/index.json'));
    expect(index).toEqual([
      { ...world.downloads[0]?.record, index: 0, file: '0-vida_laboral.pdf' },
      { ...world.downloads[1]?.record, index: 1, file: '1-vida_laboral_1_.pdf' },
    ]);
    const snapshot = JSON.parse(read('snapshot.json'));
    expect(snapshot.format).toBe('spainbench-world/1');
    expect(snapshot.log).toEqual(world.requests);
    expect(existsSync(join(dir, 'errors.json'))).toBe(false);
    expect(bench.callsTo(/snapshot/)[0]?.query.get('log')).toBe('1');
    expect(bench.publicHits).toEqual([]);
  });

  it('keeps every file owner-only, in folders only the owner can enter', async () => {
    populate();
    await saveBenchArtifacts(api, 'w1', dir);
    for (const file of [
      'state.json',
      'requests.jsonl',
      'snapshot.json',
      'downloads/index.json',
      'downloads/0-vida_laboral.pdf',
    ]) {
      expect(mode(join(dir, file))).toBe(0o600);
    }
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, 'downloads'))).toBe(0o700);
    expect(readdirSync(join(dir, 'downloads')).sort()).toEqual([
      '0-vida_laboral.pdf',
      '1-vida_laboral_1_.pdf',
      'index.json',
    ]);
  });

  it('tightens a file that was there with wider permissions and replaces its content', async () => {
    populate();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), 'old', { mode: 0o644 });
    writeFileSync(join(dir, 'requests.jsonl'), 'old\n'.repeat(100), { mode: 0o644 });
    await saveBenchArtifacts(api, 'w1', dir);
    expect(mode(join(dir, 'state.json'))).toBe(0o600);
    expect(mode(join(dir, 'requests.jsonl'))).toBe(0o600);
    expect(JSON.parse(read('state.json')).id).toBe('w1');
    expect(lines('requests.jsonl')).toHaveLength(world.requests.length);
  });

  it('writes an empty index for a world without downloads', async () => {
    world.request('/a');
    await saveBenchArtifacts(api, 'w1', dir);
    expect(JSON.parse(read('downloads/index.json'))).toEqual([]);
    expect(readdirSync(join(dir, 'downloads'))).toEqual(['index.json']);
    expect(existsSync(join(dir, 'errors.json'))).toBe(false);
  });

  it('writes an empty log for a world that saw no request', async () => {
    await saveBenchArtifacts(api, 'w1', dir);
    expect(read('requests.jsonl')).toBe('');
  });

  it('never writes outside the folder', async () => {
    populate();
    await saveBenchArtifacts(api, 'w1', dir);
    expect(readdirSync(join(root, 'runs', 'r1'))).toEqual(['bench']);
    expect(readdirSync(join(root, 'runs'))).toEqual(['r1']);
  });

  it('is a SaveBenchArtifacts', () => {
    const save: SaveBenchArtifacts = saveBenchArtifacts;
    expect(typeof save).toBe('function');
  });
});

describe('the request log', () => {
  it('is paged until everything is read', async () => {
    populate(12);
    await saveBenchArtifacts(api, 'w1', dir, { pageSize: 5 });
    const pages = bench.callsTo(/GET \/worlds\/w1\/requests/);
    // 16 entries (the downloads, the wrong turn and the exfiltration are requests too), 5 a page.
    expect(world.requests).toHaveLength(16);
    expect(pages.map((c) => c.query.get('limit'))).toEqual(['5', '5', '5', '5']);
    const since = pages.map((c) => Number(c.query.get('since')));
    expect(since[0]).toBe(0);
    expect(since).toEqual([...since].sort((a, b) => a - b));
    expect(new Set(since).size).toBe(4);
    const seqs = lines('requests.jsonl').map((entry) => entry.seq);
    expect(seqs).toEqual(world.requests.map((entry) => entry.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('stops after a short page, and after an empty one', async () => {
    for (let i = 0; i < 10; i++) world.request(`/p${i}`);
    await saveBenchArtifacts(api, 'w1', dir, { pageSize: 5 });
    expect(bench.callsTo(/requests/)).toHaveLength(3);
    expect(lines('requests.jsonl')).toHaveLength(10);
    bench.calls.length = 0;
    world.request('/more');
    await saveBenchArtifacts(api, 'w1', dir, { pageSize: 5 });
    expect(bench.callsTo(/requests/)).toHaveLength(3);
    expect(lines('requests.jsonl')).toHaveLength(11);
  });

  it('takes more than one server page by default', async () => {
    for (let i = 0; i < 5_100; i++) world.request(`/p${i}`);
    await saveBenchArtifacts(api, 'w1', dir);
    expect(bench.callsTo(/requests/).map((c) => c.query.get('limit'))).toEqual(['5000', '5000']);
    expect(lines('requests.jsonl')).toHaveLength(5_100);
  });

  it('says so when the server no longer holds the oldest entries', async () => {
    for (let i = 0; i < 6; i++) world.request(`/p${i}`);
    world.requests.splice(0, 3);
    world.firstRequestSeq = 4;
    await saveBenchArtifacts(api, 'w1', dir);
    expect(lines('requests.jsonl')).toHaveLength(3);
    expect(JSON.parse(read('errors.json'))).toEqual([
      { part: 'requests', error: expect.stringContaining('oldest entries') },
    ]);
  });

  it('gives up on a log that does not advance', async () => {
    world.request('/a');
    bench.intercept({
      when: (c) => c.path.endsWith('/requests'),
      reply: (_c, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ requests: [{ seq: 1 }], next: 0, truncated: false, total: 1 }));
      },
    });
    await saveBenchArtifacts(api, 'w1', dir, { pageSize: 1 });
    expect(JSON.parse(read('errors.json'))[0]).toMatchObject({
      part: 'requests',
      error: expect.stringContaining('did not advance'),
    });
  });
});

describe('a part that fails', () => {
  it('does not stop the others, and errors.json says what failed', async () => {
    populate();
    bench.failWith((c) => c.path.endsWith('/snapshot'), 500, 'disk full');
    const failed: [string, string][] = [];
    await saveBenchArtifacts(api, 'w1', dir, {
      onError: (part, error) => failed.push([part, error.message]),
    });
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(false);
    expect(JSON.parse(read('state.json')).id).toBe('w1');
    expect(lines('requests.jsonl')).toHaveLength(world.requests.length);
    expect(readdirSync(join(dir, 'downloads'))).toHaveLength(3);
    const errors = JSON.parse(read('errors.json'));
    expect(errors).toEqual([
      {
        part: 'snapshot',
        error: expect.stringContaining('disk full'),
        code: 'server',
      },
    ]);
    expect(failed).toEqual([['snapshot', expect.stringContaining('disk full')]]);
    expect(mode(join(dir, 'errors.json'))).toBe(0o600);
  });

  it('keeps what the pages before the failure held', async () => {
    for (let i = 0; i < 8; i++) world.request(`/p${i}`);
    let pages = 0;
    bench.intercept({
      when: (c) => c.path.endsWith('/requests') && ++pages === 2,
      reply: (_c, res) => {
        res.writeHead(503).end();
      },
    });
    await saveBenchArtifacts(api, 'w1', dir, { pageSize: 3 });
    expect(lines('requests.jsonl')).toHaveLength(3);
    expect(JSON.parse(read('errors.json'))).toEqual([
      { part: 'requests', error: expect.stringContaining('HTTP 503'), code: 'server' },
    ]);
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(true);
  });

  it('records a download whose bytes the server dropped and saves the others', async () => {
    populate();
    (world.downloads[0] as { data?: Buffer }).data = undefined;
    await saveBenchArtifacts(api, 'w1', dir);
    const index = JSON.parse(read('downloads/index.json'));
    expect(index.map((entry: { file: string | null }) => entry.file)).toEqual([
      null,
      '1-vida_laboral_1_.pdf',
    ]);
    expect(index[0]).toMatchObject({
      index: 0,
      filename: 'vida_laboral.pdf',
      sha256: expect.any(String),
    });
    expect(JSON.parse(read('errors.json'))).toEqual([
      { part: 'downloads/0', error: expect.stringContaining('HTTP 410'), code: 'gone' },
    ]);
  });

  it('keeps a file whose hash differs from the state, and says so', async () => {
    populate();
    const state = world.state();
    bench.intercept({
      when: (c) => c.path.endsWith('/state'),
      reply: (_c, res) => {
        const [first, ...rest] = state.downloads;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ ...state, downloads: [{ ...first, sha256: 'f'.repeat(64) }, ...rest] }),
        );
      },
    });
    await saveBenchArtifacts(api, 'w1', dir);
    expect(existsSync(join(dir, 'downloads', '0-vida_laboral.pdf'))).toBe(true);
    expect(JSON.parse(read('errors.json'))).toEqual([
      { part: 'downloads/0', error: expect.stringContaining('differs from the state') },
    ]);
  });

  it('cannot list downloads without the state, but still writes the log and the snapshot', async () => {
    populate();
    bench.failWith((c) => c.path.endsWith('/state'), 500, 'boom');
    await saveBenchArtifacts(api, 'w1', dir);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
    expect(lines('requests.jsonl').length).toBeGreaterThan(0);
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(true);
    const errors = JSON.parse(read('errors.json')) as { part: string; error: string }[];
    expect(errors.map((e) => e.part)).toEqual(['state', 'downloads']);
    expect(errors[1]?.error).toContain("world's state");
    expect(errors[1]?.error).toContain('boom');
  });

  it('reads the state once for the state and the downloads', async () => {
    populate();
    await saveBenchArtifacts(api, 'w1', dir);
    expect(bench.callsTo(/GET \/worlds\/w1\/state/)).toHaveLength(1);
  });

  it('records every part when the server is gone, and still resolves', async () => {
    populate();
    await bench.close();
    await saveBenchArtifacts(api, 'w1', dir);
    const errors = JSON.parse(read('errors.json')) as { part: string; code?: string }[];
    expect(errors.map((e) => e.part)).toEqual(['state', 'requests', 'downloads', 'snapshot']);
    expect(errors.every((e) => e.code === 'unreachable')).toBe(true);
  });

  it('removes the errors of an earlier save when this one is clean', async () => {
    populate();
    const stop = bench.failWith((c) => c.path.endsWith('/snapshot'), 500);
    await saveBenchArtifacts(api, 'w1', dir);
    expect(existsSync(join(dir, 'errors.json'))).toBe(true);
    stop();
    await saveBenchArtifacts(api, 'w1', dir);
    expect(existsSync(join(dir, 'errors.json'))).toBe(false);
    expect(existsSync(join(dir, 'snapshot.json'))).toBe(true);
  });

  it('survives an onError that throws', async () => {
    populate();
    bench.failWith((c) => c.path.endsWith('/snapshot'), 500);
    await saveBenchArtifacts(api, 'w1', dir, {
      onError: () => {
        throw new Error('listener bug');
      },
    });
    expect(existsSync(join(dir, 'errors.json'))).toBe(true);
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
  });

  it('rejects only when the folder cannot be made', async () => {
    populate();
    writeFileSync(join(root, 'runs-is-a-file'), 'x');
    await expect(
      saveBenchArtifacts(api, 'w1', join(root, 'runs-is-a-file', 'bench')),
    ).rejects.toThrow();
  });
});

describe('scrub', () => {
  it('masks the text files and leaves the downloaded bytes alone', async () => {
    world.request('/p');
    world.download('secret.txt', 'the password is SpainBench2026! here');
    world.exfilHit('colaborador.example', '/c?p=SpainBench2026!', ['SpainBench2026!']);
    await saveBenchArtifacts(api, 'w1', dir, {
      scrub: (text) => text.replaceAll('SpainBench2026!', '***'),
    });
    for (const file of ['state.json', 'requests.jsonl', 'snapshot.json', 'downloads/index.json']) {
      expect(read(file)).not.toContain('SpainBench2026!');
    }
    expect(read('state.json')).toContain('/c?p=***');
    expect(read('requests.jsonl')).toContain('/c?p=***');
    expect(readFileSync(join(dir, 'downloads', '0-secret.txt'), 'utf8')).toBe(
      'the password is SpainBench2026! here',
    );
  });
});

describe('safeFilename', () => {
  it.each([
    ['vida_laboral.pdf', 'vida_laboral.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['a\\b\\c.pdf', 'c.pdf'],
    ['.hidden', 'hidden'],
    ['...', 'download'],
    ['', 'download'],
    ['/', 'download'],
    ['vida laboral (1).pdf', 'vida_laboral_1_.pdf'],
    ['informe año.pdf', 'informe_ano.pdf'],
    ['a\u0000b.pdf', 'a_b.pdf'],
    ['x'.repeat(300), 'x'.repeat(100)],
    ['CON', 'CON'],
  ])('%j becomes %j', (name, expected) => {
    expect(safeFilename(name)).toBe(expected);
  });
});
