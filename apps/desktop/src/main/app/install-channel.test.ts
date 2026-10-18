import { describe, expect, it } from 'vitest';
import { installChannel } from './install-channel';

describe('installChannel', () => {
  const packaged = { packaged: true, windowsStore: false } as const;

  it('tells the Microsoft Store package from the NSIS installer', () => {
    expect(installChannel({ ...packaged, platform: 'win32', windowsStore: true })).toBe('msix');
    expect(installChannel({ ...packaged, platform: 'win32' })).toBe('nsis');
  });

  it('names the macOS and Linux packages', () => {
    expect(installChannel({ ...packaged, platform: 'darwin' })).toBe('dmg');
    expect(installChannel({ ...packaged, platform: 'linux', linuxPackageType: 'deb' })).toBe('deb');
    expect(installChannel({ ...packaged, platform: 'linux' })).toBe('unpacked');
  });

  it('is dev for every unpackaged run', () => {
    expect(installChannel({ packaged: false, platform: 'win32', windowsStore: true })).toBe('dev');
    expect(installChannel({ packaged: false, platform: 'darwin', windowsStore: false })).toBe(
      'dev',
    );
  });
});
