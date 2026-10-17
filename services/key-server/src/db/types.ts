/**
 * Minimal database abstraction shared by the Postgres (`pg`) and PGlite adapters.
 * All SQL is plain Postgres; columns whose JS type differs between drivers (numeric, int8) are
 * cast explicitly in queries (`::float8`, `::int`).
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs one or more statements without parameters (used by migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Runs `fn` inside a transaction: committed if it resolves, rolled back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
