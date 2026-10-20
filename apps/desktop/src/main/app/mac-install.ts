import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import {
  bundleManifest,
  cleanupInstaller,
  detachInstaller,
  forgetInstaller,
  identifyInstaller,
  mountedDiskImages,
  rememberInstaller,
} from './mac-installer';

const bundlePath = () => dirname(dirname(dirname(app.getPath('exe'))));

/** Runs before services, vault access, onboarding, or any normal app window is started. */
export async function installMacApp(e2e: boolean): Promise<boolean> {
  if (process.platform !== 'darwin' || !app.isPackaged || e2e) return false;
  const userData = app.getPath('userData');
  if (app.isInApplicationsFolder()) {
    // The installed instance is alive. Cleanup never blocks onboarding or shows a success screen.
    void cleanupInstaller({
      userData,
      manifest: () => bundleManifest(bundlePath()),
      images: mountedDiskImages,
      detach: detachInstaller,
      trash: (image) => shell.trashItem(image),
    }).catch((error: unknown) => console.warn('Installer cleanup skipped:', error));
    return false;
  }

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
  win.on('closed', () => app.quit());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadFile(join(process.resourcesPath, 'installer/progress.html'));
  win.show();
  // Wait for a composited frame before the synchronous native copy. The renderer keeps the
  // indeterminate CSS animation running while the main process is occupied by the bundle mover.
  await win.webContents.capturePage();
  try {
    try {
      const manifest = await bundleManifest(bundlePath());
      const source = await identifyInstaller(await mountedDiskImages(), manifest);
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
