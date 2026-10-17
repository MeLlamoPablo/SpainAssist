import { appendFileSync, closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalProvider } from '../contracts';
import { agentRole } from './cache';
import type { CostSource, TokenCounts } from './cost';
import { ensurePrivateDir } from './home';

/**
 * The spend ledger: append-only JSONL under `<home>/ledger/spend-YYYY-MM.jsonl`, one line per
 * model request (forwarded, replayed from the cache or refused) plus `epoch` lines
 * that reset the lifetime total. Several eval processes may append at once: every line is one
 * `O_APPEND` write of a few hundred bytes, and readers tolerate a torn last line and keep their
 * byte offsets, so the totals are cheap to refresh before every budget decision.
 *
 * Only forwarded requests of the `voucher` provider are real spend. Replays carry the cost they
 * had live, flagged virtual, and are never added to the totals the caps use. The `mock` provider
 * is free.
 *
 * A request is on the books from the moment it starts, not when it ends: before a request goes
 * upstream the meter appends a `reserve` line with its worst-case cost and a request id (`rid`),
 * and the `forward` line that settles it carries the same `rid` (a request that is refused after
 * all, or ends with no response, gets a `release` line). Until one of those comes the worst case
 * counts as spent, for every process that reads the ledger: parallel evals cannot all spend the
 * same headroom, a Codex request is counted when it starts, and a process killed mid-request
 * leaves a conservative charge instead of nothing. Reservation lines have their own `type`, so
 * the copy of a run's lines (`llm/meter.jsonl`) holds one line per request as before.
 */

type LedgerKind = 'forward' | 'replay' | 'reject';

export interface LedgerRequest {
  type: 'request';
  v: 1;
  /** ISO time. */
  ts: string;
  runId: string;
  agent: string;
  provider: EvalProvider;
  model?: string;
  kind: LedgerKind;
  /** Why a request was refused (`reject` lines): a `CapReason`, `replay_miss` or `path_not_allowed`. */
  reason?: string;
  /** Upstream path of the request (no query). */
  path: string;
  status?: number;
  ms?: number;
  ttfbMs?: number;
  stream?: boolean;
  aborted?: boolean;
  /** First 16 hex characters of the canonical request hash. */
  reqHash?: string;
  occurrence?: number;
  cache?: 'hit' | 'miss' | 'off';
  /** A replay that was not an exact replay of its recording: `looseWhy` says what differed. */
  loose?: boolean;
  looseWhy?: string[];
  variant?: string;
  /** The reservation this line settles (`forward` lines): see `Ledger.reserve`. */
  rid?: string;
  usage?: TokenCounts;
  cost?: { usd: number; source: CostSource; estimateUsd?: number; virtual?: boolean };
  /** Codex: what the tokens would cost on the API; informational, the plan is metered by request. */
  apiEquivalentUsd?: number;
  /** The gateway's own accounting, as it reported it (spend is one call behind). */
  litellm?: { keySpendUsd?: number; keyMaxBudgetUsd?: number; responseCostUsd?: number };
  /** Codex rate-limit headers, verbatim (`x-codex-*`, `x-ratelimit-*`, `retry-after`). */
  limitHeaders?: Record<string, string>;
  finish?: string;
  /** Redacted, at most a few hundred characters. */
  error?: string;
  /** The gateway or plan itself refused (LiteLLM budget, Codex usage limit). */
  gatewayLimit?: boolean;
}

export type LedgerRecord = Omit<LedgerRequest, 'type' | 'v' | 'ts'> & { ts?: string };

interface LedgerEpoch {
  type: 'epoch';
  v: 1;
  ts: string;
  note?: string;
}

/** A request about to go upstream: counted as spent (its worst case) until it settles. */
interface LedgerReserve {
  type: 'reserve';
  v: 1;
  ts: string;
  rid: string;
  run: string;
  agent: string;
  provider: EvalProvider;
  model?: string;
  path: string;
  /** The worst-case cost (voucher; 0 for the others). */
  usd: number;
}

interface LedgerRelease {
  type: 'release';
  v: 1;
  ts: string;
  rid: string;
}

export type ReserveInput = Omit<LedgerReserve, 'type' | 'v' | 'ts'>;

interface Pending {
  usd: number;
  ts: string;
  atMs: number;
  provider: EvalProvider;
  day: string;
}

