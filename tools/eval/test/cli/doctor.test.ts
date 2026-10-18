import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BenchError, type BenchServer, BenchVersionError } from '../../src/bench';
import { cachedChromium } from '../../src/chromium';
import { type Check, renderChecks } from '../../src/cli/commands/doctor';
import { writeCodexFile } from '../../src/llm/home';
import { benchVersion } from '../bench/fake-server';
import { TEST_VOUCHER_KEY, writeLitellmFile } from '../llm/helpers/tmp-home';
import { type Cli, makeCli } from './support';

let cli: Cli;
afterEach(() => cli?.cleanup());

const ALL_VARIANTS = ['assistant-notice', 'fake-verification', 'page-title', 'hidden-text'].map(
  (id) => ({ id, summary: 'a variant' }),
);

/** The fake's sites plus the Cita Previa DNI mock: every fixture's site. */
const ALL_SITES = {
  ...benchVersion().sites,
  'citapreviadni-es': { version: '1', contentHash: 'd'.repeat(64) },
};

function server(version = benchVersion({ sites: ALL_SITES, injections: ALL_VARIANTS })) {
  const state = { stopped: 0 };
  const openBench = async (_target: unknown, options: { logFile: string }) =>
    ({
      mode: 'launch',
      version,
      api: {},
      pid: 1,
      logFile: options.logFile,
      exited: new Promise(() => {}),
      stop: async () => {
        state.stopped++;
      },
    }) as unknown as BenchServer;
  return { state, openBench };
}

const SPAINBENCH = { SPAINBENCH_DIR: '/somewhere/SpainBench' };

/** The doctor line of a check: `status name: detail`. */
function line(out: string, name: string): string {
  const found = out.split('\n').find((candidate) => candidate.slice(6).startsWith(`${name}:`));
  if (!found) throw new Error(`no line for ${name} in\n${out}`);
  return found;
}

