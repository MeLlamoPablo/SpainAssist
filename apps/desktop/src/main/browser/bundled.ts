/**
 * The Chromium that ships inside the packaged app (D17): playwright-core's pinned build, copied
 * at packaging time by `scripts/chromium.ts` to `<resources>/chromium/`, with a manifest that
 * names its executable. Development runs have none and launch Playwright's cache instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** The folder under `<resources>` (`extraResources` in electron-builder.ts). */
export const BUNDLED_CHROMIUM_DIR = 'chromium';

/** Written next to the browser by `scripts/chromium.ts`. */
export const BUNDLED_CHROMIUM_MANIFEST = 'chromium.json';

const ChromiumManifest = z.object({
  /** Relative to the manifest's folder, with `/` separators. */
  executable: z
    .string()
    .min(1)
    .refine((p) => !path.isAbsolute(p) && !p.split('/').includes('..'), 'must stay inside'),
  /** Chrome for Testing version (`153.0.8010.12`), for logs. */
  version: z.string(),
});
export type ChromiumManifest = z.infer<typeof ChromiumManifest>;

/**
 * The bundled Chromium's executable and version, or, when this build has none or it is broken,
 * the `reason` (for the log).
 */
export function bundledChromiumPath(
  resourcesPath: string,
): { executable: string; version: string } | { reason: string } {
  const dir = path.join(resourcesPath, BUNDLED_CHROMIUM_DIR);
  let manifest: ChromiumManifest;
  try {
    manifest = ChromiumManifest.parse(
      JSON.parse(readFileSync(path.join(dir, BUNDLED_CHROMIUM_MANIFEST), 'utf8')),
    );
  } catch (err) {
    return { reason: `no valid ${BUNDLED_CHROMIUM_MANIFEST}: ${(err as Error).message}` };
  }
  const executable = path.join(dir, ...manifest.executable.split('/'));
  if (!existsSync(executable)) return { reason: `${manifest.executable} is missing` };
  return { executable, version: manifest.version };
}
