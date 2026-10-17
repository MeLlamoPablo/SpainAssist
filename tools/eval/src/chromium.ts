import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * Where playwright-core keeps the Chromium that `@sa/browser` launches (its registry is internal
 * API, as in `@sa/browser`'s install.ts). Never installs anything: undefined when it is missing.
 */
export function cachedChromium(): string | undefined {
  try {
    const registry = createRequire(import.meta.url)('playwright-core/lib/coreBundle').registry
      .registry as {
      findExecutable(name: 'chromium'): { executablePath(): string | undefined } | undefined;
    };
    const path = registry.findExecutable('chromium')?.executablePath();
    return path && existsSync(path) && statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** What a run (and `eval doctor`) says when the browser the agents need is not there. */
export const NO_CHROMIUM_MESSAGE =
  "Chromium is not in Playwright's cache, and this suite never downloads one: corepack pnpm --filter @sa/eval exec playwright-core install chromium";
