// Bundles the eval agent host (src/host/eval-main.ts) into dist/eval-host.js: the product host
// (packages/agent, `runHost` from @sa/agent/host-runtime) with the eval's hooks. Same bundle shape as
// packages/agent/scripts/build-host.mjs: one ESM file run with plain Node (the eval has no Electron),
// with pi, typebox and the native canvas (PDF page rendering) external. They resolve from this
// package's node_modules (@earendil-works/*, typebox and @napi-rs/canvas are its dependencies), so
// the bundle must stay under tools/eval/. The product host never contains any of this: it is built
// from packages/agent/src/host/main.ts, which passes no hooks.
// dist/package.json marks the folder as ESM.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/host/eval-main.ts'],
  outfile: 'dist/eval-host.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@earendil-works/*', 'typebox', 'typebox/*', '@napi-rs/canvas'],
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: {
    js: "import { createRequire as __saCreateRequire } from 'node:module'; const require = __saCreateRequire(import.meta.url);",
  },
  sourcemap: 'linked',
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
});
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`built dist/eval-host.js (${Math.round(bytes / 1024)} KiB)`);
