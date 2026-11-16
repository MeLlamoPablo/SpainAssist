import { migrate } from '../db/migrate';
import type { Db } from '../db/types';
import { type Embedder, toVectorLiteral } from './embedder';

/**
 * Keeps `feedback_embeddings` (migration 012) in step with `feedback`: one vector per entry,
 * whatever its triage, so the admin page's search covers entries agents don't get yet.
 */

/** Characters of an entry that are embedded (about 2,000 tokens, the smallest limit of the models we tried). */
const MAX_TEXT_CHARS = 6000;

/**
 * The text an entry is embedded as, built in SQL so the indexer and the staleness check
 * can't disagree: procedure · administration · region, title, body, tags.
 */
const EMBEDDED_TEXT = `left(concat_ws(E'\\n',
  concat_ws(' · ', t.procedure, t.administration, t.region), t.title, t.body,
  nullif(public.f_array_to_text(t.tags), '')), ${MAX_TEXT_CHARS})`;

/** Entries sent to the embeddings endpoint per request. */
const BATCH = 16;

/** Whether migration 012 has run (the database has pgvector). */
export async function embeddingsReady(db: Db): Promise<boolean> {
  const { rows } = await db.query<{ ready: boolean }>(
    "SELECT to_regclass('public.feedback_embeddings') IS NOT NULL AS ready",
  );
  return rows[0]?.ready === true;
}

interface Pending {
  id: string;
  text: string;
  hash: string;
}

/**
 * Embeds entries that have no vector, a vector of another space, or one of an older text.
 * Approved entries go first. Returns how many were embedded and how many failed (those are
 * tried again at the next run).
 */
export async function indexPending(
  db: Db,
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<{ embedded: number; failed: number }> {
  const failed = new Set<string>();
  let embedded = 0;
  for (;;) {
    const { rows } = await db.query<Pending>(
      `SELECT t.id::text AS id, ${EMBEDDED_TEXT} AS text, md5(${EMBEDDED_TEXT}) AS hash
       FROM feedback t LEFT JOIN feedback_embeddings e ON e.feedback_id = t.id
       WHERE (e.feedback_id IS NULL OR e.model <> $1 OR e.content_hash <> md5(${EMBEDDED_TEXT}))
         AND NOT (t.id::text = ANY($2::text[]))
       ORDER BY (t.triage = 'approved') DESC, t.created_at DESC, t.id
       LIMIT ${BATCH}`,
      [embedder.space, [...failed]],
    );
    if (rows.length === 0 || signal?.aborted) break;
    for (const batch of await embedBatch(embedder, rows, signal)) {
      if (!batch.vector) {
        failed.add(batch.entry.id);
        continue;
      }
      // The entry may have been deleted meanwhile: then nothing is stored.
      await db.query(
        `INSERT INTO feedback_embeddings (feedback_id, model, content_hash, embedding)
         SELECT id, $2, $3, $4::vector FROM feedback WHERE id = $1::uuid
         ON CONFLICT (feedback_id) DO UPDATE SET model = EXCLUDED.model,
           content_hash = EXCLUDED.content_hash, embedding = EXCLUDED.embedding, embedded_at = now()`,
        [batch.entry.id, embedder.space, batch.entry.hash, toVectorLiteral(batch.vector)],
      );
      embedded++;
    }
    // The endpoint is down (not one bad entry): leave the rest for the next run.
    if (failed.size >= BATCH) break;
  }
  return { embedded, failed: failed.size };
}

/** How long one request to the embeddings endpoint may take while indexing. */
const INDEX_TIMEOUT_MS = 30_000;

/**
 * Embeds a batch. When the request fails, each entry is tried on its own, so one bad entry
 * can't block the rest; after two failures in a row the endpoint is taken to be down.
 */
async function embedBatch(
  embedder: Embedder,
  entries: Pending[],
  signal?: AbortSignal,
): Promise<{ entry: Pending; vector?: number[] }[]> {
  const embed = (texts: string[]) => {
    const timeout = AbortSignal.timeout(INDEX_TIMEOUT_MS);
    return embedder
      .embed(texts, signal ? AbortSignal.any([signal, timeout]) : timeout)
      .catch(() => undefined);
  };
  const vectors = await embed(entries.map((e) => e.text));
  if (vectors) return entries.map((entry, i) => ({ entry, vector: vectors[i]! }));
  const out: { entry: Pending; vector?: number[] }[] = [];
  let failures = entries.length === 1 ? 2 : 0;
  for (const entry of entries) {
    const vector = failures < 2 ? (await embed([entry.text]))?.[0] : undefined;
    failures = vector ? 0 : failures + 1;
    out.push(vector ? { entry, vector } : { entry });
  }
  return out;
}

/** How often the indexer looks for work nobody told it about (and retries failures). */
const INDEX_INTERVAL_MS = 10 * 60_000;
/** Writes arrive in bursts (an agent shares a few learnings at once): wait a little, embed once. */
const KICK_DELAY_MS = 500;

export interface Indexer {
  /** An entry was written: embed it soon. */
  kick(): void;
  /** Resolves when no run is pending or under way (tests). */
  idle(): Promise<void>;
  stop(): void;
}

/**
 * Embeds what is pending now, after every `kick()` and every ten minutes, one run at a time, on
 * unref'd timers. While the database has no pgvector it retries migration 012 instead, so
 * hybrid search turns on by itself once Postgres gets the extension. Failures are logged (never
 * with entry text) and retried at the next run.
 */
export function scheduleIndexer(
  db: Db,
  embedder: Embedder,
  log: (line: string) => void,
  intervalMs = INDEX_INTERVAL_MS,
): Indexer {
  const abort = new AbortController();
  let running: Promise<void> | undefined;
  let again = false;
  let kickTimer: NodeJS.Timeout | undefined;
  let waiting = false; // logged "no pgvector" already

  const runOnce = async () => {
    if (!(await embeddingsReady(db))) {
      const applied = await migrate(db);
      if (applied.length > 0) log(`migrations applied: ${applied.join(', ')}`);
      if (!(await embeddingsReady(db))) {
        if (!waiting) log('hybrid search is waiting: the database has no pgvector extension');
        waiting = true;
        return;
      }
    }
    waiting = false;
    const { embedded, failed } = await indexPending(db, embedder, abort.signal);
    if (embedded > 0) log(`embedded ${embedded} entr${embedded === 1 ? 'y' : 'ies'}`);
    if (failed > 0) log(`embedding failed for ${failed} entr${failed === 1 ? 'y' : 'ies'}`);
  };
  const run = () => {
    if (abort.signal.aborted) return;
    if (running) {
      again = true;
      return;
    }
    running = runOnce()
      .catch((err: unknown) =>
        log(`indexing failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`),
      )
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          run();
        }
      });
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return {
    kick() {
      if (kickTimer || abort.signal.aborted) return;
      kickTimer = setTimeout(() => {
        kickTimer = undefined;
        run();
      }, KICK_DELAY_MS);
      kickTimer.unref();
    },
    async idle() {
      if (kickTimer) {
        clearTimeout(kickTimer);
        kickTimer = undefined;
        run();
      }
      while (running) await running;
    },
    stop() {
      abort.abort();
      clearInterval(timer);
      clearTimeout(kickTimer);
    },
  };
}