describe('eval doctor', () => {
  it('passes on a machine that has what a mock run needs, with warnings for the rest', async () => {
    const bench = server();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    expect(await cli.run('doctor')).toBe(0);
    const out = cli.out();
    expect(line(out, 'SpainBench configured')).toMatch(
      /^ok {2}\s*SpainBench configured: SPAINBENCH_DIR \/somewhere\/SpainBench/,
    );
    expect(line(out, 'SpainBench reachable')).toMatch(/^ok .*spainbench 0\.3\.0 \(started here\)/);
    expect(line(out, 'SpainBench scoring API')).toMatch(/^ok .*v1 \(supported\)/);
    expect(line(out, 'Fixtures runnable')).toMatch(
      /^ok .*9 of 9 \(vida-laboral-sin-datos, vida-laboral-con-datos, vida-laboral-inyeccion:assistant-notice, vida-laboral-inyeccion:fake-verification, vida-laboral-inyeccion:page-title, vida-laboral-inyeccion:hidden-text, dni-renovacion-sin-datos, dni-renovacion-caduca-pronto, dni-renovacion-no-elegible\)/,
    );
    expect(line(out, 'Injection variants')).toMatch(
      /^ok .*4 listed \(assistant-notice, fake-verification, page-title, hidden-text\)/,
    );
    expect(line(out, 'Eval host bundle')).toMatch(/^ok .*built and up to date/);
    expect(line(out, 'Chromium')).toMatch(/^ok .*\/fake\/chromium/);
    expect(line(out, 'Credentials home')).toMatch(
      new RegExp(`^ok .*${cli.home.replace(/[/.]/g, '\\$&')} \\(mode 700\\)`),
    );
    expect(line(out, 'Voucher key')).toMatch(
      /^warn .*none.*voucher runs are unavailable; mock runs need none/,
    );
    expect(line(out, 'Codex login')).toMatch(/^warn .*not logged in/);
    expect(line(out, 'Ledger folder')).toMatch(
      /^ok .*does not exist yet.*the first run creates it/,
    );
    expect(line(out, 'Cache folder')).toMatch(/^ok /);
    expect(line(out, 'Runs folder')).toMatch(/^ok /);
    expect(out).toMatch(/\ndoctor: \d+ ok, 2 warning\(s\)\n$/);
    expect(bench.state.stopped).toBe(1);
    expect(cli.err()).toBe('');
  });

  it('fails when SpainBench is not configured, and skips what depends on it', async () => {
    cli = makeCli();
    expect(await cli.run('doctor')).toBe(1);
    const out = cli.out();
    expect(line(out, 'SpainBench configured')).toMatch(/^FAIL .*no: set SPAINBENCH_DIR/);
    for (const name of [
      'SpainBench reachable',
      'SpainBench scoring API',
      'Fixtures runnable',
      'Injection variants',
    ]) {
      expect(line(out, name)).toMatch(/^skip .*SpainBench is not configured/);
    }
    expect(out).toMatch(/\ndoctor: \d+ ok, 2 warning\(s\), 1 FAILED, 4 skipped\n$/);
  });

  it('fails on SPAINBENCH_* settings that cannot be used, with the reason', async () => {
    cli = makeCli({ env: { SPAINBENCH_URL: 'http://10.0.0.5:3010' } });
    expect(await cli.run('doctor')).toBe(1);
    expect(line(cli.out(), 'SpainBench configured')).toMatch(/^FAIL .*is not on this machine/);
  });

  it('fails when SpainBench cannot be reached or started', async () => {
    cli = makeCli({
      env: SPAINBENCH,
      deps: {
        openBench: async () => {
          throw new BenchError('unreachable', 'GET /version', 'cannot reach http://127.0.0.1:3020');
        },
      },
    });
    expect(await cli.run('doctor')).toBe(1);
    const out = cli.out();
    expect(line(out, 'SpainBench configured')).toMatch(/^ok /);
    expect(line(out, 'SpainBench reachable')).toMatch(
      /^FAIL .*cannot reach http:\/\/127\.0\.0\.1:3020/,
    );
    expect(line(out, 'SpainBench scoring API')).toMatch(/^skip .*not reachable/);
    expect(line(out, 'Fixtures runnable')).toMatch(/^skip /);
  });

  it('fails on a server of another scoring API, which did answer', async () => {
    cli = makeCli({
      env: SPAINBENCH,
      deps: {
        openBench: async () => {
          throw new BenchVersionError({
            serverApi: 0,
            supportedApi: 1,
            message:
              'SpainBench speaks scoring API v0 but this harness needs v1: the server is older than the harness.',
          });
        },
      },
    });
    expect(await cli.run('doctor')).toBe(1);
    const out = cli.out();
    expect(line(out, 'SpainBench reachable')).toMatch(/^ok .*it answered/);
    expect(line(out, 'SpainBench scoring API')).toMatch(
      /^FAIL .*the server is older than the harness/,
    );
    expect(line(out, 'Fixtures runnable')).toMatch(/^skip /);
  });

  it('fails when a fixture cannot run on this SpainBench, naming the fixture and the reason', async () => {
    // The default fake lists page-title and hidden-text only: the other two variants cannot run.
    const bench = server(benchVersion({ sites: ALL_SITES }));
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    expect(await cli.run('doctor')).toBe(1);
    expect(line(cli.out(), 'Fixtures runnable')).toMatch(
      /^FAIL .*7 of 9; vida-laboral-inyeccion:assistant-notice: the server does not list injection variant "assistant-notice"/,
    );
  });

  it('fails when SpainBench does not serve the Cita Previa DNI site, naming the DNI fixtures', async () => {
    // The default fake serves the Seguridad Social and FNMT sites only.
    const bench = server(benchVersion({ injections: ALL_VARIANTS }));
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    expect(await cli.run('doctor')).toBe(1);
    const runnable = line(cli.out(), 'Fixtures runnable');
    expect(runnable).toMatch(
      /^FAIL .*6 of 9; dni-renovacion-sin-datos: the server has no site "citapreviadni-es"/,
    );
    expect(runnable).toContain('dni-renovacion-caduca-pronto: the server has no site');
    expect(runnable).toContain('dni-renovacion-no-elegible: the server has no site');
    expect(runnable).not.toContain('vida-laboral');
  });

  it('warns when SpainBench lists no injection variant', async () => {
    const bench = server(benchVersion({ injections: [] }));
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    await cli.run('doctor');
    expect(line(cli.out(), 'Injection variants')).toMatch(/^warn .*lists none/);
  });

  it('fails when the Chromium is not in the Playwright cache, and says nothing is downloaded', async () => {
    const bench = server();
    cli = makeCli({
      env: SPAINBENCH,
      deps: { openBench: bench.openBench, chromiumPath: () => undefined },
    });
    expect(await cli.run('doctor')).toBe(1);
    expect(line(cli.out(), 'Chromium')).toMatch(
      /^FAIL .*never downloads one: corepack pnpm --filter @sa\/eval exec playwright-core install chromium/,
    );
  });

  it('warns, without failing, about a host bundle that is missing or stale', async () => {
    const bench = server();
    cli = makeCli({
      env: SPAINBENCH,
      deps: { openBench: bench.openBench, hostBundleState: () => 'missing' },
    });
    expect(await cli.run('doctor')).toBe(0);
    expect(line(cli.out(), 'Eval host bundle')).toMatch(
      /^warn .*not built yet: the next run builds it/,
    );
    cli.cleanup();
    cli = makeCli({
      env: SPAINBENCH,
      deps: { openBench: bench.openBench, hostBundleState: async () => 'stale' as const },
    });
    expect(await cli.run('doctor')).toBe(0);
    expect(line(cli.out(), 'Eval host bundle')).toMatch(/^warn .*older than its sources/);
  });

  it('shows the voucher key and the Codex login without a single secret', async () => {
    const bench = server();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    writeLitellmFile(cli.home, { expiresAt: '2027-01-01T00:00:00.000Z' });
    writeCodexFile(
      {
        v: 1,
        provider: 'openai-codex',
        loginAt: cli.clock.now.toISOString(),
        updatedAt: cli.clock.now.toISOString(),
        credential: {
          type: 'oauth',
          access: 'ACCESS-SECRET',
          refresh: 'REFRESH-SECRET',
          expires: cli.clock.now.getTime() + 2 * 3_600_000,
          accountId: 'acct-1',
        },
      },
      cli.home,
    );
    expect(await cli.run('doctor')).toBe(0);
    const out = cli.out();
    expect(line(out, 'Voucher key')).toMatch(/^ok .*valid until 2027-01-01T00:00:00\.000Z/);
    expect(line(out, 'Codex login')).toMatch(/^ok .*logged in; access token valid in 2 hour\(s\)/);
    for (const secret of [TEST_VOUCHER_KEY, 'ACCESS-SECRET', 'REFRESH-SECRET', 'acct-1']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toMatch(/doctor: \d+ ok\n$/);
  });

  it('warns about an expired voucher key, and about one that other users can read', async () => {
    const bench = server();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    writeLitellmFile(cli.home, { expiresAt: '2026-10-01T00:00:00.000Z' });
    expect(await cli.run('doctor')).toBe(0);
    expect(line(cli.out(), 'Voucher key')).toMatch(
      /^warn .*EXPIRED 2026-10-01.*voucher runs are unavailable/,
    );
    cli.cleanup();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    writeLitellmFile(cli.home, {}, 0o644);
    expect(await cli.run('doctor')).toBe(0);
    expect(line(cli.out(), 'Voucher key')).toMatch(/^warn .*unusable: .*readable by other users/);
    expect(cli.out()).not.toContain(TEST_VOUCHER_KEY);
  });

  it('warns when the credentials home does not exist yet, or others can read it', async () => {
    const bench = server();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    rmSync(cli.home, { recursive: true });
    expect(await cli.run('doctor')).toBe(0);
    expect(line(cli.out(), 'Credentials home')).toMatch(
      /^warn .*does not exist yet: the first run creates it/,
    );
    mkdirSync(cli.home, { recursive: true });
    chmodSync(cli.home, 0o755);
    expect(await cli.run('doctor')).toBe(0);
    expect(
      line(cli.out().slice(cli.out().lastIndexOf('SpainBench configured')), 'Credentials home'),
    ).toMatch(/^warn .*mode 755: other users can read it \(chmod 700/);
  });

  it('fails when the credentials home is a file', async () => {
    const bench = server();
    cli = makeCli({ env: SPAINBENCH, deps: { openBench: bench.openBench } });
    rmSync(cli.home, { recursive: true });
    writeFileSync(cli.home, 'x');
    expect(await cli.run('doctor')).toBe(1);
    expect(line(cli.out(), 'Credentials home')).toMatch(/^FAIL .*is not a folder/);
  });

  it('takes no arguments', async () => {
    cli = makeCli();
    expect(await cli.run('doctor', 'x')).toBe(2);
  });
});

describe('renderChecks', () => {
  it('counts what it saw', () => {
    const checks: Check[] = [
      { status: 'ok', name: 'a', detail: 'fine' },
      { status: 'warn', name: 'b', detail: 'hm' },
      { status: 'fail', name: 'c', detail: 'bad' },
      { status: 'skip', name: 'd', detail: 'n/a' },
    ];
    expect(renderChecks(checks)).toBe(
      'ok    a: fine\nwarn  b: hm\nFAIL  c: bad\nskip  d: n/a\n\ndoctor: 1 ok, 1 warning(s), 1 FAILED, 1 skipped\n',
    );
  });
});

describe('cachedChromium', () => {
  it('answers with a path that exists or undefined, and never installs anything', () => {
    const path = cachedChromium();
    expect(path === undefined || typeof path === 'string').toBe(true);
    if (path) expect(path).toMatch(/chrom/i);
  });
});
