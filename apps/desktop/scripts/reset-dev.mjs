// Builds a dev reset entry (default: src/main/dev/reset.ts) into a temporary Electron main
// process; no credentials leave the encrypted vault.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('electron-vite/package.json'))('esbuild');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] ?? 'src/main/dev/reset.ts';
const temporary = await mkdtemp(join(tmpdir(), 'sa-reset-dev-'));
try {
  const entry = join(temporary, 'reset.cjs');
  await build({
    absWorkingDir: root,
    entryPoints: [source],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent',
  });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [entry], { env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
