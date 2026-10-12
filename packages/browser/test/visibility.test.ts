import { type Browser, chromium, type Page } from 'playwright-core';
import { expect, it, vi } from 'vitest';
import { createBrowserService } from '../src';
import { createTestService, page, refOf, startServer } from './helpers';

async function windowState(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    return (await cdp.send('Browser.getWindowForTarget')).bounds.windowState;
  } finally {
    await cdp.detach();
  }
}

// Native macOS window focus is affected by concurrent Chromium launches. Run this desktop
// integration test separately with SA_TEST_BROWSER_WINDOWS=1; the regular suite is headless.
it.skipIf(
  process.env.SA_TEST_BROWSER_WINDOWS !== '1' ||
    (process.platform === 'linux' && !process.env.DISPLAY),
)(
  'minimizes automation windows, preserves the live page during help, and hides popups',
  async () => {
    const server = await startServer({
      '/': page(
        '<label>Nombre <input></label><button onclick="window.open(\'/popup\')">Popup</button>',
      ),
      '/popup': page('<h1>Ventana emergente</h1>'),
    });
    const fixture = createTestService();
    let browser: Browser | undefined;
    const launch = chromium.launch.bind(chromium);
    const spy = vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      browser = await launch(options);
      return browser;
    });
    const service = createBrowserService({
      headless: false,
      startHidden: true,
      downloadsDir: fixture.downloadsDir,
      onDownload: async () => ({ downloadId: 'test', name: 'test', mimeType: 'text/plain' }),
    });
    try {
      const observation = await service.open('help', server.origin);
      const live = browser!.contexts()[0]!.pages()[0]!;
      await expect.poll(() => windowState(live)).toBe('minimized');
      await service.type('help', refOf(observation.snapshot, 'textbox "Nombre"'), 'Lucía');
      const marker = await live.evaluate(() => {
        const marker = Math.random();
        Object.assign(window, { sessionMarker: marker });
        return marker;
      });
      await service.show('help');
      await expect.poll(() => windowState(live)).toBe('normal');
      expect(await live.locator('input').inputValue()).toBe('Lucía');
      expect(await live.evaluate(() => Reflect.get(window, 'sessionMarker'))).toBe(marker);
      await service.hide('help');
      await expect.poll(() => windowState(live)).toBe('minimized');
      const snapshot = await service.snapshot('help');
      await service.click('help', refOf(snapshot.snapshot, 'button "Popup"'));
      await expect.poll(() => browser!.contexts()[0]!.pages().length).toBe(2);
      for (const tab of browser!.contexts()[0]!.pages()) {
        await expect.poll(() => windowState(tab)).toBe('minimized');
      }
      await service.show('help');
      const popup = browser!.contexts()[0]!.pages()[1]!;
      await expect.poll(() => windowState(popup)).toBe('normal');
      await service.hide('help');
      await expect.poll(() => windowState(popup)).toBe('minimized');
    } finally {
      await service.closeAll();
      spy.mockRestore();
      await fixture.cleanup();
      await server.close();
    }
  },
);
