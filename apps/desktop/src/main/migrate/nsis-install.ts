import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 *
 * The key is read with `reg export`, not `reg query`: `reg query` prints in the console's OEM
 * code page (850 on Spanish Windows), so the install dir of a user named José came out garbled
 * and the uninstaller wasn't found. `reg export` writes a .reg file in UTF-16LE whatever the
 * system's language. reg.exe is in every Windows; PowerShell would take a second to start and can
 * be restricted by policy, and neither Node nor Electron reads the registry.
 */

/** HKCU's Uninstall entry of the NSIS install. */
export const NSIS_UNINSTALL_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\000d5f47-0725-5b3b-be10-86838e4bbf42';

/**
 * A string value in a .reg file's text: REG_SZ (`"name"="text"`, with `\\` and `\"` escaped) or
 * REG_EXPAND_SZ (`"name"=hex(2):` and its UTF-16LE bytes, over continued lines), whose
 * %VARIABLES% are expanded from `env`.
 */
function regStringValue(reg: string, name: string, env: NodeJS.ProcessEnv): string | undefined {
  const quotedName = `"${name.replace(/[\\"]/g, '\\$&')}"=`;
  // A hex value continues on the next line after a trailing backslash.
  const line = reg
    .replace(/\\\r?\n[ \t]*/g, '')
    .split(/\r?\n/)
    .find((l) => l.startsWith(quotedName));
  if (!line) return undefined;
  const raw = line.slice(quotedName.length);
  if (raw.startsWith('"')) {
    let value = '';
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i];
      if (c === '"') return value;
      value += c === '\\' ? (raw[++i] ?? '') : c;
    }
    return undefined;
  }
  const hex = /^hex\(2\):([0-9a-f,\s]*)$/i.exec(raw)?.[1];
  if (hex === undefined) return undefined;
  const bytes = Buffer.from(
    hex
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean)
      .map((b) => Number.parseInt(b, 16)),
  );
  return expandEnv(bytes.toString('utf16le').replace(/\0+$/, ''), env);
}

/** Expands %NAME% like Windows does: names ignore case, unknown ones stay as they are. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? match : (env[key] ?? match);
  });
}

/**
 * The uninstaller's path in a `reg export` file of an Uninstall key (UTF-16LE after a byte order
 * mark): its `UninstallString` without the arguments.
 */
export function parseUninstallString(
  exported: Buffer,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reg = exported.toString('utf16le').replace(/^\uFEFF/, '');
  const value = regStringValue(reg, 'UninstallString', env)?.trim();
  if (!value) return undefined;
  const quoted = /^"([^"]+)"/.exec(value);
  return quoted ? quoted[1] : value.split(' /')[0];
}

/** `reg export <key> <file> /y`: false when it fails (exit code 1: no such key). */
function exportRegistryKey(key: string, file: string): Promise<boolean> {
  return new Promise((resolve) =>
    execFile('reg.exe', ['export', key, file, '/y'], { windowsHide: true }, (err) => resolve(!err)),
  );
}

/**
 * The program a registry key's `UninstallString` names (Windows), or undefined when the key or
 * the value doesn't exist. `exportKey` is for tests.
 */
export async function readUninstaller(
  key: string,
  exportKey: (key: string, file: string) => Promise<boolean> = exportRegistryKey,
): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'sa-reg-'));
  try {
    const file = join(dir, 'key.reg');
    if (!(await exportKey(key, file))) return undefined;
    return parseUninstallString(await readFile(file));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The NSIS install's uninstaller, while the app is installed: its Uninstall entry exists and the
 * uninstaller it names is still there (a leftover entry without its files doesn't count).
 */
export async function findNsisUninstaller(): Promise<string | undefined> {
  const uninstaller = await readUninstaller(NSIS_UNINSTALL_KEY);
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
