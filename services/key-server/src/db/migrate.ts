import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Arbitrary constant: serializes concurrent migrators (several replicas starting at once). */
const MIGRATION_LOCK_ID = 87_870_001;

/**
 * Applies `migrations/NNN_name.sql` files in filename order, each at most once, recording them
 * in `schema_migrations`. Everything runs in one transaction: either all pending migrations are
 * applied or none. Returns the versions applied by this call.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  const scripts = await Promise.all(
    files.map(async (file) => ({
      version: file.replace(/\.sql$/, ''),
      sql: await readFile(join(dir, file), 'utf8'),
    })),
  );

  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    await tx.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await tx.query<{ version: string }>('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r) => r.version));
    const applied: string[] = [];
    for (const { version, sql } of scripts) {
      if (done.has(version)) continue;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      applied.push(version);
    }
    return applied;
  });
}
