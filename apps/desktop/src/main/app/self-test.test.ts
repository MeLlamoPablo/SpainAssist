import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import type { BrowserObservation } from '@sa/shared';
import { buildSidecar } from '@sa/sidecar/build';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { BrowserFactory } from '../ports';
import { runSelfTest } from './self-test';

/**
 * The app runs it headed; here it is headed only where a display can show what it's for: Windows,
 * and Linux with one (CI runs the unit tests under xvfb-run). On macOS SA_TEST_HEADED=1 runs it
 * headed too. The packaged app's run is in release.yml, the development build's in e2e.
 */
const headed =
  (process.platform === 'win32' ||
    (process.platform === 'linux' && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) ||
    process.env.SA_TEST_HEADED === '1') &&
  process.env.SA_TEST_HEADED !== '0';

let dir: string;
let sidecarBinary: string;

/**
 * The real browser service, except that the first `blank` observations of `session` show no
 * title: a page that is slow to show (or, with Infinity, never does). It logs a debug line too.
 */
function slowPage(session: string, blank: number): BrowserFactory {
  return (options) => {
    const service = createBrowserService(options);
    options.logger?.debug('a debug line of the browser');
    let left = blank;
    const seen = (id: string, obs: BrowserObservation) =>
      id === session && left-- > 0 ? { ...obs, title: '' } : obs;
    return new Proxy(service, {
      get(target, prop): unknown {
        if (prop === 'open')
          return async (...args: Parameters<BrowserService['open']>) =>
            seen(args[0], await target.open(...args));
        if (prop === 'snapshot') return async (id: string) => seen(id, await target.snapshot(id));
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-self-test-'));
  sidecarBinary = await buildSidecar({ outDir: join(dir, 'bin') });
}, 120_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

it('passes with Playwright Chromium and a freshly built sidecar', {
  timeout: 120_000,
}, async () => {
  const report = await runSelfTest({
    dir: join(dir, 'run'),
    sidecarBinary,
    browserFactory: createBrowserService,
    headless: !headed,
  });
  expect(
    report.checks.filter((c) => !c.ok),
    report.log.join('\n'),
  ).toEqual([]);
  expect(report.checks.map((c) => c.name)).toEqual([
    'browser-executable',
    'crlset',
    'sidecar',
    'browser-launch',
    'browser-survives-without-windows',
    'browser-second-session',
  ]);
  expect(report.ok).toBe(true);
});

it('waits for a first page that is slow to show', { timeout: 120_000 }, async () => {
  const report = await runSelfTest({
    dir: join(dir, 'slow'),
    sidecarBinary,
    browserFactory: slowPage('self-test-1', 2),
    headless: !headed,
  });
  expect(
    report.checks.filter((c) => !c.ok),
    report.log.join('\n'),
  ).toEqual([]);
  expect(report.checks.find((c) => c.name === 'browser-launch')?.detail).toMatch(
    /showing its first page in \d+ ms$/,
  );
});

it('reports what the browser showed when a page does not show, and its debug lines', {
  timeout: 120_000,
}, async () => {
  const report = await runSelfTest({
    dir: join(dir, 'blank'),
    sidecarBinary,
    browserFactory: slowPage('self-test-1', Number.POSITIVE_INFINITY),
    headless: !headed,
    pageMs: 1_500,
  });
  expect(report.ok).toBe(false);
  const failed = report.checks.at(-1);
  expect(failed).toMatchObject({
    name: 'browser-launch',
    ok: false,
    error: expect.stringMatching(/^the page's title is "", not "Uno", after \d+ ms$/),
    page: {
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/one$/),
      title: '',
      notes: [],
      tabs: [expect.stringMatching(/\/one$/)],
    },
  });
  expect(failed?.page?.ms).toBeGreaterThanOrEqual(1_500);
  expect(report.log).toContainEqual(
    expect.stringMatching(/ DEBUG \[browser\] a debug line of the browser$/),
  );
});

it('fails without the bundled browser it was told to use', async () => {
  const report = await runSelfTest({
    dir: join(dir, 'missing'),
    chromium: { reason: 'chromium.json is missing' },
    sidecarBinary,
    browserFactory: createBrowserService,
  });
  expect(report.ok).toBe(false);
  expect(report.checks).toEqual([
    expect.objectContaining({
      name: 'browser-executable',
      ok: false,
      error: expect.stringContaining('chromium.json'),
    }),
  ]);
});
