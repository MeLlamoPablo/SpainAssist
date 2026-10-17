import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { CacheMode } from '../contracts';
import { pairIds } from './align';
import {
  type CanonicalRequest,
  type PageObservation,
  type Reaction,
  reactionTo,
} from './canonical';
import type { CostSource, TokenCounts } from './cost';
import { writePrivateJson } from './home';
import { summarizeBody, toolCallsOf, type WireApi } from './sse';

/**
 * The record/replay cache: model responses stored by the canonical hash of the request that
 * produced them (see canonical.ts). Modes:
 *
 * - `off`: nothing is read or written;
 * - `record`: every request goes upstream and its response is stored (replacing an older take);
 * - `replay`: nothing goes upstream; a miss answers 424 with a first-divergent-message diagnostic,
 *   and no credentials are needed;
 * - `auto`: a hit is replayed, a miss goes upstream and is stored.
 *
 * Takes are indexed by occurrence: the n-th time one run asks for the same hash it gets the n-th
 * recorded take, so a retry or a genuine repeat replays the same sequence. Only complete 200
 * responses are stored, never errors or truncated streams.
 *
 * A `replay` that finds no exact take may use a looser one (`takeLoose`): a recording of the same
 * conversation, system prompt, tools and model, whose browser pages differ in ways that cannot
 * change what the model would do. Every such hit is flagged (`CacheHit.loose`) and counted, so a
 * run that was replayed loosely is never mistaken for one that was reproduced exactly:
 *
 * - a page at the same URL that says the same (`contentOf` in canonical.ts) and differs only in its
 *   element refs, the focus marker, how the elements are nested or the numbers of the ids it
 *   shows is the same page (an answer that uses a ref does not replay on another set of refs);
 * - any other difference (another URL: a redirect caught at another hop; the same URL caught
 *   while it was still loading: its title is `Loading <url>`) counts only when the model's
 *   reaction to the page was to wait or look again (`browser_wait`, `browser_snapshot`), whatever
 *   the page said: such an answer is true of any state of the page. The next answer that acts
 *   on a page needs that page to say what was recorded, so a changed page (an injected text, a
 *   changed form) is a miss at the latest there, and a recorded click never lands on another page;
 * - the ids of the recording are paired with the live ones by what surrounds them, never by
 *   position, and an id the recorded answer names that cannot be paired is a miss.
 *
 * Screenshots are not part of the exact key (pixels differ between runs, `strictImages` aside),
 * so a hit whose screenshots differ from the recorded ones is flagged too.
 */

export const CACHE_MODES: readonly CacheMode[] = ['off', 'record', 'replay', 'auto'];

export function isCacheMode(value: string): value is CacheMode {
  return (CACHE_MODES as readonly string[]).includes(value);
}

const Take = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  usage: z
    .object({
      prompt: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
      completion: z.number(),
      reasoning: z.number(),
    })
    .optional(),
  costUsd: z.number(),
  costSource: z.string(),
  recordedAt: z.string(),
  runId: z.string(),
  agent: z.string(),
  ids: z.array(z.string()).optional(),
});

export interface CacheTake {
  status: number;
  headers: Record<string, string>;
  /** UTF-8 text of the SSE stream or JSON body, as the model wrote it. */
  body: string;
  usage?: TokenCounts;
  /** What the request cost live: replays report it as virtual, never as spend. */
  costUsd: number;
  costSource: CostSource;
  recordedAt: string;
  runId: string;
  agent: string;
  /** The app's ids in the request this answered, in order of appearance (`CanonicalRequest.ids`). */
  ids?: string[];
}

const Page = z.object({
  index: z.number().int(),
  url: z.string(),
  title: z.string(),
  shape: z.string(),
  next: z.object({ waits: z.boolean(), refs: z.boolean() }).optional(),
});

const Entry = z.object({
  v: z.literal(1),
  key: z.string(),
  upstream: z.string(),
  model: z.string(),
  api: z.enum(['chat-completions', 'responses']),
  variant: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // The fields below were added later: an entry recorded before has none and is only replayed exactly.
  skeleton: z.string().optional(),
  pages: z.array(Page).optional(),
  images: z.array(z.string()).optional(),
  idContexts: z.array(z.string()).optional(),
  summary: z.object({
    messages: z.number(),
    tools: z.number(),
    bytes: z.number(),
    lastUser: z.string(),
  }),
  head: z.record(z.string(), z.string()),
  messageHashes: z.array(z.string()),
  messagePreviews: z.array(z.string()),
  takes: z.array(Take.nullable()),
});

