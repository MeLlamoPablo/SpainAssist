// Renders packaging/icon.svg to:
// - packaging/icon.png (1024×1024, transparent corners), the icon electron-builder converts for
//   every platform;
// - packaging/appx/*.png, the Microsoft Store package's logos and tiles (electron-builder's
//   `appx` target reads that folder; `.scale-*` and `.targetsize-*` files make it index them).
// Uses Playwright's Chromium (already in the cache when you have run the app or the e2e tests).
//   node apps/desktop/packaging/render-icon.mjs
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const dir = import.meta.dirname;
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');

/**
 * The Store package's images: `[file, width, height, icon]`, where `icon` is the side of the
 * square icon drawn in the middle (icon.svg keeps its own margin around the flag).
 */
const appxImages = [];
for (const scale of [100, 200]) {
  const s = scale / 100;
  appxImages.push(
    [`StoreLogo.scale-${scale}.png`, 50 * s, 50 * s, 50 * s],
    [`Square44x44Logo.scale-${scale}.png`, 44 * s, 44 * s, 44 * s],
    [`Square150x150Logo.scale-${scale}.png`, 150 * s, 150 * s, 100 * s],
    [`Wide310x150Logo.scale-${scale}.png`, 310 * s, 150 * s, 100 * s],
  );
}
// The taskbar, Start and the file explorer: exact sizes, also without the tile plate.
for (const size of [16, 24, 32, 48, 256]) {
  appxImages.push(
    [`Square44x44Logo.targetsize-${size}.png`, size, size, size],
    [`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size, size],
  );
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const render = async (file, width, height, icon) => {
    await page.setViewportSize({ width, height });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}body{width:${width}px;height:${height}px;display:flex;align-items:center;justify-content:center}svg{display:block;width:${icon}px;height:${icon}px}</style>${svg}`,
    );
    await page.screenshot({ path: file, omitBackground: true });
  };
  await render(join(dir, 'icon.png'), 1024, 1024, 1024);
  const appx = join(dir, 'appx');
  rmSync(appx, { recursive: true, force: true });
  mkdirSync(appx);
  for (const [name, width, height, icon] of appxImages)
    await render(join(appx, name), width, height, icon);
} finally {
  await browser.close();
}
console.log(`packaging/icon.png, packaging/appx/ (${appxImages.length} images)`);
