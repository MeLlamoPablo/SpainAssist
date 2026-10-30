import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseUninstallString, readUninstaller } from './nsis-install';

/**
 * What `reg export` writes for the NSIS install's Uninstall key, byte for byte, when the user's
 * folder is `C:\Users\José Muñoz`: UTF-16LE after a byte order mark, CRLF line ends, the values
 * electron-builder's installer sets, in its order.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'nsis-uninstall-key.reg');
const UNINSTALLER =
  'C:\\Users\\José Muñoz\\AppData\\Local\\Programs\\spain-assist\\Uninstall Spain Assist.exe';

/** A .reg file's bytes, as `reg export` writes them. */
function regFile(...values: string[]): Buffer {
  const text = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\x]',
    ...values,
    '',
    '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

/** A REG_EXPAND_SZ value as `reg export` writes it: hex(2) bytes, lines continued at 80. */
function expandSz(name: string, value: string): string {
  const bytes = [...Buffer.from(`${value}\0`, 'utf16le')].map((b) =>
    b.toString(16).padStart(2, '0'),
  );
  let out = `"${name}"=hex(2):`;
  let line = out.length;
  bytes.forEach((byte, i) => {
    const piece = i < bytes.length - 1 ? `${byte},` : byte;
    if (line + piece.length > 77) {
      out += '\\\r\n  ';
      line = 2;
    }
    out += piece;
    line += piece.length;
  });
  return out;
}

describe('parseUninstallString', () => {
  it("reads an accented install dir from reg export's UTF-16LE file", async () => {
    expect(parseUninstallString(await readFile(FIXTURE))).toBe(UNINSTALLER);
  });

  it('expands the variables of a REG_EXPAND_SZ value', () => {
    const value = expandSz(
      'UninstallString',
      '"%LOCALAPPDATA%\\Programs\\spain-assist\\Uninstall Spain Assist.exe" /currentuser',
    );
    expect(value).toContain('\\\r\n  ');
    const env = { LocalAppData: 'C:\\Users\\José Muñoz\\AppData\\Local' };
    expect(parseUninstallString(regFile(value), env)).toBe(UNINSTALLER);
  });

  it('takes an unquoted path up to its arguments', () => {
    expect(
      parseUninstallString(regFile('"UninstallString"="C:\\\\SA\\\\Uninstall.exe /currentuser"')),
    ).toBe('C:\\SA\\Uninstall.exe');
  });

  it('finds nothing without the value', () => {
    expect(parseUninstallString(Buffer.alloc(0))).toBeUndefined();
    expect(parseUninstallString(regFile('"DisplayName"="Spain Assist 0.2.1"'))).toBeUndefined();
    expect(parseUninstallString(regFile('"UninstallString"=dword:00000001'))).toBeUndefined();
    expect(
      parseUninstallString(regFile('"QuietUninstallString"="C:\\\\SA\\\\Uninstall.exe /S"')),
    ).toBeUndefined();
  });
});

describe('readUninstaller', () => {
  it('reads the exported key and removes the export', async () => {
    let exported = '';
    const uninstaller = await readUninstaller('HKCU\\x', async (_, file) => {
      exported = file;
      await copyFile(FIXTURE, file);
      return true;
    });
    expect(uninstaller).toBe(UNINSTALLER);
    expect(exported).not.toBe('');
    expect(existsSync(dirname(exported))).toBe(false);
  });

  it('finds nothing when the key does not exist (not installed)', async () => {
    expect(await readUninstaller('HKCU\\x', async () => false)).toBeUndefined();
  });

  // reg.exe itself, on a key of its own under HKCU: REG_SZ and REG_EXPAND_SZ, with accents.
  it.runIf(process.platform === 'win32')('reads what reg.exe exports on this Windows', async () => {
    const run = promisify(execFile);
    const key = `HKCU\\Software\\SpainAssist-test-${randomUUID()}`;
    const setUninstallString = (type: string, data: string) =>
      run('reg.exe', ['add', key, '/v', 'UninstallString', '/t', type, '/d', data, '/f']);
    try {
      await setUninstallString('REG_SZ', `"${UNINSTALLER}" /currentuser`);
      expect(await readUninstaller(key)).toBe(UNINSTALLER);
      process.env.SA_TEST_PROGRAMS = 'C:\\Users\\José Muñoz\\AppData\\Local\\Programs';
      await setUninstallString(
        'REG_EXPAND_SZ',
        '%SA_TEST_PROGRAMS%\\spain-assist\\Uninstall Spain Assist.exe /currentuser',
      );
      expect(await readUninstaller(key)).toBe(UNINSTALLER);
    } finally {
      delete process.env.SA_TEST_PROGRAMS;
      await run('reg.exe', ['delete', key, '/f']).catch(() => {});
    }
    expect(await readUninstaller(key)).toBeUndefined();
  });
});
