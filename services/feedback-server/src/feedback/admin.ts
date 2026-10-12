import type {
  FeedbackAdminDetail,
  FeedbackAdminEntry,
  FeedbackAdminList,
  FeedbackAdminListQuery,
  FeedbackAdminStats,
  FeedbackAdminVote,
  FeedbackKind,
  FeedbackSearchQuery,
} from '@sa/shared';
import type { Db } from '../db/types';
import {
  COLUMNS,
  type NewFeedback,
  type Row,
  searchCandidates,
  toEntry,
  UUID_RE,
  type VoteContext,
} from './repo';
import { decayFactor, serveChance, type Voter } from './votes';

/** Queries behind the admin page: browse, inspect, edit and curate entries. */

interface AdminRow extends Row {
  app_version: string | null;
  updated_at: Date | string | null;
  weight: number;
  up_votes: number;
  down_votes: number;
  human_votes: number;
}

/** Net weights closer to 0 than this count as neutral (entries show weights to 2 decimals). */
const EPSILON = 0.005;

const DAY_MS = 86_400_000;

/**
 * SQL builder with numbered parameters. `votes` joins each entry's vote aggregates; the weight
 * is the SQL twin of `voteWeight` in votes.ts (a test keeps them in step).
 */
class Query {
  readonly params: unknown[] = [];
  constructor(private readonly ctx: VoteContext) {}

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  votes(): string {
    const { threshold, decayStartDays: start, decayEndDays: end } = this.ctx.policy;
    const now = this.param(new Date(this.ctx.now).toISOString());
    const [t, s, e] = [this.param(threshold), this.param(start), this.param(end)];
    const age = `extract(epoch FROM (${now}::timestamptz - v.created_at)) / 86400.0`;
    const decay = `greatest(0, least(1, (${e}::float8 - ${age}) / (${e}::float8 - ${s}::float8)))`;
    return `LEFT JOIN LATERAL (
      SELECT coalesce(sum(v.value * CASE WHEN v.voter = 'human' THEN ${t}::float8 ELSE 1 END
                          * ${decay}), 0)::float8 AS weight,
             count(*) FILTER (WHERE v.value > 0)::int AS up_votes,
             count(*) FILTER (WHERE v.value < 0)::int AS down_votes,
             count(*) FILTER (WHERE v.voter = 'human')::int AS human_votes
      FROM feedback_votes v WHERE v.feedback_id = t.id) w ON true`;
  }
}

const ADMIN_COLUMNS = `${COLUMNS}, t.app_version, t.updated_at,
  w.weight, w.up_votes, w.down_votes, w.human_votes`;

function toAdminEntry(row: AdminRow, ctx: VoteContext, score?: number): FeedbackAdminEntry {
  const weight = Number(row.weight);
  return {
    ...toEntry(row, weight, score),
    ...(row.app_version ? { appVersion: row.app_version } : {}),
    ...(row.updated_at ? { updatedAt: new Date(row.updated_at).toISOString() } : {}),
    chance: Math.round(serveChance(weight, ctx.policy) * 1000) / 1000,
    upVotes: Number(row.up_votes),
    downVotes: Number(row.down_votes),
    humanVotes: Number(row.human_votes),
  };
}

