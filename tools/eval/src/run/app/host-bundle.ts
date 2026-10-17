/**
 * The eval host bundle (`tools/eval/dist/eval-host.js`, built by `corepack pnpm --filter @sa/eval
 * build:host`) is gitignored, so a run makes sure it exists and is newer than its sources before
 * the first agent starts, building it when it is not. It fails with a clear message when it
 * cannot: an agent host that is silently the wrong one would invalidate the run.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { evalHostPath } from '../../host';

const execFileAsync = promisify(execFile);

/** `tools/eval`. */
const packageRoot = join(import.meta.dirname, '..', '..', '..');
const repoRoot = join(packageRoot, '..', '..');

export interface HostBundleOptions {
  /** The bundle. Default: `evalHostPath()`. */
  bundle?: string;
  /** Files and folders the bundle is built from: it is rebuilt when any of them is newer. */
  sources?: readonly string[];
  /** Default: `scripts/build-eval-host.mjs` of this package (what `build:host` runs). */
  buildScript?: string;
  /** Runs the build (tests replace it). Default: `node <buildScript>`. */
  build?(script: string): Promise<void>;
}

/** What the bundle contains: the eval host, the network layer, the product host and the contracts. */
function defaultSources(): string[] {
  return [
    join(packageRoot, 'src', 'host'),
    join(packageRoot, 'src', 'net'),
    join(packageRoot, 'src', 'contracts.ts'),
    join(packageRoot, 'scripts', 'build-eval-host.mjs'),
    join(repoRoot, 'packages', 'agent', 'src'),
    join(repoRoot, 'packages', 'shared', 'src'),
  ];
}

function newestMtime(path: string): number {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name)));
  }
  return newest;
}

type BundleState = 'fresh' | 'missing' | 'stale';

export function hostBundleState(options: HostBundleOptions = {}): BundleState {
  const bundle = options.bundle ?? evalHostPath();
  let built: number;
  try {
    built = statSync(bundle).mtimeMs;
  } catch {
    return 'missing';
  }
  const newest = Math.max(0, ...(options.sources ?? defaultSources()).map(newestMtime));
  return newest > built ? 'stale' : 'fresh';
}

async function runBuild(script: string): Promise<void> {
  await execFileAsync(process.execPath, [script], { cwd: packageRoot, maxBuffer: 8 * 1024 * 1024 });
}

/** Builds are serialized across the processes of this machine (several test workers may start). */
async function withBuildLock<T>(bundle: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${bundle}.build.lock`;
  const deadline = Date.now() + 120_000;
  mkdirSync(dirname(bundle), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock older than a build can take is a dead owner's.
      if (Date.now() - statSync(lock).mtimeMs > 120_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the build lock ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const done = new Map<string, Promise<string>>();

/**
 * Resolves with the path of an up-to-date eval host bundle, building it first when it is missing
 * or older than its sources. Once per process and bundle: later calls share the first answer
 * (a failure is not remembered, so the next call tries again).
 */
export function ensureEvalHostBundle(options: HostBundleOptions = {}): Promise<string> {
  const bundle = options.bundle ?? evalHostPath();
  // A build the caller supplies (tests) is never shared.
  const key = options.build ? undefined : `${bundle}\0${options.buildScript ?? ''}`;
  const known = key ? done.get(key) : undefined;
  if (known) return known;
  const attempt = (async () => {
    if (hostBundleState(options) === 'fresh') return bundle;
    const script = options.buildScript ?? join(packageRoot, 'scripts', 'build-eval-host.mjs');
    const build = options.build ?? runBuild;
    await withBuildLock(bundle, async () => {
      // Another process may have built it while this one waited for the lock.
      if (hostBundleState(options) === 'fresh') return;
      try {
        await build(script);
      } catch (error) {
        const detail =
          error instanceof Error
            ? [(error as { stderr?: string }).stderr, error.message].filter(Boolean).join('\n')
            : String(error);
        throw new Error(
          `The eval agent host (${bundle}) is missing or out of date and could not be built.\n${detail.slice(-2000)}\nRun "corepack pnpm --filter @sa/eval build:host" and fix what it reports.`,
        );
      }
      if (hostBundleState(options) !== 'fresh') {
        throw new Error(
          `The eval agent host build finished but ${bundle} is still missing or out of date. Run "corepack pnpm --filter @sa/eval build:host".`,
        );
      }
    });
    return bundle;
  })();
  if (key) {
    done.set(key, attempt);
    attempt.catch(() => done.delete(key));
  }
  return attempt;
}
