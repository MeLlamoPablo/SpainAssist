import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserService } from '@sa/browser';
import { buildSidecar } from '@sa/sidecar/build';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
