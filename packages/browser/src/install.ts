import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BrowserError } from './errors';
import type { Logger } from './types';

/**
 * The part of playwright-core's internal browser registry that we use. It is not a public API
 * (docs/research/browser.md §5.2): keep playwright-core pinned and check it when you update it.
 */
export interface ChromiumRegistry {
  findExecutable(name: 'chromium'): { executablePath(): string | undefined } | undefined;
  resolveBrowsers(names: string[], options: { shell: 'no' }): unknown[];
  install(executables: unknown[], options: { gc: boolean }): Promise<void>;
}

function playwrightRegistry(): ChromiumRegistry {
  const require = createRequire(import.meta.url);
  return require('playwright-core/lib/coreBundle').registry.registry;
}

let installing: Promise<string> | undefined;

/**
 * Makes sure the Chromium that playwright-core launches by default exists, and returns its path.
 * When it is missing, downloads it (about 150 MB, once) with playwright-core's own installer.
 * Concurrent calls share one download; after a failure the next call tries again.
 */
export function ensureChromium(
  opts: { logger?: Logger; registry?: ChromiumRegistry } = {},
): Promise<string> {
  installing ??= installChromium(opts).catch((err: unknown) => {
    installing = undefined;
    throw err;
  });
  return installing;
}

async function installChromium(opts: {
  logger?: Logger;
  registry?: ChromiumRegistry;
}): Promise<string> {
  const registry = opts.registry ?? playwrightRegistry();
  const executable = registry.findExecutable('chromium')?.executablePath();
  if (!executable)
    throw new BrowserError('internal', 'The browser is not supported on this system.');
  if (existsSync(executable)) return executable;
  opts.logger?.info('browser: downloading Chromium', { executable });
  const started = Date.now();
  // The installer sets process.exitCode = 1 when a download fails: the app must not exit with it.
  const exitCode = process.exitCode;
  try {
    // gc: false keeps the browsers of other Playwright installs in the shared cache.
    await registry.install(registry.resolveBrowsers(['chromium'], { shell: 'no' }), { gc: false });
  } catch (err) {
    opts.logger?.error('browser: Chromium download failed', { error: String(err) });
    throw unavailable();
  } finally {
    process.exitCode = exitCode;
  }
  if (!existsSync(executable)) {
    opts.logger?.error('browser: Chromium is still missing after the download', { executable });
    throw unavailable();
  }
  opts.logger?.info('browser: Chromium downloaded', { ms: Date.now() - started });
  return executable;
}

function unavailable(): BrowserError {
  return new BrowserError(
    'internal',
    'The browser is not available: the app could not download it. Ask the user to check the internet connection. The app tries again on the next browser action.',
  );
}
