import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import type { Db } from '../src/db/types';
import { embeddingsReady, indexPending, scheduleIndexer } from '../src/embed/indexer';
import { createSemantic } from '../src/feedback/hybrid';
import { insertFeedback, type NewFeedback } from '../src/feedback/repo';
import { fakeEmbedder, makeApp, makeDb, postJson, submission, truncate } from './helpers';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

const entry = (overrides: Partial<NewFeedback> = {}): NewFeedback => ({
  procedure: 'Renovación del DNI',
  kind: 'tip',
  title: 'Los huecos de cita previa salen por tandas',
  body: 'Vuelve a mirar a primera hora de la mañana.',
  tags: ['dni'],
  urls: [],
  ...overrides,
});

const embeddings = async () =>
  (
    await db.query<{ id: string; model: string }>(
      'SELECT feedback_id::text AS id, model FROM feedback_embeddings ORDER BY embedded_at',
    )
  ).rows;

describe('indexPending', () => {
  it('embeds every entry once, whatever its triage, with all its searchable text', async () => {
    const embedder = fakeEmbedder();
    const approved = await insertFeedback(
      db,
      entry({ triage: 'approved', administration: 'Policía Nacional', region: 'Madrid' }),
    );
    const untriaged = await insertFeedback(db, entry({ title: 'Otra nota sin revisar' }));
    expect(await indexPending(db, embedder)).toEqual({ embedded: 2, failed: 0 });
    // Approved entries first: they are the ones agents get.
    expect((await embeddings()).map((e) => e.id)).toEqual([approved, untriaged]);
    expect(embedder.calls[0]![0]).toBe(
      'Renovación del DNI · Policía Nacional · Madrid\n' +
        'Los huecos de cita previa salen por tandas\n' +
        'Vuelve a mirar a primera hora de la mañana.\ndni',
    );
    expect(await indexPending(db, embedder)).toEqual({ embedded: 0, failed: 0 });
    expect(embedder.calls).toHaveLength(1);
  });

  it('embeds an entry again when its text changes, and all of them for another model', async () => {
    const embedder = fakeEmbedder();
    const id = await insertFeedback(db, entry());
    await insertFeedback(db, entry({ title: 'Otra nota distinta' }));
    await indexPending(db, embedder);

    await db.query("UPDATE feedback SET urls = '{https://example.org/}' WHERE id = $1", [id]);
    expect((await indexPending(db, embedder)).embedded).toBe(0); // URLs are not embedded
    await db.query("UPDATE feedback SET body = 'Mejor por la tarde.' WHERE id = $1", [id]);
    expect(await indexPending(db, embedder)).toEqual({ embedded: 1, failed: 0 });
    expect(embedder.calls.at(-1)).toEqual([expect.stringContaining('Mejor por la tarde.')]);

    expect(await indexPending(db, fakeEmbedder('other@256'))).toEqual({ embedded: 2, failed: 0 });
    expect(new Set((await embeddings()).map((e) => e.model))).toEqual(new Set(['other@256']));
  });

  it('embeds long entries in several requests and cuts very long text', async () => {
    const embedder = fakeEmbedder();
    for (let i = 0; i < 20; i++)
      await insertFeedback(db, entry({ title: `Nota número ${i}`, body: 'palabra '.repeat(1500) }));
    expect(await indexPending(db, embedder)).toEqual({ embedded: 20, failed: 0 });
    expect(embedder.calls.map((texts) => texts.length)).toEqual([16, 4]);
    expect(Math.max(...embedder.calls.flat().map((text) => text.length))).toBe(6000);
  });

  it('skips an entry the endpoint refuses and embeds the rest', async () => {
    const embedder = fakeEmbedder();
    await insertFeedback(db, entry({ title: 'Una nota UNEMBEDDABLE de verdad' }));
    await insertFeedback(db, entry({ title: 'Una nota normal' }));
    await insertFeedback(db, entry({ title: 'Otra nota normal' }));
    expect(await indexPending(db, embedder)).toEqual({ embedded: 2, failed: 1 });
    expect(await embeddings()).toHaveLength(2);
  });

  it('gives up for now when the endpoint is down, and catches up later', async () => {
    const embedder = fakeEmbedder();
    for (let i = 0; i < 40; i++) await insertFeedback(db, entry({ title: `Nota número ${i}` }));
    embedder.down = true;
    expect(await indexPending(db, embedder)).toEqual({ embedded: 0, failed: 16 });
    // The batch, then two entries on their own: not one request per entry.
    expect(embedder.calls).toHaveLength(3);
    embedder.down = false;
    expect(await indexPending(db, embedder)).toEqual({ embedded: 40, failed: 0 });
  });

  it('drops the embedding with its entry', async () => {
    const id = await insertFeedback(db, entry());
    await indexPending(db, fakeEmbedder());
    await db.query('DELETE FROM feedback WHERE id = $1', [id]);
    expect(await embeddings()).toEqual([]);
  });
});

