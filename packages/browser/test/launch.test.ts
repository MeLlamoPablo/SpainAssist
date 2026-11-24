import { type Browser, chromium, type LaunchOptions } from 'playwright-core';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestService, page, startServer, type TestServer } from './helpers';

let server: TestServer;

beforeAll(async () => {
  server = await startServer({ '/': page('<p>hola</p>', 'Inicio') });
});

afterAll(async () => {
  await server?.close();
});

/** The features a browser runs with turned off, as chrome://version reports them. */
async function disabledFeatures(browser: Browser): Promise<string[]> {
  const tab = await browser.newPage();
  try {
    await tab.goto('chrome://version/?show-variations-cmd');
    const text = (await tab.locator('body').textContent()) ?? '';
    return text.match(/--disable-features="([^"]*)"/)?.[1]?.split(',') ?? [];
  } finally {
    await tab.close();
  }
}

/** Opens a session and returns the options the service launched its browser with. */
async function launchOptionsOfService(): Promise<{
  options: LaunchOptions;
  disabled: string[];
}> {
  let launched: { options: LaunchOptions; browser: Browser } | undefined;
  const launch = chromium.launch.bind(chromium);
  const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (options = {}) => {
    const browser = await launch(options);
    launched = { options, browser };
    return browser;
  });
  const t = createTestService();
  try {
    expect((await t.service.open('launch', `${server.origin}/`)).title).toBe('Inicio');
    if (!launched) throw new Error('The service did not launch a browser');
    return { options: launched.options, disabled: await disabledFeatures(launched.browser) };
  } finally {
    spy.mockRestore();
    await t.cleanup();
  }
}

/** The features Playwright alone turns off, for a launch with the service's other options. */
async function disabledByPlaywright(options: LaunchOptions): Promise<string[]> {
  const args = (options.args ?? []).filter((arg) => !arg.startsWith('--disable-features='));
  const browser = await chromium.launch({ ...options, args });
  try {
    return await disabledFeatures(browser);
  } finally {
    await browser.close();
  }
}

it("keeps Playwright's disabled features, and on macOS turns off notifications", async () => {
  const service = await launchOptionsOfService();
  // Chromium reads only the last --disable-features: the service's must repeat Playwright's.
  expect(service.disabled).toEqual(
    expect.arrayContaining(await disabledByPlaywright(service.options)),
  );
  if (process.platform === 'darwin')
    expect(service.disabled).toEqual(
      expect.arrayContaining(['NativeNotifications', 'SystemNotifications']),
    );
});
