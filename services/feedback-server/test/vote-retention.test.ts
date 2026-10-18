import { userId } from '@sa/gateway-keys';
import { FeedbackSubmitResponse, FeedbackVoteResponse } from '@sa/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { addVote } from '../src/feedback/repo';
import { purgeExpiredVotes, voteExpiry } from '../src/feedback/retention';
import { DEFAULT_VOTE_POLICY, decayFactor } from '../src/feedback/votes';
import { ID_SECRET, makeApp, makeDb, postJson, submission, truncate, USER_KEY } from './helpers';

const policy = DEFAULT_VOTE_POLICY; // decay from day 90 to day 365
const DAY = 86_400_000;
const NOW = Date.parse('2026-10-18T12:00:00Z');

let db: Db;
beforeAll(async () => {
  db = await makeDb();
});
afterAll(() => db.close());
beforeEach(() => truncate(db));

async function create(app: ReturnType<typeof makeApp>) {
  const res = await postJson(app, '/v1/feedback', submission());
  return FeedbackSubmitResponse.parse(await res.json()).id;
}

async function vote(app: ReturnType<typeof makeApp>, id: string, v: 'up' | 'down', key = USER_KEY) {
  const res = await postJson(
    app,
    `/v1/feedback/${id}/vote`,
    { vote: v },
    {
      authorization: `Bearer ${key}`,
    },
  );
  expect(res.status).toBe(200);
  return FeedbackVoteResponse.parse(await res.json()).counted;
}

/** Sets every vote of `user` (or the human votes, for null) to have been cast at `at`. */
async function castAt(user: string | null, at: Date) {
  await db.query(
    'UPDATE feedback_votes SET created_at = $2::timestamptz WHERE user_id IS NOT DISTINCT FROM $1',
    [user, at.toISOString()],
  );
}

async function votes() {
  const { rows } = await db.query<{ voter: string; user_id: string | null; created_at: Date }>(
    'SELECT voter, user_id, created_at FROM feedback_votes ORDER BY id',
  );
  return rows;
}

describe('vote retention', () => {
  it('deletes votes that stopped counting, user id included, and keeps the others', async () => {
    const app = makeApp(db);
    const id = await create(app);
    const [old, recent] = ['sk-test-old', 'sk-test-recent'];
    await vote(app, id, 'up', old);
    await vote(app, id, 'down', recent);
    await castAt(userId(old, ID_SECRET), new Date(NOW - 400 * DAY));
    await castAt(userId(recent, ID_SECRET), new Date(NOW - 300 * DAY)); // fading, still counts
    await addVote(db, id, 1, 'human', new Date(NOW - 366 * DAY));
    await addVote(db, id, -1, 'human', new Date(NOW - 10 * DAY));

    expect(await purgeExpiredVotes(db, policy, NOW)).toBe(2);
    const left = await votes();
    expect(left.map((v) => [v.voter, v.user_id])).toEqual([
      ['agent', userId(recent, ID_SECRET)],
      ['human', null],
    ]);
    const { rows } = await db.query('SELECT 1 FROM feedback_votes WHERE user_id = $1', [
      userId(old, ID_SECRET),
    ]);
    expect(rows).toEqual([]);
    expect(await purgeExpiredVotes(db, policy, NOW)).toBe(0);
  });

  it('deletes a vote exactly at the end of its decay, when it is worth 0, and not before', async () => {
    const app = makeApp(db);
    const id = await create(app);
    await vote(app, id, 'up');
    const cast = new Date(NOW - 100 * DAY);
    await castAt(userId(USER_KEY, ID_SECRET), cast);
    const end = cast.getTime() + policy.decayEndDays * DAY;

    expect(decayFactor((end - 1 - cast.getTime()) / DAY, policy)).toBeGreaterThan(0);
    expect(await purgeExpiredVotes(db, policy, end - 1)).toBe(0);
    expect(decayFactor((end - cast.getTime()) / DAY, policy)).toBe(0);
    expect(voteExpiry(end, policy)).toEqual(cast);
    expect(await purgeExpiredVotes(db, policy, end)).toBe(1);
    expect(await votes()).toEqual([]);
  });

  it('follows VOTE_DECAY_END_DAYS', async () => {
    const app = makeApp(db);
    const id = await create(app);
    await vote(app, id, 'up');
    await castAt(userId(USER_KEY, ID_SECRET), new Date(NOW - 100 * DAY));

    expect(await purgeExpiredVotes(db, policy, NOW)).toBe(0);
    const short = { threshold: 5, decayStartDays: 30, decayEndDays: 100 };
    expect(await purgeExpiredVotes(db, short, NOW - 1)).toBe(0);
    expect(await purgeExpiredVotes(db, short, NOW)).toBe(1);
  });

  it('a user can vote again once the earlier vote expired, deleted or not yet', async () => {
    const app = makeApp(db);
    const id = await create(app);
    const user = userId(USER_KEY, ID_SECRET);
    expect(await vote(app, id, 'up')).toBe(true);

    // Fading but still counting: the same vote again is not counted, nor does it renew.
    const fading = new Date(Date.now() - 200 * DAY);
    await castAt(user, fading);
    expect(await vote(app, id, 'up')).toBe(false);
    expect((await votes())[0]?.created_at).toEqual(fading);

    // Expired, not yet deleted: the same vote renews it (and restarts its fading).
    await castAt(user, new Date(Date.now() - 400 * DAY));
    expect(await vote(app, id, 'up')).toBe(true);
    let left = await votes();
    expect(left).toHaveLength(1);
    expect(Date.now() - new Date(left[0]?.created_at ?? 0).getTime()).toBeLessThan(DAY);

    // Deleted: a new vote is a new row, still one per user.
    await castAt(user, new Date(Date.now() - 400 * DAY));
    expect(await purgeExpiredVotes(db, policy, Date.now())).toBe(1);
    expect(await vote(app, id, 'down')).toBe(true);
    expect(await vote(app, id, 'down')).toBe(false);
    left = await votes();
    expect(left.map((v) => v.user_id)).toEqual([user]);
  });

  it('a replaced vote restarts its retention', async () => {
    const app = makeApp(db);
    const id = await create(app);
    await vote(app, id, 'up');
    await castAt(userId(USER_KEY, ID_SECRET), new Date(Date.now() - 300 * DAY));
    expect(await vote(app, id, 'down')).toBe(true);
    expect(await purgeExpiredVotes(db, policy, Date.now() + 100 * DAY)).toBe(0);
    expect(await votes()).toHaveLength(1);
  });
});
