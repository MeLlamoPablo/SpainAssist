import { randomUUID } from 'node:crypto';
import type { ResearchEvent, ResearchMode, ResearchRequest, ResearchRunInfo } from '@sa/shared';
import { sha256Hex } from '../crypto';
import type { Db } from '../db/types';
import { errorSummary, HttpError } from '../errors';
import type { Logger } from '../logger';
import { type KeyProvisioner, roundUsd } from '../providers/key-provisioner';
import * as store from '../store';
import {
  PARALLEL_PROCESSOR_PRICES,
  ResearchRejected,
  type ResearchUpstream,
  type RunPoll,
} from './parallel';

export interface ResearchSettings {
  /** The Parallel processor of each mode and the price of one run in USD, taken from the key. */
  modes: Readonly<Record<ResearchMode, { processor: string; priceUsd: number }>>;
  /** Runs a key may have in flight at once. */
  maxActivePerKey: number;
  /** After this many minutes without a result we stop following a run (it stays charged). */
  maxMinutes: number;
  /** How long one result request to Parallel waits (also the progress/keep-alive interval). */
  pollSeconds: number;
}

const mode = (processor: string) => ({
  processor,
  priceUsd: PARALLEL_PROCESSOR_PRICES[processor]!,
});

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  modes: { fast: mode('lite'), balanced: mode('core'), deep: mode('pro') },
  maxActivePerKey: 3,
  maxMinutes: 30,
  pollSeconds: 25,
};

/** A `reserved` run older than this was interrupted before Parallel had it: refund it. */
const STALE_RESERVATION_MS = 10 * 60_000;
/** How long a finished run's outcome stays in memory for clients that reconnect. */
const KEEP_FINISHED_MS = 5 * 60_000;

export interface ResearchServiceDeps {
  db: Db;
  provisioner: KeyProvisioner;
  upstream: ResearchUpstream;
  settings: ResearchSettings;
  logger: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type FinalEvent = Extract<ResearchEvent, { type: 'completed' | 'failed' }>;

/** In-memory follower of one run: settles it and fans its events out to connected clients. */
interface Follower {
  id: string;
  createdAtMs: number;
  status: 'queued' | 'running';
  listeners: Set<(event: ResearchEvent) => void>;
  final?: FinalEvent;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Web research through Parallel's Task API, paid from voucher keys' LiteLLM budgets.
 *
 * Charging: the price is reserved by LOWERING the key's `max_budget` in LiteLLM (never by
 * writing `spend`, which LiteLLM's own batch writer keeps updating from chat and search calls).
 * Every budget change runs in a transaction that holds the key's `issued_keys` row lock, so
 * concurrent requests of one key read and move the cap one at a time, and the run's state change
 * commits together with it. A failed run gives the price back (Parallel bills only completed
 * runs); a completed or abandoned one keeps it.
 *
 * Runs are followed in the background, independent of the client's connection: a client that
 * disconnects does not stop the run (Parallel has no cancel for task runs) nor its settlement.
 * After a restart `resume()` picks up unfinished runs.
 */
export class ResearchService {
  private readonly followers = new Map<string, Follower>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ResearchServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepFor;
  }

  get settings(): ResearchSettings {
    return this.deps.settings;
  }

  /** The voucher key behind a bearer token, or 401. Only active voucher keys qualify. */
  async authenticate(token: string | null): Promise<store.VoucherKey> {
    const key = token?.startsWith('sk-')
      ? await store.findVoucherKeyByHash(this.deps.db, sha256Hex(token))
      : null;
    if (!key || key.provider !== this.deps.provisioner.kind) {
      throw new HttpError(401, 'unauthorized', 'This key cannot use web research.', {
        'WWW-Authenticate': 'Bearer',
      });
    }
    return key;
  }

