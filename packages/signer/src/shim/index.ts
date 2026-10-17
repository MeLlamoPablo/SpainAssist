import { AFIRMA_BINDING, AFIRMA_NOTICE } from '@sa/shared';
import { type AutoscriptShimConfig, installAutoscriptShim } from './runtime';

export type { AutoscriptShimConfig, AutoscriptShimHandle } from './runtime';
export { installAutoscriptShim } from './runtime';

/** AutoScript VERSION reported until the site's own autoscript.js provides the real one. */
export const DEFAULT_AUTOSCRIPT_VERSION = '1.10.1';

export interface AutoscriptShimOptions {
  /** Binding name the shim calls (default: `AFIRMA_BINDING` from @sa/shared). */
  binding?: string;
  /** VERSION reported before the page loads its own autoscript.js (default 1.10.1). */
  version?: string;
}

/**
 * Helpers that bundlers / coverage tools inject into transpiled functions. If any of them shows
 * up in the serialized shim, the injected source would throw a ReferenceError in the page.
 */
const FORBIDDEN_IN_SOURCE = [
  '__vite_ssr_',
  '__awaiter',
  '__async(',
  '__spreadValues',
  '__publicField',
  '_asyncToGenerator',
  'cov_',
  'import(',
  'require(',
];

/**
 * Builds the in-page AutoScript shim as a string, ready for Playwright's
 * `context.addInitScript({ content })` (or `addInitScript(source)`). It installs itself once per
 * frame and never throws into the page.
 */
export function buildAutoscriptShimSource(options: AutoscriptShimOptions = {}): string {
  const config: AutoscriptShimConfig = {
    binding: options.binding ?? AFIRMA_BINDING,
    notice: AFIRMA_NOTICE,
    version: options.version ?? DEFAULT_AUTOSCRIPT_VERSION,
  };
  const fn = installAutoscriptShim.toString();
  for (const marker of FORBIDDEN_IN_SOURCE) {
    if (fn.includes(marker)) {
      throw new Error(
        `@sa/signer: the AutoScript shim was transpiled with an external helper (${marker}); ` +
          'build the package without keepNames/coverage instrumentation for this module.',
      );
    }
  }
  // tsx/esbuild keepNames decorates inner functions with __name. Include its tiny helper
  // in the injected closure so source exports also work in development tools.
  const nameHelper = fn.includes('__name(')
    ? 'const __name = (target, value) => Object.defineProperty(target, "name", {value, configurable: true});\n'
    : '';
  const source = `(() => {\n  ${nameHelper}  try {\n    (${fn})(${JSON.stringify(config)});\n  } catch (e) {\n    /* never break the page */\n  }\n})();\n`;
  // Fail fast at build time on syntax problems (the string is evaluated by the browser later).
  new Function(source);
  return source;
}

/** The shim with default options (binding `AFIRMA_BINDING`). */
export const AUTOSCRIPT_SHIM_SOURCE: string = buildAutoscriptShimSource();
