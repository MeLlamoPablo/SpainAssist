import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIDECAR_TARGETS, sidecarBinaryPath, vendorBinaryPath } from '../src/layout';

describe('sidecar layout', () => {
  it('keeps one development folder per target', () => {
    expect(vendorBinaryPath('/v', 'darwin', 'arm64')).toBe(
      path.join('/v', 'darwin-arm64', 'sa-sidecar'),
    );
    expect(vendorBinaryPath('/v', 'win32', 'x64')).toBe(
      path.join('/v', 'win32-x64', 'sa-sidecar.exe'),
    );
  });

  it('looks in the vendor folder in development and in the resources when packaged', () => {
    const where = { resourcesPath: '/App/Resources', appPath: '/repo/apps/desktop' };
    expect(sidecarBinaryPath({ ...where, packaged: false, platform: 'linux', arch: 'x64' })).toBe(
      path.join('/repo/apps/desktop', 'vendor', 'linux-x64', 'sa-sidecar'),
    );
    expect(sidecarBinaryPath({ ...where, packaged: true, platform: 'darwin', arch: 'arm64' })).toBe(
      path.join('/App/Resources', 'vendor', 'sa-sidecar'),
    );
    expect(sidecarBinaryPath({ ...where, packaged: true, platform: 'win32', arch: 'x64' })).toBe(
      path.join('/App/Resources', 'vendor', 'sa-sidecar.exe'),
    );
  });

  it('ships both macOS architectures and x64 elsewhere', () => {
    expect(SIDECAR_TARGETS.map((t) => `${t.platform}-${t.arch}`)).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'win32-x64',
      'linux-x64',
    ]);
  });
});
