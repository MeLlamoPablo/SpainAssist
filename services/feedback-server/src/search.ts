import type { Db } from './db/types';
import { expandQuery } from './synonyms';

/**
 * Spanish full-text search over a table with `search_es` (pg_catalog.spanish) and
 * `search_unaccent` (public.spanish_unaccent) tsvector columns, in three stages:
 *
 * 1. strict: `websearch_to_tsquery` on both configs (all terms; "phrases", -negation, or);
 * 2. if fewer than `limit` hits: any term (OR), ranked by the share of query terms matched
 *    ("cita previa renovar dni" still finds "Renovación del DNI");
 * 3. if still short: trigram similarity on short text columns (typos: "enpadronamiento").
 *
 * Every stage also tries the query rewritten with official wording (see synonyms.ts).
 * Scores are tiered so they sort like the stages: strict 0.6-1.0, any-term 0.25-0.6,
 * trigram 0-0.25.
 */
export interface SearchSpec {
  /** Table name (trusted constant). */
  table: string;
  /** Select list using alias `t` (trusted constant). */
  columns: string;
  /** Unique key column, compared as text to exclude earlier stages' hits. */
  key: string;
  /** Builds filter fragments on alias `t`; `param(value)` returns its placeholder. */
  filters?: (param: (value: unknown) => string) => string[];
  /** Columns for the trigram stage, e.g. ["title", "procedure"]. */
  trigram: string[];
  /** SQL factor (>= 1) applied to the relevance, e.g. a recency boost. Default 1. */
  boost?: string;
  /** Final tie-breaker ORDER BY fragment on output column names, e.g. "created_at DESC". */
  tiebreak: string;
}

export type Scored<T> = T & { score: number };

/** With 3+ query terms, any-term hits must match at least a third of them. */
const MIN_COVERAGE_MANY_TERMS = 0.33;

const CONFIGS = [
  { col: 'search_es', cfg: 'pg_catalog.spanish' },
  { col: 'search_unaccent', cfg: 'public.spanish_unaccent' },
] as const;

