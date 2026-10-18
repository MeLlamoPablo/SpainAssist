import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../core/logger';
import {
  applyStagedLocalState,
  type DataImportDeps,
  defaultUserData,
  openDataImport,
} from './nsis-import';

let root: string;
let appData: string;
let nsis: string;
let store: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sa-nsis-import-'));
  appData = join(root, 'Roaming');
  nsis = join(appData, 'SpainAssistant');
  store = join(appData, 'SpainAssistantStore');
  await mkdir(store, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
}

/** An NSIS install that finished the onboarding and has one procedure. */
async function nsisInstall(): Promise<void> {
  await put(join(nsis, 'settings.json'), '{"onboardingCompleted":true,"language":"en"}');
  await put(join(nsis, 'state.json'), '{"deviceId":"00000000-0000-4000-8000-000000000000"}');
  await put(join(nsis, 'vault', 'key.bin'), 'wrapped-by-nsis');
  await put(join(nsis, 'vault', 'items', 'a.bin'), 'secret');
  await put(join(nsis, 'assistant', 'transcript.json'), '[]');
  await put(join(nsis, 'procedures', 'p1', 'procedure.json'), '{"id":"p1"}');
  await put(join(nsis, 'Local State'), '{"os_crypt":{"encrypted_key":"nsis"}}');
  await put(join(nsis, 'logs', 'main.log'), 'old log');
  await put(join(nsis, 'downloads', 'tmp.pdf'), 'x');
  await put(join(nsis, 'Cache', 'Cache_Data', 'data_0'), 'x');
  await put(join(nsis, 'Network', 'Cookies'), 'x');
  await put(join(nsis, 'lockfile'), '');
}

/** What a first start of the Store build creates before the import. */
async function freshStoreStart(): Promise<void> {
  await put(join(store, 'settings.json'), '{"onboardingCompleted":false}');
  await put(join(store, 'vault', 'key.bin'), 'wrapped-by-store');
  await mkdir(join(store, 'procedures'), { recursive: true });
  await put(join(store, 'Local State'), '{"os_crypt":{"encrypted_key":"store"}}');
  await put(join(store, 'logs', 'main.log'), 'new log');
}

const UNINSTALLER =
  'C:\\Users\\u\\AppData\\Local\\Programs\\spain-assist\\Uninstall Spain Assist.exe';

function deps(over: Partial<DataImportDeps> = {}): DataImportDeps {
  return {
    platform: 'win32',
    windowsStore: true,
    appData,
    userData: store,
    stop: vi.fn(async () => {}),
    relaunch: vi.fn(),
    findUninstaller: vi.fn(async () => undefined),
    launchUninstaller: vi.fn(async () => {}),
    openAppsSettings: vi.fn(async () => {}),
    logger: silentLogger,
    ...over,
  };
}

/** Deps whose NSIS app stays installed until `uninstalled()`. */
function installedDeps(over: Partial<DataImportDeps> = {}) {
  let installed = true;
  const d = deps({
    findUninstaller: vi.fn(async () => (installed ? UNINSTALLER : undefined)),
    ...over,
  });
  return {
    d,
    uninstalled: () => {
      installed = false;
    },
  };
}

const status = async (d: DataImportDeps) => (await openDataImport(d)).status();

describe('defaultUserData', () => {
  it('gives the Store build its own folder', () => {
    expect(defaultUserData(appData, 'win32', true)).toBe(store);
    expect(defaultUserData(appData, 'win32', false)).toBe(nsis);
    expect(defaultUserData(appData, 'win32', undefined)).toBe(nsis);
    expect(defaultUserData(appData, 'darwin', undefined)).toBe(nsis);
  });
});

