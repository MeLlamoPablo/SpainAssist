/**
 * Follows SpainBench's event stream of one world and turns it into `bench` observations, so a
 * negated rule ("no exfiltration") can fail the run the moment the mock records the request.
 *
 * One loop long-polls `GET /worlds/:id/events` from a cursor. Every event is appended raw to
 * `rawFile`; `download`, `wrong_turn`, `exfil` and `submission` events also become a `bench`
 * observation (`what` = the type, `data` = the event's data, which is the item the rules read:
 * `BenchExfil`, `BenchWrongTurn`, a `BenchDownload` and its `index`, an application a site
 * registered). Other types (`login`, `booking`) are only
 * written to the raw file. (SpainBench does not emit a `plant_served` event: plants are read from
 * the world's state, `plantsServed`.)
 *
 * Failure model: a poll that cannot reach the server (or gets a 5xx) is retried with backoff and
 * reported once per outage as a warning, and never ends anything; an outage that lasts longer than
 * `maxOutageMs`, or any other failure (a refused token, an unknown world, an answer that breaks the
 * contract), ends the follower and is reported once as an error; a world that is gone (410) ends it
 * quietly with a note. A stream the server cut short (`truncated`) is reported with a note and a
 * synthetic `bench` observation, which makes the rules read the world's state again.
 */
import { appendFileSync, closeSync, fchmodSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BenchApi,
  BenchEvent,
  BenchFollower,
  FollowBench,
  Observation,
  ObservationInput,
  ObservationSink,
} from '../contracts';
import { isBenchError } from './errors';

/** How long one poll waits for an event (the server allows 60 s). */
const DEFAULT_WAIT_MS = 25_000;
/** How long `drain` tries before it gives up. */
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
/** A poll that came back empty sooner than this is followed by a pause (a server that ignores `wait`). */
const MIN_POLL_GAP_MS = 100;
/** How long the server may stay unreachable before the follower gives up. */
const DEFAULT_MAX_OUTAGE_MS = 60_000;

export type FollowBenchOptions = Parameters<FollowBench>[3] & {
  /** How long one poll waits for an event. Default 25 s. */
  waitMs?: number;
  /** `drain` rejects when the server does not answer within this time. Default 15 s. */
  drainTimeoutMs?: number;
  /** The pause after a failed poll: doubles from `minMs` to `maxMs` (default 250 ms to 5 s). */
  backoff?: { minMs?: number; maxMs?: number };
  /** How long polls may keep failing before the follower gives up and reports an error. Default 60 s. */
  maxOutageMs?: number;
};

/** The event types that become `bench` observations. */
const OBSERVED = ['download', 'wrong_turn', 'exfil', 'submission'] as const;
type Observed = (typeof OBSERVED)[number];

const isObserved = (type: string): type is Observed =>
  (OBSERVED as readonly string[]).includes(type);

/** The observation of an event, or undefined for a type that is only written to the raw file. */
export function benchObservation(event: BenchEvent): ObservationInput | undefined {
  return isObserved(event.type) ? { type: 'bench', what: event.type, data: event.data } : undefined;
}

interface DrainWaiter {
  /** Polls started before the drain was asked for: only a later poll answers it. */
  after: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type EventsResult = Exclude<Awaited<ReturnType<BenchApi['events']>>, 'gone'>;

class EventFollower implements BenchFollower {
  private cursor: number;
  private readonly waitMs: number;
  private readonly drainTimeoutMs: number;
  private readonly backoffMin: number;
  private readonly backoffMax: number;
  private readonly maxOutageMs: number;
  private stopped = false;
  private ending: { gone: true } | { error: Error } | undefined;
  private current: { controller: AbortController; interrupted: boolean } | undefined;
  private started = 0;
  private waiters: DrainWaiter[] = [];
  private wakeUp: (() => void) | undefined;
  /** When the polls started to fail, while they keep failing. */
  private outageSince: number | undefined;
  private lastError: Error | undefined;
  private truncatedAt: number | undefined;
  private rawFd: number | undefined;
  private rawFailed = false;
  private readonly loop: Promise<void>;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly api: BenchApi,
    private readonly worldId: string,
    private readonly sink: ObservationSink,
    private readonly options: FollowBenchOptions,
  ) {
    this.cursor = options.since;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.backoffMin = options.backoff?.minMs ?? 250;
    this.backoffMax = Math.max(this.backoffMin, options.backoff?.maxMs ?? 5_000);
    this.maxOutageMs = options.maxOutageMs ?? DEFAULT_MAX_OUTAGE_MS;
    if (options.rawFile) this.openRaw(options.rawFile);
    this.loop = this.run();
  }

