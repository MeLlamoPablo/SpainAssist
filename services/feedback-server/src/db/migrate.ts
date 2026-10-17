import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SERVICE_DIR } from '../config';
import type { Db } from './types';

const MIGRATIONS_DIR = join(SERVICE_DIR, 'migrations');

/**
 * Applies `migrations/*.sql` in name order, once each, recording them in `schema_migrations`.
 * Each file runs in its own transaction under an advisory lock, so concurrent instances are safe.
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
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (done) applied.push(name);
  }
  return applied;
}
