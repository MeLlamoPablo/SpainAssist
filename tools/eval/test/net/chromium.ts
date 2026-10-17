import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Where playwright-core keeps a browser it already downloaded (the registry is internal API, as in
 * `@sa/browser`'s install.ts). Never installs anything: undefined when the browser is not cached.
 */
export function cachedBrowser(name: 'chromium' | 'chromium-headless-shell'): string | undefined {
  try {
    const registry = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry
      .registry as {
      findExecutable(name: string): { executablePath(): string | undefined } | undefined;
    };
    const path = registry.findExecutable(name)?.executablePath();
    return path && existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/** What a skipped browser test says: this suite never downloads a browser. */
export function notCachedMessage(name: 'chromium' | 'chromium-headless-shell'): string {
  return `${name} is not in the Playwright cache: the tests that need it are skipped (this suite never downloads browsers)`;
}
