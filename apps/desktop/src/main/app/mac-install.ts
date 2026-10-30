import { posix } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import {
  bundleManifest,
  cleanupInstaller,
  detachInstaller,
  forgetInstaller,
  hasPendingInstaller,
  identifyInstaller,
  mountedDiskImages,
  rememberInstaller,
} from './mac-installer';

// macOS-only code: macOS paths, also where its tests run on another OS.
const { dirname, join } = posix;

const bundlePath = () => dirname(dirname(dirname(app.getPath('exe'))));

/** Runs before services, vault access, onboarding, or any normal app window is started. */
export async function installMacApp(e2e: boolean): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged || e2e) return false;
  const userData = app.getPath('userData');
  if (app.isInApplicationsFolder()) {
    if (await hasPendingInstaller(userData)) await offerInstallerCleanup(userData);
    return false;
  }

  const win = await showInstallerWindow();
  win.on('closed', () => app.quit());
  // Wait for a composited frame before the synchronous native copy. The renderer keeps the
  // indeterminate CSS animation running while the main process is occupied by the bundle mover.
  await win.webContents.capturePage();
  try {
    try {
      const sourceBundle = bundlePath();
      const manifest = await bundleManifest(sourceBundle);
      const source = await identifyInstaller(await mountedDiskImages(), manifest, sourceBundle);
      if (source) await rememberInstaller(userData, source, manifest);
    } catch (error) {
      // Failure to identify the DMG cannot prevent installation; never guess what to trash.
      console.warn('Installer could not be identified:', error);
    }
    if (win.isDestroyed()) return true;
    // The destination must acquire the lock immediately when Electron relaunches it.
    app.releaseSingleInstanceLock();
    if (!app.moveToApplicationsFolder()) {
      await forgetInstaller(userData);
      app.quit();
    }
  } catch (error) {
    await forgetInstaller(userData);
    dialog.showErrorBox(
      'No hemos podido instalar Spain Assist',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
  // The native mover quits this process and opens the installed app. Never start the app on DMG.
  return true;
}

async function showInstallerWindow(hash?: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 720,
    height: 480,
    useContentSize: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'Spain Assist',
    backgroundColor: '#fbf7f2',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(join(process.resourcesPath, 'installer/progress.html'), { hash });
  win.show();
  return win;
}

/**
 * The installed app's first launch finishes the copy screen with a button, so the Downloads
 * access prompt that moving the DMG may raise answers the user's own click, never startup.
 * Clicking or closing the window both start the app, whether or not the DMG reached Trash.
 */
async function offerInstallerCleanup(userData: string): Promise<void> {
  const win = await showInstallerWindow('installed');
  const trash = await new Promise<boolean>((resolve) => {
    win.webContents.on('did-navigate-in-page', (_event, url) => {
      if (new URL(url).hash === '#opening') resolve(true);
    });
    win.on('closed', () => resolve(false));
  });
  if (trash) {
    await cleanupInstaller({
      userData,
      manifest: () => bundleManifest(bundlePath()),
      images: mountedDiskImages,
      detach: detachInstaller,
      trash: (image) => shell.trashItem(image),
    }).catch((error: unknown) => console.warn('Installer cleanup skipped:', error));
  } else {
    await forgetInstaller(userData).catch(() => {});
  }
  if (!win.isDestroyed()) win.close();
}
