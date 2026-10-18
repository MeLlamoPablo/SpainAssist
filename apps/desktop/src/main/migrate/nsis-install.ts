import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/*
 * The GitHub (NSIS) install, seen from the Microsoft Store build. electron-builder's one-click
 * installer installs per user and lists the app under HKCU's Uninstall key, named by a UUID v5 of
 * the appId (`es.spainassist.desktop`; electron-builder.test.ts checks the name). Its
 * `UninstallString` is `"<install dir>\Uninstall Spain Assist.exe" /currentuser`.
 *
 * The Store build reads that key through its merged view of the registry. It can't run the
 * uninstaller itself: a packaged app's children run in its container, where registry and AppData
 * writes are redirected, so the entry would stay in Windows Settings > Apps. explorer.exe hands the
 * file to the user's shell instead, which runs it outside the container. Started without
 * arguments, the one-click uninstaller asks "are you sure" (OK / Cancel), closes the app if it
 * runs from its own folder, and keeps the app's data (no `--delete-app-data`, and the build
 * doesn't set deleteAppDataOnUninstall), so the import can copy it afterwards.
 */

/** HKCU's Uninstall entry of the NSIS install. */
export const NSIS_UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\000d5f47-0725-5b3b-be10-86838e4bbf42';

/** The uninstaller's path from `reg query <key> /v UninstallString` output. */
export function parseUninstallString(output: string): string | undefined {
  const value = /^\s*UninstallString\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output)?.[1];
  if (!value) return undefined;
  const quoted = /^"([^"]+)"/.exec(value);
  return quoted ? quoted[1] : value.split(' /')[0];
}

/**
 * The NSIS install's uninstaller, while the app is installed: its Uninstall entry exists and the
 * uninstaller it names is still there (a leftover entry without its files doesn't count).
 */
export async function findNsisUninstaller(): Promise<string | undefined> {
  const output = await new Promise<string>((resolve) =>
    execFile(
      'reg.exe',
      ['query', NSIS_UNINSTALL_KEY, '/v', 'UninstallString'],
      { windowsHide: true },
      // Exit code 1: no such key, so not installed.
      (err, stdout) => resolve(err ? '' : stdout),
    ),
  );
  const uninstaller = parseUninstallString(output);
  return uninstaller && existsSync(uninstaller) ? uninstaller : undefined;
}

/** Starts the uninstaller through the user's shell, outside this app's container (see above). */
export function launchNsisUninstaller(uninstaller: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('explorer.exe', [uninstaller], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
