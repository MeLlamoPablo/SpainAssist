import type { KeyStatus } from '@sa/gateway-keys';
import type { Hono } from 'hono';
import { type AppDeps, createApp } from '../src/app';
import { migrate } from '../src/db/migrate';
import { openDb } from '../src/db/open';
import type { Db } from '../src/db/types';
import { type Embedder, EmbeddingError } from '../src/embed/embedder';

/**
 * Fresh in-memory PGlite with all migrations applied; `pgvector: false` for a database without
 * the extension (the embeddings migration then waits).
 */
export async function makeDb(options: { pgvector?: boolean } = {}): Promise<Db> {
  const db = await openDb('pglite://memory', options);
  await migrate(db);
  return db;
}

/** Words the fake embedder takes to mean the same (accents and case don't count). */
const CONCEPTS: Record<string, string> = {
  jubilacion: 'pension',
  retiro: 'pension',
  bebe: 'nacimiento',
  nacido: 'nacimiento',
  hijo: 'nacimiento',
  inscribir: 'registro',
  registrar: 'registro',
  apuntar: 'registro',
};
const FAKE_DIMENSIONS = 256;

/**
 * A deterministic stand-in for the embeddings endpoint: every word of 4+ letters adds to one of
 * 256 axes, words of one concept (CONCEPTS) to the same one, so "apuntar al bebé" is close to
 * "inscribir un nacimiento" though the text search finds no word in common. `calls` records
 * what it was asked to embed; while `down` is true it fails like an unreachable endpoint, and
 * it always fails for texts that contain "UNEMBEDDABLE".
 */
export function fakeEmbedder(space = 'fake@256') {
  const embedder = {
    space,
    calls: [] as string[][],
    down: false,
    async embed(texts: string[]): Promise<number[][]> {
      embedder.calls.push(texts);
      if (embedder.down || texts.some((t) => t.includes('UNEMBEDDABLE')))
        throw new EmbeddingError('The embeddings endpoint answered 503.');
      return texts.map((text) => {
        const vector = new Array<number>(FAKE_DIMENSIONS).fill(0);
        const words = text
          .normalize('NFD')
          .replace(/\p{M}/gu, '')
          .toLowerCase()
          .match(/[a-z]{4,}/g);
        for (const word of words ?? []) {
          let axis = 0;
          for (const char of CONCEPTS[word] ?? word)
            axis = (axis * 31 + char.charCodeAt(0)) % FAKE_DIMENSIONS;
          vector[axis]! += 1;
        }
        // A text without words still needs a direction: pgvector can't compare a zero vector.
        if (!words) vector[0] = 1;
        return vector;
      });
    },
  };
  return embedder satisfies Embedder;
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
