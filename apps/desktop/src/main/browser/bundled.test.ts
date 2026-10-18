import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BUNDLED_CHROMIUM_DIR, BUNDLED_CHROMIUM_MANIFEST, bundledChromiumPath } from './bundled';

let resources: string;
afterEach(() => rmSync(resources, { recursive: true, force: true }));

function setup(manifest?: unknown, executable?: string): void {
  resources = mkdtempSync(path.join(tmpdir(), 'sa-resources-'));
  const dir = path.join(resources, BUNDLED_CHROMIUM_DIR);
  mkdirSync(dir, { recursive: true });
  if (manifest !== undefined)
    writeFileSync(path.join(dir, BUNDLED_CHROMIUM_MANIFEST), JSON.stringify(manifest));
  if (executable) {
    mkdirSync(path.dirname(path.join(dir, executable)), { recursive: true });
    writeFileSync(path.join(dir, executable), '');
  }
}

describe('bundledChromiumPath', () => {
  it('finds the executable the manifest names', () => {
    setup(
      { executable: 'chrome-win64/chrome.exe', version: '153.0.8010.12' },
      'chrome-win64/chrome.exe',
    );
    expect(bundledChromiumPath(resources)).toEqual({
      executable: path.join(resources, 'chromium', 'chrome-win64', 'chrome.exe'),
      version: '153.0.8010.12',
    });
  });

  it('says why when the build has no usable browser', () => {
    setup();
    expect(bundledChromiumPath(resources)).toHaveProperty('reason');
    rmSync(resources, { recursive: true });
    setup({ executable: 'chrome-win64/chrome.exe', version: '1' });
    expect(bundledChromiumPath(resources)).toEqual({
      reason: 'chrome-win64/chrome.exe is missing',
    });
  });

  it('refuses a manifest that points outside its folder', () => {
    setup({ executable: '../vendor/sa-sidecar', version: '1' });
    expect(bundledChromiumPath(resources)).toHaveProperty('reason');
  });
});
