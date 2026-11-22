import type { BridgeResults, UiEvent, UiNode } from '@sa/shared';
import { BridgeError, type BridgeTransport } from '../bridge/client';
import { hostLog } from '../host/log';
import { createHostOps, type HostOpsDeps, type ImageStore } from './host-ops';
import { CodeRun, type DurableStore, type RunOutcome } from './run';

/**
 * Runs codemode modules in the agent host: one CodeRun per `codemode` call, the agent's durable
 * state in the app (bridge `run.*`), the user's events long-polled from the app and dispatched
 * into the run. A run outlives the tool call that started it when it waits for the user (or runs
 * long): the tool returns, and the app hands its outcome to the agent as a message.
 */

export interface StartInput {
  source: string;
  procedures?: string[];
  title?: string;
  /** Resume this run of the agent's (it waits for the user) instead of starting a new one. */
  runId?: string;
}

export interface EngineOutcome {
  runId: string;
  title?: string;
  /** `detached`: still running (waiting for the user, or long); its outcome comes as a message. */
  status: RunOutcome['status'] | 'detached';
  outcome?: RunOutcome;
  openUi: string[];
  /** What this run's api.search calls found (memoized ones are not searched again). */
  searches: Search[];
}

export interface Search {
  query: string;
  text: string;
}

/**
 * Whether the model has seen search results in an earlier report (see `markResearched`). The
 * host keeps it in the agent's session, so it survives the process ending.
 */
export interface ResearchLog {
  has(): boolean;
  add(): void;
}

export interface EngineDeps extends Omit<HostOpsDeps, 'procedures' | 'images' | 'bridge'> {
  bridge: BridgeTransport;
  images: ImageStore;
  /** Return after this long even without an interface (steering stays possible). */
  detachAfterMs: number;
  /** Where "search results reached the model" is kept; in memory without it. */
  researchLog?: ResearchLog;
  /** Gets each run's timeline when it ends (for traces; never the model's context). */
  onRunTrace?: (trace: RunTrace) => void;
}

/** One `api.*` call of a run, or an interface from when it opened until it closed. */
export interface RunTraceCall {
  /** The host operation (`browser.click`, `procedures.update`...), or `ui` for an interface. */
  op: string;
  /** The page's URL, or the interface's key. */
  label?: string;
  /** Epoch milliseconds. */
  start: number;
  ms: number;
  /** The error the module got (code and message, cut). */
  error?: string;
}

/**
 * What a run did and when, for trace viewers (`tools/trace-viewer`): the host stores it in the
 * agent's session file, outside the model's context. Op names and URLs only: no arguments or
 * results beyond what the session already holds.
 */
export interface RunTrace {
  runId: string;
  title?: string;
  startedAt: number;
  endedAt: number;
  status: RunOutcome['status'];
  /** In start order; at most MAX_TRACE_CALLS (the first ones). */
  calls: RunTraceCall[];
  /** Calls left out past MAX_TRACE_CALLS. */
  droppedCalls?: number;
}

/** Calls a run's trace keeps. */
const MAX_TRACE_CALLS = 500;

/** A run's trace while it runs. */
class TraceRecorder {
  readonly startedAt = Date.now();
  private readonly calls: RunTraceCall[] = [];
  private readonly openUis = new Map<string, number>();
  private dropped = 0;

  async time<T>(op: string, label: string | undefined, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.add({ op, label, start });
      return result;
    } catch (error) {
      this.add({ op, label, start, error: traceError(error) });
      throw error;
    }
  }

  uiOpened(key: string): void {
    if (!this.openUis.has(key)) this.openUis.set(key, Date.now());
  }

  uiClosed(key: string): void {
    const start = this.openUis.get(key);
    if (start === undefined) return;
    this.openUis.delete(key);
    this.add({ op: 'ui', label: key, start });
  }

  finish(base: Pick<RunTrace, 'runId' | 'title' | 'status'>): RunTrace {
    // Interfaces still open when the run ended were withdrawn with it.
    for (const key of [...this.openUis.keys()]) this.uiClosed(key);
    const calls = [...this.calls].sort((a, b) => a.start - b.start);
    return {
      ...base,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      calls,
      ...(this.dropped ? { droppedCalls: this.dropped } : {}),
    };
  }

  private add(call: { op: string; label?: string; start: number; error?: string }): void {
    if (this.calls.length >= MAX_TRACE_CALLS) {
      this.dropped++;
      return;
    }
    this.calls.push({
      op: call.op,
      ...(call.label ? { label: call.label.slice(0, 200) } : {}),
      start: call.start,
      ms: Date.now() - call.start,
      ...(call.error ? { error: call.error } : {}),
    });
  }
}

