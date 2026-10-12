import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import type { Db, Queryable } from './types';

function wrapTransaction(tx: Transaction): Queryable {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await tx.exec(sql);
    },
  };
}

/**
 * Wraps a PGlite instance (embedded Postgres in WASM). PGlite has a single connection and
 * serializes work: queries issued while a transaction is open wait until it finishes.
 */
export function wrapPglite(pg: PGliteInterface, onClose?: () => void): Db {
  return {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pg.query<T>(sql, params);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction((tx) => fn(wrapTransaction(tx)));
    },
    async close() {
      try {
        if (!pg.closed) await pg.close();
      } finally {
        onClose?.();
      }
    },
  };
}

/** Opens an in-memory database, or a persistent one stored in `dataDir`. */
export async function openPglite(dataDir?: string, onClose?: () => void): Promise<Db> {
  const pg = dataDir ? await PGlite.create(dataDir) : await PGlite.create();
  return wrapPglite(pg, onClose);
}
