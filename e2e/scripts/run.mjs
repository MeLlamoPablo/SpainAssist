// `corepack pnpm e2e` opens Playwright's UI mode for local, interactive runs. CI, non-interactive
// shells (agents, pipes) and `--no-ui` run the suite headlessly as plain `playwright test`.
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// On Windows `corepack` is a .cmd shim, which only a shell runs.
execFileSync('corepack', ['pnpm', '--filter', '@sa/sidecar', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const args = process.argv.slice(2);
const noUi = args.includes('--no-ui');
const passthrough = args.filter((arg) => arg !== '--no-ui');
const conflicting = ['--ui', '--debug', '--list', '--help', '-h'];
const ui =
  !noUi &&
  !process.env.CI &&
  process.stdout.isTTY === true &&
  !passthrough.some((arg) => conflicting.includes(arg) || arg.startsWith('--ui-'));

// Playwright's CLI script itself, not the .bin shim (a .cmd on Windows).
const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const child = spawn(process.execPath, [cli, 'test', ...(ui ? ['--ui'] : []), ...passthrough], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