describe('scheduleIndexer', () => {
  it('embeds what is pending at start and after every write', async () => {
    const embedder = fakeEmbedder();
    const logs: string[] = [];
    await insertFeedback(db, entry());
    const indexer = scheduleIndexer(db, embedder, (line) => logs.push(line));
    try {
      await indexer.idle();
      expect(await embeddings()).toHaveLength(1);

      const app = makeApp(db, { indexer, adminToken: 'admin' });
      const res = await postJson(app, '/v1/feedback', submission());
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as { id: string };
      await indexer.idle();
      expect((await embeddings()).map((e) => e.id)).toContain(id);

      // An edit replaces the embedding.
      const edited = await app.request(`/admin/feedback/${id}`, {
        method: 'PUT',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({
          ...submission(),
          author: undefined,
          body: 'Un texto nuevo del todo.',
        }),
      });
      expect(edited.status).toBe(200);
      await indexer.idle();
      expect(embedder.calls.at(-1)).toEqual([expect.stringContaining('Un texto nuevo del todo.')]);
      expect(logs).toEqual(['embedded 1 entry', 'embedded 1 entry', 'embedded 1 entry']);
    } finally {
      indexer.stop();
    }
  });

  it('logs failures without the text and stops when told', async () => {
    const embedder = fakeEmbedder();
    const logs: string[] = [];
    embedder.down = true;
    await insertFeedback(db, entry());
    const indexer = scheduleIndexer(db, embedder, (line) => logs.push(line));
    await indexer.idle();
    expect(logs).toEqual(['embedding failed for 1 entry']);
    indexer.stop();
    embedder.down = false;
    indexer.kick();
    await indexer.idle();
    expect(await embeddings()).toEqual([]);
  });
});

describe('a database without pgvector', () => {
  it('leaves the embeddings migration for later and searches by text', async () => {
    const plain = await makeDb({ pgvector: false });
    try {
      const applied = await plain.query<{ name: string }>('SELECT name FROM schema_migrations');
      expect(applied.rows.map((r) => r.name)).not.toContain('012_embeddings.sql');
      expect(applied.rows.length).toBeGreaterThan(5);
      expect(await embeddingsReady(plain)).toBe(false);
      expect(await migrate(plain)).toEqual([]); // still nothing to apply

      const embedder = fakeEmbedder();
      const logs: string[] = [];
      const indexer = scheduleIndexer(plain, embedder, (line) => logs.push(line));
      const semantic = createSemantic({ db: plain, embedder, minSimilarity: 0.3 });
      try {
        await insertFeedback(plain, entry({ triage: 'approved' }));
        indexer.kick();
        await indexer.idle();
        expect(logs).toEqual(['hybrid search is waiting: the database has no pgvector extension']);

        const app = makeApp(plain, { semantic, indexer, adminToken: 'admin' });
        const res = await app.request('/v1/feedback/search?q=huecos+cita+previa');
        expect(res.status).toBe(200);
        expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
        const stats = await app.request('/admin/feedback/stats', {
          headers: { authorization: 'Bearer admin' },
        });
        expect(((await stats.json()) as { embeddings: unknown }).embeddings).toEqual({
          model: 'fake@256',
          minSimilarity: 0.3,
          ready: false,
          indexed: 0,
        });
        expect(embedder.calls).toEqual([]);
      } finally {
        indexer.stop();
      }
    } finally {
      await plain.close();
    }
  });

  it('applies the migration at once when the extension is there', async () => {
    expect(await embeddingsReady(db)).toBe(true);
    const applied = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(applied.rows.map((r) => r.name)).toContain('012_embeddings.sql');
  });
});
