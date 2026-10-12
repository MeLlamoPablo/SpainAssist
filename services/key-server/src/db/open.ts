import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireDirLock } from './lock';
import { openPostgres } from './pg';
import { openPglite } from './pglite';
import type { Db } from './types';

/** Root of the key-server package (relative PGlite paths resolve against it). */
export const SERVICE_DIR = fileURLToPath(new URL('../..', import.meta.url));

export const DEFAULT_DATABASE_URL = 'pglite://.data/key-server';

/**
 * Opens the database named by `url`:
 *  - `postgres://…` / `postgresql://…` → Postgres connection pool;
 *  - `pglite://memory` → throwaway in-memory PGlite (tests);
 *  - `pglite://<dir>` → persistent PGlite in `<dir>` (relative to the service directory unless
 *    absolute, e.g. `pglite:///var/lib/key-server`).
 */
export async function openDatabase(url: string, options: { baseDir?: string } = {}): Promise<Db> {
  if (/^postgres(ql)?:\/\//.test(url)) return openPostgres(url);
  if (url.startsWith('pglite://')) {
    const location = url.slice('pglite://'.length);
    if (location === '' || location === 'memory') return openPglite();
    const dir = isAbsolute(location) ? location : resolve(options.baseDir ?? SERVICE_DIR, location);
    const release = acquireDirLock(dir);
    try {
      return await openPglite(dir, release);
    } catch (err) {
      release();
      throw err;
    }
  }
  throw new Error('Unsupported DATABASE_URL: use postgres://…, pglite://<dir> or pglite://memory');
}

/** True for URLs served by the embedded PGlite (development / tests). */
export function isPgliteUrl(url: string): boolean {
  return url.startsWith('pglite://');
}
