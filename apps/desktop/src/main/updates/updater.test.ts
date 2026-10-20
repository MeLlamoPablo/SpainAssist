import { EventEmitter } from 'node:events';
import type { UpdateStatus } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChannel } from '../app/install-channel';
import { createLogger } from '../core/logger';
import { createUpdates, type UpdaterBackend, updatesSupported } from './updater';

const logger = createLogger({ level: 'error', sinks: [] });

class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checks = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  async checkForUpdates() {
    this.checks++;
    this.emit('checking-for-update');
    return null;
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean) {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function setup(opts: { urgent?: boolean } = {}) {
  const backend = new FakeBackend();
  const updates = createUpdates({
    backend,
    logger,
    firstCheckMs: 1000,
    checkEveryMs: 60_000,
    ...opts,
  });
  const seen: UpdateStatus[] = [];
  updates.onStatus((s) => seen.push(s));
  updates.start();
  return { backend, updates, seen };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('updatesSupported', () => {
  const supported = (
    opts: Partial<Parameters<typeof installChannel>[0]> & { e2e?: boolean } = {},
  ) =>
    updatesSupported({
      channel: installChannel({ packaged: true, platform: 'win32', windowsStore: false, ...opts }),
      e2e: opts.e2e ?? false,
    });

  it('is on for the NSIS installer’s Windows builds outside e2e', () => {
    expect(supported()).toBe(true);
    expect(supported({ packaged: false })).toBe(false);
    expect(supported({ e2e: true })).toBe(false);
  });

  it('is off for the Microsoft Store build: the Store updates it', () => {
    expect(installChannel({ packaged: true, platform: 'win32', windowsStore: true })).toBe('msix');
    expect(supported({ windowsStore: true })).toBe(false);
  });

  it('is on for the packaged macOS app outside e2e', () => {
    expect(supported({ platform: 'darwin' })).toBe(true);
    expect(supported({ platform: 'darwin', packaged: false })).toBe(false);
    expect(supported({ platform: 'darwin', e2e: true })).toBe(false);
  });

  it('is on for Linux only when installed from the .deb', () => {
    const linux = { platform: 'linux' } as const;
    expect(supported({ ...linux, linuxPackageType: 'deb' })).toBe(true);
    expect(supported(linux)).toBe(false);
    expect(supported({ ...linux, linuxPackageType: 'rpm' })).toBe(false);
    expect(supported({ ...linux, linuxPackageType: 'deb', e2e: true })).toBe(false);
    expect(supported({ ...linux, linuxPackageType: 'deb', packaged: false })).toBe(false);
  });
});

describe('createUpdates', () => {
  it('is unsupported without a backend', () => {
    const updates = createUpdates({ logger });
    updates.start();
    expect(updates.status()).toEqual({ state: 'unsupported' });
  });

  it('downloads silently and installs on quit', async () => {
    const { backend, updates, seen } = setup();
    expect(backend.autoDownload).toBe(true);
    expect(backend.autoInstallOnAppQuit).toBe(true);
    expect(updates.status()).toEqual({ state: 'idle' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(backend.checks).toBe(1);
    backend.emit('update-available', { version: '0.3.0' });
    backend.emit('download-progress', { percent: 41.6 });
    backend.emit('download-progress', { percent: 41.9 });
    backend.emit('update-downloaded', { version: '0.3.0' });

    expect(seen).toEqual([
      { state: 'checking' },
      { state: 'downloading', version: '0.3.0', percent: 0 },
      { state: 'downloading', version: '0.3.0', percent: 42 },
      { state: 'ready', version: '0.3.0' },
    ]);
    expect(backend.installs).toEqual([]);
  });

  it('checks again periodically, but not while an update is downloaded', async () => {
    const { backend } = setup();
    await vi.advanceTimersByTimeAsync(1000);
    backend.emit('update-not-available');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.checks).toBe(2);
    backend.emit('update-available', { version: '0.3.0' });
    backend.emit('update-downloaded', { version: '0.3.0' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backend.checks).toBe(2);
  });

  it('when this version must update, checks at once and restarts into the update', async () => {
    const { backend } = setup({ urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.checks).toBe(1);
    backend.emit('update-available', { version: '0.3.0' });
    backend.emit('update-downloaded', { version: '0.3.0' });
    expect(backend.installs).toEqual([[true, true]]);
  });

  it('reports errors and keeps checking', async () => {
    const { backend, updates } = setup();
    await vi.advanceTimersByTimeAsync(1000);
    backend.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    expect(updates.status()).toEqual({ state: 'error' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backend.checks).toBe(2);
  });

  it('stops its timers', async () => {
    const { backend, updates } = setup();
    updates.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backend.checks).toBe(0);
  });
});
