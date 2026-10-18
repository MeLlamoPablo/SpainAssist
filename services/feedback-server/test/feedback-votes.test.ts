import { userId } from '@sa/gateway-keys';
import { FeedbackSearchResponse, FeedbackSubmitResponse, FeedbackVoteResponse } from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { addVote } from '../src/feedback/repo';
import {
  type CastVote,
  DEFAULT_VOTE_POLICY,
  decayFactor,
  serveChance,
  voteWeight,
} from '../src/feedback/votes';
import { approve, ID_SECRET, makeApp, makeDb, postJson, submission, truncate } from './helpers';

const policy = DEFAULT_VOTE_POLICY; // threshold 5, decay from day 90 to day 365
const DAY = 86_400_000;
const AUTH = { authorization: 'Bearer s3cret-token' };

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

async function create(app: ReturnType<typeof makeApp>, overrides: Record<string, unknown> = {}) {
  const res = await postJson(app, '/v1/feedback', submission(overrides));
  return approve(db, FeedbackSubmitResponse.parse(await res.json()).id);
}

async function search(app: ReturnType<typeof makeApp>, q = 'cita previa', limit = 8) {
  const res = await app.request(
    `/v1/feedback/search?${new URLSearchParams({ q, limit: `${limit}` })}`,
  );
  expect(res.status).toBe(200);
  return FeedbackSearchResponse.parse(await res.json()).results;
}

const vote = (
  app: ReturnType<typeof makeApp>,
  id: string,
  body: unknown,
  headers: Record<string, string> = {},
) => postJson(app, `/v1/feedback/${encodeURIComponent(id)}/vote`, body, headers);

describe('vote maths', () => {
  it('keeps full value until the decay starts, then loses it linearly', () => {
    expect(decayFactor(0, policy)).toBe(1);
    expect(decayFactor(90, policy)).toBe(1);
    expect(decayFactor(227.5, policy)).toBeCloseTo(0.5);
    expect(decayFactor(365, policy)).toBe(0);
    expect(decayFactor(1000, policy)).toBe(0);
  });

  it('weighs a human vote as the threshold', () => {
    const now = Date.UTC(2026, 9, 10);
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
    const votes: CastVote[] = [
      { value: 1, voter: 'agent', createdAt: at(1) },
      { value: 1, voter: 'agent', createdAt: at(227.5) }, // half
      { value: -1, voter: 'human', createdAt: at(10) },
      { value: 1, voter: 'agent', createdAt: at(400) }, // expired
    ];
    expect(voteWeight(votes, now, policy)).toBeCloseTo(1 + 0.5 - 5);
  });

  it('serves 50% at zero, 100% at +threshold and 0% at -threshold', () => {
    expect(serveChance(0, policy)).toBe(0.5);
    expect(serveChance(2.5, policy)).toBe(0.75);
    expect(serveChance(5, policy)).toBe(1);
    expect(serveChance(9, policy)).toBe(1);
    expect(serveChance(-2.5, policy)).toBe(0.25);
    expect(serveChance(-5, policy)).toBe(0);
    expect(serveChance(1, { ...policy, threshold: 2 })).toBe(0.75);
  });
});

describe('POST /v1/feedback/:id/vote', () => {
  it('keeps one vote per user and entry, from any address and across restarts', async () => {
    const app = makeApp(db);
    const id = await create(app);
    const counted = async (body: unknown, key: string, ip = '192.0.2.1', on = app) => {
      const res = await vote(on, id, body, { authorization: `Bearer ${key}`, 'x-test-ip': ip });
      expect(res.status).toBe(200);
      return FeedbackVoteResponse.parse(await res.json()).counted;
    };
    expect(await counted({ vote: 'up' }, 'sk-test-alice')).toBe(true);
    expect(await counted({ vote: 'up' }, 'sk-test-alice', '192.0.2.77')).toBe(false);
    expect(await counted({ vote: 'up' }, 'sk-test-bob')).toBe(true);
    expect((await search(app))[0]!.votes).toBe(2);
    // A restarted server still knows who voted.
    const restarted = makeApp(db);
    expect(await counted({ vote: 'up' }, 'sk-test-alice', '192.0.2.1', restarted)).toBe(false);
    // Changing one's mind replaces the earlier vote.
    expect(await counted({ vote: 'down' }, 'sk-test-alice', '192.0.2.1', restarted)).toBe(true);
    expect((await search(app))[0]!.votes).toBe(0);
    const { rows } = await db.query<{ user_id: string }>(
      'SELECT user_id FROM feedback_votes WHERE feedback_id = $1::uuid',
      [id],
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.user_id)).toContain(userId('sk-test-alice', ID_SECRET));
  });

  it('needs a gateway key with credit', async () => {
    const app = makeApp(db);
    const id = await create(app);
    expect((await vote(app, id, { vote: 'up' }, { authorization: '' })).status).toBe(401);
    expect(
      (await vote(app, id, { vote: 'up' }, { authorization: 'Bearer sk-forged-key' })).status,
    ).toBe(401);
    expect(
      (await vote(app, id, { vote: 'up' }, { authorization: 'Bearer sk-broke-key' })).status,
    ).toBe(403);
    expect((await search(app))[0]!.votes).toBe(0);
  });

  it('rejects bad bodies and unknown or malformed ids', async () => {
    const app = makeApp(db);
    const id = await create(app);
    expect((await vote(app, id, { vote: 'maybe' })).status).toBe(400);
    expect((await vote(app, id, 'not json')).status).toBe(400);
    for (const bad of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', "1' OR '1'='1"]) {
      expect((await vote(app, bad, { vote: 'up' })).status).toBe(404);
    }
  });

  it('limits votes per address per hour and per key per day', async () => {
    const perIp = makeApp(db, { limits: { votePerHour: 1 } });
    const id = await create(perIp);
    expect((await vote(perIp, id, { vote: 'up' })).status).toBe(200);
    expect((await vote(perIp, id, { vote: 'up' })).status).toBe(429);

    const perKey = makeApp(db, { limits: { votePerKeyPerDay: 2 } });
    for (let i = 0; i < 2; i++) {
      const res = await vote(perKey, id, { vote: 'up' }, { 'x-test-ip': `192.0.2.${i}` });
      expect(res.status).toBe(200);
    }
    const over = await vote(perKey, id, { vote: 'up' }, { 'x-test-ip': '192.0.2.9' });
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
    const other = await vote(perKey, id, { vote: 'up' }, { authorization: 'Bearer sk-test-other' });
    expect(other.status).toBe(200);
  });
});

