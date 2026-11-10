import { transform } from 'sucrase';

/**
 * Turns a workflow module (`export async function main(api)`, JSX, `import … from
 * "@spainassist/ui"`) into a CommonJS-style function body the kernel can load. The output keeps
 * the source's line numbers, so errors point at the model's own lines. Not TypeScript: types
 * are documentation only (docs/codemode.md).
 */
export function transformModule(source: string): string {
  const { code } = transform(source, {
    transforms: ['jsx', 'imports'],
    jsxPragma: '__sa_h',
    jsxFragmentPragma: '__sa_Fragment',
    production: true,
    // The kernel resolves imports itself; no interop helpers for default imports of CommonJS.
    enableLegacyBabel5ModuleInterop: false,
  });
  return code;
}

/** Syntax errors in plain words with the line, for the model. */
export function transformError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `SyntaxError: ${message.replace(/^Error: /, '')}`;
}