  /**
   * Reserves the price, creates the Parallel run and starts following it. With a `requestId`
   * already used by this key, returns that run instead (no new charge).
   */
  async start(key: store.VoucherKey, request: ResearchRequest): Promise<store.ResearchRun> {
    const { db, settings, logger } = this.deps;
    const { processor, priceUsd: price } = settings.modes[request.mode];
    let lowered = false;
    let reserved: { run: store.ResearchRun; existing: boolean };
    try {
      reserved = await db.transaction(async (tx) => {
        await store.lockIssuedKey(tx, key.id);
        if (request.requestId) {
          const existing = await store.findRunByRequestId(tx, key.id, request.requestId);
          if (existing) return { run: existing, existing: true };
        }
        if ((await store.countActiveRuns(tx, key.id)) >= settings.maxActivePerKey) {
          throw new HttpError(
            429,
            'rate_limited',
            'Too many research runs at once. Wait for one to finish.',
          );
        }
        const budget = await this.budgetOf(key.keyHash);
        if (!budget?.active) {
          throw new HttpError(401, 'unauthorized', 'This key cannot use web research.');
        }
        if (budget.maxBudgetUsd === null) {
          throw new HttpError(403, 'unauthorized', 'This key has no spending cap.');
        }
        if (budget.maxBudgetUsd - budget.spendUsd < price - 1e-9) {
          throw new HttpError(
            402,
            'insufficient_budget',
            'Not enough credit left for web research.',
          );
        }
        const run = await store.insertResearchRun(tx, {
          id: randomUUID(),
          issuedKeyId: key.id,
          requestId: request.requestId,
          processor,
          priceUsd: price,
        });
        // Last step: if it fails, the transaction rolls back and nothing was reserved.
        await this.setCap(key.keyHash, budget.maxBudgetUsd - price);
        lowered = true;
        return { run, existing: false };
      });
    } catch (err) {
      if (lowered) {
        // The cap moved but the run was not recorded (commit failed): give the price back.
        logger.error('research reservation not recorded', { error: errorSummary(err) });
        await this.moveCap(key, price).catch((moveErr) =>
          logger.error('could not undo a research reservation', {
            error: errorSummary(moveErr),
          }),
        );
      }
      throw err;
    }
    if (reserved.existing) return reserved.run;

    const { run } = reserved;
    const follower = this.register(run.id, this.now());
    let parallelRunId: string;
    try {
      parallelRunId = await this.deps.upstream.create({
        input: request.input,
        ...(request.outputSchema !== undefined ? { outputSchema: request.outputSchema } : {}),
        processor,
        metadata: { sa_run: run.id },
      });
    } catch (err) {
      await this.refund(run.id);
      // Idempotent retries may be waiting on this run.
      this.emit(follower, {
        type: 'failed',
        id: run.id,
        code: 'failed',
        message: 'The research did not start. It was not charged.',
        charged: false,
      });
      logger.warn('research run not created', { runId: run.id, error: errorSummary(err) });
      if (err instanceof ResearchRejected) {
        throw new HttpError(400, 'bad_request', 'The research request was rejected.');
      }
      throw new HttpError(502, 'provider_error', 'Could not start the research. Try again later.');
    }
    await store.markRunStarted(db, run.id, parallelRunId).catch((err) => {
      // Keep following in memory; settling still updates the row.
      logger.error('could not record research start', {
        runId: run.id,
        error: errorSummary(err),
      });
    });
    logger.info('research started', { runId: run.id, processor });
    const started = { ...run, state: 'running' as const, parallelRunId };
    void this.follow(follower, started);
    return started;
  }

  /** A run of this key (404 otherwise). */
  async find(key: store.VoucherKey, id: string): Promise<store.ResearchRun> {
    const run = await store.findRun(this.deps.db, key.id, id);
    if (!run) throw new HttpError(404, 'not_found', 'Research run not found.');
    return run;
  }

  async info(run: store.ResearchRun): Promise<ResearchRunInfo> {
    const base = {
      id: run.id,
      priceUsd: run.priceUsd,
      charged: ['reserved', 'running', 'completed', 'expired'].includes(run.state),
      createdAt: run.createdAt,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    };
    switch (run.state) {
      case 'reserved':
      case 'running':
        return { ...base, status: 'running' };
      case 'refunding':
      case 'refunded':
        return { ...base, status: 'failed' };
      case 'expired':
        return { ...base, status: 'expired' };
      case 'completed': {
        const final = this.followers.get(run.id)?.final;
        if (final?.type === 'completed')
          return { ...base, status: 'completed', output: final.output };
        const poll = await this.pollOnce(run);
        return {
          ...base,
          status: 'completed',
          ...(poll?.kind === 'completed' ? { output: poll.output } : {}),
        };
      }
    }
  }

