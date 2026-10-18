import type { Db } from '../db/types';
import type { VotePolicy } from './votes';

const DAY_MS = 86_400_000;

/** How often the server deletes expired votes (and once on start-up). */
const VOTE_PURGE_INTERVAL_MS = 3_600_000;

/**
 * Votes cast at this time or before are worth 0 at `now` (ms): `decayFactor` is 0 from
 * `decayEndDays` on, so deleting them never changes a weight.
 */
export function voteExpiry(now: number, policy: VotePolicy): Date {
  return new Date(now - policy.decayEndDays * DAY_MS);
}

/**
 * Deletes every vote that stopped counting at `now` (agent votes with their user id, and human
 * votes), via the SQL function `purge_expired_votes` (migration 010). Returns how many went.
 */
export async function purgeExpiredVotes(db: Db, policy: VotePolicy, now: number): Promise<number> {
  const { rows } = await db.query<{ n: string | number }>(
    'SELECT purge_expired_votes($1::timestamptz) AS n',
    [voteExpiry(now, policy).toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Deletes expired votes now and then every hour, on an unref'd timer (it never keeps the process
 * alive). A failure is logged and retried at the next tick. Returns a function that stops it.
 */
export function scheduleVotePurge(
  db: Db,
  policy: VotePolicy,
  log: (line: string) => void,
  intervalMs = VOTE_PURGE_INTERVAL_MS,
): () => void {
  const run = () =>
    purgeExpiredVotes(db, policy, Date.now()).then(
      (n) => {
        if (n > 0) log(`deleted ${n} expired vote${n === 1 ? '' : 's'}`);
      },
      (err: unknown) =>
        log(`deleting expired votes failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
