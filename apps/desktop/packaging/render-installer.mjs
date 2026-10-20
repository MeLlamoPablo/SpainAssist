// Rebuild the Finder background from the editable HTML and the exported Framer shader.
// node apps/desktop/packaging/render-installer.mjs (macOS; uses cached Chromium only)
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = join(import.meta.dirname, 'installer');
copyFileSync(
  join(import.meta.dirname, '../src/renderer/src/assets/brand/instrument-serif-regular.ttf'),
  join(dir, 'serif.ttf'),
);
copyFileSync(
  join(
    import.meta.dirname,
    '../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2',
  ),
  join(dir, 'inter.woff2'),
);
copyFileSync(join(import.meta.dirname, 'icon.png'), join(dir, 'icon.png'));
const browser = await chromium.launch();
try {
  for (const scale of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 720, height: 502 },
      deviceScaleFactor: scale,
    });
    await page.goto(new URL('installer/dmg.html', import.meta.url).href);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: join(dir, scale === 1 ? 'background.png' : 'background@2x.png'),
    });
    await page.close();
  }
} finally {
  await browser.close();
}
execFileSync('/usr/bin/tiffutil', [
  '-cathidpicheck',
  join(dir, 'background.png'),
  join(dir, 'background@2x.png'),
  '-out',
  join(dir, 'background.tiff'),
]);
rmSync(join(dir, 'background@2x.png'));
