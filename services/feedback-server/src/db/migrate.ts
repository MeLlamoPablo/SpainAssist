import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVICE_DIR } from '../config';
import type { Db } from './types';

const MIGRATIONS_DIR = join(SERVICE_DIR, 'migrations');

/** First line of a migration that needs an extension the database may lack. */
const REQUIRES_EXTENSION = /^-- requires-extension: ([a-z_]+)\s*\n/;

/**
 * Whether the role can use an extension: it is installed, or the role may install it (a
 * superuser, or anyone who owns the database when the extension is trusted).
 */
async function extensionUsable(db: Db, name: string): Promise<boolean> {
  const { rows } = await db.query<{ usable: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = $1)
         OR EXISTS (SELECT 1 FROM pg_available_extension_versions v
                    WHERE v.name = $1
                      AND (v.trusted OR (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)))
       AS usable`,
    [name],
  );
  return rows[0]?.usable === true;
}

/**
 * Applies `migrations/*.sql` in name order, once each, recording them in `schema_migrations`.
 * Each file runs in its own transaction under an advisory lock, so concurrent instances are safe.
 *
 * A file that starts with `-- requires-extension: <name>` is skipped, and not recorded, while
 * the database can't use that extension; a later call applies it. Its feature stays off until then.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(join(dir, name), 'utf8');
    const done = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(7243001)');
      const { rows } = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (rows.length > 0) return false;
      const extension = REQUIRES_EXTENSION.exec(sql)?.[1];
      if (extension && !(await extensionUsable(tx, extension))) return false;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (done) applied.push(name);
  }
  return applied;
}