export interface CacheEntry {
  v: 1;
  key: string;
  upstream: string;
  model: string;
  api: WireApi;
  variant: string;
  createdAt: string;
  updatedAt: string;
  /** `CanonicalRequest.skeleton`: what a replay looks the entry up by when no exact one fits. */
  skeleton?: string;
  pages?: PageObservation[];
  images?: string[];
  idContexts?: string[];
  summary: CanonicalRequest['summary'];
  head: Record<string, string>;
  messageHashes: string[];
  messagePreviews: string[];
  /** Index = occurrence within a run; null where nothing cacheable happened. */
  takes: (CacheTake | null)[];
}

/** A recorded answer to serve, and how it differs from an exact replay of its recording. */
export interface CacheHit {
  take: CacheTake;
  /**
   * What is not the same as when the take was recorded, one line each (`page #6: another hop
   * (...)`, `screenshots differ ...`): empty for an exact replay. A run counts these hits.
   */
  loose: string[];
  /** The ids of the recording and of this request that belong together, when paired by their surroundings. */
  ids?: { recorded: string[]; live: string[] };
}

export interface CacheScope {
  upstream: string;
  model: string;
}

/**
 * The response headers a take keeps and a replay sends: what a client needs to read the body (the
 * content type) and the cost of this one request. Everything else an upstream may send stays out
 * of the cache: cookies, account and organisation ids, rate-limit and plan headers, request ids,
 * and the gateway's `x-litellm-key-spend` and `x-litellm-key-max-budget` (the key's balance and
 * cap). It is applied when a response is stored and again when a take is served, so an entry
 * written before it existed never sends those headers either.
 */
const KEPT_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'cache-control',
  'x-litellm-response-cost',
]);

export function keptHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && KEPT_HEADERS.has(name.toLowerCase())) {
      kept[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return kept;
}

/** The part of an agent key that is stable between runs: `procedure-3` → `procedure`. */
export function agentRole(agentKey: string): string {
  return agentKey.split('-')[0] ?? agentKey;
}

export interface MissDiagnostic {
  /** First 12 hex characters of the missed request's hash. */
  key: string;
  occurrence: number;
  reason: 'no-recordings' | 'take-missing' | 'diverged';
  /** The closest recorded request: the one sharing the longest message prefix. */
  nearest?: { key: string; recordedAt: string; commonPrefix: number; messages: number };
  /** Which parts of the request differ from the nearest recording. */
  divergence?: {
    /** Request fields (model, tools, parameters) whose hash differs. */
    head: string[];
    /** The first differing message (or the length) when the messages differ. */
    messageIndex?: number;
    recorded?: string;
    current?: string;
  };
  /** One human sentence, safe to put in the 424 body. */
  description: string;
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '__');
}

export class ResponseCache {
  constructor(readonly dir: string) {}

  private scopeDir(scope: CacheScope): string {
    return join(this.dir, slug(scope.upstream), slug(scope.model));
  }

  private entryPath(scope: CacheScope, key: string): string {
    return join(this.scopeDir(scope), `${key}.json`);
  }

