/**
 * Measures the search on labelled questions, by text only and hybrid, over a copy of a server's
 * approved entries in an in-memory database.
 *
 *   ADMIN_TOKEN=… EMBEDDINGS_URL=https://llm.<domain>/v1 EMBEDDINGS_API_KEY=sk-… \
 *     corepack pnpm --filter @sa/feedback-server eval:search --url https://feedback.<domain>
 *   … eval:search --corpus entries.json   # a saved `GET /admin/feedback?triage=approved` answer
 *
 * `--queries` (default eval/queries.json) lists `{ "q": …, "expect": [ids] }`: the entries a
 * good search returns for the question, none for a question no entry answers. EMBEDDINGS_* are
 * the server's settings. It calls the real embeddings endpoint (well under a cent; vectors are
 * cached in .data/eval-embeddings.json), so it is run by hand, never by the tests.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FeedbackAdminList, type FeedbackEntry, FeedbackSearchQuery } from '@sa/shared';
import { loadConfig, SERVICE_DIR } from '../config';
import { migrate } from '../db/migrate';
import { openDb } from '../db/open';
import type { Db } from '../db/types';
import { createGatewayEmbedder, type Embedder } from '../embed/embedder';
import { indexPending } from '../embed/indexer';
import { createSemantic, type Semantic } from '../feedback/hybrid';
import { searchCandidates } from '../feedback/repo';

interface Question {
  q: string;
  expect: string[];
}

const CACHE_FILE = resolve(SERVICE_DIR, '.data/eval-embeddings.json');
const PAGE = 200;

async function fetchCorpus(base: string, token: string): Promise<FeedbackEntry[]> {
  const entries: FeedbackEntry[] = [];
  for (;;) {
    const url = new URL(
      `/admin/feedback?triage=approved&limit=${PAGE}&offset=${entries.length}`,
      base,
    );
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${url.origin} answered ${res.status}`);
    const page = FeedbackAdminList.parse(await res.json());
    entries.push(...page.results);
    if (page.results.length === 0 || entries.length >= page.total) return entries;
  }
}

async function load(db: Db, entries: FeedbackEntry[]): Promise<void> {
  for (const e of entries) {
    await db.query(
      `INSERT INTO feedback (id, procedure, administration, region, kind, title, body, tags, urls,
                             created_at, triage)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, 'approved')`,
      [
        e.id,
        e.procedure,
        e.administration ?? null,
        e.region ?? null,
        e.kind,
        e.title,
        e.body,
        e.tags,
        e.urls,
        e.createdAt,
      ],
    );
  }
}

/** Keeps every vector on disk, so a second run costs nothing. */
function cached(embedder: Embedder): Embedder {
  let cache: Record<string, number[]> = {};
  try {
    cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as Record<string, number[]>;
  } catch {
    // no cache yet
  }
  const key = (text: string) =>
    createHash('sha256').update(`${embedder.space}\n${text}`).digest('hex');
  return {
    space: embedder.space,
    async embed(texts, signal) {
      const missing = texts.filter((t) => !cache[key(t)]);
      if (missing.length > 0) {
        const vectors = await embedder.embed(missing, signal);
        missing.forEach((t, i) => {
          cache[key(t)] = vectors[i]!;
        });
        mkdirSync(dirname(CACHE_FILE), { recursive: true });
        writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
      return texts.map((t) => cache[key(t)]!);
    },
  };
}

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

async function measure(db: Db, questions: Question[], limit: number, semantic?: Semantic) {
  const answered = {
    hit1: [] as number[],
    hit3: [] as number[],
    recall: [] as number[],
    rr: [] as number[],
  };
  const unanswerable: number[] = [];
  const misses: string[] = [];
  for (const { q, expect } of questions) {
    const query = FeedbackSearchQuery.parse({ q, limit });
    const ids = (await searchCandidates(db, query, limit, true, semantic)).map((r) => r.id);
    if (expect.length === 0) {
      unanswerable.push(ids.length);
      continue;
    }
    const first = ids.findIndex((id) => expect.includes(id));
    answered.hit1.push(first === 0 ? 1 : 0);
    answered.hit3.push(first >= 0 && first < 3 ? 1 : 0);
    answered.recall.push(
      expect.filter((id) => ids.slice(0, 5).includes(id)).length / expect.length,
    );
    answered.rr.push(first >= 0 ? 1 / (first + 1) : 0);
    if (first !== 0) misses.push(`${first < 0 ? '  –' : `#${first + 1}`.padStart(3)}  ${q}`);
  }
  return {
    'hit@1': mean(answered.hit1),
    'hit@3': mean(answered.hit3),
    'recall@5': mean(answered.recall),
    mrr: mean(answered.rr),
    // Questions nothing answers: how many entries they get anyway (the fewer the better).
    noise: mean(unanswerable),
    misses,
  };
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === '--') argv.shift(); // `pnpm run x -- --flag` forwards the separator
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' },
      corpus: { type: 'string' },
      queries: { type: 'string', default: resolve(SERVICE_DIR, 'eval/queries.json') },
      limit: { type: 'string', default: '8' },
      misses: { type: 'boolean', default: false },
    },
  });
  const config = loadConfig({ ...process.env, DATABASE_URL: 'pglite://memory' });
  if (!config.embeddings) throw new Error('set EMBEDDINGS_API_KEY and EMBEDDINGS_URL');
  let entries: FeedbackEntry[];
  if (values.corpus) {
    entries = FeedbackAdminList.parse(JSON.parse(readFileSync(values.corpus, 'utf8'))).results;
  } else {
    if (!values.url || !process.env.ADMIN_TOKEN)
      throw new Error('pass --corpus <file>, or --url <feedback server> with ADMIN_TOKEN');
    entries = await fetchCorpus(values.url, process.env.ADMIN_TOKEN);
  }
  const all = JSON.parse(readFileSync(values.queries, 'utf8')) as Question[];
  const known = new Set(entries.map((e) => e.id));
  const questions = all.filter((x) => x.expect.every((id) => known.has(id)));
  const limit = Number(values.limit);

  const db = await openDb(config.databaseUrl);
  await migrate(db);
  await load(db, entries);
  const embedder = cached(createGatewayEmbedder(config.embeddings));
  const { failed } = await indexPending(db, embedder);
  if (failed > 0) throw new Error(`${failed} entries could not be embedded`);
  const semantic = createSemantic({
    db,
    embedder,
    minSimilarity: config.embeddings.minSimilarity,
    timeoutMs: 30_000,
    log: (line) => console.error(line),
  });

  console.log(
    `${entries.length} entries, ${questions.length} questions (${all.length - questions.length} skipped: ` +
      `their entries are not in this corpus), ${embedder.space}, floor ${semantic.minSimilarity}`,
  );
  for (const [name, mode] of [
    ['text', undefined],
    ['hybrid', semantic],
  ] as const) {
    const { misses, ...scores } = await measure(db, questions, limit, mode);
    const line = Object.entries(scores)
      .map(([k, v]) => `${k} ${v.toFixed(3)}`)
      .join('  ');
    console.log(`${name.padEnd(7)} ${line}`);
    if (values.misses) for (const miss of misses) console.log(`          ${miss}`);
  }
  await db.close();
}

run().catch((err: unknown) => {
  console.error(`eval: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
