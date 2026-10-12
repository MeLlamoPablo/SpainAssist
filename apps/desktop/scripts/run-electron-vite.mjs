import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { devElectronBinary } from './dev-electron-bundle.mjs';

const require = createRequire(import.meta.url);
const env = { ...process.env };
if (process.platform === 'darwin' && env.SA_E2E !== '1') {
  // Launch Services gives Electron its own TCC identity instead of the terminal's.
  env.SA_DEV_ELECTRON_BINARY = devElectronBinary(require('electron'));
  env.ELECTRON_EXEC_PATH = fileURLToPath(new URL('./launch-electron-mac.mjs', import.meta.url));
}
const child = spawn(
  process.execPath,
  [
    join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js'),
    ...process.argv.slice(2),
  ],
  {
    stdio: 'inherit',
    env,
    detached: process.platform !== 'win32',
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch {
      /* Already stopped. */
    }
  });
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
