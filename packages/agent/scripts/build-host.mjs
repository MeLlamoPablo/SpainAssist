// Bundles the agent host (src/host/main.ts) into dist/host.js, a single ESM file run with
// Electron-as-Node (ELECTRON_RUN_AS_NODE=1) or plain Node. pi, typebox and the native canvas
// (PDF page rendering) stay external: they must resolve from dist/'s location (pnpm:
// packages/agent/node_modules). dist/package.json marks
// the folder as ESM so it keeps working when copied into the app's resources.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/host/main.ts'],
  outfile: 'dist/host.js',
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
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
});
writeFileSync(join(dist, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);

const bytes = Object.values(result.metafile.outputs).find((o) => o.entryPoint)?.bytes ?? 0;
console.log(`built dist/host.js (${Math.round(bytes / 1024)} KiB)`);
