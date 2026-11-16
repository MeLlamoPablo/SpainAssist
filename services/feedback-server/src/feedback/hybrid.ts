import { scrubPii } from '@sa/pii';
import type { Db } from '../db/types';
import { type Embedder, toVectorLiteral } from '../embed/embedder';
import { embeddingsReady } from '../embed/indexer';
import { type Scored, STRICT_SCORE } from '../search';

/**
 * Hybrid search: the text search (search.ts) finds entries that share words with the query, the
 * embeddings find entries that mean the same in other words ("me ha tocado estar en una mesa
 * en las elecciones" → "designación como miembro de mesa electoral"). Both lists are merged by
 * rank.
 */

/** How long a search waits for the query's vector before it answers with the text search alone. */
const QUERY_TIMEOUT_MS = 3000;
/** After a failure, searches don't ask for vectors for this long (they would all wait and fail). */
const RETRY_AFTER_MS = 30_000;
/** While the database has no embeddings table, look again this often. */
const READY_CHECK_MS = 60_000;

export interface SemanticOptions {
  db: Db;
  embedder: Embedder;
  /**
   * Cosine similarity (0-1) an entry found only by its vector needs. A nearest-neighbour query
   * always returns something: without a floor, a question about nothing we know would get the
   * least unrelated learnings. The right value depends on the model (see README).
   */
  minSimilarity: number;
  log?: (line: string) => void;
  now?: () => number;
  timeoutMs?: number;
}

export interface Semantic {
  /** The vector space searched, and the floor: for the admin page. */
  readonly space: string;
  readonly minSimilarity: number;
  /**
   * The query's vector as a pgvector literal, or undefined when hybrid search can't run now (no
   * pgvector yet, the endpoint is down or slow): the caller then searches by text only.
   */
  queryVector(query: string): Promise<string | undefined>;
}

export function createSemantic(options: SemanticOptions): Semantic {
  const { db, embedder } = options;
  const now = options.now ?? Date.now;
  let ready = false;
  let checkedAt = Number.NEGATIVE_INFINITY;
  let retryAt = Number.NEGATIVE_INFINITY;
  return {
    space: embedder.space,
    minSimilarity: options.minSimilarity,
    async queryVector(query) {
      if (now() < retryAt) return undefined;
      if (!ready) {
        if (now() - checkedAt < READY_CHECK_MS) return undefined;
        checkedAt = now();
        ready = await embeddingsReady(db);
        if (!ready) return undefined;
      }
      try {
        // The app scrubs queries, other MCP clients may not: nothing personal leaves this server.
        const [vector] = await embedder.embed(
          [scrubPii(query).text],
          AbortSignal.timeout(options.timeoutMs ?? QUERY_TIMEOUT_MS),
        );
        return vector && toVectorLiteral(vector);
      } catch (err) {
        retryAt = now() + RETRY_AFTER_MS;
        options.log?.(
          `search without embeddings for ${RETRY_AFTER_MS / 1000} s: ${
            err instanceof Error ? err.message.slice(0, 200) : String(err)
          }`,
        );
        return undefined;
      }
    },
  };
}

/** How an entry matched: its text score (search.ts tiers) and its cosine similarity to the query. */
interface Match {
  text?: number;
  similarity?: number;
}

export type Fused<T> = Scored<T> & { match: Match };

/** Reciprocal rank fusion constant: the usual 60 flattens the difference between neighbours. */
const RRF_K = 60;
/**
 * A text hit that matched only some of the query's words is dropped when its similarity is
 * this far below the floor: "certificado de antecedentes penales" shares a word with every
 * entry about a certificate, and means none of them.
 */
const WEAK_TEXT_MARGIN = 0.05;

/**
 * Merges the text hits and the vector hits (each in its own relevance order) by reciprocal rank:
 * an entry scores `1 / (60 + rank)` in each list it is in, so entries both searches find come
 * first and neither search needs its scores calibrated against the other's. The score is scaled
 * to 0-1 (1: first in both lists).
 *
 * `minSimilarity` decides what a vector is worth as evidence: a vector hit below it doesn't
 * count, and a partial text hit clearly below it (WEAK_TEXT_MARGIN) is dropped. Strict text hits
 * always stay, as do text hits whose similarity is unknown (no embedding yet).
 */
export function fuse<T extends { id: string }>(
  textHits: Scored<T>[],
  vectorHits: (T & { similarity: number })[],
  minSimilarity: number,
  limit: number,
): Fused<T>[] {
  const similarities = new Map(vectorHits.map((hit) => [hit.id, hit.similarity]));
  const merged = new Map<string, { row: T; rrf: number; match: Match }>();
  let rank = 0;
  for (const { score, ...row } of textHits) {
    const similarity = similarities.get(row.id);
    if (
      score < STRICT_SCORE &&
      similarity !== undefined &&
      similarity < minSimilarity - WEAK_TEXT_MARGIN
    )
      continue;
    rank++;
    merged.set(row.id, {
      row: row as unknown as T,
      rrf: 1 / (RRF_K + rank),
      match: {
        text: score,
        ...(similarity === undefined ? {} : { similarity: round(similarity) }),
      },
    });
  }
  rank = 0;
  for (const { similarity, ...row } of vectorHits) {
    if (similarity < minSimilarity) continue;
    rank++;
    const seen = merged.get(row.id);
    if (seen) seen.rrf += 1 / (RRF_K + rank);
    else
      merged.set(row.id, {
        row: row as unknown as T,
        rrf: 1 / (RRF_K + rank),
        match: { similarity: round(similarity) },
      });
  }
  const best = 2 / (RRF_K + 1);
  return [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map(({ row, rrf, match }) => ({ ...row, score: round(rrf / best), match }));
}

const round = (n: number) => Math.round(n * 1000) / 1000;
