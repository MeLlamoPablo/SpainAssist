/**
 * Where sa-sidecar lives, shared by the build (`build.ts`), electron-builder
 * (`apps/desktop/electron-builder.ts`) and the desktop app's lookup:
 *
 * - development: `apps/desktop/vendor/<platform>-<arch>/sa-sidecar[.exe]`
 * - packaged: `<resources>/vendor/sa-sidecar[.exe]`, copied there by `extraResources`
 *   (`process.resourcesPath`: `Contents/Resources` on macOS, `resources/` elsewhere)
 */
import path from 'node:path';

export interface SidecarTarget {
  platform: NodeJS.Platform;
  arch: string;
}

/** The OS/arch pairs the installers ship (`electron-builder.ts` targets). */
export const SIDECAR_TARGETS: readonly SidecarTarget[] = [
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'linux', arch: 'x64' },
];

function sidecarFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'sa-sidecar.exe' : 'sa-sidecar';
}

/** `<vendorDir>/<platform>-<arch>/sa-sidecar[.exe]`: one folder per target. */
export function vendorBinaryPath(
  vendorDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return path.join(vendorDir, `${platform}-${arch}`, sidecarFileName(platform));
}

/** The binary the desktop app starts. */
export function sidecarBinaryPath(opts: {
  /** `app.isPackaged` */
  packaged: boolean;
  /** `process.resourcesPath` */
  resourcesPath: string;
  /** `app.getAppPath()`: `apps/desktop` in development. */
  appPath: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): string {
  const platform = opts.platform ?? process.platform;
  return opts.packaged
    ? path.join(opts.resourcesPath, 'vendor', sidecarFileName(platform))
    : vendorBinaryPath(path.join(opts.appPath, 'vendor'), platform, opts.arch ?? process.arch);
}