  /**
   * An entry holds the model's output and the tool results of the mock sites, a whitelist of
   * response headers (`keptHeaders`) and no credential; the meter scrubs account identifiers from
   * both before storing (`SecretRegistry.scrubRecordedBody`/`scrubRecordedHeaders`). Review one
   * before committing it: the conversation may carry a persona's personal data.
   */
  read(scope: CacheScope, key: string): CacheEntry | undefined {
    const path = this.entryPath(scope, key);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Cache entry ${path} is not valid JSON`);
    }
    const parsed = Entry.safeParse(json);
    if (!parsed.success) throw new Error(`Cache entry ${path} is invalid`);
    return parsed.data as CacheEntry;
  }

  /** The recorded take for the n-th request of this hash in a run. */
  take(scope: CacheScope, request: CanonicalRequest, occurrence: number): CacheHit | undefined {
    const entry = this.read(scope, request.key);
    const take = entry?.takes[occurrence];
    if (!entry || !take) return undefined;
    return { take, loose: imageDifferences(entry.images, request.images) };
  }

  /**
   * The newest recorded take for the n-th request of this conversation when the exact request was
   * never recorded: see the top of this file for what may differ. Reads every entry of the scope:
   * for a replay's misses only. When no recording fits, `rejected` says why the newest candidate
   * of the same conversation did not.
   */
  takeLoose(
    scope: CacheScope,
    request: CanonicalRequest,
    occurrence: number,
  ): { hit?: CacheHit; rejected?: string } {
    let best: { updatedAt: string; hit: CacheHit } | undefined;
    let rejected: { updatedAt: string; why: string } | undefined;
    for (const entry of this.entries(scope)) {
      const take = entry.takes[occurrence];
      if (!take || !entry.skeleton || entry.skeleton !== request.skeleton) continue;
      const verdict = compare(entry, take, request);
      if ('hit' in verdict) {
        if (!best || entry.updatedAt > best.updatedAt) {
          best = { updatedAt: entry.updatedAt, hit: verdict.hit };
        }
      } else if (!rejected || entry.updatedAt > rejected.updatedAt) {
        rejected = { updatedAt: entry.updatedAt, why: verdict.rejected };
      }
    }
    if (best) return { hit: best.hit };
    return rejected ? { rejected: rejected.why } : {};
  }

  /** Stores the take at `occurrence` (replacing a recorded one), creating the entry if needed. */
  record(
    scope: CacheScope,
    request: CanonicalRequest,
    occurrence: number,
    take: CacheTake,
    now: Date = new Date(),
  ): void {
    const existing = this.read(scope, request.key);
    const takes = existing ? [...existing.takes] : [];
    while (takes.length < occurrence) takes.push(null);
    takes[occurrence] = take;
    const iso = now.toISOString();
    const entry: CacheEntry = {
      v: 1,
      key: request.key,
      upstream: scope.upstream,
      model: scope.model,
      api: request.api,
      variant: request.variant,
      createdAt: existing?.createdAt ?? iso,
      updatedAt: iso,
      skeleton: request.skeleton,
      pages: request.pages,
      images: request.images,
      idContexts: request.idContexts,
      summary: request.summary,
      head: request.head,
      messageHashes: request.messageHashes,
      messagePreviews: request.messagePreviews,
      takes,
    };
    writePrivateJson(this.entryPath(scope, request.key), entry);
  }

  private entries(scope: CacheScope): CacheEntry[] {
    const dir = this.scopeDir(scope);
    let files: string[];
    try {
      files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      return [];
    }
    const out: CacheEntry[] = [];
    for (const file of files) {
      try {
        const parsed = Entry.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        if (parsed.success) out.push(parsed.data as CacheEntry);
      } catch {
        // A torn or foreign file is not a recording.
      }
    }
    return out;
  }

  /**
   * Why `request` has no recorded take: either the same request was recorded fewer times, or the
   * closest recording diverges at a message (page content that changed between runs, a path, a
   * date) or at the request's parameters.
   */
  explainMiss(
    scope: CacheScope,
    request: CanonicalRequest,
    occurrence: number,
    agent: string,
    rejected?: string,
  ): MissDiagnostic {
    const key = request.key.slice(0, 12);
    const same = this.read(scope, request.key);
    if (same) {
      const recorded = same.takes.filter((take) => take !== null).length;
      return {
        key,
        occurrence,
        reason: 'take-missing',
        description: `Replay cache miss: this exact request was recorded ${recorded} time(s) but this is occurrence ${occurrence} (agent ${agent}).`,
      };
    }
    const candidates = this.entries(scope).filter(
      (entry) => entry.variant === request.variant && entry.api === request.api,
    );
    if (candidates.length === 0) {
      return {
        key,
        occurrence,
        reason: 'no-recordings',
        description: `Replay cache miss: nothing is recorded for ${scope.upstream} ${scope.model}${request.variant ? ` (variant ${request.variant})` : ''}; request ${key}, agent ${agent}.`,
      };
    }
    const role = agentRole(agent);
    const sameRole = candidates.filter((entry) =>
      entry.takes.some((take) => take && agentRole(take.agent) === role),
    );
    const pool = sameRole.length > 0 ? sameRole : candidates;
    let best = pool[0]!;
    let bestScore = -1;
    for (const entry of pool) {
      const prefix = commonPrefix(entry.messageHashes, request.messageHashes);
      const headMatches = Object.keys(request.head).filter(
        (field) => entry.head[field] === request.head[field],
      ).length;
      const score = prefix * 1000 + headMatches;
      if (score > bestScore || (score === bestScore && entry.updatedAt > best.updatedAt)) {
        best = entry;
        bestScore = score;
      }
    }
    const prefix = commonPrefix(best.messageHashes, request.messageHashes);
    const headFields = [
      ...new Set([...Object.keys(request.head), ...Object.keys(best.head)]),
    ].filter((field) => best.head[field] !== request.head[field]);
    const parts: string[] = [];
    let messageIndex: number | undefined;
    let recorded: string | undefined;
    let current: string | undefined;
    if (prefix < Math.min(best.messageHashes.length, request.messageHashes.length)) {
      messageIndex = prefix;
      recorded = best.messagePreviews[prefix];
      current = request.messagePreviews[prefix];
      parts.push(`message #${prefix} differs (recorded: ${recorded}; now: ${current})`);
    } else if (best.messageHashes.length !== request.messageHashes.length) {
      messageIndex = prefix;
      parts.push(
        `the request has ${request.messageHashes.length} messages, the recording ${best.messageHashes.length}`,
      );
    }
    if (headFields.length > 0) parts.push(`parameters differ: ${headFields.join(', ')}`);
    const detail = parts.length > 0 ? parts.join('; ') : 'no difference found';
    return {
      key,
      occurrence,
      reason: 'diverged',
      nearest: {
        key: best.key.slice(0, 12),
        recordedAt: best.updatedAt,
        commonPrefix: prefix,
        messages: best.messageHashes.length,
      },
      divergence: {
        head: headFields,
        ...(messageIndex !== undefined ? { messageIndex } : {}),
        ...(recorded !== undefined ? { recorded } : {}),
        ...(current !== undefined ? { current } : {}),
      },
      description: `Replay cache miss (request ${key}, agent ${agent}): nearest recording shares ${prefix} of ${request.messageHashes.length} messages; ${detail}.${rejected ? ` A recording of this conversation exists, but ${rejected}.` : ''}`,
    };
  }
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Differences kept per hit: a long run of changed pages is one line in the ledger, not forty. */
const MAX_LOOSE_NOTES = 5;