  /**
   * Events of a run for one client: `created`, then progress until `completed` or `failed`.
   * Ends early when `signal` aborts (the client left); the run itself goes on.
   */
  async *events(run: store.ResearchRun, signal?: AbortSignal): AsyncGenerator<ResearchEvent> {
    yield { type: 'created', id: run.id, priceUsd: run.priceUsd };
    let follower = this.followers.get(run.id);
    if (!follower) {
      const fresh = await store.findRunById(this.deps.db, run.id);
      if (fresh?.state === 'running' && fresh.parallelRunId) {
        follower =
          this.followers.get(run.id) ?? this.register(fresh.id, Date.parse(fresh.createdAt));
        void this.follow(follower, fresh);
      } else {
        yield await this.settledEvent(fresh ?? run);
        return;
      }
    }
    if (follower.final) {
      yield follower.final;
      return;
    }

    const queue: ResearchEvent[] = [];
    let wake: (() => void) | undefined;
    const listener = (event: ResearchEvent) => {
      queue.push(event);
      wake?.();
    };
    const onAbort = () => wake?.();
    follower.listeners.add(listener);
    signal?.addEventListener('abort', onAbort);
    try {
      for (;;) {
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (event.type === 'completed' || event.type === 'failed') return;
        }
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      follower.listeners.delete(listener);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Housekeeping (startup and hourly): follow `running` runs nobody follows (after a restart),
   * refund interrupted reservations and retry failed refunds.
   */
  async resume(): Promise<{ followed: number; refunded: number }> {
    const { db } = this.deps;
    let followed = 0;
    let refunded = 0;
    for (const run of await store.pendingRuns(db)) {
      if (this.followers.has(run.id)) continue;
      if (run.state === 'running' && run.parallelRunId) {
        void this.follow(this.register(run.id, Date.parse(run.createdAt)), run);
        followed++;
      } else if (
        run.state === 'refunding' ||
        (run.state === 'reserved' && this.now() - Date.parse(run.createdAt) > STALE_RESERVATION_MS)
      ) {
        if ((await this.refund(run.id)) === 'refunded') refunded++;
      }
    }
    return { followed, refunded };
  }

  // --- internals ---------------------------------------------------------------------------

  private register(id: string, createdAtMs: number): Follower {
    const follower: Follower = { id, createdAtMs, status: 'queued', listeners: new Set() };
    this.followers.set(id, follower);
    return follower;
  }

  private emit(follower: Follower, event: ResearchEvent): void {
    if (event.type === 'completed' || event.type === 'failed') {
      follower.final = event;
      setTimeout(() => {
        if (this.followers.get(follower.id) === follower) this.followers.delete(follower.id);
      }, KEEP_FINISHED_MS).unref();
    }
    for (const listener of follower.listeners) listener(event);
  }

  /** Polls Parallel until the run completes, fails or times out, and settles the charge. */
  private async follow(follower: Follower, run: store.ResearchRun): Promise<void> {
    const { settings, logger, db } = this.deps;
    const deadline = follower.createdAtMs + settings.maxMinutes * 60_000;
    let errors = 0;
    try {
      for (;;) {
        const started = this.now();
        const waitSeconds = Math.max(
          1,
          Math.min(settings.pollSeconds, (deadline - started) / 1000),
        );
        let poll: RunPoll | undefined;
        try {
          poll = await this.deps.upstream.poll(run.parallelRunId!, waitSeconds);
          errors = 0;
        } catch (err) {
          errors++;
          logger.warn('research poll failed', { runId: run.id, error: errorSummary(err) });
        }
        if (poll?.kind === 'completed') {
          await store.settleRun(db, run.id, 'completed');
          logger.info('research completed', { runId: run.id });
          this.emit(follower, { type: 'completed', id: run.id, output: poll.output });
          return;
        }
        if (poll?.kind === 'failed') {
          await this.refund(run.id);
          logger.info('research failed upstream', { runId: run.id });
          this.emit(follower, {
            type: 'failed',
            id: run.id,
            code: 'failed',
            message: 'The research run failed. It was not charged.',
            charged: false,
          });
          return;
        }
        if (this.now() >= deadline) {
          await store.settleRun(db, run.id, 'expired');
          logger.warn('research timed out', { runId: run.id });
          this.emit(follower, {
            type: 'failed',
            id: run.id,
            code: 'timeout',
            message: 'The research took too long. It may still have been charged.',
            charged: true,
          });
          return;
        }
        if (poll) follower.status = poll.status;
        this.emit(follower, {
          type: 'progress',
          id: run.id,
          status: follower.status,
          elapsedSeconds: Math.max(0, Math.round((this.now() - follower.createdAtMs) / 1000)),
        });
        if (!poll) await this.sleep(Math.min(30_000, 1000 * 2 ** Math.min(errors, 5)));
        else if (this.now() - started < 1000) await this.sleep(1000);
      }
    } catch (err) {
      // Database trouble while settling: the run stays pending and resume() retries it.
      logger.error('research follow failed', { runId: run.id, error: errorSummary(err) });
      this.followers.delete(run.id);
      this.emit(follower, {
        type: 'failed',
        id: run.id,
        code: 'unavailable',
        message: 'Lost track of the research. Ask for its result again later.',
        charged: true,
      });
    }
  }

  private async settledEvent(run: store.ResearchRun): Promise<ResearchEvent> {
    switch (run.state) {
      case 'completed': {
        const poll = await this.pollOnce(run);
        if (poll?.kind === 'completed')
          return { type: 'completed', id: run.id, output: poll.output };
        return {
          type: 'failed',
          id: run.id,
          code: 'unavailable',
          message: 'The research finished but its result could not be fetched. Try again later.',
          charged: true,
        };
      }
      case 'expired':
        return {
          type: 'failed',
          id: run.id,
          code: 'timeout',
          message: 'The research took too long. It may still have been charged.',
          charged: true,
        };
      case 'refunded':
      case 'refunding':
        return {
          type: 'failed',
          id: run.id,
          code: 'failed',
          message: 'The research run failed. It was not charged.',
          charged: false,
        };
      default:
        // `reserved` without a follower: interrupted before Parallel had it (refunded later).
        return {
          type: 'failed',
          id: run.id,
          code: 'unavailable',
          message: 'The research did not start. It will not be charged.',
          charged: false,
        };
    }
  }

  private async pollOnce(run: store.ResearchRun): Promise<RunPoll | undefined> {
    if (!run.parallelRunId) return undefined;
    try {
      return await this.deps.upstream.poll(run.parallelRunId, 1);
    } catch (err) {
      this.deps.logger.warn('research result fetch failed', {
        runId: run.id,
        error: errorSummary(err),
      });
      return undefined;
    }
  }

  /**
   * Gives a failed run's price back to its key, once: the state change and the cap change share
   * one transaction under the key's row lock. If LiteLLM fails, the run is left `refunding` and
   * resume() retries.
   */
  async refund(runId: string): Promise<'refunded' | 'settled' | 'pending'> {
    const { db, logger } = this.deps;
    try {
      return await db.transaction(async (tx) => {
        const owner = await store.runOwner(tx, runId);
        if (!owner) return 'settled' as const;
        await store.lockIssuedKey(tx, owner.issuedKeyId);
        const price = await store.markRunRefunded(tx, runId);
        if (price === null) return 'settled' as const;
        const budget = await this.budgetOf(owner.keyHash);
        // An unknown key (deleted upstream) has nothing to give back to.
        if (budget && budget.maxBudgetUsd !== null) {
          await this.setCap(owner.keyHash, budget.maxBudgetUsd + price);
        }
        return 'refunded' as const;
      });
    } catch (err) {
      logger.error('research refund failed', { runId, error: errorSummary(err) });
      await store.markRunRefunding(db, runId).catch(() => {});
      return 'pending';
    }
  }

  /** Moves a key's cap by `deltaUsd` under its row lock (used to undo a lost reservation). */
  private async moveCap(key: store.VoucherKey, deltaUsd: number): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      await store.lockIssuedKey(tx, key.id);
      const budget = await this.budgetOf(key.keyHash);
      if (budget && budget.maxBudgetUsd !== null) {
        await this.setCap(key.keyHash, budget.maxBudgetUsd + deltaUsd);
      }
    });
  }

  private async budgetOf(keyHash: string) {
    try {
      return await this.deps.provisioner.budget(keyHash);
    } catch (err) {
      this.deps.logger.error('key budget read failed', { error: errorSummary(err) });
      throw new HttpError(502, 'provider_error', 'Could not check your credit. Try again later.');
    }
  }

  private async setCap(keyHash: string, maxBudgetUsd: number): Promise<void> {
    try {
      await this.deps.provisioner.setMaxBudget(keyHash, roundUsd(Math.max(0, maxBudgetUsd)));
    } catch (err) {
      this.deps.logger.error('key budget update failed', { error: errorSummary(err) });
      throw new HttpError(502, 'provider_error', 'Could not reserve your credit. Try again later.');
    }
  }
}