/** Escapes LIKE wildcards (PostgreSQL's default escape character is the backslash). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const ALL_TEXT = `public.f_unaccent(lower(t.title || ' ' || t.body || ' ' || t.procedure || ' '
  || coalesce(t.administration, '') || ' ' || coalesce(t.region, '') || ' '
  || public.f_array_to_text(t.tags) || ' ' || public.f_array_to_text(t.urls)))`;

function where(q: Query, query: FeedbackAdminListQuery): string {
  const conditions: string[] = [];
  if (query.q) {
    const $q = q.param(query.q);
    const $like = q.param(likeEscape(query.q));
    const text = [
      `t.search_es @@ websearch_to_tsquery('pg_catalog.spanish', ${$q})`,
      `t.search_unaccent @@ websearch_to_tsquery('public.spanish_unaccent', ${$q})`,
      `${ALL_TEXT} LIKE '%' || public.f_unaccent(lower(${$like})) || '%'`,
    ];
    if (/^[0-9a-f-]{4,36}$/i.test(query.q)) {
      text.push(`t.id::text LIKE ${q.param(`${query.q.toLowerCase()}%`)}`);
    }
    conditions.push(`(${text.join(' OR ')})`);
  }
  if (query.kind) conditions.push(`t.kind = ${q.param(query.kind)}`);
  if (query.procedure) conditions.push(`lower(t.procedure) = lower(${q.param(query.procedure)})`);
  if (query.tag) conditions.push(`${q.param(query.tag.toLowerCase())} = ANY(t.tags)`);
  if (query.author) conditions.push(`t.author = ${q.param(query.author)}`);
  if (query.votes === 'up') conditions.push(`w.weight >= ${EPSILON}`);
  if (query.votes === 'down') conditions.push(`w.weight <= -${EPSILON}`);
  if (query.votes === 'neutral') conditions.push(`abs(w.weight) < ${EPSILON}`);
  if (query.reviewed === 'yes') conditions.push('w.human_votes > 0');
  if (query.reviewed === 'no') conditions.push('w.human_votes = 0');
  return conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
}

const ORDER: Record<FeedbackAdminListQuery['sort'], string> = {
  newest: 't.created_at DESC, t.id',
  oldest: 't.created_at ASC, t.id',
  votes: 'w.weight DESC, t.created_at DESC, t.id',
  edited: 't.updated_at DESC NULLS LAST, t.created_at DESC, t.id',
};

export async function adminList(
  db: Db,
  query: FeedbackAdminListQuery,
  ctx: VoteContext,
): Promise<FeedbackAdminList> {
  const q = new Query(ctx);
  const from = `FROM feedback t ${q.votes()} ${where(q, query)}`;
  const [page, count] = await Promise.all([
    db.query<AdminRow>(
      `SELECT ${ADMIN_COLUMNS} ${from} ORDER BY ${ORDER[query.sort]}
       LIMIT ${query.limit} OFFSET ${query.offset}`,
      q.params,
    ),
    db.query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, q.params),
  ]);
  return {
    results: page.rows.map((r) => toAdminEntry(r, ctx)),
    total: Number(count.rows[0]?.n ?? 0),
  };
}

async function adminEntries(db: Db, ids: string[], ctx: VoteContext): Promise<AdminRow[]> {
  if (ids.length === 0) return [];
  const q = new Query(ctx);
  const joins = q.votes();
  const { rows } = await db.query<AdminRow>(
    `SELECT ${ADMIN_COLUMNS} FROM feedback t ${joins} WHERE t.id = ANY(${q.param(ids)}::uuid[])`,
    q.params,
  );
  return rows;
}

export async function adminEntry(
  db: Db,
  id: string,
  ctx: VoteContext,
): Promise<FeedbackAdminEntry | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await adminEntries(db, [id.toLowerCase()], ctx);
  return row && toAdminEntry(row, ctx);
}

export async function adminDetail(
  db: Db,
  id: string,
  ctx: VoteContext,
): Promise<FeedbackAdminDetail | undefined> {
  const entry = await adminEntry(db, id, ctx);
  if (!entry) return undefined;
  const { rows } = await db.query<{
    id: string;
    value: number;
    voter: Voter;
    created_at: Date | string;
  }>(
    `SELECT id::text AS id, value, voter, created_at FROM feedback_votes
     WHERE feedback_id = $1::uuid ORDER BY created_at DESC, id DESC`,
    [entry.id],
  );
  const votes = rows.map((r): FeedbackAdminVote => {
    const createdAt = new Date(r.created_at);
    const value = Number(r.value) > 0 ? 1 : -1;
    const base = r.voter === 'human' ? ctx.policy.threshold : 1;
    const decay = decayFactor((ctx.now - createdAt.getTime()) / DAY_MS, ctx.policy);
    return {
      id: r.id,
      vote: value > 0 ? 'up' : 'down',
      voter: r.voter,
      createdAt: createdAt.toISOString(),
      weight: Math.round(value * base * decay * 100) / 100,
    };
  });
  return { entry, votes };
}

/** The agents' search for an admin: every candidate in relevance order, no serving draw. */
export async function adminSearch(
  db: Db,
  query: FeedbackSearchQuery,
  ctx: VoteContext,
): Promise<FeedbackAdminEntry[]> {
  const hits = await searchCandidates(db, query, query.limit);
  const rows = new Map(
    (
      await adminEntries(
        db,
        hits.map((h) => h.id),
        ctx,
      )
    ).map((r) => [r.id, r]),
  );
  return hits.flatMap((h) => {
    const row = rows.get(h.id);
    return row ? [toAdminEntry(row, ctx, h.score)] : [];
  });
}

