/**
 * Getting a SpainBench to talk to: start the private repo's server as a child process of the
 * harness (`startBench`), or connect to one that already runs (`connectBench`). `openBench` picks
 * by `resolveBenchTarget(env)` (see `target.ts` for the variables).
 *
 * A launched server gets two free loopback ports and a random token, a minimal environment (no
 * inherited secrets or proxy settings), strict worlds (a request that names a world nobody created
 * is a 404, not a new world), and its output goes to a log file. It is stopped with
 * SIGTERM, then SIGKILL after a grace period, and never outlives the harness: a hook on the
 * process' exit (and on SIGINT, SIGTERM and SIGHUP, which skip it) kills it.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import type { BenchApi, BenchVersion } from '../contracts';
import { checkBenchVersion } from './check';
import { createBenchApi } from './client';
import { BenchLaunchError, BenchTargetError } from './errors';
import { type BenchEnv, type BenchTarget, resolveBenchEndpoints } from './target';

/** A launch is tried this many times when a port the launcher chose was taken in the meantime. */
const PORT_ATTEMPTS = 3;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_STOP_GRACE_MS = 5_000;
/** SIGKILL is not negotiable: this long after it, a process that is still there is an error. */
const KILL_WAIT_MS = 5_000;
const HEALTH_POLL_MS = 75;
const LOG_TAIL_LINES = 25;
const LOG_SCAN_BYTES = 64 * 1024;

/** The only variables of the harness' environment the server gets. */
const INHERITED_ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG'] as const;
/** What the launcher decides itself: a caller's `env` cannot set them. */
const OWNED_ENV = [
  'SPAINBENCH_PORT',
  'SPAINBENCH_BIND',
  'SPAINBENCH_SCORING_PORT',
  'SPAINBENCH_SCORING_BIND',
  'SPAINBENCH_STRICT_WORLDS',
  'BENCHMARK_TOKEN',
] as const;

export interface BenchExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface BenchServerBase {
  /** The scoring API client; `api.publicOrigin` is what `HostEvalConfig.mockOrigin` takes. */
  api: BenchApi;
  version: BenchVersion;
  /** Stops a server the harness started; does nothing for one it connected to. Idempotent. */
  stop(): Promise<void>;
}

export interface LaunchedBench extends BenchServerBase {
  mode: 'launch';
  pid: number;
  /** Stdout and stderr of the server (owner-only). */
  logFile: string;
  /** Resolves when the server process is gone, whatever the reason (never rejects). */
  exited: Promise<BenchExit>;
}

export interface ConnectedBench extends BenchServerBase {
  mode: 'connect';
}

export type BenchServer = LaunchedBench | ConnectedBench;

export interface StartBenchOptions {
  /** The SpainBench repo (the folder that holds `server/index.mjs`). */
  dir: string;
  /** Where the server's stdout and stderr go. Its folder is created. */
  logFile: string;
  /** More environment for the server: `SPAINBENCH_SITES`, `SPAINBENCH_DATE`... Not the ports or the token. */
  env?: BenchEnv;
  /** How long the server may take to answer `/health`. Default 30 s. */
  readyTimeoutMs?: number;
  /** How long `stop` waits after SIGTERM before SIGKILL. Default 5 s. */
  stopGraceMs?: number;
  /**
   * The harness handles SIGINT, SIGTERM and SIGHUP itself and stops the server when it is done
   * (the CLI's Ctrl-C ends the run, which still has to read the world and save it). Then the server
   * is started in its own process group, so a terminal's Ctrl-C does not reach it, and a signal
   * that reaches a harness that has a handler of its own does not kill it: the harness decides, and
   * the hook on `exit` still kills a server that outlives it. With no handler of the harness the
   * signal kills the server and ends the harness as usual. Default false: the signal kills the server.
   */
  keepOnSignal?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Never an orphan
// ---------------------------------------------------------------------------------------------

const live = new Set<ChildProcess>();
/** Servers that stay alive when the harness has a handler of its own for the signal. */
const keptOnSignal = new WeakSet<ChildProcess>();
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let installed = false;

function kill(child: ChildProcess): void {
  try {
    child.kill('SIGKILL');
  } catch {
    // Already gone.
  }
}

function killLive(): void {
  for (const child of live) kill(child);
}

function removeHooks(): void {
  if (!installed) return;
  installed = false;
  process.off('exit', killLive);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  signalHandlers.clear();
}

/**
 * A process that is killed by a signal does not run its 'exit' listeners, so the servers are
 * killed from the signal handlers too. The handler then gives the signal back: when nobody else
 * listens for it, it is re-raised with the default action, as if there had been no handler. When
 * the harness does listen, a server it asked to keep (`keepOnSignal`) is left alone: the harness
 * decides, and the hook on 'exit' still kills whatever outlives it.
 */
function track(child: ChildProcess, keepOnSignal: boolean): void {
  live.add(child);
  if (keepOnSignal) keptOnSignal.add(child);
  if (installed) return;
  installed = true;
  process.on('exit', killLive);
  for (const signal of SIGNALS) {
    const handler = () => {
      // Ours is one of the listeners: another one is the harness' own.
      const harnessDecides = process.listenerCount(signal) > 1;
      let kept = false;
      for (const child of live) {
        if (harnessDecides && keptOnSignal.has(child)) kept = true;
        else kill(child);
      }
      if (kept) return;
      removeHooks();
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
}

function untrack(child: ChildProcess): void {
  live.delete(child);
  if (live.size === 0) removeHooks();
}

// ---------------------------------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------------------------------

/** Two (or `count`) loopback ports that are free right now and different from each other. */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<net.Server>((resolveServer, reject) => {
          const server = net.createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => resolveServer(server));
        }),
    ),
  );
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
  return ports;
}

