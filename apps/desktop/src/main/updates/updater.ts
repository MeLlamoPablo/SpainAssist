import type { InstallChannel, UpdateStatus } from '@sa/shared';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';

/**
 * The part of electron-updater's `autoUpdater` this module uses (a fake in tests). It reads
 * `app-update.yml`, which electron-builder writes from `publish` (GitHub Releases).
 */
export interface UpdaterBackend {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: electron-updater's typed events, narrowed below
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface Updates {
  status(): UpdateStatus;
  onStatus(listener: (status: UpdateStatus) => void): () => void;
}

/**
 * Where the app updates itself from GitHub Releases, by how it was installed
 * (`installChannel`): the NSIS installer's builds, the macOS app (from its zip, through
 * Squirrel.Mac), and the Linux .deb, which electron-updater reinstalls with `dpkg -i`, asking for
 * the password through pkexec. Not the Microsoft Store's MSIX: the Store updates it. Not
 * development, e2e or unpacked builds.
 *
 * Squirrel.Mac only installs an update signed by the running app's Developer ID: releases are
 * signed (release.yml), and a local ad-hoc build's updates fail with an `error` status.
 */
export function updatesSupported(opts: { channel: InstallChannel; e2e: boolean }): boolean {
  return !opts.e2e && (opts.channel === 'nsis' || opts.channel === 'dmg' || opts.channel === 'deb');
}

/** The Store's page of the app: the Microsoft Store build updates there (`updates.openStore`). */
export const STORE_PAGE_URL = 'ms-windows-store://pdp/?productid=9ND5MF94VKGC';

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

/**
 * The app's own updates, silent: they download in the background and install when the app quits
 * (autoInstallOnAppQuit). `urgent` (the `must-update` flag): check at once and install as soon as
 * the update is downloaded, restarting the app. Without a backend the status stays `unsupported`.
 */
export function createUpdates(deps: {
  backend?: UpdaterBackend;
  logger: Logger;
  urgent?: boolean;
  firstCheckMs?: number;
  checkEveryMs?: number;
}): Updates & { start(): void; stop(): void } {
  const { backend, logger: log } = deps;
  let status: UpdateStatus = { state: backend ? 'idle' : 'unsupported' };
  const listeners = new Set<(status: UpdateStatus) => void>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const set = (next: UpdateStatus) => {
    status = next;
    for (const listener of listeners) listener(next);
  };
  const busy = () => status.state === 'downloading' || status.state === 'ready';

  const check = () => {
    if (!backend || busy()) return;
    // Failures also arrive as `error` events; this only keeps the rejection handled.
    backend.checkForUpdates().catch(() => {});
  };

  return {
    status: () => status,
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (!backend) return;
      backend.autoDownload = true;
      backend.autoInstallOnAppQuit = true;
      backend.on('checking-for-update', () => {
        if (!busy()) set({ state: 'checking' });
      });
      backend.on('update-not-available', () => set({ state: 'upToDate' }));
      backend.on('update-available', (info: { version: string }) => {
        log.info('update available', { version: info.version });
        set({ state: 'downloading', version: info.version, percent: 0 });
      });
      backend.on('download-progress', (progress: { percent: number }) => {
        if (status.state !== 'downloading') return;
        const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
        if (percent !== status.percent) set({ ...status, percent });
      });
      backend.on('update-downloaded', (info: { version: string }) => {
        set({ state: 'ready', version: info.version });
        if (deps.urgent) {
          log.info('update downloaded: this version must update, restarting', {
            version: info.version,
          });
          backend.quitAndInstall(true, true);
        } else log.info('update downloaded: installs on quit', { version: info.version });
      });
      backend.on('error', (err: unknown) => {
        log.warn('update failed', { error: errorMessage(err) });
        if (status.state !== 'ready') set({ state: 'error' });
      });
      timers.push(setTimeout(check, deps.urgent ? 0 : (deps.firstCheckMs ?? FIRST_CHECK_MS)));
      timers.push(setInterval(check, deps.checkEveryMs ?? CHECK_EVERY_MS));
    },
    stop() {
      for (const timer of timers.splice(0)) clearTimeout(timer);
    },
  };
}
