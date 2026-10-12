/** Minimal database interface shared by node-postgres and PGlite. Raw SQL with $1… params. */
export interface Db {
  readonly kind: 'pg' | 'pglite';
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs one or more statements without parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Runs `fn` in a transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
