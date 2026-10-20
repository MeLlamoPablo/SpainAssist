import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    isInApplicationsFolder: vi.fn(() => false),
    getPath: vi.fn((name: string) =>
      name === 'exe'
        ? '/Volumes/Spain Assist/Spain Assist.app/Contents/MacOS/Spain Assist'
        : '/tmp/sa-install-test',
    ),
    releaseSingleInstanceLock: vi.fn(),
    moveToApplicationsFolder: vi.fn(() => true),
    quit: vi.fn(),
  },
  win: {
    loadFile: vi.fn(async () => {}),
    show: vi.fn(),
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: { setWindowOpenHandler: vi.fn(), capturePage: vi.fn(async () => {}) },
  },
  errorBox: vi.fn(),
  bundleManifest: vi.fn(async () => 'manifest'),
  cleanupInstaller: vi.fn(async () => {}),
  detachInstaller: vi.fn(),
  forgetInstaller: vi.fn(async () => {}),
  identifyInstaller: vi.fn(async () => ({
    image: '/Downloads/app.dmg',
    mount: '/Volumes/Spain Assist',
  })),
  mountedDiskImages: vi.fn(async () => []),
  rememberInstaller: vi.fn(async () => {}),
}));
vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: class {
    constructor() {
      Object.assign(this, mocks.win);
    }
  },
  dialog: { showErrorBox: mocks.errorBox },
  shell: { trashItem: vi.fn() },
}));
vi.mock('./mac-installer', () => mocks);

import { installMacApp } from './mac-install';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: '/app/resources' });
  mocks.app.isPackaged = true;
  mocks.app.isInApplicationsFolder.mockReturnValue(false);
  mocks.app.moveToApplicationsFolder.mockReturnValue(true);
});
afterEach(() => vi.unstubAllGlobals());

describe('automatic macOS installation', () => {
  it('skips development, e2e and other platforms', async () => {
    expect(await installMacApp(true)).toBe(false);
    mocks.app.isPackaged = false;
    expect(await installMacApp(false)).toBe(false);
    mocks.app.isPackaged = true;
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    expect(await installMacApp(false)).toBe(false);
    expect(mocks.win.loadFile).not.toHaveBeenCalled();
    expect(mocks.app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('shows the preparation window and records the source before moving without confirmation', async () => {
    expect(await installMacApp(false)).toBe(true);
    expect(mocks.win.loadFile).toHaveBeenCalledWith('/app/resources/installer/progress.html');
    expect(mocks.win.show).toHaveBeenCalled();
    expect(mocks.rememberInstaller).toHaveBeenCalledWith(
      '/tmp/sa-install-test',
      { image: '/Downloads/app.dmg', mount: '/Volumes/Spain Assist' },
      'manifest',
    );
    expect(mocks.rememberInstaller.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.moveToApplicationsFolder.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.app.releaseSingleInstanceLock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.moveToApplicationsFolder.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.errorBox).not.toHaveBeenCalled();
  });

  it('starts cleanup without a window or completion dialog in the installed app', async () => {
    mocks.app.isInApplicationsFolder.mockReturnValue(true);
    expect(await installMacApp(false)).toBe(false);
    expect(mocks.cleanupInstaller).toHaveBeenCalledOnce();
    expect(mocks.win.loadFile).not.toHaveBeenCalled();
    expect(mocks.app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('quits without starting from the image when authorization is cancelled', async () => {
    mocks.app.moveToApplicationsFolder.mockReturnValue(false);
    expect(await installMacApp(false)).toBe(true);
    expect(mocks.forgetInstaller).toHaveBeenCalled();
    expect(mocks.app.quit).toHaveBeenCalled();
    expect(mocks.errorBox).not.toHaveBeenCalled();
  });

  it('preserves the image on copy failure and reports the actual error', async () => {
    mocks.app.moveToApplicationsFolder.mockImplementationOnce(() => {
      throw new Error('Disk full');
    });
    expect(await installMacApp(false)).toBe(true);
    expect(mocks.forgetInstaller).toHaveBeenCalled();
    expect(mocks.errorBox).toHaveBeenCalledWith(
      'No hemos podido instalar Spain Assist',
      'Disk full',
    );
    expect(mocks.app.quit).toHaveBeenCalled();
  });
});