describe('POST /admin/feedback/:id/vote (human votes)', () => {
  it('needs the admin token and weighs the threshold, every time', async () => {
    const app = makeApp(db, { adminToken: 's3cret-token' });
    const id = await create(app);
    const human = (body: unknown, headers: Record<string, string> = AUTH) =>
      postJson(app, `/admin/feedback/${id}/vote`, body, headers);
    expect((await human({ vote: 'up' }, {})).status).toBe(401);
    expect(await (await human({ vote: 'up' })).json()).toEqual({ id, counted: true });
    expect(await (await human({ vote: 'up' })).json()).toEqual({ id, counted: true });
    const list = await app.request('/admin/feedback', { headers: AUTH });
    expect(((await list.json()) as { results: { votes: number }[] }).results[0]!.votes).toBe(10);
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      (await postJson(app, `/admin/feedback/${unknown}/vote`, { vote: 'up' }, AUTH)).status,
    ).toBe(404);
  });
});

describe('serving by votes', () => {
  it('serves entries with the chance their votes give them', async () => {
    const draw = { value: 0.6 };
    const app = makeApp(db, { adminToken: 's3cret-token', random: () => draw.value });
    const id = await create(app);
    expect(await search(app)).toHaveLength(0); // chance 0.5 < draw 0.6
    await vote(app, id, { vote: 'up' }, { authorization: 'Bearer sk-test-voter-a' }); // 0.6: still not
    expect(await search(app)).toHaveLength(0);
    await vote(app, id, { vote: 'up' }, { authorization: 'Bearer sk-test-voter-b' }); // 0.7
    expect((await search(app)).map((r) => r.id)).toEqual([id]);

    await postJson(app, `/admin/feedback/${id}/vote`, { vote: 'down' }, AUTH); // 2 - 5 = -3
    draw.value = 0.19; // chance 0.2
    expect(await search(app)).toHaveLength(1);
    draw.value = 0.2;
    expect(await search(app)).toHaveLength(0);
  });

  it('never serves an entry at -threshold and fills the limit with the next hits', async () => {
    const app = makeApp(db);
    const best = await create(app, { title: 'Cita previa: cita previa por la mañana' });
    const next = await create(app, { title: 'Cita previa en otra oficina' });
    expect((await search(app, 'cita previa', 1)).map((r) => r.id)).toEqual([best]);
    await addVote(db, best, -1, 'human');
    expect((await search(app, 'cita previa', 1)).map((r) => r.id)).toEqual([next]);
  });

  it('stops counting votes once they expire', async () => {
    const app = makeApp(db, { random: () => 0.99 });
    const id = await create(app);
    await addVote(db, id, 1, 'human', new Date(Date.now() - 400 * DAY));
    expect(await search(app)).toHaveLength(0); // back to 50%
    await addVote(db, id, 1, 'human', new Date(Date.now() - 30 * DAY));
    expect((await search(app))[0]!.votes).toBe(5);
  });

  it('uses the configured threshold', async () => {
    const app = makeApp(db, { random: () => 0.99, votes: { ...policy, threshold: 1 } });
    const id = await create(app);
    await vote(app, id, { vote: 'up' });
    expect((await search(app)).map((r) => r.id)).toEqual([id]);
  });
});
