import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, parse, resolve } from 'node:path';

/**
 * Make sure the session file and its directory are private (0600 / 0700) before pi touches
 * them: session files hold the whole transcript, including personal data and screenshots.
 * A missing file is created empty; pi then writes a fresh session header into it.
 */
export function prepareSessionFile(sessionFile: string): string {
  const file = resolve(sessionFile);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!isSharedDirectory(dir)) chmodPrivate(dir, 0o700);
  if (!existsSync(file)) {
    closeSync(openSync(file, 'a', 0o600));
  }
  chmodPrivate(file, 0o600);
  return file;
}

/** Never tighten directories other programs rely on (home, temp, filesystem root). */
function isSharedDirectory(dir: string): boolean {
  const real = safeRealpath(dir);
  return [homedir(), tmpdir(), parse(real).root].some((shared) => safeRealpath(shared) === real);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function chmodPrivate(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, mode);
  } catch {
    // Not fatal (e.g. a directory we don't own); the process umask still protects new files.
  }
}
