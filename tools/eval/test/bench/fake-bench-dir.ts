/**
 * A folder that looks like the SpainBench repo to the launcher: `server/index.mjs`, a plain Node
 * script with the parts of the server the launcher touches (the environment it reads, the two
 * listeners, `/health`, `/version`, the token, SIGTERM, and the line it prints when it cannot
 * start). `FAKE_BENCH` (an `env` extra of `startBench`) picks a behaviour:
 *
 * - `ok` (default): starts and serves
 * - `ignore-term`: as `ok`, but SIGTERM does nothing (only SIGKILL stops it)
 * - `cannot-start`: prints `SpainBench cannot start: ...` and exits 1
 * - `silent-exit`: exits 3 without a word
 * - `never-ready`: listens on the public port only, never on the scoring one
 * - `port-conflict-once`: the first start fails like a port that was taken, later ones work
 * - `old-api` / `new-api`: reports another scoring API
 *
 * It records what it saw in `seen.json` (environment, pid) in the folder it runs from.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchVersion } from './fake-server';

const SCRIPT = `
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';

const mode = process.env.FAKE_BENCH || 'ok';
const env = process.env;
const seen = { pid: process.pid, cwd: process.cwd(), env, mode };
writeFileSync('seen.json', JSON.stringify(seen));

if (mode === 'cannot-start') {
  console.error('SpainBench cannot start: SPAINBENCH_DATE must be a date like 2026-10-16, got "soon"');
  process.exit(1);
}
if (mode === 'silent-exit') process.exit(3);
if (mode === 'port-conflict-once' && !existsSync('attempted')) {
  writeFileSync('attempted', String(Date.now()));
  console.error('SpainBench cannot start: Cannot listen on 127.0.0.1:' + env.SPAINBENCH_PORT + ': listen EADDRINUSE: address already in use');
  process.exit(1);
}

const version = ${JSON.stringify(benchVersion())};
if (mode === 'old-api') version.scoringApi = 0;
if (mode === 'new-api') version.scoringApi = 2;

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const scoring = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') return json(res, 200, { status: 'ok' });
  if (url.pathname === '/version') return json(res, 200, version);
  if (req.headers['x-benchmark-token'] !== env.BENCHMARK_TOKEN) return json(res, 403, { error: 'Forbidden' });
  if (url.pathname === '/meta/hosts') return json(res, 200, { aliasSuffix: '.sb.localhost', hosts: [] });
  return json(res, 404, { error: 'Not found' });
});
const pub = http.createServer((req, res) => json(res, 404, { error: 'Not found' }));

const listening = (server, port, bind) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(Number(port), bind, resolve);
});

await listening(pub, env.SPAINBENCH_PORT, env.SPAINBENCH_BIND);
if (mode === 'never-ready') {
  setInterval(() => {}, 1000);
} else {
  await listening(scoring, env.SPAINBENCH_SCORING_PORT, env.SPAINBENCH_SCORING_BIND);
}
console.log('SpainBench (fake): public port ' + env.SPAINBENCH_PORT + '; scoring port ' + env.SPAINBENCH_SCORING_PORT);

if (mode !== 'ignore-term') {
  process.once('SIGTERM', () => {
    pub.closeAllConnections();
    scoring.closeAllConnections();
    process.exit(0);
  });
} else {
  process.on('SIGTERM', () => {});
}
`;

/** Makes the folder (in the OS temp dir) and returns its path. The caller removes it. */
export function createFakeBenchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-spainbench-'));
  mkdirSync(join(dir, 'server'));
  writeFileSync(join(dir, 'server', 'index.mjs'), SCRIPT);
  return dir;
}

export interface Seen {
  pid: number;
  cwd: string;
  env: Record<string, string>;
  mode: string;
}

/** Whether a process with this pid exists. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
