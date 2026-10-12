#!/usr/bin/env node
// Starts the local backend services for development with prefixed, colored logs.
//
//   corepack pnpm services                 # key-server, feedback-server, relay-server (+
//                                           # maps-server when MAPBOX_TOKEN and LITELLM_URL are set)
//   corepack pnpm services -- --mocks      # + mock LLM (demo scenario) and mock sede
//   corepack pnpm services -- --only key-server,mock-sede
//
// Ctrl+C stops everything. Data lives in each service's .data/ directory (gitignored).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const withMocks = args.includes('--mocks');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? '').split(',').filter(Boolean)) : null;

const services = [
  { name: 'key-server', pkg: '@sa/key-server', color: 33, env: { DEV_SEED: '1', PORT: '8787' } },
  {
    name: 'feedback-server',
    pkg: '@sa/feedback-server',
    color: 36,
    env: { DEV_SEED: '1', PORT: '8788' },
  },
  {
    name: 'maps-server',
    pkg: '@sa/maps-server',
    color: 34,
    env: { PORT: '8793' },
    // A Mapbox token and a LiteLLM to check gateway keys against: never committed defaults.
    needs: ['MAPBOX_TOKEN', 'LITELLM_URL'],
  },
  {
    name: 'relay-server',
    pkg: '@sa/relay-server',
    color: 31,
    // On every interface, so a phone on the same Wi-Fi can reach it (DNIe signing).
    env: { PORT: '8794', HOST: '0.0.0.0' },
  },
  { name: 'mock-llm', pkg: '@sa/mock-llm', color: 35, mock: true, args: ['--', '--port', '8789'] },
  { name: 'mock-sede', pkg: '@sa/mock-sede', color: 32, mock: true },
]
  .filter((s) => (only ? only.has(s.name) : withMocks || !s.mock))
  .filter((s) => {
    const missing = (s.needs ?? []).filter((name) => !process.env[name]);
    if (missing.length) process.stdout.write(`${s.name}: skipped (set ${missing.join(', ')})\n`);
    return missing.length === 0;
  });

const children = [];
for (const s of services) {
  const child = spawn('corepack', ['pnpm', '--filter', s.pkg, 'start', ...(s.args ?? [])], {
    cwd: root,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', FORCE_COLOR: '1', ...s.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `\x1b[${s.color}m${s.name.padEnd(16)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        out.write(`${prefix}${buf.slice(0, i)}\n`);
        buf = buf.slice(i + 1);
        i = buf.indexOf('\n');
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited with code ${code}\n`));
  children.push(child);
}

const stop = () => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