/**
 * The server's whole environment: `PATH`, `HOME`, `TMPDIR` and `LANG` of `parent`, the caller's
 * extras, and the launcher's own settings (ports, loopback binds, strict worlds, token). No proxy
 * variable, key or token of the harness' environment is ever passed on.
 */
export function benchEnvironment(input: {
  publicPort: number;
  scoringPort: number;
  token: string;
  extra?: BenchEnv;
  parent?: BenchEnv;
}): Record<string, string> {
  const parent = input.parent ?? process.env;
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = parent[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(input.extra ?? {})) {
    if (value !== undefined) env[name] = value;
  }
  return {
    ...env,
    SPAINBENCH_PORT: String(input.publicPort),
    SPAINBENCH_BIND: '127.0.0.1',
    SPAINBENCH_SCORING_PORT: String(input.scoringPort),
    SPAINBENCH_SCORING_BIND: '127.0.0.1',
    // The public port believes the world header of whoever sends it: with strict worlds a stray
    // client (or a request that lost its header) gets a 404 instead of a world of its own.
    SPAINBENCH_STRICT_WORLDS: '1',
    BENCHMARK_TOKEN: input.token,
  };
}

/** What the server printed since `offset`, at most its last 64 KB. */
function readLog(file: string, offset: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const from = Math.max(offset, size - LOG_SCAN_BYTES);
    if (size <= from) return '';
    const buffer = Buffer.alloc(size - from);
    readSync(fd, buffer, 0, buffer.length, from);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const lastLines = (text: string): string =>
  text.trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function healthy(scoringOrigin: string): Promise<boolean> {
  try {
    const response = await fetch(`${scoringOrigin}/health`, { signal: AbortSignal.timeout(1_000) });
    await response.arrayBuffer();
    return response.status === 200;
  } catch {
    return false;
  }
}

interface Attempt {
  dir: string;
  logFile: string;
  extra: BenchEnv | undefined;
  readyTimeoutMs: number;
  stopGraceMs: number;
  keepOnSignal: boolean;
}

async function launchOnce(attempt: Attempt): Promise<LaunchedBench> {
  const [publicPort, scoringPort] = (await freePorts(2)) as [number, number];
  const token = randomBytes(24).toString('hex');
  const publicOrigin = `http://127.0.0.1:${publicPort}`;
  const scoringOrigin = `http://127.0.0.1:${scoringPort}`;

  mkdirSync(dirname(attempt.logFile), { recursive: true, mode: 0o700 });
  const fd = openSync(attempt.logFile, 'a', 0o600);
  let child: ChildProcess;
  let logStart: number;
  try {
    fchmodSync(fd, 0o600);
    logStart = fstatSync(fd).size;
    child = spawn(process.execPath, ['server/index.mjs'], {
      cwd: attempt.dir,
      env: benchEnvironment({ publicPort, scoringPort, token, extra: attempt.extra }),
      stdio: ['ignore', fd, fd],
      // Its own process group: a terminal's Ctrl-C reaches the harness only.
      detached: attempt.keepOnSignal,
    });
  } finally {
    closeSync(fd);
  }

  let exit: BenchExit | undefined;
  let spawnError: Error | undefined;
  const exited = new Promise<BenchExit>((done) => {
    child.once('exit', (code, signal) => {
      exit = { code, signal };
      done(exit);
    });
    child.on('error', (error) => {
      // Spawning failed (no such interpreter): there is no process and there will be no 'exit'.
      // (Any other 'error', such as a kill that was refused, leaves the process as it was.)
      if (child.pid !== undefined) return;
      spawnError = error;
      exit ??= { code: null, signal: null };
      done(exit);
    });
  });
  track(child, attempt.keepOnSignal);

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      try {
        if (exit) return;
        child.kill('SIGTERM');
        const grace = withTimer(attempt.stopGraceMs);
        const gone = await Promise.race([exited.then(() => true), grace.timeout.then(() => false)]);
        grace.cancel();
        if (gone) return;
        child.kill('SIGKILL');
        const last = withTimer(KILL_WAIT_MS);
        const dead = await Promise.race([exited.then(() => true), last.timeout.then(() => false)]);
        last.cancel();
        if (!dead) {
          throw new Error(`The SpainBench server (pid ${child.pid}) did not die after SIGKILL`);
        }
      } finally {
        untrack(child);
      }
    })();
    return stopping;
  };

  const logSince = () => readLog(attempt.logFile, logStart);
  const failure = (): BenchLaunchError | undefined => {
    const text = logSince();
    const said = /SpainBench cannot start: (.+)/.exec(text)?.[1];
    const options = {
      logFile: attempt.logFile,
      logTail: lastLines(text),
      portConflict: /Cannot listen on/.test(text),
    };
    if (spawnError) {
      return new BenchLaunchError(`Cannot run ${process.execPath}: ${spawnError.message}`, {
        ...options,
        cause: spawnError,
      });
    }
    if (said) return new BenchLaunchError(`SpainBench cannot start: ${said}`, options);
    if (exit) {
      const how = exit.signal ? `was killed by ${exit.signal}` : `exited with code ${exit.code}`;
      return new BenchLaunchError(`The SpainBench server ${how} before it was ready`, options);
    }
    return undefined;
  };

  try {
    const deadline = Date.now() + attempt.readyTimeoutMs;
    for (;;) {
      const failed = failure();
      if (failed) throw failed;
      if (await healthy(scoringOrigin)) break;
      if (Date.now() >= deadline) {
        throw new BenchLaunchError(
          `The SpainBench server did not answer ${scoringOrigin}/health within ${attempt.readyTimeoutMs} ms`,
          { logFile: attempt.logFile, logTail: lastLines(logSince()) },
        );
      }
      await Promise.race([exited, sleep(HEALTH_POLL_MS)]);
    }
    const api = createBenchApi({ publicOrigin, scoringOrigin, token });
    const version = await api.version();
    checkBenchVersion(version);
    return {
      mode: 'launch',
      api,
      version,
      pid: child.pid as number,
      logFile: attempt.logFile,
      exited,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}

/** A timer that can be cancelled (so a finished stop does not keep the process alive). */
function withTimer(ms: number): { timeout: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
  });
  return { timeout, cancel: () => clearTimeout(timer) };
}

