/**
 * `eval doctor`: one line per thing a run depends on. A `fail` is something a mock run needs and
 * lacks (exit code 1); a `warn` is something only real-model runs need, or that the next run fixes
 * by itself. No secret is ever printed: only whether a credential exists and until when it is valid.
 */
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBenchTarget } from '../../bench';
import { runnable } from '../../bench/check';
import { NO_CHROMIUM_MESSAGE } from '../../chromium';
import { type BenchVersion, SUPPORTED_SCORING_API } from '../../contracts';
import { INYECCION_ID, listFixtures } from '../../fixtures';
import { codexStatus } from '../../llm/codex-auth';
import { evalHome, homePaths } from '../../llm/home';
import { parseCommandArgs } from '../args';
import type { CliDeps } from '../deps';
import { EXIT_FAILED, EXIT_OK, messageOf } from '../exit';
import { isDirectory, resolveRunsRoot } from '../paths';
import { DOCTOR_SPEC } from '../specs';
import { describeVoucher, relativeTime } from './auth';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Check {
  status: CheckStatus;
  name: string;
  detail: string;
}

const LABEL: Record<CheckStatus, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip' };

export function renderChecks(checks: readonly Check[]): string {
  const lines = checks.map((check) => `${LABEL[check.status]}  ${check.name}: ${check.detail}`);
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  const summary = [`${count('ok')} ok`];
  if (count('warn')) summary.push(`${count('warn')} warning(s)`);
  if (count('fail')) summary.push(`${count('fail')} FAILED`);
  if (count('skip')) summary.push(`${count('skip')} skipped`);
  return `${[...lines, '', `doctor: ${summary.join(', ')}`].join('\n')}\n`;
}

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const fine = major > 22 || (major === 22 && minor >= 19);
  return fine
    ? { status: 'ok', name: 'Node', detail: process.version }
    : {
        status: 'fail',
        name: 'Node',
        detail: `${process.version}: the suite needs Node 22.19 or later (24 is the repo's)`,
      };
}

/** Whether `dir` can be written to now, or created because its closest existing folder can. */
function writableCheck(name: string, dir: string): Check {
  let existing = dir;
  while (!isDirectory(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  try {
    accessSync(existing, constants.W_OK);
  } catch {
    return { status: 'fail', name, detail: `${existing} is not writable (${dir})` };
  }
  return existing === dir
    ? { status: 'ok', name, detail: `${dir} is writable` }
    : {
        status: 'ok',
        name,
        detail: `${dir} does not exist yet; ${existing} is writable, so the first run creates it`,
      };
}

function homeCheck(home: string): Check {
  const name = 'Credentials home';
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(home);
  } catch {
    return {
      status: 'warn',
      name,
      detail: `${home} does not exist yet: the first run creates it (mode 700)`,
    };
  }
  if (!stats.isDirectory()) return { status: 'fail', name, detail: `${home} is not a folder` };
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    return {
      status: 'warn',
      name,
      detail: `${home} has mode ${(stats.mode & 0o777).toString(8)}: other users can read it (chmod 700 ${home})`,
    };
  }
  return { status: 'ok', name, detail: `${home} (mode ${(stats.mode & 0o777).toString(8)})` };
}

function voucherCheck(home: string, now: Date): Check {
  const voucher = describeVoucher(home, now);
  const detail = voucher.line;
  if (!voucher.present) {
    return {
      status: 'warn',
      name: 'Voucher key',
      detail: `${detail} (voucher runs are unavailable; mock runs need none)`,
    };
  }
  if (!voucher.ok || voucher.expired) {
    return {
      status: 'warn',
      name: 'Voucher key',
      detail: `${detail} (voucher runs are unavailable)`,
    };
  }
  return { status: 'ok', name: 'Voucher key', detail };
}

function codexCheck(home: string, now: Date): Check {
  const name = 'Codex login';
  try {
    const status = codexStatus({ home, now: () => now.getTime() });
    if (!status.loggedIn) {
      return {
        status: 'warn',
        name,
        detail: 'not logged in (development only: eval login codex --codex-consent)',
      };
    }
    const left = status.expiresInMs ?? 0;
    return {
      status: 'ok',
      name,
      detail:
        left > 0
          ? `logged in; access token valid ${relativeTime(now.getTime() + left, now.getTime())}`
          : 'logged in; the access token is expired and is refreshed when used',
    };
  } catch (error) {
    return { status: 'warn', name, detail: `unusable: ${messageOf(error)}` };
  }
}

