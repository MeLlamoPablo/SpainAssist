import { existsSync, renameSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DataImportStatus } from '@sa/shared';
import { z } from 'zod';
import { type AppPaths, assistantPaths, createAppPaths } from '../app/paths';
import { readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import { normalizeSettings } from '../settings/store';

/*
 * Windows ships two builds: the Microsoft Store MSIX (advertised) and the NSIS installer from
 * GitHub Releases (kept, unadvertised). Some NSIS users install the Store build too; this module
 * offers to bring the NSIS install's data into it on its first start.
 *
 * Where each build keeps its data. Both are Electron userData under the real %APPDATA%:
 * - NSIS: `%APPDATA%\SpainAssistant` (index.ts sets it explicitly; the name also keys the macOS
 *   keychain item, so it never changes).
 * - MSIX: `%APPDATA%\SpainAssistantStore`. An MSIX app's AppData is virtualized (Windows 10
 *   1903+): new files and folders go to the package's private
 *   `%LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming`, but opening a file the private copy
 *   doesn't have falls through to the real AppData, and such a file is then modified in place.
 *   With the same folder name the Store build would read the NSIS install's files, append to some
 *   of them in place (transcripts, sessions) and fork others into private copies (every atomic
 *   write creates a new file), leaving both installs inconsistent. Its own folder name starts it
 *   truly empty, keeps it out of the NSIS install's data, and its data goes away with the package
 *   when it is uninstalled. The fall-through is also what lets it read the NSIS data to import.
 *
 * What is copied: an allowlist of the app's own data (settings, app state, the vault, the
 * assistant's conversation, the procedures), classified per `AppPaths` entry below so that a new
 * path doesn't compile until someone decides. Everything else in userData is left behind:
 * - logs: diagnostics of the other install (and this one's logger already writes there);
 * - downloads: temporary browser downloads, deleted at every start anyway;
 * - scanner: development-only scan transcripts, deleted at start in packaged builds;
 * - Chromium's own profile (Cache, Code Cache, GPUCache, DawnCache, Network (cookies), Local
 *   Storage, Session Storage, IndexedDB, Preferences, Crashpad, lockfile...), and the error
 *   reports' queue (`sentry`): caches, locks and state of the app window only. The renderer
 *   keeps nothing in web storage.
 * - `Local State`, except for its encryption key, below.
 *
 * The vault's key. The vault encrypts with a random data key, wrapped by Electron's safeStorage
 * (`vault/keyProvider.ts`). On Windows safeStorage is Chromium's os_crypt: an AES-256-GCM key
 * stored in userData's `Local State` (`os_crypt.encrypted_key`), itself encrypted with DPAPI for
 * the current Windows user. The Store build runs as the same user with full trust (not in an
 * AppContainer), so DPAPI unwraps that key there too; what it lacks is the NSIS install's
 * `Local State`, since each userData has its own, with a different random key. So the import
 * copies that `Local State` as well. It can't overwrite the live one: Chromium keeps it in memory
 * and may write it back while quitting. It is staged next to it instead and moved into place on
 * the next start, before `ready`, when Chromium hasn't read it yet (`applyStagedLocalState`).
 * Replacing it costs nothing else: the only other secrets it protects are the app window's
 * cookies from this first run, which Chromium drops when it can't decrypt them.
 *
 * Copying happens in a staging folder while the app still runs, so a failure leaves everything
 * as it was. Then main's services stop, each entry is swapped in, the decision is saved and the
 * app restarts. An import cut short (crash, power loss) leaves the staging folder, which brings
 * the offer back on the next start; the NSIS data itself is only ever read.
 */

/** Electron's userData folder name in the NSIS (and macOS, Linux) builds. */
const NSIS_FOLDER = 'SpainAssistant';
/** The MSIX build's own userData folder name (see above). */
const STORE_FOLDER = 'SpainAssistantStore';
/** Chromium's file with the os_crypt key that wraps the vault's key on Windows. */
const LOCAL_STATE = 'Local State';
/** The NSIS install's `Local State`, waiting for the next start. */
const STAGED_LOCAL_STATE = 'Local State.nsis-import';
/** Where the import copies to before swapping entries in. */
const STAGING_DIR = 'nsis-import.staging';
/** The user's answer, kept out of the imported entries. */
const DECISION_FILE = 'nsis-import.json';

/**
 * Whether each of the app's paths under userData is imported. Typed by `AppPaths`: a new path
 * doesn't compile until it is classified here. Imported paths must be direct children of userData.
 */
const IMPORTED: Record<Exclude<keyof AppPaths, 'userData' | 'tmpDir'>, boolean> = {
  settingsFile: true,
  stateFile: true,
  vaultDir: true,
  assistantDir: true,
  proceduresDir: true,
  logsDir: false,
  downloadsDir: false,
  scanTranscriptsDir: false,
};

function importedEntries(userData: string): string[] {
  const paths = createAppPaths(userData);
  return Object.entries(IMPORTED)
    .filter(([, imported]) => imported)
    .map(([key]) => relative(userData, paths[key as keyof typeof IMPORTED]));
}

const Decision = z.object({ state: z.enum(['declined', 'imported', 'dismissed']) });
type Decision = z.infer<typeof Decision>['state'];

/** Electron's `process.windowsStore` on Windows: true only in the MSIX build. */
function isStoreBuild(platform: NodeJS.Platform, windowsStore: boolean | undefined): boolean {
  return platform === 'win32' && windowsStore === true;
}

/** This build's userData folder, under Electron's `appData` (the real %APPDATA% on Windows). */
export function defaultUserData(
  appData: string,
  platform: NodeJS.Platform,
  windowsStore: boolean | undefined,
): string {
  return join(appData, isStoreBuild(platform, windowsStore) ? STORE_FOLDER : NSIS_FOLDER);
}

/**
 * Moves a staged `Local State` into place. Called before `ready`, so Chromium loads the imported
 * os_crypt key. If it fails, opening the vault fails next and the startup error says so.
 */
export function applyStagedLocalState(userData: string): void {
  const staged = join(userData, STAGED_LOCAL_STATE);
  if (!existsSync(staged)) return;
  try {
    renameSync(staged, join(userData, LOCAL_STATE));
  } catch {
    // Reported by the vault, which can't decrypt its key without it.
  }
}

export interface DataImport {
  status(): DataImportStatus;
  /** Copies the NSIS install's data in, stops the app's services and restarts the app. */
  accept(): Promise<void>;
  decline(): Promise<void>;
  dismiss(): Promise<void>;
  openAppsSettings(): Promise<void>;
}

/** Builds that have nothing to import (macOS, Linux, NSIS, tests). */
export const noDataImport: DataImport = {
  status: () => ({ state: 'none' }),
  accept: () => Promise.reject(new Error('Nothing to import')),
  decline: async () => {},
  dismiss: async () => {},
  openAppsSettings: () => Promise.reject(new Error('Not available')),
};

export interface DataImportDeps {
  platform: NodeJS.Platform;
  /** Electron's `process.windowsStore`. */
  windowsStore: boolean | undefined;
  /** Electron's `appData`: the real %APPDATA%, where the NSIS install keeps its data. */
  appData: string;
  /** This app's userData. */
  userData: string;
  /** Stops main's services (agents, browser, pending writes) before files are swapped. */
  stop(): Promise<void>;
  /** Restarts the app; doesn't return. */
  relaunch(): void;
  /** Opens Windows Settings > Apps. */
  openAppsSettings(): Promise<void>;
  logger: Logger;
}

/**
 * The import offer of the MSIX build. Call it before main's services open this userData: they
 * create its files, and "has no data of its own yet" is decided from what was there before.
 */
export async function openDataImport(deps: DataImportDeps): Promise<DataImport> {
  const { userData, logger } = deps;
  const source = join(deps.appData, NSIS_FOLDER);
  if (!isStoreBuild(deps.platform, deps.windowsStore) || source === userData) return noDataImport;

  const staging = join(userData, STAGING_DIR);
  const decisionFile = join(userData, DECISION_FILE);
  const decision = await readDecision(decisionFile, logger);
  const interrupted = await exists(staging);
  let state: DataImportStatus['state'] = 'none';
  if (decision === 'imported') state = 'imported';
  else if (!decision && (await hasUserData(source)))
    state = interrupted || !(await hasUserData(userData)) ? 'offer' : 'none';
  if (decision && interrupted) await rm(staging, { recursive: true, force: true }).catch(() => {});
  logger.info('NSIS data import', { state, decision: decision ?? 'none', interrupted });

  const decide = async (next: Decision) => {
    await writeFileAtomic(decisionFile, `${JSON.stringify({ state: next })}\n`);
  };
  let importing: Promise<void> | undefined;

  return {
    status: () => ({ state }),
    accept() {
      if (state !== 'offer') return Promise.reject(new Error('Nothing to import'));
      importing ??= runImport().finally(() => {
        importing = undefined;
      });
      return importing;
    },
    async decline() {
      if (state !== 'offer') return;
      await decide('declined');
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      state = 'none';
    },
    async dismiss() {
      if (state !== 'imported') return;
      await decide('dismissed');
      state = 'none';
    },
    openAppsSettings: () => deps.openAppsSettings(),
  };

  async function runImport(): Promise<void> {
    const entries = importedEntries(userData);
    // 1. Copy into staging while the app runs: a failure here changes nothing.
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      for (const entry of entries) {
        const from = join(source, entry);
        if (await exists(from))
          await cp(from, join(staging, entry), { recursive: true, preserveTimestamps: true });
      }
      const localState = join(source, LOCAL_STATE);
      if (await exists(localState)) await copyFile(localState, join(staging, LOCAL_STATE));
    } catch (err) {
      logger.warn('NSIS data import: copy failed', { error: errorMessage(err) });
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
    // 2. Stop everything that reads or writes userData, swap the entries in, restart. If a swap
    // fails, the staging folder stays and the next start offers the import again.
    logger.info('NSIS data import: copied, restarting');
    await deps.stop();
    try {
      for (const entry of entries) {
        await rm(join(userData, entry), { recursive: true, force: true });
        const staged = join(staging, entry);
        if (await exists(staged)) await rename(staged, join(userData, entry));
      }
      const stagedLocalState = join(staging, LOCAL_STATE);
      if (await exists(stagedLocalState))
        await rename(stagedLocalState, join(userData, STAGED_LOCAL_STATE));
      await decide('imported');
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      logger.error('NSIS data import: swap failed', { error: errorMessage(err) });
    }
    deps.relaunch();
  }
}

/**
 * Whether a userData folder holds anything of the user's: a finished onboarding, a procedure or
 * a conversation. A fresh start creates an empty vault and settings, which don't count.
 */
async function hasUserData(dir: string): Promise<boolean> {
  const paths = createAppPaths(dir);
  const settings = await readJsonFile(paths.settingsFile).catch(() => undefined);
  if (settings !== undefined && normalizeSettings(settings).onboardingCompleted) return true;
  const procedures = await readdir(paths.proceduresDir).catch(() => []);
  if (procedures.length > 0) return true;
  return exists(assistantPaths(paths.assistantDir).transcriptFile);
}

async function readDecision(file: string, logger: Logger): Promise<Decision | undefined> {
  try {
    const parsed = Decision.safeParse(await readJsonFile(file));
    return parsed.success ? parsed.data.state : undefined;
  } catch (err) {
    logger.warn('NSIS data import: unreadable decision', { error: errorMessage(err) });
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
