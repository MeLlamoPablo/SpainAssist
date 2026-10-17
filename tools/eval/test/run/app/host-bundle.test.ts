import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEvalAppWith } from '../../../src/run/app';
import { ensureEvalHostBundle, hostBundleState } from '../../../src/run/app/host-bundle';
import { startWorld } from './support';

let root: string;
let bundle: string;
let source: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sa-bundle-'));
  bundle = join(root, 'dist', 'eval-host.js');
  source = join(root, 'src');
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'main.ts'), 'export {}');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const touch = (path: string, secondsAgo: number) => {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path, when, when);
};

describe('hostBundleState', () => {
  it('is missing, stale or fresh', () => {
    const options = { bundle, sources: [source] };
    expect(hostBundleState(options)).toBe('missing');
    writeFileSync(bundle, '// bundle');
    touch(bundle, 100);
    touch(join(source, 'main.ts'), 10);
    touch(source, 10);
    expect(hostBundleState(options)).toBe('stale');
    touch(bundle, 1);
    expect(hostBundleState(options)).toBe('fresh');
    // A file added to a source folder counts, at any depth.
    mkdirSync(join(source, 'deep', 'er'), { recursive: true });
    writeFileSync(join(source, 'deep', 'er', 'new.ts'), 'export {}');
    touch(bundle, 100);
    expect(hostBundleState(options)).toBe('stale');
    touch(bundle, -100);
    for (const path of [
      join(source, 'deep', 'er', 'new.ts'),
      join(source, 'deep', 'er'),
      join(source, 'deep'),
      source,
    ])
      touch(path, 50);
    expect(hostBundleState(options)).toBe('fresh');
  });
});

describe('ensureEvalHostBundle', () => {
  it('builds a missing bundle once, even when several runs ask at the same time', async () => {
    let builds = 0;
    const build = async () => {
      builds++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(bundle, '// built');
    };
    const options = { bundle, sources: [source], build, buildScript: 'build.mjs' };
    const paths = await Promise.all([
      ensureEvalHostBundle(options),
      ensureEvalHostBundle(options),
      ensureEvalHostBundle(options),
    ]);
    expect(paths).toEqual([bundle, bundle, bundle]);
    expect(builds).toBe(1);
  });

  it('rebuilds a stale bundle and leaves a fresh one alone', async () => {
    writeFileSync(bundle, '// old');
    touch(bundle, 100);
    touch(join(source, 'main.ts'), 10);
    let builds = 0;
    const build = async () => {
      builds++;
      writeFileSync(bundle, '// new');
    };
    await ensureEvalHostBundle({ bundle, sources: [source], build });
    expect(builds).toBe(1);
    await ensureEvalHostBundle({ bundle, sources: [source], build });
    expect(builds).toBe(1);
  });

  it('runs the build script it is given, with the Node that runs the tests', async () => {
    const script = join(root, 'build.mjs');
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(bundle)}, '// from script');`,
    );
    await ensureEvalHostBundle({ bundle, sources: [source], buildScript: script });
    expect(hostBundleState({ bundle, sources: [source] })).toBe('fresh');
  });

  it('says what went wrong, and how to fix it, when the build fails', async () => {
    const script = join(root, 'broken.mjs');
    writeFileSync(script, "console.error('esbuild: cannot find the entry'); process.exit(1);");
    const error = await ensureEvalHostBundle({
      bundle,
      sources: [source],
      buildScript: script,
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/missing or out of date and could not be built/);
    expect((error as Error).message).toContain('esbuild: cannot find the entry');
    expect((error as Error).message).toContain('corepack pnpm --filter @sa/eval build:host');
  });

  it('does not trust a build that leaves no bundle', async () => {
    await expect(
      ensureEvalHostBundle({ bundle, sources: [source], build: async () => {} }),
    ).rejects.toThrow(/still missing or out of date/);
  });
});

describe('a run without an agent host', () => {
  it('refuses to start, with the reason, before it makes anything', async () => {
    const world = await startWorld({ hostBundle: bundle });
    try {
      const error = await createEvalAppWith(world.spec, world.deps, {
        hostBundle: {
          bundle,
          sources: [source],
          build: async () => {
            throw new Error('esbuild is not installed');
          },
        },
      }).catch((e: Error) => e);
      expect((error as Error).message).toMatch(/could not be built/);
      expect((error as Error).message).toContain('esbuild is not installed');
      expect((error as Error).message).toContain('build:host');
      // Nothing was created: no profile, no log, no process.
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(world.runDir).filter((name) => name !== 'events.jsonl')).toEqual([]);
    } finally {
      world.run.close();
      await world.env.close();
      await world.bench.close();
      world.log.close();
      rmSync(world.runDir, { recursive: true, force: true });
    }
  });
});
