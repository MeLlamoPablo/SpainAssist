import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
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
    on: vi.fn((event: string, handler: Handler) => mocks.handlers.set(`win:${event}`, handler)),
    close: vi.fn(),
    isDestroyed: vi.fn(() => false),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      capturePage: vi.fn(async () => {}),
      on: vi.fn((event: string, handler: Handler) => mocks.handlers.set(event, handler)),
    },
  },
  errorBox: vi.fn(),
  bundleManifest: vi.fn(async () => 'manifest'),
  cleanupInstaller: vi.fn(async () => {}),
  detachInstaller: vi.fn(),
  forgetInstaller: vi.fn(async () => {}),
  hasPendingInstaller: vi.fn(async () => true),
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
  mocks.handlers.clear();
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
    expect(mocks.win.loadFile).toHaveBeenCalledWith('/app/resources/installer/progress.html', {
      hash: undefined,
    });
    expect(mocks.win.show).toHaveBeenCalled();
    expect(mocks.identifyInstaller).toHaveBeenCalledWith(
      [],
      'manifest',
      '/Volumes/Spain Assist/Spain Assist.app',
    );
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

  it('starts the installed app directly when no copy is pending', async () => {
    mocks.app.isInApplicationsFolder.mockReturnValue(true);
    mocks.hasPendingInstaller.mockResolvedValueOnce(false);
    expect(await installMacApp(false)).toBe(false);
    expect(mocks.win.loadFile).not.toHaveBeenCalled();
    expect(mocks.cleanupInstaller).not.toHaveBeenCalled();
  });

  /** Resolves once the installed app shows its finished screen and waits for the user. */
  async function installedScreen(): Promise<{ started: Promise<boolean> }> {
    mocks.app.isInApplicationsFolder.mockReturnValue(true);
    const started = installMacApp(false);
    await vi.waitFor(() => expect(mocks.handlers.has('did-navigate-in-page')).toBe(true));
    expect(mocks.win.loadFile).toHaveBeenCalledWith('/app/resources/installer/progress.html', {
      hash: 'installed',
    });
    expect(mocks.cleanupInstaller).not.toHaveBeenCalled();
    return { started };
  }

  it('moves the installer to Trash only after the button, then starts the app', async () => {
    const { started } = await installedScreen();
    mocks.handlers.get('did-navigate-in-page')?.({}, 'file:///app/progress.html#opening');
    expect(await started).toBe(false);
    expect(mocks.cleanupInstaller).toHaveBeenCalledOnce();
    expect(mocks.win.close).toHaveBeenCalled();
    expect(mocks.app.moveToApplicationsFolder).not.toHaveBeenCalled();
  });

  it('starts the app when Trash access is denied', async () => {
    mocks.cleanupInstaller.mockRejectedValueOnce(new Error('Operation not permitted'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { started } = await installedScreen();
    mocks.handlers.get('did-navigate-in-page')?.({}, 'file:///app/progress.html#opening');
    expect(await started).toBe(false);
    expect(mocks.win.close).toHaveBeenCalled();
  });

  it('keeps the installer and starts the app when the window is closed instead', async () => {
    const { started } = await installedScreen();
    mocks.handlers.get('win:closed')?.();
    expect(await started).toBe(false);
    expect(mocks.cleanupInstaller).not.toHaveBeenCalled();
    expect(mocks.forgetInstaller).toHaveBeenCalled();
    expect(mocks.app.quit).not.toHaveBeenCalled();
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