/** Replaces an entry's editable fields, author included; false if it does not exist. */
export async function updateFeedback(db: Db, id: string, f: NewFeedback): Promise<boolean> {
  if (!UUID_RE.test(id)) return false;
  const { rows } = await db.query(
    `UPDATE feedback SET procedure = $2, administration = $3, region = $4, kind = $5, title = $6,
       body = $7, tags = $8, urls = $9, author = $10, updated_at = now()
     WHERE id = $1::uuid RETURNING id`,
    [
      id,
      f.procedure,
      f.administration ?? null,
      f.region ?? null,
      f.kind,
      f.title,
      f.body,
      f.tags,
      f.urls,
      f.author ?? null,
    ],
  );
  return rows.length > 0;
}

/** Removes one vote of an entry (e.g. a mistaken human vote); false if there is no such vote. */
export async function deleteVote(db: Db, id: string, voteId: string): Promise<boolean> {
  if (!UUID_RE.test(id) || !/^\d{1,18}$/.test(voteId)) return false;
  const { rows } = await db.query(
    'DELETE FROM feedback_votes WHERE id = $2::bigint AND feedback_id = $1::uuid RETURNING id',
    [id, voteId],
  );
  return rows.length > 0;
}

/** Most frequent procedures, tags and authors listed by the stats (they feed the page's filters). */
const FACETS = 200;

export async function adminStats(db: Db, ctx: VoteContext): Promise<FeedbackAdminStats> {
  const q = new Query(ctx);
  const [kinds, votes, procedures, tags, authors] = await Promise.all([
    db.query<{ kind: FeedbackKind; n: number }>(
      'SELECT kind, count(*)::int AS n FROM feedback GROUP BY kind',
    ),
    db.query<{ up: number; down: number; neutral: number; reviewed: number }>(
      `SELECT count(*) FILTER (WHERE w.weight >= ${EPSILON})::int AS up,
              count(*) FILTER (WHERE w.weight <= -${EPSILON})::int AS down,
              count(*) FILTER (WHERE abs(w.weight) < ${EPSILON})::int AS neutral,
              count(*) FILTER (WHERE w.human_votes > 0)::int AS reviewed
       FROM feedback t ${q.votes()}`,
      q.params,
    ),
    db.query<{ value: string; n: number }>(
      `SELECT procedure AS value, count(*)::int AS n FROM feedback
       GROUP BY procedure ORDER BY n DESC, procedure LIMIT ${FACETS}`,
    ),
    db.query<{ value: string; n: number }>(
      `SELECT tag AS value, count(*)::int AS n FROM feedback, unnest(tags) AS tag
       GROUP BY tag ORDER BY n DESC, tag LIMIT ${FACETS}`,
    ),
    db.query<{ value: string; n: number }>(
      `SELECT author AS value, count(*)::int AS n FROM feedback WHERE author IS NOT NULL
       GROUP BY author ORDER BY n DESC, author LIMIT ${FACETS}`,
    ),
  ]);
  const byKind: Record<FeedbackKind, number> = { tip: 0, friction: 0, gotcha: 0 };
  for (const r of kinds.rows) byKind[r.kind] = Number(r.n);
  const v = votes.rows[0] ?? { up: 0, down: 0, neutral: 0, reviewed: 0 };
  const facet = (rows: { value: string; n: number }[]) =>
    rows.map((r) => ({ value: r.value, count: Number(r.n) }));
  return {
    total: Object.values(byKind).reduce((a, b) => a + b, 0),
    kinds: byKind,
    votes: { up: Number(v.up), down: Number(v.down), neutral: Number(v.neutral) },
    reviewed: Number(v.reviewed),
    procedures: facet(procedures.rows),
    tags: facet(tags.rows),
    authors: facet(authors.rows),
    policy: { ...ctx.policy },
  };
}
