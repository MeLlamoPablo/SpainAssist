import { detectPii } from '@sa/pii';
import { FeedbackSearchResponse } from '@sa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { SEED_FEEDBACK, seedFeedback } from '../src/feedback/seed';
import { makeApp, makeDb } from './helpers';

let db: Db;
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  db = await makeDb();
  await seedFeedback(db);
  app = makeApp(db);
});
afterAll(() => db.close());

async function search(params: Record<string, string>) {
  const res = await app.request(`/v1/feedback/search?${new URLSearchParams(params)}`);
  expect(res.status).toBe(200);
  return FeedbackSearchResponse.parse(await res.json()).results;
}

describe('GET /v1/feedback/search', () => {
  it('finds DNI renewal notes from a few keywords', async () => {
    const results = await search({ q: 'cita previa renovar dni' });
    expect(results[0]!.procedure).toBe('Renovación del DNI');
    expect(results[1]!.procedure).toBe('Renovación del DNI');
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it('ignores accents and case', async () => {
    for (const q of ['renovacion dni', 'RENOVACIÓN DEL DNI', 'renovación del dni']) {
      const titles = (await search({ q })).map((r) => r.procedure);
      expect(titles.slice(0, 2)).toEqual(['Renovación del DNI', 'Renovación del DNI']);
    }
  });

  it('matches word stems', async () => {
    expect((await search({ q: 'empadronarse' }))[0]!.title).toMatch(/[Ee]mpadronamiento/);
    expect((await search({ q: 'desempleo plazos' }))[0]!.procedure).toBe(
      'Prestación por desempleo',
    );
  });

  it('understands everyday words', async () => {
    expect((await search({ q: 'paro' }))[0]!.procedure).toBe('Prestación por desempleo');
    expect((await search({ q: 'clave sms' }))[0]!.procedure).toBe('Acceso con Cl@ve PIN');
  });

  it('tolerates typos (trigram fallback)', async () => {
    expect((await search({ q: 'enpadronamiento madrid' }))[0]!.procedure).toMatch(/mpadronamiento/);
    expect((await search({ q: 'autofirna' }))[0]!.title).toMatch(/AutoFirma/);
  });

  it('sorts by score and respects limit', async () => {
    const results = await search({ q: 'cita previa', limit: '3' });
    expect(results).toHaveLength(3);
    const scores = results.map((r) => r.score!);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('filters by procedure (fuzzy) and kind', async () => {
    const byProcedure = await search({ q: 'cita', procedure: 'renovacion dni' });
    expect(byProcedure.length).toBeGreaterThan(0);
    expect(new Set(byProcedure.map((r) => r.procedure))).toEqual(new Set(['Renovación del DNI']));

    const gotchas = await search({ q: 'dni', kind: 'gotcha' });
    expect(gotchas.map((r) => r.kind)).toEqual(['gotcha']);
  });

  it('returns nothing for unrelated queries', async () => {
    expect(await search({ q: 'astronauta submarino' })).toEqual([]);
  });

  it('validates the query', async () => {
    expect((await app.request('/v1/feedback/search?q=a')).status).toBe(400);
    expect((await app.request('/v1/feedback/search?q=dni&limit=50')).status).toBe(400);
    expect((await app.request('/v1/feedback/search?q=dni&kind=rant')).status).toBe(400);
  });
});

describe('seed data', () => {
  it('is tagged, written by a human and free of personal data', async () => {
    expect(SEED_FEEDBACK.length).toBeGreaterThanOrEqual(12);
    for (const s of SEED_FEEDBACK) {
      for (const text of [s.procedure, s.administration ?? '', s.region ?? '', s.title, s.body]) {
        expect(detectPii(text)).toEqual([]);
      }
    }
    const { rows } = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM feedback WHERE 'seed' = ANY(tags) AND author = 'human'",
    );
    expect(rows[0]!.n).toBe(SEED_FEEDBACK.length);
    expect(await seedFeedback(db)).toBe(0); // idempotent
  });
});
