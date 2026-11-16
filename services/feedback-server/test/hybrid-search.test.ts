import {
  FeedbackAdminSearchResponse,
  FeedbackAdminStats,
  FeedbackSearchResponse,
} from '@sa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { indexPending } from '../src/embed/indexer';
import { createSemantic, fuse } from '../src/feedback/hybrid';
import { insertFeedback, type NewFeedback } from '../src/feedback/repo';
import { fakeEmbedder, makeApp, makeDb } from './helpers';

const TOKEN = 'admin-token';
/** Fits the fake embedder: related texts share at least a third of their direction. */
const MIN_SIMILARITY = 0.3;

let db: Db;
let now = 1_800_000_000_000;
const embedder = fakeEmbedder();
const ids: Record<string, string> = {};

const entry = (overrides: Partial<NewFeedback>): NewFeedback => ({
  procedure: 'Trámite',
  kind: 'tip',
  title: 'Título',
  body: 'Texto.',
  tags: [],
  urls: [],
  triage: 'approved',
  ...overrides,
});

const semantic = () =>
  createSemantic({ db, embedder, minSimilarity: MIN_SIMILARITY, now: () => now });

beforeAll(async () => {
  db = await makeDb();
  ids.pension = await insertFeedback(
    db,
    entry({
      procedure: 'Seguridad Social',
      kind: 'gotcha',
      title: 'Pensión contributiva',
      body: 'Simulador de la pensión.',
    }),
  );
  ids.nacimiento = await insertFeedback(
    db,
    entry({
      procedure: 'Registro Civil',
      title: 'Inscribir un nacimiento',
      body: 'Inscribir el nacimiento.',
    }),
  );
  ids.untriaged = await insertFeedback(
    db,
    entry({
      procedure: 'Registro Civil',
      title: 'Inscribir nacimiento tardío',
      body: 'Nacimiento.',
      triage: 'untriaged',
    }),
  );
  ids.padron = await insertFeedback(
    db,
    entry({
      procedure: 'Empadronamiento',
      title: 'Certificado del padrón',
      body: 'Descarga municipal desde la sede.',
    }),
  );
  await indexPending(db, embedder);
  embedder.calls.length = 0;
});
afterAll(() => db.close());