describe('openDataImport', () => {
  it('does nothing outside the Store build', async () => {
    await nsisInstall();
    for (const over of [
      { windowsStore: false },
      { platform: 'darwin' as const, windowsStore: undefined },
      { platform: 'linux' as const },
    ]) {
      const { d } = installedDeps(over);
      expect(await status(d)).toEqual({ state: 'none' });
      expect(d.findUninstaller).not.toHaveBeenCalled();
    }
  });

  it('imports nothing without NSIS data, or when it never got past the onboarding', async () => {
    expect(await status(deps())).toEqual({ state: 'none' });
    await put(join(nsis, 'settings.json'), '{"onboardingCompleted":false}');
    await put(join(nsis, 'vault', 'key.bin'), 'x');
    expect(await status(deps())).toEqual({ state: 'none' });
  });

  it('imports on a first start, and again until it is done', async () => {
    await nsisInstall();
    expect(await status(deps())).toEqual({ state: 'import' });
    await freshStoreStart();
    expect(await status(deps())).toEqual({ state: 'import' });
  });

  it('imports nothing once the Store build has data of its own', async () => {
    await nsisInstall();
    await put(join(store, 'settings.json'), '{"onboardingCompleted":true}');
    expect(await status(deps())).toEqual({ state: 'none' });
    await rm(join(store, 'settings.json'));
    await put(join(store, 'procedures', 'p9', 'procedure.json'), '{}');
    expect(await status(deps())).toEqual({ state: 'none' });
  });

  it('keeps an answer from the betas that asked first', async () => {
    await nsisInstall();
    for (const answer of ['declined', 'dismissed', 'imported']) {
      await put(join(store, 'nsis-import.json'), `{"state":"${answer}"}`);
      expect(await status(deps())).toEqual({ state: 'none' });
    }
  });

  it('copies the app data, stages Local State, restarts, and is done', async () => {
    await nsisInstall();
    await freshStoreStart();
    const d1 = deps();
    const d = await openDataImport(d1);
    await d.run();

    expect(d1.stop).toHaveBeenCalledOnce();
    expect(d1.relaunch).toHaveBeenCalledOnce();
    expect(await readFile(join(store, 'settings.json'), 'utf8')).toContain('"language":"en"');
    expect(await readFile(join(store, 'state.json'), 'utf8')).toContain('deviceId');
    expect(await readFile(join(store, 'vault', 'key.bin'), 'utf8')).toBe('wrapped-by-nsis');
    expect(await readFile(join(store, 'vault', 'items', 'a.bin'), 'utf8')).toBe('secret');
    expect(await readdir(join(store, 'procedures'))).toEqual(['p1']);
    expect(await readFile(join(store, 'assistant', 'transcript.json'), 'utf8')).toBe('[]');
    // Not copied: this install's own logs, temporary downloads, Chromium's profile and locks.
    expect(await readFile(join(store, 'logs', 'main.log'), 'utf8')).toBe('new log');
    const entries = await readdir(store);
    for (const junk of ['downloads', 'Cache', 'Network', 'lockfile', 'nsis-import.staging'])
      expect(entries).not.toContain(junk);
    // The live Local State is untouched until the next start, before `ready`.
    expect(await readFile(join(store, 'Local State'), 'utf8')).toContain('"store"');
    applyStagedLocalState(store);
    expect(await readFile(join(store, 'Local State'), 'utf8')).toContain('"nsis"');
    expect(await readdir(store)).not.toContain('Local State.nsis-import');
    // The NSIS install is only read.
    expect(await readFile(join(nsis, 'vault', 'key.bin'), 'utf8')).toBe('wrapped-by-nsis');

    expect(await status(deps())).toEqual({ state: 'none' });
  });

  it('changes nothing when the copy fails', async () => {
    await nsisInstall();
    await freshStoreStart();
    // An unreadable file makes the copy fail.
    await chmod(join(nsis, 'vault', 'items', 'a.bin'), 0);
    const d1 = deps();
    const d = await openDataImport(d1);
    await expect(d.run()).rejects.toThrow();
    expect(d1.stop).not.toHaveBeenCalled();
    expect(await readFile(join(store, 'vault', 'key.bin'), 'utf8')).toBe('wrapped-by-store');
    expect(await readdir(store)).not.toContain('nsis-import.staging');
    expect(await d.status()).toEqual({ state: 'import' });
  });

  it('imports again after an import cut short', async () => {
    await nsisInstall();
    await put(join(store, 'settings.json'), '{"onboardingCompleted":true}');
    await mkdir(join(store, 'nsis-import.staging'), { recursive: true });
    expect(await status(deps())).toEqual({ state: 'import' });
  });

  it('asks to uninstall the NSIS app first, then imports once it is gone', async () => {
    await nsisInstall();
    const { d: d1, uninstalled } = installedDeps();
    const d = await openDataImport(d1);
    expect(await d.status()).toEqual({ state: 'uninstall' });
    await expect(d.run()).rejects.toThrow();
    expect(d1.stop).not.toHaveBeenCalled();

    await d.uninstall();
    expect(d1.launchUninstaller).toHaveBeenCalledWith(UNINSTALLER);
    // Cancelled, or still running: the screen stays.
    expect(await d.status()).toEqual({ state: 'uninstall' });

    uninstalled();
    expect(await d.status()).toEqual({ state: 'import' });
    await d.run();
    expect(d1.relaunch).toHaveBeenCalledOnce();
    expect(await readFile(join(store, 'vault', 'key.bin'), 'utf8')).toBe('wrapped-by-nsis');
  });

  it('asks to uninstall it even with nothing to import', async () => {
    await put(join(store, 'nsis-import.json'), '{"state":"imported"}');
    const { d: d1, uninstalled } = installedDeps();
    const d = await openDataImport(d1);
    expect(await d.status()).toEqual({ state: 'uninstall' });
    uninstalled();
    expect(await d.status()).toEqual({ state: 'none' });
  });

  it('opens Windows Settings > Apps when the uninstaller does not start', async () => {
    const { d: d1 } = installedDeps({
      launchUninstaller: vi.fn(async () => {
        throw new Error('spawn explorer.exe ENOENT');
      }),
    });
    await (await openDataImport(d1)).uninstall();
    expect(d1.openAppsSettings).toHaveBeenCalledOnce();
  });

  it('starts no uninstaller once the NSIS app is gone', async () => {
    const d1 = deps();
    await (await openDataImport(d1)).uninstall();
    expect(d1.launchUninstaller).not.toHaveBeenCalled();
  });
});
