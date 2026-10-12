// Renders packaging/icon.svg to packaging/icon.png (1024×1024, transparent corners), the one
// icon electron-builder converts for every platform. Uses Playwright's Chromium (already in the
// cache when you have run the app or the e2e tests).
//   node apps/desktop/packaging/render-icon.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = import.meta.dirname;
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`,
  );
  await page.locator('svg').screenshot({ path: join(dir, 'icon.png'), omitBackground: true });
} finally {
  await browser.close();
}
console.log('packaging/icon.png');
