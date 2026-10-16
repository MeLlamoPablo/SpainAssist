/**
 * Lists a profile's browser captures (development capture mode, SA_BROWSER_CAPTURE=1) and copies
 * one out, e.g. to build a SpainBench mock site from it.
 *
 *   corepack pnpm --filter @sa/desktop captures [list] [--user-data <dir>]
 *   corepack pnpm --filter @sa/desktop captures export <procedureId>/<run> [<out dir>] [--user-data <dir>]
 *
 * The profile is --user-data, else SA_USER_DATA_DIR, else the app's default userData folder.
 * Captures hold personal data (only typed secrets are scrubbed): take them only from synthetic
 * or throwaway accounts, and never commit or share one that isn't.
 */
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

/** pnpm runs scripts in the package folder: paths given by the user are relative to theirs. */
const cwd = process.env.INIT_CWD ?? process.cwd();
const args = process.argv.slice(2);
const flag = args.indexOf('--user-data');
const userData = path.resolve(
  cwd,
  flag >= 0 ? (args.splice(flag, 2)[1] ?? '') : (process.env.SA_USER_DATA_DIR ?? defaultUserData()),
);
const proceduresDir = path.join(userData, 'procedures');
const [command = 'list', target, out] = args;

function dirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function size(dir: string): number {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .reduce((total, e) => total + statSync(path.join(e.parentPath, e.name)).size, 0);
}

function title(procedureId: string): string {
  try {
    const raw = JSON.parse(
      readFileSync(path.join(proceduresDir, procedureId, 'procedure.json'), 'utf8'),
    );
    return typeof raw.title === 'string' ? raw.title : '';
  } catch {
    return '';
  }
}

if (command === 'list') {
  console.log(`Captures in ${proceduresDir}`);
  let count = 0;
  for (const id of dirs(proceduresDir)) {
    const runs = dirs(path.join(proceduresDir, id, 'capture'));
    if (!runs.length) continue;
    console.log(`\n${id}  ${title(id)}`);
    for (const run of runs) {
      const dir = path.join(proceduresDir, id, 'capture', run);
      const info = path.join(dir, 'capture.json');
      const steps = existsSync(info)
        ? `${JSON.parse(readFileSync(info, 'utf8')).steps} steps`
        : 'incomplete';
      console.log(`  ${id}/${run}  ${steps}, ${(size(dir) / 1e6).toFixed(1)} MB`);
      count++;
    }
  }
  if (!count) console.log('None. Run the app with SA_BROWSER_CAPTURE=1 (development builds only).');
} else if (command === 'export' && target) {
  const [id, run] = target.split('/');
  const source = id && run ? path.join(proceduresDir, id, 'capture', run) : '';
  if (!source || !existsSync(path.join(source, 'capture.json'))) {
    console.error(`No complete capture ${target} (see "captures list").`);
    process.exit(1);
  }
  const dest = path.resolve(cwd, out ?? `capture-${id}-${run}`);
  if (existsSync(dest)) {
    console.error(`${dest} already exists.`);
    process.exit(1);
  }
  cpSync(source, dest, { recursive: true });
  console.log(`Copied to ${dest}`);
  console.log('It holds personal data (only typed secrets are scrubbed): handle it accordingly.');
} else {
  console.error(
    'Usage: captures [list] | captures export <procedureId>/<run> [<out dir>] [--user-data <dir>]',
  );
  process.exit(1);
}
