// `corepack pnpm e2e` opens Playwright's UI mode for local, interactive runs. CI, non-interactive
// shells (agents, pipes) and `--no-ui` run the suite headlessly as plain `playwright test`.
import { execFileSync, spawn } from 'node:child_process';

execFileSync('corepack', ['pnpm', '--filter', '@sa/sidecar', 'build'], { stdio: 'inherit' });

const args = process.argv.slice(2);
const noUi = args.includes('--no-ui');
const passthrough = args.filter((arg) => arg !== '--no-ui');
const conflicting = ['--ui', '--debug', '--list', '--help', '-h'];
const ui =
  !noUi &&
  !process.env.CI &&
  process.stdout.isTTY === true &&
  !passthrough.some((arg) => conflicting.includes(arg) || arg.startsWith('--ui-'));

const child = spawn('playwright', ['test', ...(ui ? ['--ui'] : []), ...passthrough], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
