import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Db } from './types';

/**
 * Opens a database from a URL:
 * - `postgres://…` / `postgresql://…` → node-postgres pool
 * - `pglite://memory` → in-memory PGlite (tests)
 * - `pglite://<dir>` → PGlite persisted in <dir> (dev; resolve relative dirs first, see config)
 */
export async function openDb(url: string): Promise<Db> {
  if (/^postgres(?:ql)?:\/\//.test(url)) return openPg(url);
  if (url.startsWith('pglite://')) {
    const target = url.slice('pglite://'.length);
    return openPglite(target === '' || target === 'memory' ? undefined : target);
  }
  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite://');
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const [{ PGlite }, { unaccent }, { pg_trgm }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/unaccent'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
  ]);
  const unlock = dataDir ? await lockDataDir(dataDir) : async () => {};
  const pg = await PGlite.create({ dataDir, extensions: { unaccent, pg_trgm } }).catch(
    async (err: unknown) => {
      await unlock();
      throw err;
    },
  );
  type Tx = Pick<typeof pg, 'query' | 'exec'>;
  const wrap = (conn: Tx): Omit<Db, 'transaction' | 'close'> => ({
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await conn.query<T>(sql, params);
      return { rows: res.rows };
    },
    async exec(sql: string) {
      await conn.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    // PGlite has a single connection: nested transactions run inline.
    transaction: (fn) =>
      pg.transaction((tx) =>
        fn({ ...wrap(tx), transaction: (inner) => inner(db), close: db.close }),
      ),
    close: async () => {
      await pg.close();
      await unlock();
    },
  };
  return db;
}

/**
 * PGlite is single-process: a second process opening the same directory (e.g. a one-off
 * script while the server runs) could corrupt it. A `<dir>.lock` file with our PID prevents that;
 * stale locks (dead PIDs) are ignored.
 */
async function lockDataDir(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const lockFile = `${dataDir.replace(/[/\\]+$/, '')}.lock`;
  const holder = Number.parseInt(await readFile(lockFile, 'utf8').catch(() => ''), 10);
  if (holder && holder !== process.pid && isAlive(holder)) {
    throw new Error(
      `The PGlite database ${dataDir} is in use by process ${holder} (stop it first: PGlite ` +
        'allows one process at a time).',
    );
  }
  await writeFile(lockFile, String(process.pid));
  return () => rm(lockFile, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function openPg(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on('error', (err) => process.stderr.write(`postgres pool error: ${err.message}\n`));
  type Conn = Pick<InstanceType<typeof pg.Pool>, 'query'>;
  const wrap = (conn: Conn): Omit<Db, 'transaction' | 'close'> => ({
    kind: 'pg',
    async query<T>(sql: string, params?: unknown[]) {
      const res = await conn.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
  });
  const db: Db = {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const txDb: Db = { ...wrap(client), transaction: (inner) => inner(txDb), close: db.close };
        const result = await fn(txDb);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}
