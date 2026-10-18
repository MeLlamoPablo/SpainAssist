import type { KeyStatus } from '@sa/gateway-keys';
import type { Hono } from 'hono';
import { type AppDeps, createApp } from '../src/app';
import { migrate } from '../src/db/migrate';
import { openDb } from '../src/db/open';
import type { Db } from '../src/db/types';

/** Fresh in-memory PGlite with all migrations applied. */
export async function makeDb(): Promise<Db> {
  const db = await openDb('pglite://memory');
  await migrate(db);
  return db;
}

/** The gateway key `postJson` sends unless told otherwise. */
export const USER_KEY = 'sk-test-user-key-1';

/** A fake LiteLLM key check: `sk-test-…` keys are fine, `sk-broke-…` keys have no credit. */
async function fakeCheckKey(key: string): Promise<KeyStatus> {
  if (key.startsWith('sk-test-')) return 'ok';
  return key.startsWith('sk-broke-') ? 'no_credit' : 'invalid';
}

/** The user id secret of `makeApp`. */
export const ID_SECRET = 'test-user-id-secret-0123456789abcdef';

/**
 * App whose client address comes from the `x-test-ip` header (default 203.0.113.1), with a fake
 * gateway key check. Serving draws are 0, so every entry with a chance above 0 is served.
 */
export function makeApp(db: Db, overrides: Partial<AppDeps> = {}): Hono {
  return createApp({
    db,
    users: { checkKey: fakeCheckKey, idSecret: ID_SECRET },
    clientIp: (c) => c.req.header('x-test-ip') ?? '203.0.113.1',
    random: () => 0,
    ...overrides,
  });
}

export function postJson(
  app: Hono,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${USER_KEY}`,
        ...headers,
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

/** The author the app sends for its procedure agents. */
export const AUTHOR = 'gpt-6.1-sol · medium';

export const submission = (overrides: Record<string, unknown> = {}) => ({
  procedure: 'Renovación del DNI',
  administration: 'Policía Nacional',
  kind: 'tip',
  title: 'Los huecos de cita previa salen por tandas',
  body: 'Si no ves huecos para renovar, vuelve a mirar a primera hora de la mañana.',
  tags: ['dni', 'cita previa'],
  urls: ['https://www.citapreviadnie.es/'],
  author: AUTHOR,
  ...overrides,
});

/** Approves an entry (as a maintainer triaging it), so agents get it and can vote on it. */
export async function approve(db: Db, id: string): Promise<string> {
  await db.query("UPDATE feedback SET triage = 'approved', triaged_at = now() WHERE id = $1", [id]);
  return id;
}

export async function truncate(db: Db): Promise<void> {
  await db.exec('TRUNCATE feedback CASCADE;');
}
