import { AFIRMA_BINDING, AFIRMA_NOTICE, FNMT_BINDING, FNMT_ERROR, FNMT_NOTICE } from '@sa/shared';
import { type FnmtShimConfig, installFnmtShim } from './fnmt';
import { type AutoscriptShimConfig, installAutoscriptShim } from './runtime';

export type { FnmtShimConfig, FnmtShimHandle } from './fnmt';
export { installFnmtShim } from './fnmt';
export type { AutoscriptShimConfig, AutoscriptShimHandle } from './runtime';
export { installAutoscriptShim } from './runtime';

/** AutoScript VERSION reported until the site's own autoscript.js provides the real one. */
export const DEFAULT_AUTOSCRIPT_VERSION = '1.10.1';

/** FnmtCertRequest VERSION reported until FNMT's own fnmtcertrq.js provides the real one. */
export const DEFAULT_FNMT_VERSION = '1.6.4';

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
 * Serializes an in-page installer and its config into a string ready for Playwright's
 * `context.addInitScript({ content })`. It installs itself once per frame and never throws into
 * the page.
 */
function serializeShim(install: (config: never) => void, config: unknown, what: string): string {
  const fn = install.toString();
  for (const marker of FORBIDDEN_IN_SOURCE) {
    if (fn.includes(marker)) {
      throw new Error(
        `@sa/signer: the ${what} shim was transpiled with an external helper (${marker}); ` +
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

/** Builds the in-page AutoScript shim as a string (see `serializeShim`). */
export function buildAutoscriptShimSource(options: AutoscriptShimOptions = {}): string {
  const config: AutoscriptShimConfig = {
    binding: options.binding ?? AFIRMA_BINDING,
    notice: AFIRMA_NOTICE,
    version: options.version ?? DEFAULT_AUTOSCRIPT_VERSION,
  };
  return serializeShim(installAutoscriptShim, config, 'AutoScript');
}

/** The shim with default options (binding `AFIRMA_BINDING`). */
export const AUTOSCRIPT_SHIM_SOURCE: string = buildAutoscriptShimSource();

export interface FnmtShimOptions {
  /** Binding name the shim calls (default: `FNMT_BINDING` from @sa/shared). */
  binding?: string;
  /** VERSION reported before the page loads its own fnmtcertrq.js (default 1.6.4). */
  version?: string;
}

/** Builds the in-page FnmtCertRequest shim as a string (see `serializeShim`). */
export function buildFnmtShimSource(options: FnmtShimOptions = {}): string {
  const config: FnmtShimConfig = {
    binding: options.binding ?? FNMT_BINDING,
    notice: FNMT_NOTICE,
    version: options.version ?? DEFAULT_FNMT_VERSION,
    errors: { generic: FNMT_ERROR.generic, cardNotSupported: FNMT_ERROR.cardNotSupported },
  };
  return serializeShim(installFnmtShim, config, 'FnmtCertRequest');
}

/** The FNMT shim with default options (binding `FNMT_BINDING`). */
export const FNMT_SHIM_SOURCE: string = buildFnmtShimSource();
