import type { FeedbackEntry, FeedbackKind, FeedbackSearchQuery } from '@sa/shared';
import type { Db } from '../db/types';
import { type Scored, type SearchSpec, tieredSearch } from '../search';
import { type CastVote, serveChance, type VotePolicy, type Voter, voteWeight } from './votes';

/** A scrubbed submission ready to store. */
export interface NewFeedback {
  procedure: string;
  administration?: string;
  region?: string;
  kind: FeedbackKind;
  title: string;
  body: string;
  tags: string[];
  urls: string[];
  appVersion?: string;
  /** An agent ("<model id> · <reasoning level>") or "human"; undefined when unknown. */
  author?: string;
  /** Only for seeds/imports; defaults to now(). */
  createdAt?: Date;
}

/** How votes are weighed, and "now" (ms) for their decay. */
export interface VoteContext {
  policy: VotePolicy;
  now: number;
}

export interface Row extends Record<string, unknown> {
  id: string;
  procedure: string;
  administration: string | null;
  region: string | null;
  kind: FeedbackKind;
  title: string;
  body: string;
  tags: string[];
  urls: string[];
  author: string | null;
  created_at: Date | string;
}

export const COLUMNS = `t.id::text AS id, t.procedure, t.administration, t.region, t.kind, t.title, t.body,
  t.tags, t.urls, t.author, t.created_at`;

/** Small recency boost: +20%, decaying over ~3 months. Votes decide serving, not ranking. */
const BOOST = '(1 + 0.2 / (1 + extract(epoch FROM (now() - t.created_at)) / 86400 / 90))';

