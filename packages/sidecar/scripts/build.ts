/**
 * corepack pnpm --filter @sa/sidecar build [--out <dir>] [--platform darwin|win32|linux] [--arch arm64|x64]
 * corepack pnpm --filter @sa/sidecar build --all [--out <dir>]   # every shipped target
 *
 * Default: the host's binary only (development). Packaging builds its target itself
 * (`apps/desktop/electron-builder.ts`). Without Go it says so and exits 0: the app runs, with
 * certificate logins off.
 */
import path from 'node:path';
import { buildAllSidecars, buildSidecar } from '../src/build';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = option('--out');
const outDir = out ? path.resolve(out) : undefined;

try {
  const binaries = args.includes('--all')
    ? await buildAllSidecars({ outDir })
    : [
        await buildSidecar({
          outDir,
          platform: option('--platform') as NodeJS.Platform | undefined,
          arch: option('--arch'),
        }),
      ];
  for (const binary of binaries) console.log(`sa-sidecar: ${path.relative(process.cwd(), binary)}`);
} catch (err) {
  const e = err as NodeJS.ErrnoException & { stderr?: string };
  if (e.code === 'ENOENT') {
    console.warn(
      'sa-sidecar: Go is not installed (https://go.dev/dl). Certificate logins stay off.',
    );
  } else {
    console.error(`sa-sidecar: build failed\n${e.stderr ?? e.message}`);
    process.exit(1);
  }
}
