import { describe, expect, it } from 'vitest';
import { NSIS_UNINSTALL_KEY, parseUninstallString } from './nsis-install';

const UNINSTALLER =
  'C:\\Users\\Ana\\AppData\\Local\\Programs\\spain-assist\\Uninstall Spain Assist.exe';

describe('parseUninstallString', () => {
  it('reads the uninstaller from reg query output', () => {
    const output = [
      '',
      NSIS_UNINSTALL_KEY.replace('HKCU', 'HKEY_CURRENT_USER'),
      `    UninstallString    REG_SZ    "${UNINSTALLER}" /currentuser`,
      '',
    ].join('\r\n');
    expect(parseUninstallString(output)).toBe(UNINSTALLER);
  });

  it('takes an unquoted path up to its arguments', () => {
    expect(
      parseUninstallString(
        '    UninstallString    REG_EXPAND_SZ    C:\\SA\\Uninstall.exe /currentuser',
      ),
    ).toBe('C:\\SA\\Uninstall.exe');
  });

  it('finds nothing without the value', () => {
    expect(parseUninstallString('')).toBeUndefined();
    expect(parseUninstallString('    DisplayName    REG_SZ    Spain Assist 0.2.1')).toBeUndefined();
  });
});