/** Candidates fetched per result asked for, so entries skipped by chance can be replaced. */
const CANDIDATES_PER_RESULT = 3;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toEntry(row: Row, votes: number, score?: number): FeedbackEntry {
  return {
    id: row.id,
    procedure: row.procedure,
    ...(row.administration ? { administration: row.administration } : {}),
    ...(row.region ? { region: row.region } : {}),
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: row.tags ?? [],
    urls: row.urls ?? [],
    ...(row.author ? { author: row.author } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    ...(score === undefined ? {} : { score }),
    votes: Math.round(votes * 100) / 100,
  };
}

export async function insertFeedback(db: Db, f: NewFeedback): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO feedback
       (procedure, administration, region, kind, title, body, tags, urls, app_version, author,
        created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now()))
     RETURNING id::text AS id`,
    [
      f.procedure,
      f.administration ?? null,
      f.region ?? null,
      f.kind,
      f.title,
      f.body,
      f.tags,
      f.urls,
      f.appVersion ?? null,
      f.author ?? null,
      f.createdAt?.toISOString() ?? null,
    ],
  );
  return rows[0]!.id;
}

/**
 * Searches, then serves each hit with the chance its votes give it (see votes.ts), in relevance
 * order. `random` returns a number in [0, 1).
 */
export async function searchFeedback(
  db: Db,
  query: FeedbackSearchQuery,
  votes: VoteContext,
  random: () => number = Math.random,
): Promise<FeedbackEntry[]> {
  const rows = await searchCandidates(db, query, query.limit * CANDIDATES_PER_RESULT);
  const weights = await voteWeights(
    db,
    rows.map((r) => r.id),
    votes,
  );
  const served: FeedbackEntry[] = [];
  for (const { score, ...row } of rows) {
    const weight = weights.get(row.id) ?? 0;
    if (random() >= serveChance(weight, votes.policy)) continue;
    served.push(toEntry(row as Row, weight, score));
    if (served.length >= query.limit) break;
  }
  return served;
}

/** Search hits in relevance order, before votes and the serving draw. */
export function searchCandidates(
  db: Db,
  query: FeedbackSearchQuery,
  limit: number,
): Promise<Scored<Row>[]> {
  const spec: SearchSpec = {
    table: 'feedback',
    columns: COLUMNS,
    key: 'id',
    filters: (param) => {
      const where: string[] = [];
      if (query.procedure) {
        const $ = param(query.procedure);
        // Fuzzy procedure filter: same words (stemmed, accent-insensitive) or a similar name.
        where.push(`(to_tsvector('public.spanish_unaccent', t.procedure)
            @@ plainto_tsquery('public.spanish_unaccent', ${$}::text)
          OR similarity(public.f_unaccent(lower(t.procedure)), public.f_unaccent(lower(${$}::text))) >= 0.4)`);
      }
      if (query.kind) where.push(`t.kind = ${param(query.kind)}`);
      return where;
    },
    trigram: ['title', 'procedure'],
    boost: BOOST,
    tiebreak: 'created_at DESC',
  };
  return tieredSearch<Row>(db, spec, query.q, limit);
}

/** Records a vote with no user (maintainers' votes); false if the entry does not exist. */
export async function addVote(
  db: Db,
  id: string,
  value: 1 | -1,
  voter: Voter,
  createdAt?: Date,
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rows } = await db.query(
    `INSERT INTO feedback_votes (feedback_id, value, voter, created_at)
     SELECT id, $2, $3, coalesce($4::timestamptz, now()) FROM feedback WHERE id = $1::uuid
     RETURNING id`,
    [id, value, voter, createdAt?.toISOString() ?? null],
  );
  return rows.length > 0;
}

/**
 * Records a user's agent vote: one per user and entry. A different vote replaces the earlier one
 * (and restarts its fading). True when the vote was stored, changed or renewed; false when the
 * user had already cast this vote and it still counts, or the entry does not exist. A vote cast
 * at `expiredAt` or before no longer counts (and the next purge deletes it): the same vote again
 * renews it, as if it had been deleted already.
 */
export async function castVote(
  db: Db,
  id: string,
  value: 1 | -1,
  userId: string,
  expiredAt: Date,
): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rows } = await db.query(
    `INSERT INTO feedback_votes (feedback_id, value, voter, user_id)
     SELECT id, $2, 'agent', $3 FROM feedback WHERE id = $1::uuid
     ON CONFLICT (feedback_id, user_id) WHERE user_id IS NOT NULL
     DO UPDATE SET value = EXCLUDED.value, created_at = now()
       WHERE feedback_votes.value <> EXCLUDED.value OR feedback_votes.created_at <= $4::timestamptz
     RETURNING id`,
    [id, value, userId, expiredAt.toISOString()],
  );
  return rows.length > 0;
}

export async function feedbackExists(db: Db, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rows } = await db.query('SELECT 1 FROM feedback WHERE id = $1::uuid', [id]);
  return rows.length > 0;
}

/** Net vote weight per entry id (entries without votes are missing from the map). */
async function voteWeights(db: Db, ids: string[], ctx: VoteContext): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{
    feedback_id: string;
    value: number;
    voter: Voter;
    created_at: Date | string;
  }>(
    `SELECT feedback_id::text AS feedback_id, value, voter, created_at
     FROM feedback_votes WHERE feedback_id = ANY($1::uuid[])`,
    [ids],
  );
  const byEntry = new Map<string, CastVote[]>();
  for (const r of rows) {
    const list = byEntry.get(r.feedback_id) ?? [];
    list.push({
      value: Number(r.value) > 0 ? 1 : -1,
      voter: r.voter,
      createdAt: new Date(r.created_at),
    });
    byEntry.set(r.feedback_id, list);
  }
  const weights = new Map<string, number>();
  for (const [id, list] of byEntry) weights.set(id, voteWeight(list, ctx.now, ctx.policy));
  return weights;
}

export async function deleteFeedback(db: Db, id: string): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rows } = await db.query('DELETE FROM feedback WHERE id = $1::uuid RETURNING id', [id]);
  return rows.length > 0;
}

export async function countFeedback(db: Db, tag?: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    tag
      ? 'SELECT count(*)::int AS n FROM feedback WHERE $1 = ANY(tags)'
      : 'SELECT count(*)::int AS n FROM feedback',
    tag ? [tag] : [],
  );
  return Number(rows[0]?.n ?? 0);
}
