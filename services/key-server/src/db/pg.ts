import pg from 'pg';
import type { Db, Queryable } from './types';

/** Postgres via a `pg` connection pool. Transactions run on a dedicated pooled client. */
export function openPostgres(connectionString: string, options: { max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // Errors on idle clients (e.g. the server restarted) must not crash the process; the pool
  // discards the client and the next query reconnects.
  pool.on('error', (err) => {
    console.error(
      JSON.stringify({ level: 'error', msg: 'postgres idle client error', error: err.message }),
    );
  });

  return {
    kind: 'pg',
    async query<T>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params as unknown[] | undefined);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      // No parameters: simple query protocol, so multi-statement scripts work.
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const tx: Queryable = {
        async query<R>(sql: string, params?: unknown[]) {
          const result = await client.query(sql, params as unknown[] | undefined);
          return { rows: result.rows as R[] };
        },
        async exec(sql: string) {
          await client.query(sql);
        },
      };
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // the connection is unusable: destroy it instead of returning it
        }
        throw err;
      } finally {
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