async function search(app: ReturnType<typeof makeApp>, params: Record<string, string>) {
  const res = await app.request(`/v1/feedback/search?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  return FeedbackSearchResponse.parse(await res.json()).results;
}

async function adminSearch(app: ReturnType<typeof makeApp>, params: Record<string, string>) {
  const res = await app.request(`/admin/feedback/search?${new URLSearchParams(params)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  expect(res.status).toBe(200);
  return FeedbackAdminSearchResponse.parse(await res.json()).results;
}

describe('hybrid search', () => {
  it('finds by meaning what shares no word with the query', async () => {
    const q = 'jubilación retiro';
    expect(await search(makeApp(db), { q })).toEqual([]);
    const results = await search(makeApp(db, { semantic: semantic() }), { q });
    expect(results.map((r) => r.id)).toEqual([ids.pension]);
    expect(results[0]!.score).toBeGreaterThan(0);
    expect(results[0]!.score).toBeLessThanOrEqual(1);
  });

  it('puts first what both searches find', async () => {
    const results = await search(makeApp(db, { semantic: semantic() }), {
      q: 'apuntar bebé certificado',
    });
    // "certificado" is one of the padrón entry's words, but the question is about a birth.
    expect(results.map((r) => r.id)).toEqual([ids.nacimiento]);
    expect((await search(makeApp(db), { q: 'apuntar bebé certificado' })).map((r) => r.id)).toEqual(
      [ids.padron],
    );
    const both = await search(makeApp(db, { semantic: semantic() }), { q: 'inscribir nacimiento' });
    expect(both[0]).toMatchObject({ id: ids.nacimiento, score: 1 });
  });

  it('returns nothing for a question no entry is about', async () => {
    const app = makeApp(db, { semantic: semantic() });
    expect(await search(app, { q: 'receta de paella valenciana' })).toEqual([]);
  });

  it('serves approved entries only, and filters like the text search', async () => {
    const app = makeApp(db, { semantic: semantic(), adminToken: TOKEN });
    const q = 'apuntar bebé';
    expect((await search(app, { q })).map((r) => r.id)).toEqual([ids.nacimiento]);
    expect((await search(app, { q, kind: 'gotcha' })).map((r) => r.id)).toEqual([]);
    expect((await search(app, { q, procedure: 'registro civil' })).map((r) => r.id)).toEqual([
      ids.nacimiento,
    ]);
    expect(await search(app, { q, procedure: 'empadronamiento' })).toEqual([]);
    // The admin page also sees what agents don't get yet, and how each entry matched.
    const candidates = await adminSearch(app, { q });
    expect(new Set(candidates.map((r) => r.id))).toEqual(new Set([ids.nacimiento, ids.untriaged]));
    for (const candidate of candidates) {
      expect(candidate.match?.text).toBeUndefined();
      expect(candidate.match?.similarity).toBeGreaterThanOrEqual(MIN_SIMILARITY);
    }
    const byText = await adminSearch(app, { q: 'certificado padrón' });
    expect(byText[0]).toMatchObject({ id: ids.padron, match: { text: expect.any(Number) } });
    expect(byText[0]!.match!.similarity).toBeGreaterThan(0.5);
  });

  it('reports the model and how many entries are embedded', async () => {
    const app = makeApp(db, { semantic: semantic(), adminToken: TOKEN });
    const res = await app.request('/admin/feedback/stats', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(FeedbackAdminStats.parse(await res.json()).embeddings).toEqual({
      model: 'fake@256',
      minSimilarity: MIN_SIMILARITY,
      ready: true,
      indexed: 4,
    });
    const plain = await makeApp(db, { adminToken: TOKEN }).request('/admin/feedback/stats', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(FeedbackAdminStats.parse(await plain.json()).embeddings).toBeUndefined();
  });

  it('never sends personal data in a query to the embeddings endpoint', async () => {
    embedder.calls.length = 0;
    await search(makeApp(db, { semantic: semantic() }), { q: 'jubilación con DNI 12345678Z' });
    expect(embedder.calls).toHaveLength(1);
    expect(embedder.calls[0]![0]).toContain('jubilación');
    expect(embedder.calls[0]![0]).not.toContain('12345678Z');
  });

  it('answers by text alone while the endpoint is down, and asks again later', async () => {
    const logs: string[] = [];
    const app = makeApp(db, {
      semantic: createSemantic({
        db,
        embedder,
        minSimilarity: MIN_SIMILARITY,
        now: () => now,
        log: (line) => logs.push(line),
      }),
    });
    embedder.down = true;
    embedder.calls.length = 0;
    try {
      expect(await search(app, { q: 'jubilación retiro' })).toEqual([]);
      expect((await search(app, { q: 'pensión contributiva' }))[0]!.id).toBe(ids.pension);
      // One failed request, then none for 30 s: searches must not all wait for a dead endpoint.
      expect(embedder.calls).toHaveLength(1);
      expect(logs).toEqual([
        'search without embeddings for 30 s: The embeddings endpoint answered 503.',
      ]);
      embedder.down = false;
      expect(await search(app, { q: 'jubilación retiro' })).toEqual([]);
      now += 30_001;
      expect((await search(app, { q: 'jubilación retiro' })).map((r) => r.id)).toEqual([
        ids.pension,
      ]);
    } finally {
      embedder.down = false;
    }
  });

  it('ignores embeddings of another model until they are replaced', async () => {
    const other = fakeEmbedder('other@256');
    const app = makeApp(db, {
      semantic: createSemantic({ db, embedder: other, minSimilarity: MIN_SIMILARITY }),
    });
    expect(await search(app, { q: 'jubilación retiro' })).toEqual([]);
    await indexPending(db, other);
    expect((await search(app, { q: 'jubilación retiro' })).map((r) => r.id)).toEqual([ids.pension]);
    await indexPending(db, embedder); // back to the model the other tests use
  });

  it('serves MCP searches too', async () => {
    const app = makeApp(db, { semantic: semantic() });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_feedback', arguments: { query: 'jubilación retiro' } },
      }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const { results } = JSON.parse(body.result.content[0]!.text) as { results: { id: string }[] };
    expect(results.map((r) => r.id)).toEqual([ids.pension]);
  });
});

describe('fuse', () => {
  const text = (id: string, score: number) => ({ id, score });
  const vector = (id: string, similarity: number) => ({ id, similarity });

  it('ranks by the places an entry takes in both lists', () => {
    const fused = fuse<{ id: string }>(
      [text('a', 0.9), text('b', 0.8), text('c', 0.7)],
      [vector('c', 0.9), vector('d', 0.8), vector('a', 0.7), vector('b', 0.1)],
      0.5,
      10,
    );
    // a: 1st + 3rd, c: 3rd + 1st, then b (2nd in one list) before d (2nd in the other, later).
    expect(fused.map((f) => f.id)).toEqual(['a', 'c', 'b', 'd']);
    expect(fused.find((f) => f.id === 'd')!.match).toEqual({ similarity: 0.8 });
    expect(fused.find((f) => f.id === 'b')!.match).toEqual({ text: 0.8, similarity: 0.1 });
    expect(fuse<{ id: string }>([text('a', 0.9)], [vector('a', 0.9)], 0.5, 10)[0]!.score).toBe(1);
  });

  it('counts a vector only from the floor up', () => {
    const fused = fuse<{ id: string }>([], [vector('a', 0.5), vector('b', 0.49)], 0.5, 10);
    expect(fused.map((f) => f.id)).toEqual(['a']);
  });

  it('drops partial text hits that clearly mean something else, never strict ones', () => {
    const fused = fuse<{ id: string }>(
      [text('strict', 0.6), text('partial', 0.59), text('near', 0.3), text('unknown', 0.1)],
      [vector('strict', 0.1), vector('partial', 0.44), vector('near', 0.45)],
      0.5,
      10,
    );
    expect(fused.map((f) => f.id)).toEqual(['strict', 'near', 'unknown']);
  });

  it('keeps the best `limit`', () => {
    expect(
      fuse<{ id: string }>([text('a', 0.9), text('b', 0.8)], [vector('c', 0.9)], 0.5, 2),
    ).toHaveLength(2);
  });
});
