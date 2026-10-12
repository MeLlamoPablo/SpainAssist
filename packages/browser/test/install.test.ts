import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChromiumRegistry } from '../src/install';

let dir: string;
let executable: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-browser-install-'));
  executable = path.join(dir, 'chromium-1243', 'Chromium');
  // ensureChromium keeps its download in module state: start each test with a fresh module.
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function loadEnsureChromium() {
  return (await import('../src/install')).ensureChromium;
}

function createExecutable(): void {
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
}

/** A registry whose `install` runs `download` (by default: the download creates the file). */
function fakeRegistry(download: () => Promise<void> = async () => createExecutable()) {
  const install = vi.fn(async (_executables: unknown[], _options: { gc: boolean }) => download());
  const registry: ChromiumRegistry = {
    findExecutable: () => ({ executablePath: () => executable }),
    resolveBrowsers: (names) => names,
    install,
  };
  return { registry, install };
}

describe('ensureChromium', () => {
  it('returns the executable without a download when it exists', async () => {
    createExecutable();
    const { registry, install } = fakeRegistry();
    const ensureChromium = await loadEnsureChromium();

    await expect(ensureChromium({ registry })).resolves.toBe(executable);
    expect(install).not.toHaveBeenCalled();
  });

  it('downloads a missing Chromium once, without removing other browsers', async () => {
    const { registry, install } = fakeRegistry();
    const ensureChromium = await loadEnsureChromium();

    const results = await Promise.all([ensureChromium({ registry }), ensureChromium({ registry })]);

    expect(results).toEqual([executable, executable]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(['chromium'], { gc: false });
  });

  it('fails with an actionable error, keeps the exit code and tries again on the next call', async () => {
    const failing = fakeRegistry(async () => {
      process.exitCode = 1;
      throw new Error('Download failure, code=1');
    });
    const ensureChromium = await loadEnsureChromium();
    const exitCode = process.exitCode;

    await expect(ensureChromium({ registry: failing.registry })).rejects.toThrow(
      /could not download it.*internet connection/,
    );
    expect(process.exitCode).toBe(exitCode);

    const working = fakeRegistry();
    await expect(ensureChromium({ registry: working.registry })).resolves.toBe(executable);
    expect(working.install).toHaveBeenCalledTimes(1);
  });

  it('fails when the download does not create the executable', async () => {
    const { registry } = fakeRegistry(async () => {});
    const ensureChromium = await loadEnsureChromium();

    await expect(ensureChromium({ registry })).rejects.toThrow(/browser is not available/);
  });
});