function imageDifferences(
  recorded: readonly string[] | undefined,
  live: readonly string[],
): string[] {
  if (recorded === undefined) {
    return live.length > 0 ? ['screenshots: the recording does not say what they showed'] : [];
  }
  const same = recorded.length === live.length && recorded.every((hash, i) => hash === live[i]);
  return same ? [] : ['screenshots differ from the recorded ones'];
}

/** Whether `take` may answer `request`, a request of the same skeleton as `entry`'s. */
function compare(
  entry: CacheEntry,
  take: CacheTake,
  request: CanonicalRequest,
): { hit: CacheHit } | { rejected: string } {
  const { pages: recordedPages, idContexts } = entry;
  if (!recordedPages || !idContexts) {
    return {
      rejected: 'it was recorded before pages and ids were fingerprinted (record it again)',
    };
  }
  if (recordedPages.length !== request.pages.length) {
    return { rejected: 'it shows another number of pages' };
  }
  const contentType = take.headers['content-type'];
  // What the take does is only read when a page at the end of the request differs.
  let answer: Reaction | undefined;
  const reaction = (page: PageObservation): Reaction => {
    if (page.next) return page.next;
    answer ??= reactionTo(toolCallsOf(request.api, take.body, contentType));
    return answer;
  };
  const loose: string[] = [];
  for (const [k, page] of request.pages.entries()) {
    const recorded = recordedPages[k] as PageObservation;
    if (entry.messageHashes[recorded.index] === request.messageHashes[page.index]) continue;
    const label = `page #${page.index}`;
    const { waits, refs } = reaction(page);
    if (recorded.url === page.url && recorded.shape === page.shape) {
      if (refs)
        return { rejected: `${label} has other element refs and the recorded answer uses one` };
      loose.push(`${label}: same content, other refs or layout`);
    } else if (waits) {
      loose.push(
        recorded.url === page.url
          ? `${label}: caught in another state (${page.url})`
          : `${label}: caught at another hop (${recorded.url} recorded, ${page.url} now)`,
      );
    } else {
      return {
        rejected:
          recorded.url === page.url
            ? `${label} (${page.url}) does not show what was recorded and the recorded answer acts on it`
            : `${label} is another page (${recorded.url} recorded, ${page.url} now) and the recorded answer acts on it`,
      };
    }
  }
  const named = summarizeBody(request.api, take.body, contentType).outputText;
  const ids = pairIds(
    { ids: take.ids ?? [], contexts: idContexts },
    { ids: request.ids, contexts: request.idContexts },
    named,
  );
  if (!ids)
    return { rejected: 'an id the recorded answer names has no counterpart in this request' };
  loose.push(...imageDifferences(entry.images, request.images));
  const shown =
    loose.length > MAX_LOOSE_NOTES
      ? [...loose.slice(0, MAX_LOOSE_NOTES), `and ${loose.length - MAX_LOOSE_NOTES} more`]
      : loose;
  return { hit: { take, loose: shown, ids } };
}