function traceError(error: unknown): string {
  const code =
    typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  const message = error instanceof Error ? error.message : String(error);
  return (code ? `${code}: ${message}` : message).slice(0, 300);
}

function traceLabel(args: unknown): string | undefined {
  const url = (args as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? url : undefined;
}

interface LiveRun {
  run: CodeRun;
  runId: string;
  title?: string;
  trace: TraceRecorder;
  deliver: boolean;
  searches: Search[];
  /** Dispatches the events that wait for an interface to open (set by `pollEvents`). */
  flushWaiting?: () => void;
}

export class RunEngine {
  private readonly live = new Map<string, LiveRun>();
  private resumer?: ReturnType<typeof setInterval>;
  private resuming = false;
  private researchedHere = false;

  constructor(private readonly deps: EngineDeps) {}

  /** Search results have reached the model in a report of an earlier run. */
  researched(): boolean {
    return this.researchedHere || (this.deps.researchLog?.has() ?? false);
  }

  /** A report the model gets (tool result or message) holds search results. */
  markResearched(): void {
    if (this.researched()) return;
    this.researchedHere = true;
    this.deps.researchLog?.add();
  }

  /** Runs executing in this process. */
  running(): string[] {
    return [...this.live.keys()];
  }

  /**
   * Starts (or resumes) a run. Resolves when it ends, or detaches as `deps` says.
   * `signal` (the tool call aborted) cancels a run that has not detached yet.
   */
  async start(
    input: StartInput,
    signal?: AbortSignal,
    options: { detach?: boolean } = {},
  ): Promise<EngineOutcome> {
    const { bridge } = this.deps;
    const begin = await bridge.call(
      'run.begin',
      {
        source: input.source,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.procedures?.length ? { procedures: input.procedures } : {}),
      },
      { signal },
    );
    const runId = begin.runId;
    const procedures = [...begin.procedures];
    const trace = new TraceRecorder();
    const pendingRender = new Map<string, { tree: UiNode; rev: number }>();
    const pendingDurable = new Map<string, unknown>();
    let uiChain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = uiChain.then(fn, fn);
      uiChain = next.catch(() => {});
      return next;
    };
    const store: DurableStore = {
      setMemo: (key, value) => bridge.call('run.memo', { runId, key, value }).then(() => undefined),
      deleteMemo: (key) =>
        bridge.call('run.memo', { runId, key, delete: true }).then(() => undefined),
      openUi: (key, tree, rev) => {
        trace.uiOpened(key);
        return serial(() => bridge.call('run.ui', { runId, action: 'open', key, tree, rev })).then(
          () => undefined,
        );
      },
      renderUi: (key, tree, rev) => {
        const queued = pendingRender.has(key);
        pendingRender.set(key, { tree, rev });
        if (queued) return;
        void serial(async () => {
          const latest = pendingRender.get(key);
          pendingRender.delete(key);
          if (!latest) return;
          await bridge.call('run.ui', {
            runId,
            action: 'render',
            key,
            tree: latest.tree,
            rev: latest.rev,
          });
        }).catch((err) => hostLog('warn', `render of ${runId}/${key} failed: ${String(err)}`));
      },
      setDurable: (key, name, value) => {
        // Only the latest value of each waits to be sent: a loop of updates keeps one, not all.
        const id = `${key}\u0000${name}`;
        const queued = pendingDurable.has(id);
        pendingDurable.set(id, value);
        if (queued) return;
        void serial(() => {
          const latest = pendingDurable.get(id);
          pendingDurable.delete(id);
          return bridge.call('run.ui', { runId, action: 'durable', key, name, value: latest });
        }).catch((err) =>
          hostLog('warn', `durable value of ${runId}/${key} not saved: ${String(err)}`),
        );
      },
      closeUi: (key, result) => {
        trace.uiClosed(key);
        return serial(() => bridge.call('run.ui', { runId, action: 'close', key, result })).then(
          (res) => res.note,
        );
      },
    };

    // documents.create needs search results the model read before this run was written: the
    // run's own searches never count (docs/codemode.md, "Research before documents").
    const researched = this.researched();
    const searches: Search[] = [];
    const baseOps = createHostOps({
      ...this.deps,
      procedures: () => procedures,
      researched: () => researched,
    });
    let uiChanged: () => void = () => {};
    const run = new CodeRun({
      source: input.source,
      state: begin.state,
      procedures,
      store,
      call: async (op, args, ctx) => {
        const result = await trace.time(op, traceLabel(args), () => baseOps(op, args, ctx));
        if (op === 'search' && typeof result === 'string')
          searches.push({ query: searchQuery(args), text: result });
        if (op === 'procedures.getOrCreate' || op === 'procedures.update') {
          // The procedure touched last comes first: the run's default for prompts and documents.
          const id = (result as { id?: string }).id;
          if (id)
            procedures.splice(0, procedures.length, id, ...procedures.filter((p) => p !== id));
        }
        return result;
      },
      onUiChange: () => {
        uiChanged();
        // Out of the state operation that opened it: dispatch runs module code.
        setTimeout(() => live.flushWaiting?.(), 0);
      },
    });
    const live: LiveRun = {
      run,
      runId,
      ...(input.title ? { title: input.title } : {}),
      trace,
      deliver: false,
      searches,
    };
    this.live.set(runId, live);
    void this.pollEvents(live).catch((err) =>
      hostLog('warn', `events of ${runId} stopped: ${String(err)}`),
    );
    run.done.then(
      (outcome) => this.finish(live, outcome),
      () => {},
    );
    // start() settles only when main does: the outcome comes through run.done.
    void run.start();

    const detach = options.detach ?? false;
    const base = { runId, ...(input.title ? { title: input.title } : {}), searches };
    if (detach) {
      live.deliver = true;
      return { ...base, status: 'detached', openUi: run.openUis() };
    }
    const onAbort = () => run.cancel('The agent stopped');
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const detached = new Promise<'detached'>((resolve) => {
        const timer = setTimeout(() => resolve('detached'), this.deps.detachAfterMs);
        timer.unref?.();
        const check = () => {
          if (run.openUis().length > 0) resolve('detached');
        };
        uiChanged = check;
        check();
        void run.done.finally(() => clearTimeout(timer));
      });
      const settled = await Promise.race([run.done, detached]);
      if (settled === 'detached') {
        live.deliver = true;
        return { ...base, status: 'detached', openUi: run.openUis() };
      }
      return { ...base, status: settled.status, outcome: settled, openUi: [] };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      uiChanged = () => {};
    }
  }

  private async finish(live: LiveRun, outcome: RunOutcome): Promise<void> {
    if (this.live.get(live.runId) === live) this.live.delete(live.runId);
    try {
      this.deps.onRunTrace?.(
        live.trace.finish({
          runId: live.runId,
          ...(live.title ? { title: live.title } : {}),
          status: outcome.status,
        }),
      );
    } catch (err) {
      hostLog('warn', `trace of ${live.runId} not kept: ${String(err)}`);
    }
    const value =
      outcome.status === 'succeeded' && outcome.value !== undefined
        ? outcome.value.slice(0, RESULT_CHARS)
        : undefined;
    const logs = outcome.logs.length ? outcome.logs.join('\n').slice(-RESULT_CHARS) : undefined;
    // The agent hears this outcome as a message (its tool call returned): with the searches it
    // didn't return, as the tool result shows them.
    let searches: string | undefined;
    if (live.deliver && live.searches.length) {
      searches = unreturnedSearches(
        live.searches,
        // What main's message shows of them (coordinator.ts clips value and logs).
        `${value ?? ''}\n${logs ?? ''}`,
      );
      this.markResearched();
    }
    try {
      await this.deps.bridge.call('run.end', {
        runId: live.runId,
        outcome: {
          status: outcome.status,
          ...(value !== undefined ? { value } : {}),
          ...(outcome.status === 'failed'
            ? {
                error: outcome.error.slice(0, 10_000),
                // Module code chooses it; the bridge takes 40 characters.
                ...(outcome.code ? { code: outcome.code.slice(0, 40) } : {}),
              }
            : {}),
          ...(outcome.status === 'cancelled' ? { error: outcome.reason.slice(0, 10_000) } : {}),
          ...(logs ? { logs } : {}),
          ...(searches ? { searches } : {}),
        },
        deliver: live.deliver,
      });
    } catch (err) {
      hostLog('warn', `run.end of ${live.runId} failed: ${String(err)}`);
    }
  }

  /** Long-polls the user's events and dispatches them; events for interfaces not open yet wait. */
  private async pollEvents(live: LiveRun): Promise<void> {
    const { bridge } = this.deps;
    let after = 0;
    const waiting: { key: string; event: UiEvent }[] = [];
    let ended = false;
    void live.run.done.finally(() => {
      ended = true;
    });
    const flushWaiting = () => {
      for (let i = 0; i < waiting.length; ) {
        const item = waiting[i];
        if (item && live.run.openUis().includes(item.key)) {
          live.run.dispatch(item.key, item.event);
          waiting.splice(i, 1);
        } else i++;
      }
    };
    live.flushWaiting = flushWaiting;
    while (!ended) {
      let response: BridgeResults['run.events'];
      try {
        response = await bridge.call('run.events', { runId: live.runId, after });
      } catch (err) {
        if (ended) return;
        // The app ended the run (it no longer knows it): stop it here too.
        if (err instanceof BridgeError && err.code === 'not_found') {
          live.run.cancel('The app ended this run');
          return;
        }
        hostLog('warn', `run.events of ${live.runId} failed: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      if (response.ended) {
        live.run.cancel('Cancelled from the app');
        return;
      }
      for (const item of response.events) {
        after = Math.max(after, item.seq);
        if (live.run.openUis().includes(item.key)) live.run.dispatch(item.key, item.event);
        else waiting.push({ key: item.key, event: item.event });
      }
      // Events for interfaces still opening (a resumed run replays first) go when they open.
      flushWaiting();
    }
  }

  /** Resumes this agent's runs that wait for the user (after the process started). */
  async resumeAll(): Promise<void> {
    if (this.resuming) return;
    this.resuming = true;
    try {
      await this.resumeOnce();
    } finally {
      this.resuming = false;
    }
  }

  private async resumeOnce(): Promise<void> {
    let list: BridgeResults['run.resumable']['runs'] = [];
    try {
      list = (await this.deps.bridge.call('run.resumable', {})).runs;
    } catch (err) {
      hostLog('warn', `could not list runs to resume: ${String(err)}`);
      return;
    }
    for (const r of list) {
      if (this.live.has(r.runId)) continue;
      await this.start(r, undefined, { detach: true }).catch((err) =>
        hostLog('warn', `could not resume ${r.runId}: ${String(err)}`),
      );
    }
  }

  /**
   * Looks for runs to resume now and then while the process runs, not only at startup: one
   * whose live run went stale in main, or that waits while this process stayed up, would
   * otherwise never continue (found by the protocol's model checker, docs/codemode.md).
   */
  startResuming(everyMs = 15_000): void {
    void this.resumeAll();
    this.resumer ??= setInterval(() => void this.resumeAll(), everyMs);
    this.resumer.unref?.();
  }

  /** Cancels every run (process shutdown is not this: runs then simply end with it). */
  cancelAll(reason: string): void {
    for (const live of this.live.values()) live.run.cancel(reason);
  }
}

/**
 * The one limit on what the model reads of a run: the tool result, and the value and logs of
 * the message main sends when a run ended after its call returned (coordinator.ts).
 */
export const RESULT_CHARS = 50_000;
/** Of each search shown because main didn't return it. */
const SEARCH_SHOWN_CHARS = 4_000;
const SEARCHES_SHOWN_CHARS = 16_000;

function searchQuery(args: unknown): string {
  const a = (args ?? {}) as { prompt?: unknown; query?: unknown };
  const query = typeof a.prompt === 'string' ? a.prompt : a.query;
  return typeof query === 'string' ? query.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/** `report` shows the search: whole, cut, or as a JSON string inside a returned object. */
function shows(report: string, text: string): boolean {
  const probe = text.trim().slice(0, 200);
  return !probe || report.includes(probe) || report.includes(JSON.stringify(probe).slice(1, -1));
}

/**
 * The run's searches that `report` (what the model reads of the run) doesn't show, for it to
 * read: a search found what the model must know, and a module can't make sense of prose
 * itself. Empty when it returned them all.
 */
export function unreturnedSearches(searches: Search[], report: string): string {
  const missing = searches.filter((s) => !shows(report, s.text));
  if (!missing.length) return '';
  const blocks = missing.map((s) => {
    const text =
      s.text.length > SEARCH_SHOWN_CHARS
        ? `${s.text.slice(0, SEARCH_SHOWN_CHARS)}\n… ${s.text.length - SEARCH_SHOWN_CHARS} more characters: return it to read all.`
        : s.text;
    return `### api.search: ${s.query}\n${text}`;
  });
  const section = `Searches main didn't return (read them):\n\n${blocks.join('\n\n')}`;
  return section.length > SEARCHES_SHOWN_CHARS
    ? `${section.slice(0, SEARCHES_SHOWN_CHARS)}\n… cut: return what you need.`
    : section;
}
