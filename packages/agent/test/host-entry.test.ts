/**
 * Guards for the product host: `runHost`'s hooks are for harnesses and tests that call it
 * themselves. The shipped entry (src/host/main.ts, bundled to dist/host.js) must pass none and
 * must not contain a way to switch one on, so no config key, environment variable or bundled
 * module can turn an eval or test seam on in a packaged app.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { EVAL_MARKERS } from './helpers/eval-markers';

const packageRoot = join(import.meta.dirname, '..');
const mainSource = readFileSync(join(packageRoot, 'src', 'host', 'main.ts'), 'utf8');

describe('the product host entry (main.ts)', () => {
  it('calls runHost once, with no hooks', () => {
    const calls = [...mainSource.matchAll(/\brunHost\(([^)]*)\)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toBe('');
  });

  it('imports only the logger and runHost itself', () => {
    const imports = [...mainSource.matchAll(/^import\s+(?:[^;]*?\sfrom\s+)?'([^']+)';/gms)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(['./log', './run']);
    expect(mainSource).not.toMatch(/\bimport\(/);
  });

  it('bundles into a module graph with no eval, test or hook-implementation code', async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints: ['src/host/main.ts'],
      outdir: 'dist/host-entry-check',
      write: false,
      metafile: true,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      external: ['@earendil-works/*', 'typebox', 'typebox/*', '@napi-rs/canvas'],
      logLevel: 'silent',
    });
    const ours = Object.keys(result.metafile.inputs).filter(
      (path) => !path.includes('node_modules'),
    );
    expect(ours).toContain('src/host/run.ts');
    expect(ours.filter((path) => /eval|^test\/|runtime\.ts$/i.test(path))).toEqual([]);
    const code = result.outputFiles.map((file) => file.text).join('\n');
    expect(code).not.toMatch(EVAL_MARKERS);
  });
});