export interface LedgerSummary {
  /** Real USD since the last epoch. */
  sinceEpochUsd: number;
  allTimeUsd: number;
  /** Real USD by UTC day. */
  byDay: Record<string, number>;
  byRun: Record<
    string,
    { usd: number; requests: number; replays: number; looseReplays: number; rejects: number }
  >;
  /** By agent role (`procedure-3` counts as `procedure`). */
  byAgent: Record<string, { usd: number; requests: number }>;
  byModel: Record<string, { usd: number; requests: number }>;
  /** What the cache hits would have cost live. */
  replayedUsd: number;
  /** Of the replays, those that were not an exact replay of their recording. */
  looseReplays: number;
  requests: { forward: number; replay: number; reject: number };
  /** Forwarded Codex requests, all time (informational: Codex use is not capped). */
  codex: { total: number };
  /** Reserved and not settled yet: in flight now, or left by a process that died. */
  pending: { requests: number; usd: number; oldest?: string };
  /** The last `x-litellm-key-*` headers seen. */
  lastKey?: { spendUsd: number; maxBudgetUsd: number; at: string };
  lastEpochAt?: string;
}

const MAX_ERROR_CHARS = 400;

export class Ledger {
  private readonly offsets = new Map<string, { offset: number; tail: string }>();
  private sinceEpochUsd = 0;
  private allTimeUsd = 0;
  private readonly byDay = new Map<string, number>();
  private readonly byRun = new Map<
    string,
    { usd: number; requests: number; replays: number; looseReplays: number; rejects: number }
  >();
  private readonly byAgent = new Map<string, { usd: number; requests: number }>();
  private readonly byModel = new Map<string, { usd: number; requests: number }>();
  private replayedUsd = 0;
  private looseReplays = 0;
  private readonly requests = { forward: 0, replay: 0, reject: 0 };
  private codexTotal = 0;
  private lastKey: LedgerSummary['lastKey'];
  private lastEpochAt: string | undefined;
  private lastEpochMs: number | undefined;
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.refresh();
  }

  /** Appends one request line and folds everything written since the last refresh into the totals. */
  append(record: LedgerRecord): LedgerRequest {
    const entry: LedgerRequest = {
      type: 'request',
      v: 1,
      ...record,
      ts: record.ts ?? this.clock().toISOString(),
      ...(record.error ? { error: record.error.slice(0, MAX_ERROR_CHARS) } : {}),
    };
    this.write(entry.ts, entry);
    return entry;
  }

  /** Resets the lifetime total (the next ceiling check starts from zero). */
  epoch(note?: string): void {
    const ts = this.clock().toISOString();
    this.write(ts, { type: 'epoch', v: 1, ts, ...(note ? { note } : {}) });
  }

  /**
   * Puts a request on the books before it goes upstream (see the top of this file). Settle it by
   * appending its `forward` line with the same `rid`, or `release` it.
   */
  reserve(input: ReserveInput): void {
    const ts = this.clock().toISOString();
    this.write(ts, { type: 'reserve', v: 1, ts, ...input });
  }

  /** Takes a reservation off the books: the request was never sent, or ended with no response. */
  release(rid: string): void {
    const ts = this.clock().toISOString();
    this.write(ts, { type: 'release', v: 1, ts, rid });
  }

  private write(
    ts: string,
    line: LedgerRequest | LedgerEpoch | LedgerReserve | LedgerRelease,
  ): void {
    ensurePrivateDir(this.dir);
    appendFileSync(join(this.dir, `spend-${ts.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`, {
      mode: 0o600,
    });
    this.refresh();
  }

  /** Reads what other processes (and we) appended since the last call. */
  refresh(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir)
        .filter((name) => /^spend-\d{4}-\d{2}\.jsonl$/.test(name))
        .sort();
    } catch {
      return;
    }
    for (const name of files) {
      const path = join(this.dir, name);
      const state = this.offsets.get(path) ?? { offset: 0, tail: '' };
      let size: number;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      if (size <= state.offset) continue;
      const buffer = Buffer.alloc(size - state.offset);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, buffer.length, state.offset);
      } finally {
        closeSync(fd);
      }
      const text = state.tail + buffer.toString('utf8');
      const lastNewline = text.lastIndexOf('\n');
      const complete = lastNewline === -1 ? '' : text.slice(0, lastNewline);
      state.tail = lastNewline === -1 ? text : text.slice(lastNewline + 1);
      state.offset = size;
      this.offsets.set(path, state);
      for (const line of complete.split('\n')) if (line.trim()) this.ingest(line);
    }
  }

  private ingest(line: string): void {
    let entry: LedgerRequest | LedgerEpoch | LedgerReserve | LedgerRelease;
    try {
      entry = JSON.parse(line) as LedgerRequest | LedgerEpoch | LedgerReserve | LedgerRelease;
    } catch {
      return;
    }
    if (entry.type === 'epoch') {
      this.sinceEpochUsd = 0;
      this.lastEpochAt = entry.ts;
      this.lastEpochMs = Date.parse(entry.ts);
      return;
    }
    if (entry.type === 'reserve') {
      const atMs = Date.parse(entry.ts);
      this.pending.set(entry.rid, {
        usd: entry.usd,
        ts: entry.ts,
        atMs,
        provider: entry.provider,
        day: entry.ts.slice(0, 10),
      });
      if (entry.provider === 'codex') this.codexTotal++;
      return;
    }
    if (entry.type === 'release') {
      const released = this.pending.get(entry.rid);
      if (!released) return;
      this.pending.delete(entry.rid);
      if (released.provider === 'codex') this.codexTotal--;
      return;
    }
    if (entry.type !== 'request') return;
    const run = this.byRun.get(entry.runId) ?? {
      usd: 0,
      requests: 0,
      replays: 0,
      looseReplays: 0,
      rejects: 0,
    };
    this.byRun.set(entry.runId, run);
    if (entry.kind === 'reject') {
      this.requests.reject++;
      run.rejects++;
      return;
    }
    if (entry.kind === 'replay') {
      this.requests.replay++;
      run.replays++;
      if (entry.loose) {
        this.looseReplays++;
        run.looseReplays++;
      }
      this.replayedUsd += entry.cost?.usd ?? 0;
      return;
    }
    const reserved = entry.rid ? this.pending.get(entry.rid) : undefined;
    if (entry.rid) this.pending.delete(entry.rid);
    this.requests.forward++;
    run.requests++;
    const usd = entry.provider === 'voucher' ? (entry.cost?.usd ?? 0) : 0;
    run.usd += usd;
    this.sinceEpochUsd += usd;
    this.allTimeUsd += usd;
    const day = entry.ts.slice(0, 10);
    this.byDay.set(day, (this.byDay.get(day) ?? 0) + usd);
    const role = agentRole(entry.agent);
    const agent = this.byAgent.get(role) ?? { usd: 0, requests: 0 };
    agent.usd += usd;
    agent.requests++;
    this.byAgent.set(role, agent);
    if (entry.model) {
      const model = this.byModel.get(entry.model) ?? { usd: 0, requests: 0 };
      model.usd += usd;
      model.requests++;
      this.byModel.set(entry.model, model);
    }
    // A Codex request was counted when it was reserved.
    if (entry.provider === 'codex' && !reserved) this.codexTotal++;
    const key = entry.litellm;
    if (key?.keySpendUsd !== undefined && key.keyMaxBudgetUsd !== undefined) {
      this.lastKey = { spendUsd: key.keySpendUsd, maxBudgetUsd: key.keyMaxBudgetUsd, at: entry.ts };
    }
  }

  /** Real USD since the last epoch (call `refresh()` first for other processes' lines). */
  spentSinceEpochUsd(): number {
    return this.sinceEpochUsd;
  }

  spentOnDayUsd(day: string): number {
    return this.byDay.get(day) ?? 0;
  }

  spentTodayUsd(): number {
    return this.spentOnDayUsd(this.clock().toISOString().slice(0, 10));
  }

  /**
   * The worst case of the voucher requests that are reserved and not settled (call `refresh()`
   * first for other processes' lines). `day` keeps those reserved on that UTC day; `sinceMs` those
   * reserved at or after that time: a request that is still in flight is recent, an older
   * reservation belongs to a process that died.
   */
  pendingUsd(filter: { day?: string; sinceMs?: number } = {}): number {
    let total = 0;
    for (const reservation of this.pending.values()) {
      if (reservation.provider !== 'voucher') continue;
      if (filter.day !== undefined && reservation.day !== filter.day) continue;
      if (filter.sinceMs !== undefined && reservation.atMs < filter.sinceMs) continue;
      total += reservation.usd;
    }
    return total;
  }

  /** `pendingUsd` of the current epoch: what the lifetime ceiling counts. */
  pendingSinceEpochUsd(): number {
    return this.pendingUsd(this.lastEpochMs !== undefined ? { sinceMs: this.lastEpochMs } : {});
  }

  private pendingSummary(): LedgerSummary['pending'] {
    let oldest: string | undefined;
    for (const reservation of this.pending.values()) {
      if (oldest === undefined || reservation.ts < oldest) oldest = reservation.ts;
    }
    return {
      requests: this.pending.size,
      usd: this.pendingUsd(),
      ...(oldest !== undefined ? { oldest } : {}),
    };
  }

  summary(): LedgerSummary {
    return {
      sinceEpochUsd: this.sinceEpochUsd,
      allTimeUsd: this.allTimeUsd,
      byDay: Object.fromEntries(this.byDay),
      byRun: Object.fromEntries(this.byRun),
      byAgent: Object.fromEntries(this.byAgent),
      byModel: Object.fromEntries(this.byModel),
      replayedUsd: this.replayedUsd,
      looseReplays: this.looseReplays,
      requests: { ...this.requests },
      codex: { total: this.codexTotal },
      pending: this.pendingSummary(),
      ...(this.lastKey ? { lastKey: this.lastKey } : {}),
      ...(this.lastEpochAt ? { lastEpochAt: this.lastEpochAt } : {}),
    };
  }
}
