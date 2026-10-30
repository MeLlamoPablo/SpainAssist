import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PROFILE_PREFIX } from '../src/service';
import type { BrowserServiceOptions, CrlSetComponent } from '../src/types';
import { createTestService, page, startServer, type TestServer } from './helpers';

/**
 * `crlSet` seeds each launch's temporary profile with the app's CRLSet (README.md, "Revoked
 * certificates"). A local server can't show Chromium enforcing it (an untrusted test certificate
 * fails first), so these check the launch around it; the desktop app's live test checks a real
 * revoked site.
 */

const VERSION = '7777';
let server: TestServer;
let componentDir: string;

/** A CRLSet blocking nothing: a JSON header and no parents. */
function writeComponent(dir: string): void {
  const header = Buffer.from(
    JSON.stringify({
      Version: 0,
      ContentType: 'CRLSet',
      Sequence: Number(VERSION),
      DeltaFrom: 0,
      NumParents: 0,
      BlockedSPKIs: [],
    }),
  );
  const length = Buffer.alloc(2);
  length.writeUInt16LE(header.length);
  fs.writeFileSync(path.join(dir, 'crl-set'), Buffer.concat([length, header]));
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ manifest_version: 2, name: 'crl-set-test.data', version: VERSION }),
  );
}

/**
 * Headed Chromium started persistently quits when its last window closes on Windows and Linux,
 * but not on macOS, nor headless: only a headed run off macOS shows whether the browser survives.
 * Linux needs a display (CI runs the unit tests under xvfb-run); SA_TEST_BROWSER_WINDOWS=1 runs it
 * on macOS too (windows on the desktop, minimized).
 */
const headed =
  (process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) &&
  (process.platform !== 'darwin' || process.env.SA_TEST_BROWSER_WINDOWS === '1');

async function windowState(page: Page): Promise<string | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    return (await cdp.send('Browser.getWindowForTarget')).bounds.windowState;
  } finally {
    await cdp.detach();
  }
}

/**
 * The launch's blank window outlives every session window, and no session sees it: v0.3.2 closed
 * it after the settle, so on Windows the browser quit right away and every call relaunched it.
 */
async function keepsItsWindow(overrides: Partial<BrowserServiceOptions>): Promise<void> {
  const launched: BrowserContext[] = [];
  const launch = chromium.launchPersistentContext.bind(chromium);
  const spy = vi
    .spyOn(chromium, 'launchPersistentContext')
    .mockImplementation(async (dir, options) => {
      const context = await launch(dir, options);
      launched.push(context);
      return context;
    });
  const component: CrlSetComponent = { version: VERSION, dir: componentDir };
  const t = createTestService({ crlSet: async () => component, ...overrides });
  try {
    const obs = await t.service.open('window', `${server.origin}/`);
    expect(obs.title).toBe('Inicio');
    const own = launched[0] as BrowserContext;
    const browser = own.browser();
    expect(own.pages().map((p) => p.url())).toEqual(['about:blank']);
    if (overrides.startHidden && process.platform !== 'linux') {
      // Minimized (on Linux that is up to the window manager, which xvfb-run has none of).
      expect(await windowState(own.pages()[0] as Page)).toBe('minimized');
    }
    expect(obs.tabs).toEqual([expect.objectContaining({ url: `${server.origin}/`, active: true })]);
    expect(await t.service.tabs('window', 'list')).toHaveLength(1);

    // The session's only window closes: the browser keeps running on its own.
    await t.service.close('window');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(browser?.isConnected()).toBe(true);
    expect(own.pages()).toHaveLength(1);

    const again = await t.service.open('window-2', `${server.origin}/`);
    expect(again.title).toBe('Inicio');
    expect(again.tabs).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    spy.mockRestore();
    await t.cleanup();
  }
}

function profiles(): Set<string> {
  return new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(PROFILE_PREFIX)));
}

beforeAll(async () => {
  server = await startServer({ '/': page('<p>hola</p>', 'Inicio') });
  componentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-crlset-test-'));
  writeComponent(componentDir);
});

afterAll(async () => {
  await server?.close();
  fs.rmSync(componentDir, { recursive: true, force: true });
});

describe('crlSet', () => {
  it('seeds a temporary profile, browses as usual and deletes the profile on close', async () => {
    const before = profiles();
    const component: CrlSetComponent = { version: VERSION, dir: componentDir };
    const t = createTestService({ crlSet: async () => component });
    try {
      const obs = await t.service.open('crl', `${server.origin}/`);
      expect(obs.title).toBe('Inicio');
      // A second session gets its own context of the same browser.
      const other = await t.service.open('crl-2', `${server.origin}/`);
      expect(other.title).toBe('Inicio');
      const created = [...profiles()].filter((name) => !before.has(name));
      expect(created).toHaveLength(1);
      const seeded = path.join(os.tmpdir(), created[0] as string, 'CertificateRevocation', VERSION);
      expect(fs.readdirSync(seeded).sort()).toEqual(['crl-set', 'manifest.json']);
    } finally {
      await t.cleanup();
    }
    // Deleted when the browser goes away (asynchronously, after `disconnected`).
    await expect.poll(() => [...profiles()].filter((name) => !before.has(name))).toEqual([]);
  });

  it('keeps the blank window of the launch, which no session sees', () => keepsItsWindow({}));

  it.skipIf(!headed)('keeps a headed browser running when no session has a window', () =>
    keepsItsWindow({ headless: false, startHidden: true }),
  );

  it('launches without a CRLSet when the app has none', async () => {
    const before = profiles();
    const t = createTestService({
      crlSet: async () => {
        throw new Error('offline');
      },
    });
    try {
      const obs = await t.service.open('no-crl', `${server.origin}/`);
      expect(obs.title).toBe('Inicio');
      expect([...profiles()].filter((name) => !before.has(name))).toEqual([]);
    } finally {
      await t.cleanup();
    }
  });
});
