import type { InstallChannel } from '@sa/shared';

/**
 * How this copy of the app was installed (D17). It decides where updates come from (D19), and
 * goes to Unleash and to error reports.
 *
 * - `windowsStore`: Electron's `process.windowsStore`, true inside the Microsoft Store's MSIX.
 *   Any other packaged Windows build counts as the NSIS installer's.
 * - `linuxPackageType`: `<resources>/package-type`, which electron-builder writes for the .deb.
 */
export function installChannel(opts: {
  packaged: boolean;
  platform: NodeJS.Platform;
  windowsStore: boolean;
  linuxPackageType?: string;
}): InstallChannel {
  if (!opts.packaged) return 'dev';
  if (opts.platform === 'win32') return opts.windowsStore ? 'msix' : 'nsis';
  if (opts.platform === 'darwin') return 'dmg';
  return opts.linuxPackageType === 'deb' ? 'deb' : 'unpacked';
}
