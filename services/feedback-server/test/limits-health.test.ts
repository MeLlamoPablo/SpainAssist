import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
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
    ]);
  });

  it('answers unknown routes with the API error shape', async () => {
    const res = await makeApp(db).request('/v2/nothing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });
});