export async function tieredSearch<T extends Record<string, unknown>>(
  db: Db,
  spec: SearchSpec,
  query: string,
  limit: number,
): Promise<Scored<T>[]> {
  // $1 = query, $2 = query in official wording (same as $1 when nothing to expand)
  const params: unknown[] = [query, expandQuery(query) ?? query];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const filters = (spec.filters?.(param) ?? []).map((w) => `AND ${w}`).join(' ');
  const base = [...params];
  const p = (i: number) => `$${base.length + i}`; // stage-specific params come after
  const boost = spec.boost ?? '1';
  const out: Scored<T>[] = [];
  const seen = () => out.map((r) => String(r[spec.key]));
  const take = (rows: (T & { s: number })[], floor: number, width: number) => {
    for (const { s, ...row } of rows) {
      out.push({ ...(row as unknown as T), score: round(floor + width * Math.min(1, s)) });
    }
  };

  // 1) strict: every term, in either config, for the query or its official wording
  const strictQ = CONFIGS.map(
    ({ cfg }, i) =>
      `websearch_to_tsquery('${cfg}', $1) || websearch_to_tsquery('${cfg}', $2) AS q${i}`,
  ).join(', ');
  const strict = await db.query<T & { s: number }>(
    `WITH q AS (SELECT ${strictQ})
     SELECT ${spec.columns},
            greatest(ts_rank_cd(t.search_es, q.q0, 32), ts_rank_cd(t.search_unaccent, q.q1, 32))
              * ${boost} AS s
     FROM ${spec.table} t, q
     WHERE (t.search_es @@ q.q0 OR t.search_unaccent @@ q.q1) ${filters}
     ORDER BY s DESC, ${spec.tiebreak}
     LIMIT ${p(1)}`,
    [...base, limit],
  );
  take(strict.rows, 0.6, 0.4);
  if (out.length >= limit) return out;

  // 2) any term, ranked by the share of query terms matched, then cover density
  const orQ = (cfg: string, n: 1 | 2) =>
    `nullif(replace(plainto_tsquery('${cfg}', $${n})::text, ' & ', ' | '), '')::tsquery`;
  const terms = (cfg: string, n: 1 | 2) =>
    `ARRAY(SELECT to_tsquery('simple', quote_literal(l))
           FROM unnest(tsvector_to_array(to_tsvector('${cfg}', $${n}))) l)`;
  const coverage = (col: string, arr: string) =>
    `(SELECT count(*) FROM unnest(q.${arr}) x WHERE t.${col} @@ x)::float8 / greatest(cardinality(q.${arr}), 1)`;
  const anyTerm = await db.query<T & { s: number }>(
    `WITH q0 AS (
       SELECT ${orQ('pg_catalog.spanish', 1)} AS es1, ${orQ('pg_catalog.spanish', 2)} AS es2,
              ${orQ('public.spanish_unaccent', 1)} AS un1, ${orQ('public.spanish_unaccent', 2)} AS un2,
              ${terms('pg_catalog.spanish', 1)} AS es1_terms, ${terms('pg_catalog.spanish', 2)} AS es2_terms,
              ${terms('public.spanish_unaccent', 1)} AS un1_terms,
              ${terms('public.spanish_unaccent', 2)} AS un2_terms),
     q AS (
       SELECT q0.*, coalesce(es1 || es2, es1, es2) AS es, coalesce(un1 || un2, un1, un2) AS un FROM q0),
     hits AS (
       SELECT ${spec.columns},
              greatest(coalesce(ts_rank_cd(t.search_es, q.es, 32), 0),
                       coalesce(ts_rank_cd(t.search_unaccent, q.un, 32), 0)) AS rank,
              greatest(${coverage('search_es', 'es1_terms')}, ${coverage('search_es', 'es2_terms')},
                       ${coverage('search_unaccent', 'un1_terms')},
                       ${coverage('search_unaccent', 'un2_terms')}) AS coverage,
              greatest(cardinality(q.es1_terms), cardinality(q.un1_terms)) AS terms,
              ${boost} AS boost
       FROM ${spec.table} t, q
       WHERE (t.search_es @@ q.es OR t.search_unaccent @@ q.un)
         AND NOT (t.${spec.key}::text = ANY(${p(1)}::text[])) ${filters})
     SELECT *, (0.7 * coverage + 0.3 * rank) * boost AS s
     FROM hits
     WHERE terms < 3 OR coverage >= ${MIN_COVERAGE_MANY_TERMS}
     ORDER BY s DESC, ${spec.tiebreak}
     LIMIT ${p(2)}`,
    [...base, seen(), limit - out.length],
  );
  take(
    anyTerm.rows.map(
      ({ rank: _r, coverage: _c, terms: _t, boost: _b, ...row }) => row as T & { s: number },
    ),
    0.25,
    0.35,
  );
  if (out.length >= limit) return out;

  // 3) trigram similarity (typos) on the given short columns
  const norm = (col: string) => `public.f_unaccent(lower(t.${col}))`;
  const match = spec.trigram.map((c) => `${norm(c)} % q.norm OR ${norm(c)} %> q.norm`).join(' OR ');
  const sim = spec.trigram
    .map((c) => `similarity(${norm(c)}, q.norm), word_similarity(q.norm, ${norm(c)})`)
    .join(', ');
  const fuzzy = await db.query<T & { s: number }>(
    `WITH q AS (SELECT public.f_unaccent(lower($1)) AS norm, $2::text AS official)
     SELECT ${spec.columns}, greatest(${sim}) * ${boost} AS s
     FROM ${spec.table} t, q
     WHERE (${match})
       AND NOT (t.${spec.key}::text = ANY(${p(1)}::text[])) ${filters}
     ORDER BY s DESC, ${spec.tiebreak}
     LIMIT ${p(2)}`,
    [...base, seen(), limit - out.length],
  );
  take(fuzzy.rows, 0, 0.25);
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
