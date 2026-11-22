/**
 * Opens SpainAssist traces in the browser:
 *
 *   corepack pnpm traces [<path>] [--port <n>]
 *   corepack pnpm traces --demo      a demo: a real capture of the mock sede, and its agents
 *
 * <path>: a userData folder (default: SA_USER_DATA_DIR, else the app's own), an extracted or
 * zipped transcripts export (Ajustes → Exportar historial), a browser capture run, a Playwright
 * trace.zip or a session.jsonl. Files can also be dropped on the page.
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { makeDemo } from './demo';

function defaultUserData(): string {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'SpainAssistant');
  if (process.platform === 'win32')
    return path.join(
      process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'),
      'SpainAssistant',
    );
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'SpainAssistant');
}

const args = process.argv.slice(2);
const portFlag = args.indexOf('--port');
const port = portFlag >= 0 ? Number(args.splice(portFlag, 2)[1]) : undefined;
/** pnpm runs scripts in the package folder: paths given by the user are relative to theirs. */
const cwd = process.env.INIT_CWD ?? process.cwd();
const given = args.find((a) => !a.startsWith('--'));
let input = given ? path.resolve(cwd, given) : (process.env.SA_USER_DATA_DIR ?? defaultUserData());
if (args.includes('--demo')) {
  console.log('Recording the demo: the mock sede in Chromium…');
  input = await makeDemo(path.join(os.tmpdir(), 'sa-traces-demo'));
}

if (!existsSync(input)) {
  if (given) {
    console.error(`${input} does not exist.`);
    process.exit(1);
  }
  console.log(`No profile at ${input}: drop a file on the page instead.`);
} else process.env.SA_TRACES_INPUT = input;

const server = await createServer({
  configFile: path.join(import.meta.dirname, '..', 'vite.config.ts'),
  ...(port ? { server: { port, strictPort: true } } : {}),
});
await server.listen();
const url = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5190/';
if (process.env.SA_TRACES_INPUT) console.log(`Traces of ${input}`);
console.log(`Open ${url}  (Ctrl+C to stop)`);
