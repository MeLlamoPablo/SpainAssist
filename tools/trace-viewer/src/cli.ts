/**
 * Opens SpainAssist traces in the browser:
 *
 *   corepack pnpm traces [<path>] [--port <n>]
 *   corepack pnpm traces --demo      a demo: a real capture of the mock sede, and its agents
 *
 * <path>: a userData folder (default: SA_USER_DATA_DIR, else the app's own), an extracted or
 * zipped transcripts export (Ajustes → Exportar historial), a browser capture run, a Playwright
 * trace.zip or a session.jsonl, or an eval run's folder or id (`<runs root>/<runId>`, see
 * `tools/eval`). Files can also be dropped on the page.
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

/** The eval's runs root (`defaultRunsRoot` in `tools/eval/src/run/results.ts`). */
function evalRunsRoot(): string {
  const override = process.env.SPAINBENCH_DATA_DIR?.trim();
  if (override) return path.join(path.resolve(override), 'runs');
  const home = os.homedir();
  const absolute = (value: string | undefined) =>
    value && path.isAbsolute(value) ? value : undefined;
  const data =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (absolute(process.env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local'))
        : (absolute(process.env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share'));
  return path.join(data, 'spainbench', 'runs');
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

// A bare eval run id.
if (given && !existsSync(input) && /^[\w.-]+$/.test(given)) {
  const run = path.join(evalRunsRoot(), given);
  if (existsSync(run)) input = run;
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
