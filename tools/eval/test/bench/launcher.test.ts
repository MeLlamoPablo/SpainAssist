import '../llm/helpers/no-network';
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BenchError,
  BenchLaunchError,
  BenchTargetError,
  BenchVersionError,
  connectBench,
  createBenchApi,
  type LaunchedBench,
  openBench,
  resolveBenchTarget,
  type StartBenchOptions,
  startBench,
} from '../../src/bench';
import { benchEnvironment } from '../../src/bench/launcher';
import { alive, createFakeBenchDir, type Seen } from './fake-bench-dir';
import { FakeBench, TOKEN, until } from './fake-server';

const started: LaunchedBench[] = [];
const dirs: string[] = [];
const children: ChildProcess[] = [];
/** Servers the stand-in harnesses started: killed here when a test failed to stop them. */
const strays: number[] = [];

function fakeDir(): string {
  const dir = createFakeBenchDir();
  dirs.push(dir);
  return dir;
}

async function start(
  mode: string | undefined,
  options: Partial<StartBenchOptions> & { dir?: string } = {},
): Promise<LaunchedBench> {
  const dir = options.dir ?? fakeDir();
  const bench = await startBench({
    logFile: join(dir, 'logs', 'spainbench.log'),
    ...options,
    dir,
    env: { ...(mode ? { FAKE_BENCH: mode } : {}), ...options.env },
  });
  started.push(bench);
  return bench;
}

const seen = (dir: string): Seen => JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));

const baseline = () => ({
  exit: process.listenerCount('exit'),
  SIGINT: process.listenerCount('SIGINT'),
  SIGTERM: process.listenerCount('SIGTERM'),
  SIGHUP: process.listenerCount('SIGHUP'),
});

let before: ReturnType<typeof baseline>;

