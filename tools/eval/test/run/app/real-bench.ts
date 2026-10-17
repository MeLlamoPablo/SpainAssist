/**
 * The real SpainBench server (a private repo, `SPAINBENCH_DIR`) started for one test on free
 * loopback ports, and stopped after it. Only what the test needs of its API: the host table and
 * worlds. (The run loop's own launcher, `src/bench`, is another part's.)
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { BenchHost, BenchWorldSpec } from '../../../src/contracts';

const TOKEN = 'eval-app-test-token';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface RealBench {
  publicOrigin: string;
  scoringOrigin: string;
  hosts: BenchHost[];
  createWorld(spec: BenchWorldSpec): Promise<void>;
  state(
    worldId: string,
  ): Promise<{ wrongTurns: { count: number }; counters: { requests: number } }>;
  stop(): Promise<void>;
}

async function scoring(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: { 'X-Benchmark-Token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });
}

export async function startRealBench(repoDir: string, sites = 'seg-social-es'): Promise<RealBench> {
  const publicPort = await freePort();
  const scoringPort = await freePort();
  const publicOrigin = `http://127.0.0.1:${publicPort}`;
  const scoringOrigin = `http://127.0.0.1:${scoringPort}`;
  const child: ChildProcess = spawn(process.execPath, ['index.mjs'], {
    cwd: join(repoDir, 'server'),
    env: {
      PATH: process.env.PATH ?? '',
      SPAINBENCH_SITES: sites,
      SPAINBENCH_PORT: String(publicPort),
      SPAINBENCH_BIND: '127.0.0.1',
      SPAINBENCH_SCORING_PORT: String(scoringPort),
      SPAINBENCH_SCORING_BIND: '127.0.0.1',
      BENCHMARK_TOKEN: TOKEN,
    },
    stdio: 'ignore',
  });
  const exited = new Promise<never>((_, reject) =>
    child.once('exit', (code) => reject(new Error(`SpainBench exited early (code ${code})`))),
  );
  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      child.kill();
    });
  try {
    const ready = (async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          if ((await fetch(`${scoringOrigin}/health`)).ok) return;
        } catch {
          // not listening yet
        }
        if (Date.now() > deadline) throw new Error('SpainBench never answered /health');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    await Promise.race([ready, exited]);
    const hostsResponse = await scoring(scoringOrigin, '/meta/hosts');
    const { hosts } = (await hostsResponse.json()) as { hosts: BenchHost[] };
    return {
      publicOrigin,
      scoringOrigin,
      hosts,
      async createWorld(spec) {
        const response = await scoring(scoringOrigin, '/worlds', {
          method: 'POST',
          body: JSON.stringify(spec),
        });
        if (response.status !== 201)
          throw new Error(`POST /worlds: ${response.status} ${await response.text()}`);
      },
      async state(worldId) {
        const response = await scoring(scoringOrigin, `/worlds/${worldId}/state`);
        return (await response.json()) as never;
      },
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