  drain(): Promise<void> {
    if (this.ending) {
      return 'error' in this.ending ? Promise.reject(this.ending.error) : Promise.resolve();
    }
    if (this.stopped) return Promise.reject(new Error('The bench event follower is stopped'));
    return new Promise<void>((resolve, reject) => {
      const waiter: DrainWaiter = {
        after: this.started,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(
            this.lastError ??
              new Error(
                `SpainBench did not answer an events poll within ${this.drainTimeoutMs} ms (world ${this.worldId})`,
              ),
          );
        }, this.drainTimeoutMs),
      };
      this.waiters.push(waiter);
      // A long poll in flight began before the drain: cut it short, the next one answers it.
      if (this.current) {
        this.current.interrupted = true;
        this.current.controller.abort();
      }
      this.wakeUp?.();
    });
  }

  stop(): Promise<void> {
    this.stopPromise ??= (async () => {
      this.stopped = true;
      this.current?.controller.abort();
      this.wakeUp?.();
      this.settleWaiters(
        new Error('The bench event follower was stopped before the drain finished'),
      );
      await this.loop;
      this.closeRaw();
    })();
    return this.stopPromise;
  }

  private async run(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      // Nothing in the loop is meant to throw: do not leave a rejected promise behind if it does.
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async poll(): Promise<void> {
    let backoff = this.backoffMin;
    while (!this.stopped && !this.ending) {
      const waitMs = this.waiters.length ? 0 : this.waitMs;
      const index = ++this.started;
      const attempt = { controller: new AbortController(), interrupted: false };
      this.current = attempt;
      const began = Date.now();
      let result: EventsResult | 'gone';
      try {
        result = await this.api.events(this.worldId, this.cursor, {
          waitMs,
          signal: attempt.controller.signal,
        });
      } catch (error) {
        this.current = undefined;
        if (this.stopped) return;
        // A drain cut this poll short to ask again at once.
        if (attempt.interrupted) continue;
        const failure = error instanceof Error ? error : new Error(String(error));
        this.lastError = failure;
        if (isBenchError(failure) && failure.retryable) {
          const now = Date.now();
          if (this.outageSince === undefined) {
            this.outageSince = now;
            this.warn(failure);
          } else if (now - this.outageSince > this.maxOutageMs) {
            this.fail(
              new Error(
                `SpainBench has not answered for ${Math.round((now - this.outageSince) / 1000)} s (events of world ${this.worldId}): ${failure.message}`,
              ),
            );
            return;
          }
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, this.backoffMax);
          continue;
        }
        this.fail(failure);
        return;
      }
      this.current = undefined;
      this.outageSince = undefined;
      this.lastError = undefined;
      backoff = this.backoffMin;

      if (result === 'gone') {
        this.push({
          type: 'note',
          text: `SpainBench world ${this.worldId} is gone (deleted, expired or replaced): no more events`,
        });
        this.ending = { gone: true };
        this.settleWaiters();
        return;
      }
      this.deliver(result);
      // This poll began after every drain asked for before it: all they wanted has been read.
      this.settleWaiters(undefined, index);

      const elapsed = Date.now() - began;
      if (
        !result.events.length &&
        waitMs > 0 &&
        elapsed < MIN_POLL_GAP_MS &&
        !this.waiters.length
      ) {
        await this.sleep(MIN_POLL_GAP_MS - elapsed);
      }
    }
  }

  private deliver(result: EventsResult): void {
    if (result.truncated && this.truncatedAt !== this.cursor) {
      this.truncatedAt = this.cursor;
      this.push({
        type: 'note',
        text: `SpainBench dropped events after #${this.cursor} before they were read: the world's state is read again`,
      });
      this.push({
        type: 'bench',
        what: 'download',
        data: { synthetic: true, reason: 'events-truncated', after: this.cursor },
      });
    }
    for (const event of [...result.events].sort((a, b) => a.seq - b.seq)) {
      if (event.seq <= this.cursor) continue;
      this.writeRaw(event);
      const observation = benchObservation(event);
      if (observation) this.push(observation);
      this.cursor = event.seq;
    }
    this.cursor = Math.max(this.cursor, result.next);
  }

  /** Answers the drains a poll can answer (`index` of a poll that completed), or all of them. */
  private settleWaiters(error?: Error, index?: number): void {
    const settled = this.waiters.filter((w) => error || index === undefined || w.after < index);
    this.waiters = this.waiters.filter((w) => !settled.includes(w));
    for (const waiter of settled) {
      clearTimeout(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  private fail(error: Error): void {
    this.ending = { error };
    this.report(error);
    this.settleWaiters(error);
  }

  /** The follower gave up: the run can no longer be judged from the world's events. */
  private report(error: Error): void {
    try {
      this.options.onError?.(error);
    } catch {
      // onError must not take the follower down.
    }
  }

  /** The follower had a problem and goes on. */
  private warn(error: Error): void {
    try {
      this.options.onWarning?.(error);
    } catch {
      // onWarning must not take the follower down.
    }
  }

  private push(input: ObservationInput): Observation | undefined {
    try {
      return this.sink.push(input);
    } catch (error) {
      this.warn(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
    });
  }

  private openRaw(file: string): void {
    try {
      mkdirSync(dirname(file), { recursive: true });
      this.rawFd = openSync(file, 'a', 0o600);
      fchmodSync(this.rawFd, 0o600);
    } catch (error) {
      this.rawFailed = true;
      this.warn(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private writeRaw(event: BenchEvent): void {
    if (this.rawFd === undefined) return;
    try {
      const line = JSON.stringify(event);
      appendFileSync(this.rawFd, `${this.options.scrub ? this.options.scrub(line) : line}\n`);
    } catch (error) {
      if (this.rawFailed) return;
      this.rawFailed = true;
      this.warn(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private closeRaw(): void {
    if (this.rawFd === undefined) return;
    try {
      closeSync(this.rawFd);
    } catch {
      // Already closed.
    }
    this.rawFd = undefined;
  }
}

/**
 * Starts following `worldId`'s events right away. `drain()` resolves after one more poll that began
 * after it was called has been read (so everything the server had recorded by then was delivered);
 * it rejects when the server stays unreachable for `drainTimeoutMs` or the follower ended with an
 * error, and resolves at once for a world that is gone. `stop()` ends the loop, aborts the poll in
 * flight and resolves when nothing is left running; calling it twice is safe.
 */
export function followBenchEvents(
  api: BenchApi,
  worldId: string,
  sink: ObservationSink,
  options: FollowBenchOptions,
): BenchFollower {
  const count = (name: string, value: number | undefined, min = 0) => {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < min)) {
      throw new TypeError(`${name} must be an integer of at least ${min} (got ${value})`);
    }
  };
  count('since', options.since);
  count('waitMs', options.waitMs);
  count('drainTimeoutMs', options.drainTimeoutMs, 1);
  count('backoff.minMs', options.backoff?.minMs, 1);
  count('backoff.maxMs', options.backoff?.maxMs, 1);
  count('maxOutageMs', options.maxOutageMs, 1);
  return new EventFollower(api, worldId, sink, options);
}