beforeEach(() => {
  before = baseline();
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((bench) => bench.stop().catch(() => undefined)));
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const pid of strays.splice(0)) {
    try {
      // Only a process that is still a fake server: a pid can be reused.
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
      });
      if (command.includes('server/index.mjs')) process.kill(pid, 'SIGKILL');
    } catch {
      // Gone, as it should be.
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

describe('startBench', () => {
  it('starts the server from the repo folder and returns a client that has the token', async () => {
    const dir = fakeDir();
    const bench = await start('ok', { dir });
    expect(bench.mode).toBe('launch');
    expect(bench.version.name).toBe('spainbench');
    expect(bench.version.scoringApi).toBe(1);
    expect(alive(bench.pid)).toBe(true);
    expect(seen(dir)).toMatchObject({
      pid: bench.pid,
      cwd: expect.stringContaining('fake-spainbench-'),
    });
    // /meta/hosts needs the token: the client was built with the one the server was started with.
    expect(await bench.api.hosts()).toEqual([]);
    expect(bench.api.publicOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(bench.api.scoringOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('chooses two free loopback ports and a random token, and binds loopback', async () => {
    const dirA = fakeDir();
    const dirB = fakeDir();
    const a = await start('ok', { dir: dirA });
    const b = await start('ok', { dir: dirB });
    const envA = seen(dirA).env;
    const envB = seen(dirB).env;
    for (const env of [envA, envB]) {
      expect(env.SPAINBENCH_BIND).toBe('127.0.0.1');
      expect(env.SPAINBENCH_SCORING_BIND).toBe('127.0.0.1');
      expect(env.BENCHMARK_TOKEN).toMatch(/^[0-9a-f]{48}$/);
      expect(env.SPAINBENCH_PORT).not.toBe(env.SPAINBENCH_SCORING_PORT);
      expect(['3010', '3020']).not.toContain(env.SPAINBENCH_PORT);
    }
    expect(envA.BENCHMARK_TOKEN).not.toBe(envB.BENCHMARK_TOKEN);
    const ports = [envA, envB].flatMap((e) => [e.SPAINBENCH_PORT, e.SPAINBENCH_SCORING_PORT]);
    expect(new Set(ports).size).toBe(4);
    expect(a.api.publicOrigin).toBe(`http://127.0.0.1:${envA.SPAINBENCH_PORT}`);
    expect(a.api.scoringOrigin).toBe(`http://127.0.0.1:${envA.SPAINBENCH_SCORING_PORT}`);
    expect(b.api.scoringOrigin).toBe(`http://127.0.0.1:${envB.SPAINBENCH_SCORING_PORT}`);
  });

  it('gives the server a minimal environment: no inherited secrets, no proxies', async () => {
    const polluted = {
      SA_TEST_SECRET: 'do-not-pass',
      OPENAI_API_KEY: 'sk-nope',
      HTTP_PROXY: 'http://proxy.invalid:3128',
      HTTPS_PROXY: 'http://proxy.invalid:3128',
      ALL_PROXY: 'http://proxy.invalid:3128',
      NO_PROXY: '',
      SPAINBENCH_TOKEN: 'harness-token',
      BENCHMARK_TOKEN: 'harness-benchmark-token',
      SPAINBENCH_PORT: '3010',
    };
    const saved = Object.fromEntries(Object.keys(polluted).map((k) => [k, process.env[k]]));
    Object.assign(process.env, polluted);
    try {
      const dir = fakeDir();
      await start('ok', {
        dir,
        env: { SPAINBENCH_SITES: 'seg-social-es', SPAINBENCH_DATE: '2026-10-16' },
      });
      const env = seen(dir).env;
      const allowed = new Set([
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'FAKE_BENCH',
        'SPAINBENCH_SITES',
        'SPAINBENCH_DATE',
        'SPAINBENCH_PORT',
        'SPAINBENCH_BIND',
        'SPAINBENCH_SCORING_PORT',
        'SPAINBENCH_SCORING_BIND',
        'SPAINBENCH_STRICT_WORLDS',
        'BENCHMARK_TOKEN',
        // Added by macOS to every process.
        '__CF_USER_TEXT_ENCODING',
      ]);
      expect(Object.keys(env).filter((key) => !allowed.has(key))).toEqual([]);
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.SPAINBENCH_SITES).toBe('seg-social-es');
      expect(env.SPAINBENCH_DATE).toBe('2026-10-16');
      expect(env.BENCHMARK_TOKEN).not.toBe('harness-benchmark-token');
      expect(env.SPAINBENCH_PORT).not.toBe('3010');
      expect(env.SPAINBENCH_STRICT_WORLDS).toBe('1');
      expect(JSON.stringify(env)).not.toMatch(/do-not-pass|sk-nope|proxy\.invalid|harness-token/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('writes the server output to an owner-only log file in a folder it creates', async () => {
    const dir = fakeDir();
    const logFile = join(dir, 'a', 'b', 'bench.log');
    await start('ok', { dir, logFile });
    await until(
      () => readFileSync(logFile, 'utf8').includes('SpainBench (fake)'),
      2_000,
      'the log line',
    );
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('tightens a log file that was there and appends to it', async () => {
    const dir = fakeDir();
    const logFile = join(dir, 'bench.log');
    mkdirSync(dir, { recursive: true });
    writeFileSync(logFile, 'earlier run\n', { mode: 0o644 });
    await start('ok', { dir, logFile });
    await until(
      () => readFileSync(logFile, 'utf8').includes('SpainBench (fake)'),
      2_000,
      'the log line',
    );
    expect(readFileSync(logFile, 'utf8').startsWith('earlier run\n')).toBe(true);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('starts again right after a stop, on ports that are free again', async () => {
    const dir = fakeDir();
    const first = await start('ok', { dir });
    const publicPort = Number(new URL(first.api.publicOrigin).port);
    await first.stop();
    expect(await listening(publicPort)).toBe(false);
    const second = await start('ok', { dir });
    expect(second.pid).not.toBe(first.pid);
    expect(second.version.scoringApi).toBe(1);
    expect(await second.api.hosts()).toEqual([]);
  });

  it('runs two at once, each with a token that opens only its own server', async () => {
    const dirA = fakeDir();
    const dirB = fakeDir();
    const [a, b] = await Promise.all([start('ok', { dir: dirA }), start('ok', { dir: dirB })]);
    expect(a.api.scoringOrigin).not.toBe(b.api.scoringOrigin);
    expect(await a.api.hosts()).toEqual([]);
    expect(await b.api.hosts()).toEqual([]);
    const crossed = createBenchApi({
      publicOrigin: b.api.publicOrigin,
      scoringOrigin: b.api.scoringOrigin,
      token: seen(dirA).env.BENCHMARK_TOKEN as string,
    });
    await expect(crossed.hosts()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses the settings the launcher owns', async () => {
    const dir = fakeDir();
    for (const name of [
      'SPAINBENCH_PORT',
      'SPAINBENCH_SCORING_PORT',
      'SPAINBENCH_BIND',
      'SPAINBENCH_SCORING_BIND',
      'SPAINBENCH_STRICT_WORLDS',
      'BENCHMARK_TOKEN',
    ]) {
      await expect(
        startBench({ dir, logFile: join(dir, 'x.log'), env: { [name]: 'x' } }),
      ).rejects.toThrow(new RegExp(name));
    }
    expect(existsSync(join(dir, 'seen.json'))).toBe(false);
  });

  it('refuses a folder that is not a SpainBench checkout', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'not-spainbench-'));
    dirs.push(empty);
    const error = await startBench({ dir: empty, logFile: join(empty, 'x.log') }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchLaunchError);
    expect(error.message).toContain(empty);
    expect(error.message).toContain('server/index.mjs');
    expect(existsSync(join(empty, 'x.log'))).toBe(false);
    await expect(
      startBench({ dir: join(empty, 'missing'), logFile: join(empty, 'x.log') }),
    ).rejects.toBeInstanceOf(BenchLaunchError);
  });
});

describe('stop', () => {
  it('ends the server, leaves no process or listener, and is idempotent', async () => {
    const bench = await start('ok');
    const port = Number(new URL(bench.api.scoringOrigin).port);
    expect(await listening(port)).toBe(true);
    const first = bench.stop();
    const second = bench.stop();
    await Promise.all([first, second]);
    await bench.stop();
    expect(alive(bench.pid)).toBe(false);
    expect(await listening(port)).toBe(false);
    const exit = await bench.exited;
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
    expect(baseline()).toEqual(before);
  });

  it('kills a server that ignores SIGTERM once the grace period is over', async () => {
    const bench = await start('ignore-term', { stopGraceMs: 250 });
    const began = Date.now();
    await bench.stop();
    expect(Date.now() - began).toBeGreaterThanOrEqual(240);
    expect(Date.now() - began).toBeLessThan(4_000);
    expect(alive(bench.pid)).toBe(false);
    expect((await bench.exited).signal).toBe('SIGKILL');
    expect(baseline()).toEqual(before);
  });

  it('does not wait out the grace period for a server that stops by itself', async () => {
    const bench = await start('ok', { stopGraceMs: 30_000 });
    const began = Date.now();
    await bench.stop();
    expect(Date.now() - began).toBeLessThan(3_000);
  });

  it('resolves for a server that died on its own, and says it did', async () => {
    const bench = await start('ok');
    process.kill(bench.pid, 'SIGKILL');
    expect((await bench.exited).signal).toBe('SIGKILL');
    await bench.stop();
    expect(baseline()).toEqual(before);
  });

  it('keeps the hooks installed while any server is running', async () => {
    const a = await start('ok');
    const b = await start('ok');
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    await a.stop();
    expect(process.listenerCount('exit')).toBe(before.exit + 1);
    await b.stop();
    expect(baseline()).toEqual(before);
  });
});

describe('a server that does not start', () => {
  it('fails fast with the line the server printed, and the log', async () => {
    const began = Date.now();
    const error = await start('cannot-start', { readyTimeoutMs: 20_000 }).catch((e) => e);
    expect(Date.now() - began).toBeLessThan(8_000);
    expect(error).toBeInstanceOf(BenchLaunchError);
    expect(error.message).toContain(
      'SpainBench cannot start: SPAINBENCH_DATE must be a date like 2026-10-16',
    );
    expect(error.message).toContain('--- last log lines ---');
    expect(error.logTail).toContain('cannot start');
    expect(error.portConflict).toBe(false);
    expect(baseline()).toEqual(before);
  });

  it('fails fast when the process exits without a word, naming the exit code', async () => {
    const error = await start('silent-exit', { readyTimeoutMs: 20_000 }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchLaunchError);
    expect(error.message).toMatch(/exited with code 3 before it was ready/);
    expect(baseline()).toEqual(before);
  });

  it('gives up when the server never answers, and leaves no process behind', async () => {
    const dir = fakeDir();
    const error = await start('never-ready', { dir, readyTimeoutMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchLaunchError);
    expect(error.message).toMatch(/did not answer http:\/\/127\.0\.0\.1:\d+\/health within 500 ms/);
    const { pid } = seen(dir);
    await until(() => !alive(pid), 3_000, 'the server to be gone');
    expect(baseline()).toEqual(before);
  });

  it.each([
    ['old-api', 'server', /server is older than the harness/],
    ['new-api', 'harness', /harness is older than the server/],
  ] as const)(
    'refuses a server of another scoring API (%s) and stops it',
    async (mode, older, message) => {
      const dir = fakeDir();
      const error = await start(mode, { dir }).catch((e) => e);
      expect(error).toBeInstanceOf(BenchVersionError);
      expect(error.older).toBe(older);
      expect(error.message).toMatch(message);
      await until(() => !alive(seen(dir).pid), 3_000, 'the server to be gone');
      expect(baseline()).toEqual(before);
    },
  );

  it('chooses new ports when one it chose was taken in the meantime', async () => {
    const dir = fakeDir();
    const logFile = join(dir, 'bench.log');
    const bench = await start('port-conflict-once', { dir, logFile });
    expect(existsSync(join(dir, 'attempted'))).toBe(true);
    expect(await bench.api.hosts()).toEqual([]);
    const log = readFileSync(logFile, 'utf8');
    expect(log).toContain('Cannot listen on');
    expect(log).toContain('SpainBench (fake)');
  });

  it('does not take the line of an earlier attempt for this one', async () => {
    const dir = fakeDir();
    const logFile = join(dir, 'bench.log');
    await expect(start('cannot-start', { dir, logFile })).rejects.toBeInstanceOf(BenchLaunchError);
    // The log still holds the earlier failure; a healthy start must not read it as its own.
    const bench = await start('ok', { dir, logFile });
    expect(await bench.api.hosts()).toEqual([]);
  });
});

describe('never an orphan', () => {
  const script = resolve(import.meta.dirname, 'harness-child.ts');

  /**
   * Runs the stand-in harness and resolves once it printed the pid of the server it started.
   * `ownGroup` makes it the leader of a process group, so a test can signal "the terminal's".
   */
  async function harness(mode: string, options: { ownGroup?: boolean } = {}) {
    const dir = fakeDir();
    // Node itself with the tsx loader (not the `tsx` command, which is a process in between).
    const child = spawn(process.execPath, ['--import', 'tsx', script, dir, mode], {
      cwd: resolve(import.meta.dirname, '../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      detached: options.ownGroup ?? false,
    });
    children.push(child);
    let output = '';
    let errors = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal })),
    );
    await until(
      () => /READY \d+/.test(output) || /Error/.test(errors),
      20_000,
      'the harness to be ready',
    );
    const pid = Number(/READY (\d+)/.exec(output)?.[1]);
    if (!pid) throw new Error(`The stand-in harness failed: ${errors}`);
    strays.push(pid);
    return { child, pid, exited, output: () => output };
  }

  it('kills the server when the harness exits without stopping it', async () => {
    const run = await harness('exit');
    expect((await run.exited).code).toBe(0);
    await until(() => !alive(run.pid), 5_000, 'the server to be gone');
  }, 30_000);

  it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)(
    'kills the server when the harness gets %s, and the harness still dies of it',
    async (signal) => {
      const run = await harness('wait');
      expect(alive(run.pid)).toBe(true);
      run.child.kill(signal);
      expect((await run.exited).signal).toBe(signal);
      await until(() => !alive(run.pid), 5_000, 'the server to be gone');
    },
    30_000,
  );

  it('kills the server and leaves the decision to a handler of the harness', async () => {
    const run = await harness('graceful');
    run.child.kill('SIGTERM');
    const exit = await run.exited;
    expect(run.output()).toContain('GRACEFUL');
    expect(exit).toEqual({ code: 0, signal: null });
    await until(() => !alive(run.pid), 5_000, 'the server to be gone');
  }, 30_000);

  describe("keepOnSignal: a harness that handles the signal itself (the CLI's Ctrl-C)", () => {
    it('leaves the server alone until the harness stops it', async () => {
      const run = await harness('keep');
      run.child.kill('SIGINT');
      const exit = await run.exited;
      expect(run.output()).toContain('SERVER_ALIVE yes');
      expect(exit).toEqual({ code: 0, signal: null });
      await until(() => !alive(run.pid), 5_000, 'the server to be gone');
    }, 30_000);

    it('does not let a Ctrl-C of the terminal (the whole process group) reach the server', async () => {
      const run = await harness('keep', { ownGroup: true });
      // What a terminal does: SIGINT to every process of the foreground group.
      process.kill(-(run.child.pid as number), 'SIGINT');
      const exit = await run.exited;
      expect(run.output()).toContain('SERVER_ALIVE yes');
      expect(exit).toEqual({ code: 0, signal: null });
      await until(() => !alive(run.pid), 5_000, 'the server to be gone');
    }, 30_000);

    it('still kills the server, and the harness still dies, when the harness has no handler', async () => {
      const run = await harness('keep-bare');
      run.child.kill('SIGINT');
      expect((await run.exited).signal).toBe('SIGINT');
      await until(() => !alive(run.pid), 5_000, 'the server to be gone');
    }, 30_000);
  });
});

describe('benchEnvironment', () => {
  it('passes four variables of the parent and the launcher settings, nothing else', () => {
    expect(
      benchEnvironment({
        publicPort: 4001,
        scoringPort: 4002,
        token: 'tok',
        extra: { SPAINBENCH_SITES: 'seg-social-es', DROPPED: undefined },
        parent: {
          PATH: '/bin',
          HOME: '/home/u',
          TMPDIR: '/tmp',
          LANG: 'es_ES.UTF-8',
          HTTP_PROXY: 'x',
          AWS_SECRET_ACCESS_KEY: 'y',
          SPAINBENCH_PORT: '1',
        },
      }),
    ).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      TMPDIR: '/tmp',
      LANG: 'es_ES.UTF-8',
      SPAINBENCH_SITES: 'seg-social-es',
      SPAINBENCH_PORT: '4001',
      SPAINBENCH_BIND: '127.0.0.1',
      SPAINBENCH_SCORING_PORT: '4002',
      SPAINBENCH_SCORING_BIND: '127.0.0.1',
      // A request for a world nobody made is a 404, not a new world.
      SPAINBENCH_STRICT_WORLDS: '1',
      BENCHMARK_TOKEN: 'tok',
    });
  });

  it('leaves out a parent variable that is not set', () => {
    const env = benchEnvironment({
      publicPort: 1,
      scoringPort: 2,
      token: 't',
      parent: { PATH: '/bin' },
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        'BENCHMARK_TOKEN',
        'PATH',
        'SPAINBENCH_BIND',
        'SPAINBENCH_PORT',
        'SPAINBENCH_SCORING_BIND',
        'SPAINBENCH_SCORING_PORT',
        'SPAINBENCH_STRICT_WORLDS',
      ].sort(),
    );
  });
});

describe('connectBench', () => {
  let fake: FakeBench;

  beforeEach(async () => {
    fake = await FakeBench.start();
  });

  afterEach(async () => {
    await fake.close();
  });

  it('connects, checks the version and the token, and has nothing to stop', async () => {
    const connected = await connectBench({
      publicUrl: fake.publicOrigin,
      scoringUrl: fake.scoringOrigin,
      token: TOKEN,
    });
    expect(connected.mode).toBe('connect');
    expect(connected.version.name).toBe('spainbench');
    expect(connected.api.publicOrigin).toBe(fake.publicOrigin);
    expect(await connected.api.hosts()).toHaveLength(3);
    await connected.stop();
    await connected.stop();
    expect((await connected.api.version()).scoringApi).toBe(1);
    expect(fake.publicHits).toEqual([]);
  });

  it('refuses a token the server does not accept', async () => {
    const error = await connectBench({
      publicUrl: fake.publicOrigin,
      scoringUrl: fake.scoringOrigin,
      token: 'wrong-token',
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchError);
    expect(error.code).toBe('unauthorized');
    expect(error.message).not.toContain('wrong-token');
  });

  it('refuses a server of another scoring API', async () => {
    fake.version = { ...fake.version, scoringApi: 2 };
    await expect(
      connectBench({ publicUrl: fake.publicOrigin, scoringUrl: fake.scoringOrigin, token: TOKEN }),
    ).rejects.toBeInstanceOf(BenchVersionError);
  });

  it('says so when nothing answers', async () => {
    const { publicOrigin, scoringOrigin } = fake;
    await fake.close();
    const error = await connectBench({
      publicUrl: publicOrigin,
      scoringUrl: scoringOrigin,
      token: TOKEN,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchError);
    expect(error.code).toBe('unreachable');
    fake = await FakeBench.start();
  });

  it('refuses a server that is not on this machine before it connects', async () => {
    const error = await connectBench({
      publicUrl: 'http://bench.example.org:3010',
      scoringUrl: 'http://bench.example.org:3020',
      token: TOKEN,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchTargetError);
    expect(error.message).toContain('not on this machine');
    expect(error.message).not.toContain(TOKEN);
  });

  it('needs the scoring URL unless the public one is on port 3010', async () => {
    await expect(
      connectBench({ publicUrl: fake.publicOrigin, token: TOKEN }),
    ).rejects.toBeInstanceOf(BenchTargetError);
  });
});

describe('openBench', () => {
  it('explains what to set when nothing is configured', async () => {
    const error = await openBench(resolveBenchTarget({}), {
      logFile: join(tmpdir(), 'unused.log'),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(BenchTargetError);
    expect(error.message).toContain('SPAINBENCH_DIR');
    expect(error.message).toContain('SPAINBENCH_URL');
  });

  it('launches for SPAINBENCH_DIR and connects for SPAINBENCH_URL', async () => {
    const dir = fakeDir();
    const launched = await openBench(resolveBenchTarget({ SPAINBENCH_DIR: dir }), {
      logFile: join(dir, 'bench.log'),
      env: { FAKE_BENCH: 'ok' },
    });
    expect(launched.mode).toBe('launch');
    try {
      const fake = await FakeBench.start();
      try {
        const connected = await openBench(
          {
            mode: 'connect',
            publicUrl: fake.publicOrigin,
            scoringUrl: fake.scoringOrigin,
            token: TOKEN,
          },
          { logFile: join(dir, 'unused.log') },
        );
        expect(connected.mode).toBe('connect');
      } finally {
        await fake.close();
      }
    } finally {
      await launched.stop();
    }
  });
});
