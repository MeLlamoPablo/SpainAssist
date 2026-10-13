// Runs electron-builder (arguments passed through) with `pnpm` on PATH resolving to the repo's
// pnpm through Corepack. electron-builder collects the production node_modules with `pnpm list`;
// a global pnpm of another major (this machine has v7) fails there, and electron-builder then
// falls back to walking node_modules. Called by the `package*` scripts after the app is built.
// First it writes THIRD_PARTY_NOTICES.txt (scripts/notices.ts, after the build so sa-sidecar's Go
// licence is in it) and checks that the build carries no Exa API key (scripts/secrets.ts, D23).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const shell = process.platform === 'win32';

// Fails on a licence that isn't permissive (DECISIONS D16).
const noticesScript = fileURLToPath(new URL('notices.ts', import.meta.url));
const notices = spawnSync(process.execPath, [noticesScript], { stdio: 'inherit' });
if (notices.status !== 0) process.exit(notices.status ?? 1);

// Users bring their own Exa key: refuses to package one (DECISIONS D23).
const secretsScript = fileURLToPath(new URL('secrets.ts', import.meta.url));
const secrets = spawnSync(process.execPath, [secretsScript], { stdio: 'inherit' });
if (secrets.status !== 0) process.exit(secrets.status ?? 1);

const shims = mkdtempSync(join(tmpdir(), 'sa-pnpm-'));
try {
  const corepack = spawnSync('corepack', ['enable', 'pnpm', '--install-directory', shims], {
    stdio: 'inherit',
    shell,
  });
  if (corepack.status !== 0) throw new Error('corepack enable failed');
  const builder = spawnSync('electron-builder', process.argv.slice(2), {
    stdio: 'inherit',
    shell,
    env: { ...process.env, PATH: `${shims}${delimiter}${process.env.PATH}` },
  });
  process.exitCode = builder.status ?? 1;
} finally {
  rmSync(shims, { recursive: true, force: true });
}