/** The SpainBench checks: configured, reachable, scoring API, fixtures runnable, variants. */
async function benchChecks(deps: CliDeps): Promise<Check[]> {
  const skipped = (reason: string): Check[] =>
    [
      'SpainBench reachable',
      'SpainBench scoring API',
      'Fixtures runnable',
      'Injection variants',
    ].map((name) => ({ status: 'skip' as const, name, detail: reason }));

  let target: ReturnType<typeof resolveBenchTarget>;
  try {
    target = resolveBenchTarget(deps.env, { cwd: deps.cwd });
  } catch (error) {
    return [
      { status: 'fail', name: 'SpainBench configured', detail: messageOf(error) },
      ...skipped('SpainBench is not configured'),
    ];
  }
  if (target.mode === 'none') {
    return [
      {
        status: 'fail',
        name: 'SpainBench configured',
        detail: 'no: set SPAINBENCH_DIR (the private repo) or SPAINBENCH_URL (a running server)',
      },
      ...skipped('SpainBench is not configured'),
    ];
  }
  const checks: Check[] = [
    {
      status: 'ok',
      name: 'SpainBench configured',
      detail:
        target.mode === 'launch'
          ? `SPAINBENCH_DIR ${target.dir} (started on free ports for each command)`
          : `SPAINBENCH_URL ${target.publicUrl}, scoring ${target.scoringUrl} (a running server)`,
    },
  ];

  const logDir = mkdtempSync(join(tmpdir(), 'sa-eval-doctor-'));
  let version: BenchVersion;
  try {
    const server = await deps.openBench(target, { logFile: join(logDir, 'bench-server.log') });
    try {
      version = server.version;
      checks.push({
        status: 'ok',
        name: 'SpainBench reachable',
        detail: `${version.name} ${version.version} (${server.mode === 'launch' ? 'started here' : 'connected'})`,
      });
    } finally {
      await server.stop().catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'BenchVersionError') {
      return [
        ...checks,
        { status: 'ok', name: 'SpainBench reachable', detail: 'it answered' },
        { status: 'fail', name: 'SpainBench scoring API', detail: messageOf(error) },
        ...skipped('the scoring API is not supported').slice(2),
      ];
    }
    return [
      ...checks,
      { status: 'fail', name: 'SpainBench reachable', detail: messageOf(error) },
      ...skipped('SpainBench was not reachable').slice(1),
    ];
  } finally {
    rmSync(logDir, { recursive: true, force: true });
  }

  checks.push(
    version.scoringApi === SUPPORTED_SCORING_API
      ? {
          status: 'ok',
          name: 'SpainBench scoring API',
          detail: `v${version.scoringApi} (supported)`,
        }
      : {
          status: 'fail',
          name: 'SpainBench scoring API',
          detail: `v${version.scoringApi}, this harness supports v${SUPPORTED_SCORING_API}`,
        },
  );
  const fixtures = listFixtures();
  const problems = fixtures.flatMap((fixture) => {
    const verdict = runnable(fixture, version);
    return verdict.ok ? [] : [`${fixture.id}: ${verdict.reason}`];
  });
  checks.push(
    problems.length === 0
      ? {
          status: 'ok',
          name: 'Fixtures runnable',
          detail: `${fixtures.length} of ${fixtures.length} (${fixtures.map((f) => f.id).join(', ')})`,
        }
      : {
          status: 'fail',
          name: 'Fixtures runnable',
          detail: `${fixtures.length - problems.length} of ${fixtures.length}; ${problems.join('; ')}`,
        },
  );
  const variants = version.injections.map((variant) => variant.id);
  checks.push(
    variants.length > 0
      ? {
          status: 'ok',
          name: 'Injection variants',
          detail: `${variants.length} listed (${variants.join(', ')}) for ${INYECCION_ID}:<variant>`,
        }
      : {
          status: 'warn',
          name: 'Injection variants',
          detail: 'SpainBench lists none: the injection fixture cannot run',
        },
  );
  return checks;
}

export async function doctorCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  parseCommandArgs(DOCTOR_SPEC, args, { min: 0, max: 0, names: '' });
  const home = evalHome(deps.env);
  const paths = homePaths(home);
  const now = deps.now();
  const checks: Check[] = [nodeCheck(), ...(await benchChecks(deps))];

  const bundle = await deps.hostBundleState();
  checks.push(
    bundle === 'fresh'
      ? {
          status: 'ok',
          name: 'Eval host bundle',
          detail: 'dist/eval-host.js is built and up to date',
        }
      : {
          status: 'warn',
          name: 'Eval host bundle',
          detail: `${bundle === 'missing' ? 'not built yet' : 'older than its sources'}: the next run builds it (or now: corepack pnpm --filter @sa/eval build:host)`,
        },
  );
  const chromium = deps.chromiumPath();
  checks.push(
    chromium
      ? { status: 'ok', name: 'Chromium', detail: `${chromium} (in Playwright's cache)` }
      : {
          status: 'fail',
          name: 'Chromium',
          detail: NO_CHROMIUM_MESSAGE,
        },
  );
  checks.push(
    homeCheck(home),
    voucherCheck(home, now),
    codexCheck(home, now),
    writableCheck('Ledger folder', paths.ledgerDir),
    writableCheck('Cache folder', paths.cacheDir),
    writableCheck('Runs folder', resolveRunsRoot(undefined, deps.cwd, deps.env)),
  );

  deps.stdout(renderChecks(checks));
  return checks.some((check) => check.status === 'fail') ? EXIT_FAILED : EXIT_OK;
}
