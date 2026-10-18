import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_DIR } from '../src/config';
import { migrate } from '../src/db/migrate';
import { openDb } from '../src/db/open';
import type { Db } from '../src/db/types';
import { makeApp, makeDb, postJson, submission, truncate } from './helpers';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

describe('rate limits', () => {
  it('limits submissions per client', async () => {
    let now = 1_000_000;
    const app = makeApp(db, { limits: { submitPerHour: 2 }, now: () => now });
    for (let i = 0; i < 2; i++) {
      expect((await postJson(app, '/v1/feedback', submission())).status).toBe(201);
    }
    const blocked = await postJson(app, '/v1/feedback', submission());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await blocked.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // another client is not affected
    const other = await postJson(app, '/v1/feedback', submission(), { 'x-test-ip': '192.0.2.99' });
    expect(other.status).toBe(201);
    // the window resets
    now += 3_600_001;
    expect((await postJson(app, '/v1/feedback', submission())).status).toBe(201);
  });

  it('limits searches per client', async () => {
    const app = makeApp(db, { limits: { searchPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.request('/v1/feedback/search?q=dni')).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('uses X-Forwarded-For only when trusted', async () => {
    const trusted = makeApp(db, {
      clientIp: undefined,
      trustProxy: true,
      limits: { searchPerMinute: 1 },
    });
    const hit = (ip: string) =>
      trusted.request('/v1/feedback/search?q=dni', {
        headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` },
      });
    expect((await hit('192.0.2.10')).status).toBe(200);
    expect((await hit('192.0.2.11')).status).toBe(200);
    expect((await hit('192.0.2.10')).status).toBe(429);
  });
});

describe('health and migrations', () => {
  it('reports ok', async () => {
    const res = await makeApp(db).request('/health');
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('migrations are idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM schema_migrations ORDER BY name',
    );
    expect(rows.map((r) => r.name)).toEqual([
      '001_search_config.sql',
      '002_feedback.sql',
      '004_drop_catalog.sql',
      '005_votes.sql',
      '006_admin_edits.sql',
      '007_author.sql',
      '008_drop_outcome.sql',
      '009_vote_users.sql',
      '010_vote_retention.sql',
      '011_triage.sql',
    ]);
  });

  it('011 approves the entries maintainers had vouched for, and nothing else', async () => {
    const all = join(SERVICE_DIR, 'migrations');
    const dir = await mkdtemp(join(tmpdir(), 'feedback-migrations-'));
    const old = await openDb('pglite://memory');
    try {
      for (const name of await readdir(all)) {
        if (name < '011') await cp(join(all, name), join(dir, name));
      }
      await migrate(old, dir);
      const insert = async (title: string, author: string | null) =>
        (
          await old.query<{ id: string }>(
            `INSERT INTO feedback (procedure, kind, title, body, author)
             VALUES ('Renovación del DNI', 'tip', $1, 'Un texto de prueba.', $2) RETURNING id::text`,
            [title, author],
          )
        ).rows[0]!.id;
      const vote = (id: string, value: 1 | -1, voter: 'agent' | 'human') =>
        old.query('INSERT INTO feedback_votes (feedback_id, value, voter) VALUES ($1, $2, $3)', [
          id,
          value,
          voter,
        ]);
      const human = await insert('Escrito por una persona', 'human');
      const liked = await insert('Útil según un mantenedor', 'gpt-6.1-sol · medium');
      await vote(liked, 1, 'human');
      const mixed = await insert('Opiniones encontradas', 'gpt-6.1-sol · medium');
      await vote(mixed, 1, 'human');
      await vote(mixed, -1, 'human');
      const agentsOnly = await insert('Solo votos de agentes', null);
      await vote(agentsOnly, 1, 'agent');
      const plain = await insert('Sin votos', 'gpt-6.1-sol · medium');

      expect(await migrate(old)).toEqual(['011_triage.sql']);
      const { rows } = await old.query<{ id: string; triage: string; triaged: boolean }>(
        'SELECT id::text, triage, triaged_at IS NOT NULL AS triaged FROM feedback',
      );
      const triage = Object.fromEntries(rows.map((r) => [r.id, [r.triage, r.triaged]]));
      expect(triage).toEqual({
        [human]: ['approved', true],
        [liked]: ['approved', true],
        [mixed]: ['untriaged', false],
        [agentsOnly]: ['untriaged', false],
        [plain]: ['untriaged', false],
      });
    } finally {
      await old.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('answers unknown routes with the API error shape', async () => {
    const res = await makeApp(db).request('/v2/nothing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });
});