/**
 * Starts `node server/index.mjs` from the SpainBench repo `dir` and waits until its scoring
 * listener answers `/health`. Fails (and leaves no process behind) when the folder is not the repo,
 * the server prints `SpainBench cannot start: ...` or exits, it is not ready in `readyTimeoutMs`, or
 * it speaks another scoring API; the error carries the last lines of the log.
 */
export async function startBench(options: StartBenchOptions): Promise<LaunchedBench> {
  const dir = resolve(options.dir);
  if (!existsSync(join(dir, 'server', 'index.mjs')) || !statSync(dir).isDirectory()) {
    throw new BenchLaunchError(
      `${dir} is not a SpainBench checkout: server/index.mjs is missing (SPAINBENCH_DIR)`,
    );
  }
  for (const name of OWNED_ENV) {
    if (options.env && name in options.env) {
      throw new TypeError(
        `${name} is set by the launcher (free ports, a random token): do not pass it`,
      );
    }
  }
  const attempt: Attempt = {
    dir,
    logFile: resolve(options.logFile),
    extra: options.env,
    readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
    keepOnSignal: options.keepOnSignal ?? false,
  };
  for (let tries = 1; ; tries++) {
    try {
      return await launchOnce(attempt);
    } catch (error) {
      // Another process took one of the ports between choosing and binding it: choose again.
      if (error instanceof BenchLaunchError && error.portConflict && tries < PORT_ATTEMPTS)
        continue;
      throw error;
    }
  }
}

export interface ConnectBenchOptions {
  /** The public listener, `http://127.0.0.1:3010`. */
  publicUrl: string;
  /** The scoring listener. Optional when the public one is on port 3010 (then 3020 of the same host). */
  scoringUrl?: string;
  token: string;
  timeoutMs?: number;
  /** Tests: another `fetch`. */
  fetch?: typeof fetch;
}

/**
 * Connects to a SpainBench that is already running: checks that it speaks this scoring API and that
 * the token is accepted. Refuses a server that is not on this machine, and a scoring URL that is the
 * public listener under another name.
 */
export async function connectBench(options: ConnectBenchOptions): Promise<ConnectedBench> {
  const endpoints = resolveBenchEndpoints(options);
  const api = createBenchApi({
    publicOrigin: endpoints.publicUrl,
    scoringOrigin: endpoints.scoringUrl,
    token: options.token,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
  });
  const version = await api.version();
  checkBenchVersion(version);
  await api.hosts();
  return { mode: 'connect', api, version, stop: async () => undefined };
}

/** What `target` says: start the server, connect to it, or (`none`) explain what to set. */
export async function openBench(
  target: BenchTarget,
  options: Pick<
    StartBenchOptions,
    'logFile' | 'env' | 'readyTimeoutMs' | 'stopGraceMs' | 'keepOnSignal'
  >,
): Promise<BenchServer> {
  switch (target.mode) {
    case 'launch':
      return startBench({ ...options, dir: target.dir });
    case 'connect':
      return connectBench(target);
    case 'none':
      throw new BenchTargetError(
        'No SpainBench is configured: set SPAINBENCH_DIR (the private repo; the harness starts it) or SPAINBENCH_URL (a server that is running)',
      );
  }
}
