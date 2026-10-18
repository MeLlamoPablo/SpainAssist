/**
 * Stages playwright-core's pinned Chromium (Chrome for Testing) for packaging (D17): electron-
 * builder's `beforePack` calls it, and `extraResources` copies the folder to `<resources>/chromium`,
 * where main finds it (`src/main/browser/bundled.ts`). The app never downloads a browser.
 *
 * Takes the build from Playwright's cache, after `playwright-core install --no-shell --no-remove chromium`
 * (a no-op when it is already there), so a CI runner downloads it once per build and a developer
 * machine reuses its cache. Runs on the OS and CPU it packages for, like the rest of beforePack.
 */
import { spawnSync } from 'node:child_process';
import { constants, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { BUNDLED_CHROMIUM_MANIFEST, type ChromiumManifest } from '../src/main/browser/bundled';

const require = createRequire(import.meta.url);

/**
 * The part of playwright-core's internal browser registry used here. Not a public API
 * (docs/research/browser.md §5.2): check it when playwright-core is updated.
 */
interface ChromiumExecutable {
  /** `<cache>/chromium-<revision>` */
  directory: string;
  executablePath(): string | undefined;
  browserVersion: string;
}

function chromiumExecutable(): ChromiumExecutable {
  const registry = require('playwright-core/lib/coreBundle').registry.registry;
  const executable = registry.findExecutable('chromium') as ChromiumExecutable | undefined;
  if (!executable?.executablePath())
    throw new Error(`Playwright has no Chromium build for ${process.platform}-${process.arch}.`);
  return executable;
}

function installChromium(): void {
  const cli = path.join(path.dirname(require.resolve('playwright-core/package.json')), 'cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'install', '--no-shell', '--no-remove', 'chromium'],
    {
      stdio: 'inherit',
    },
  );
  if (result.status !== 0) throw new Error('playwright-core could not download Chromium.');
}

/**
 * Copies the browser into `outDir` (emptied first) with its manifest, and returns the manifest.
 * The copy keeps symlinks (the macOS .app's frameworks) and clones files where the disk can.
 */
export function stageChromium(outDir: string): ChromiumManifest {
  const executable = chromiumExecutable();
  const executablePath = executable.executablePath() as string;
  if (!existsSync(executablePath)) installChromium();
  if (!existsSync(executablePath)) throw new Error(`Chromium is still missing: ${executablePath}`);
  // `chrome-win64/chrome.exe`, `chrome-mac-arm64/Google Chrome for Testing.app/...`: only that
  // folder ships, not the cache's marker files.
  const relative = path.relative(executable.directory, executablePath).split(path.sep);
  const [top] = relative;
  if (!top || relative.length < 2) throw new Error(`Unexpected Chromium layout: ${executablePath}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(path.join(executable.directory, top), path.join(outDir, top), {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const manifest: ChromiumManifest = {
    executable: relative.join('/'),
    version: executable.browserVersion,
  };
  writeFileSync(
    path.join(outDir, BUNDLED_CHROMIUM_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
