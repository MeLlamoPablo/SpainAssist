import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BridgeResults,
  type MapPoint,
  type RunInfo,
  RunStatus,
  type RunUi,
  UI_FAILED,
  type UiAnswer,
  type UiEvent,
  type UiNode,
  uiTreeAddresses,
  uiTreeAnswers,
  uiTreeProblem,
} from '@sa/shared';
import { z } from 'zod';
import { BridgeError } from '../core/errors';
import type { EventBus } from '../core/events';
import { DebouncedWriter, ensurePrivateDir, readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage, isSafeId, KeyedQueue, newId } from '../core/util';
import { MapQuotaError } from '../places/maps';
import type { PlaceLookup } from '../places/resolve-form';

/**
 * Codemode runs (docs/codemode.md): each `codemode` call executes a module once, in the agent's
 * process. The durable state belongs to the agent and is shared by all its runs
 * (`agents/<id>/state.json`): memoized values (`api.state.memo`), stored before `memo` resolves,
 * and interfaces (`api.ui.present`) by key: the latest tree (validated before the renderer sees
 * it), durable values, and the result once closed. Main is the source of truth: a host reports
 * every durable change here before its run continues, and long-polls the user's events, queued
 * per run (`events`).
 * A run that waits for the user keeps a record (its source) in the same file. When no process
 * runs it, its interfaces stay on screen and the user's events wait here: `onDetachedEvent` asks
 * the coordinator to wake its agent, whose host resumes it (`resumable`) by running the module
 * again from the agent's state.
 */

const UiRecord = z.object({
  key: z.string(),
  /** `withdrawn`: its run ended without closing it; its durable values stay for the next one. */
  status: z.enum(['open', 'closed', 'withdrawn']),
  /** The run showing it (open). */
  runId: z.string().optional(),
  tree: z.unknown().optional(),
  rev: z.number().int().nonnegative(),
  durable: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  openedAt: z.string(),
  closedAt: z.string().optional(),
});
type UiRecord = z.infer<typeof UiRecord>;

/** A run that is not over: running, waiting for the user, or interrupted and not yet told. */
const RunRecord = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string().optional(),
  procedures: z.array(z.string()),
  source: z.string(),
  status: RunStatus,
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecord>;

const AgentState = z.object({
  memo: z.record(z.string(), z.object({ value: z.unknown().optional() })),
  ui: z.record(z.string(), UiRecord),
  runs: z.record(z.string(), RunRecord),
});
type AgentState = z.infer<typeof AgentState>;

interface QueuedEvent {
  seq: number;
  key: string;
  event: UiEvent;
}

/** A run some host executes (`ended`: stopped from here, until its host reports the end). */
interface Live {
  record: RunRecord;
  seq: number;
  events: QueuedEvent[];
  waiters: Set<() => void>;
  ended: boolean;
  /** Cancelled from outside; `tell`: its agent hears it when its host reports the end. */
  cancelled?: { tell: boolean; reason?: string };
  /** When the host last reached main for this run (ms), and polls in progress. */
  lastSeen: number;
  polling: number;
}

export interface RunEnd {
  run: RunRecord;
  agentId: string;
  outcome: {
    status: 'succeeded' | 'failed' | 'cancelled';
    value?: string;
    error?: string;
    code?: string;
    logs?: string;
    /** Search results the agent didn't return, for it to read. */
    searches?: string;
  };
  deliver: boolean;
}

export interface RunServiceDeps {
  /** The agents' directory: each agent's state is in its folder. */
  dir: string;
  events: EventBus;
  logger: Logger;
  clock: Clock;
  /** Looks up a map address (null: not found); positions never reach the agent. */
  placeLookup?: PlaceLookup;
  /** A run ended. */
  onEnd?(end: RunEnd): void;
  /** The user acted on an interface of a run no process is running. */
  onDetachedEvent?(run: RunRecord): void;
  /**
   * An interface closed with values for Mis datos (its fields' `vaultKey`). Saved before its
   * `present` resolves, so the run reads them back from the vault.
   */
  saveAnswers?(answers: UiAnswer[]): Promise<void>;
  /** A run that was running stopped reaching main (its host lost it); its agent should know. */
  onStale?(run: RunRecord): void;
  /** A run that neither polls nor calls for this long is gone (default 75 s; polls last 25 s). */
  staleMs?: number;
  debounceMs?: number;
  /** Longest a `run.events` poll stays open without events. */
  pollMs?: number;
}

const MAX_QUEUED_EVENTS = 500;
const MAX_MEMO_BYTES = 2 * 1024 * 1024;
/** Nesting of a stored value (deeper values break cloning when a run resumes). */
const MAX_VALUE_DEPTH = 64;
/** An agent's whole state: main loads every one at start and sends open trees to the renderer. */
const MAX_STATE_BYTES = 8 * 1024 * 1024;
/** Interfaces of one agent open at once ("Para ti" shows every one). */
const MAX_OPEN_UIS = 20;

export class RunService {
  private readonly states = new Map<string, AgentState>();
  private readonly live = new Map<string, Live>();
  /** Events for runs no process runs, delivered when one resumes them. */
  private readonly detachedEvents = new Map<string, { key: string; event: UiEvent }[]>();
  /** Positions of map addresses per agent (memory only: Mapbox results may not be stored). */
  private readonly places = new Map<string, Map<string, MapPoint | null>>();
  private readonly writer: DebouncedWriter;
  private readonly queue = new KeyedQueue();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: RunServiceDeps) {
    this.writer = new DebouncedWriter(deps.debounceMs ?? 300, (key, err) =>
      deps.logger.error(`agent state write failed: ${key}`, err),
    );
  }

  /**
   * Ends runs whose host stopped reaching main without ending them (a "zombie": the host lost
   * the run, or its `run.end` never arrived). Found by the protocol's model checker
   * (docs/codemode.md, "Formal verification"): otherwise the user's events would go to a run
   * nobody executes and it could never continue.
   */
  sweep(): void {
    const now = this.deps.clock().getTime();
    for (const live of [...this.live.values()]) {
      if (live.ended || live.polling > 0 || now - live.lastSeen <= (this.deps.staleMs ?? 75_000))
        continue;
      const { record } = live;
      this.live.delete(record.id);
      for (const wake of [...live.waiters]) wake();
      this.deps.logger.warn('run stopped reaching main', {
        runId: record.id,
        agentId: record.agentId,
      });
      if (record.status === 'running') {
        // Told now, so not noted again later: its record goes.
        record.status = 'interrupted';
        this.drop(record);
        this.deps.onStale?.(record);
      } else if (record.status === 'waiting_user') {
        // Its interfaces stay; what the user did waits for the next run, which resumes it.
        const events = live.events.map(({ key, event }) => ({ key, event }));
        if (events.length) {
          this.detachedEvents.set(record.id, [
            ...(this.detachedEvents.get(record.id) ?? []),
            ...events,
          ]);
          this.deps.onDetachedEvent?.(record);
        }
        this.emit(record);
      }
    }
  }

  /** Sweeps for stale runs every `everyMs` (the app does; tests call `sweep`). */
  startSweeping(everyMs = 30_000): void {
    this.sweeper ??= setInterval(() => this.sweep(), everyMs);
    this.sweeper.unref?.();
  }

  dispose(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.deps.dir);
    let agents: string[] = [];
    try {
      agents = await readdir(this.deps.dir);
    } catch {
      agents = [];
    }
    for (const agentId of agents) {
      if (!isSafeId(agentId)) continue;
      try {
        const parsed = AgentState.safeParse(await readJsonFile(this.file(agentId)));
        if (!parsed.success) continue;
        const state = parsed.data;
        // Runs never survive the app: what was running when it quit was interrupted.
        for (const run of Object.values(state.runs))
          if (run.status === 'running') run.status = 'interrupted';
        this.states.set(agentId, state);
      } catch (err) {
        this.deps.logger.warn('unreadable agent state', { agentId, error: errorMessage(err) });
      }
    }
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  private file(agentId: string): string {
    return join(this.deps.dir, agentId, 'state.json');
  }

  private state(agentId: string): AgentState {
    let state = this.states.get(agentId);
    if (!state) {
      state = { memo: {}, ui: {}, runs: {} };
      this.states.set(agentId, state);
    }
    return state;
  }

  /** Refuses a change that makes the state too large to keep: `undo` takes it back first. */
  private checkSize(state: AgentState, undo: () => void): void {
    const size = JSON.stringify(state).length;
    if (size <= MAX_STATE_BYTES) return;
    undo();
    throw new BridgeError(
      'bad_request',
      `Your state would keep too much (${size} characters; at most ${MAX_STATE_BYTES}): delete memoized values you no longer need (api.state.delete) or keep less.`,
    );
  }

  private write(agentId: string): Promise<void> {
    const json = JSON.stringify(this.state(agentId));
    return this.queue.run(agentId, async () => {
      await ensurePrivateDir(join(this.deps.dir, agentId));
      await writeFileAtomic(this.file(agentId), json);
    });
  }

  /** Stores the agent's state now (memo, open, close: the run waits for it). */
  private persist(agentId: string): Promise<void> {
    return this.write(agentId);
  }

  private persistSoon(agentId: string): void {
    this.writer.schedule(agentId, () => this.write(agentId));
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  // --- reads ---------------------------------------------------------------------------------

  get(runId: string): RunRecord | undefined {
    for (const state of this.states.values()) if (state.runs[runId]) return state.runs[runId];
    return undefined;
  }

  /** Every run that is not over, most recently changed first. */
  list(): RunRecord[] {
    return [...this.states.values()]
      .flatMap((state) => Object.values(state.runs))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** An agent's memoized values and interfaces (tests). */
  stateOf(agentId: string): Pick<AgentState, 'memo' | 'ui'> {
    const { memo, ui } = this.state(agentId);
    return { memo, ui };
  }

  /** What the renderer shows: runs with open interfaces or still running, newest last. */
  infos(): RunInfo[] {
    return this.list()
      .filter((r) => r.status === 'running' || r.status === 'waiting_user')
      .map((r) => this.info(r))
      .reverse();
  }

  info(r: RunRecord): RunInfo {
    const live = this.live.get(r.id);
    return {
      id: r.id,
      ...(r.title ? { title: r.title } : {}),
      status: r.status,
      agentId: r.agentId,
      ui: this.openUis(r).map(
        (u): RunUi => ({
          key: u.key,
          status: 'open',
          ...(u.tree ? { tree: u.tree as UiNode } : {}),
          rev: u.rev,
          openedAt: u.openedAt,
        }),
      ),
      attached: !!live && !live.ended,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(r.error ? { error: r.error.slice(0, 500) } : {}),
    };
  }

  private openUis(r: RunRecord): UiRecord[] {
    return Object.values(this.state(r.agentId).ui)
      .filter((u) => u.status === 'open' && u.runId === r.id)
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
  }

  private emit(r: RunRecord): void {
    this.deps.events.emit({ type: 'codemode.run', run: this.info(r) });
  }

  /** The record and state of a run the caller owns and is executing. */
  private runOf(runId: string, agentId: string): { record: RunRecord; state: AgentState } {
    const live = this.live.get(runId);
    if (!live || live.ended) throw new BridgeError('not_found', 'This run has ended.');
    if (live.record.agentId !== agentId) throw new BridgeError('unauthorized', 'Not your run.');
    live.lastSeen = this.deps.clock().getTime();
    return { record: live.record, state: this.state(agentId) };
  }

  // --- runs ----------------------------------------------------------------------------------

  /**
   * Starts a run, or resumes one of the agent's that waits for the user (`runId`; refused while
   * a live process runs it). Returns the agent's durable state for the run to start from.
   */
  async begin(
    agentId: string,
    input: { runId?: string; title?: string; procedures?: string[]; source: string },
  ): Promise<Omit<BridgeResults['run.begin'], 'procedures'>> {
    const state = this.state(agentId);
    const now = this.now();
    let record: RunRecord;
    if (input.runId) {
      const existing = state.runs[input.runId];
      if (existing?.status !== 'waiting_user')
        throw new BridgeError('not_found', `No run ${input.runId} to resume.`);
      if (this.live.get(existing.id)?.ended === false)
        throw new BridgeError('conflict', `Run ${existing.id} is live in another process.`);
      record = existing;
      record.source = input.source;
    } else {
      record = {
        id: newId('run'),
        agentId,
        ...(input.title ? { title: input.title.slice(0, 120) } : {}),
        procedures: [...(input.procedures ?? [])],
        source: input.source,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      };
      state.runs[record.id] = record;
    }
    record.updatedAt = now;
    record.status = this.openUis(record).length ? 'waiting_user' : 'running';
    const live: Live = {
      record,
      seq: 0,
      events: [],
      waiters: new Set(),
      ended: false,
      lastSeen: this.deps.clock().getTime(),
      polling: 0,
    };
    // Events the user caused while no process ran it go to this run, in order.
    for (const queued of this.detachedEvents.get(record.id) ?? [])
      this.queueEvent(live, queued.key, queued.event);
    this.detachedEvents.delete(record.id);
    this.live.set(record.id, live);
    await this.persist(agentId);
    this.emit(record);
    // JSON copies (any depth; structuredClone doesn't): the run's values are its own.
    return {
      runId: record.id,
      state: {
        memo: jsonCopy(state.memo),
        ui: Object.fromEntries(
          Object.values(state.ui).map((u) => [
            u.key,
            {
              status: u.status,
              ...(u.status === 'closed' ? { result: u.result } : {}),
              durable: jsonCopy(u.durable),
              rev: u.rev,
            },
          ]),
        ),
      },
    };
  }

  async memo(
    agentId: string,
    runId: string,
    key: string,
    value: unknown,
    remove: boolean,
  ): Promise<void> {
    const { state } = this.runOf(runId, agentId);
    const prev = state.memo[key];
    if (remove) delete state.memo[key];
    else {
      checkValue(`The value of "${key}"`, value);
      state.memo[key] = value === undefined ? {} : { value };
      this.checkSize(state, () => {
        if (prev) state.memo[key] = prev;
        else delete state.memo[key];
      });
    }
    await this.persist(agentId);
  }

  async openUi(
    agentId: string,
    runId: string,
    key: string,
    tree: unknown,
    rev: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { record, state } = this.runOf(runId, agentId);
    const problem = uiTreeProblem(tree);
    if (problem)
      throw new BridgeError('bad_request', `The interface "${key}" cannot be shown: ${problem}`);
    const prev = state.ui[key];
    if (prev?.status === 'open' && prev.runId !== runId)
      throw new BridgeError(
        'conflict',
        `The interface "${key}" is open in your run ${prev.runId}, waiting for the user: use another key, or cancel that run (api.runs.cancel).`,
      );
    if (
      prev?.status !== 'open' &&
      Object.values(state.ui).filter((u) => u.status === 'open').length >= MAX_OPEN_UIS
    )
      throw new BridgeError(
        'bad_request',
        `You have ${MAX_OPEN_UIS} interfaces open: close some (api.ui.close) before presenting more.`,
      );
    await this.locate(agentId, tree as UiNode, signal);
    state.ui[key] = {
      key,
      status: 'open',
      runId,
      tree,
      rev,
      durable: prev?.durable ?? {},
      openedAt: prev?.status === 'open' ? prev.openedAt : this.now(),
    };
    this.checkSize(state, () => {
      if (prev) state.ui[key] = prev;
      else delete state.ui[key];
    });
    record.status = 'waiting_user';
    record.updatedAt = this.now();
    await this.persist(agentId);
    this.emit(record);
  }

  async renderUi(
    agentId: string,
    runId: string,
    key: string,
    tree: unknown,
    rev: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { record, state } = this.runOf(runId, agentId);
    const ui = state.ui[key];
    if (ui?.status !== 'open' || ui.runId !== runId) return;
    if (rev <= ui.rev && ui.tree) return;
    const problem = uiTreeProblem(tree);
    if (problem)
      throw new BridgeError('bad_request', `The interface "${key}" cannot be shown: ${problem}`);
    await this.locate(agentId, tree as UiNode, signal);
    const prev = { tree: ui.tree, rev: ui.rev };
    ui.tree = tree;
    ui.rev = rev;
    this.checkSize(state, () => Object.assign(ui, prev));
    record.updatedAt = this.now();
    this.persistSoon(agentId);
    this.emit(record);
  }

  durable(agentId: string, runId: string, key: string, name: string, value: unknown): void {
    const { state } = this.runOf(runId, agentId);
    const ui = state.ui[key];
    if (ui?.status !== 'open' || ui.runId !== runId) return;
    checkValue(`The durable value "${name}"`, value);
    const had = Object.hasOwn(ui.durable, name);
    const prev = ui.durable[name];
    ui.durable[name] = value;
    this.checkSize(state, () => {
      if (had) ui.durable[name] = prev;
      else delete ui.durable[name];
    });
    this.persistSoon(agentId);
  }

  async closeUi(agentId: string, runId: string, key: string, result: unknown): Promise<void> {
    const { record, state } = this.runOf(runId, agentId);
    checkValue(`The result of "${key}"`, result);
    const ui = state.ui[key];
    // What the user answered, as the last tree shows it (the app keeps it, not the agent).
    const answers = ui?.status === 'open' ? uiTreeAnswers(ui.tree as UiNode | undefined) : [];
    state.ui[key] = {
      key,
      status: 'closed',
      rev: ui?.rev ?? 0,
      durable: ui?.durable ?? {},
      result,
      openedAt: ui?.openedAt ?? this.now(),
      closedAt: this.now(),
    };
    this.checkSize(state, () => {
      if (ui) state.ui[key] = ui;
      else delete state.ui[key];
    });
    if (!this.openUis(record).length && record.status === 'waiting_user') record.status = 'running';
    record.updatedAt = this.now();
    await this.persist(agentId);
    this.emit(record);
    if (answers.length && this.deps.saveAnswers)
      await this.deps.saveAnswers(answers).catch((err: unknown) =>
        this.deps.logger.warn('saving an interface’s answers failed', {
          runId,
          error: errorMessage(err),
        }),
      );
  }

  /** Long poll for the user's events on a run's interfaces. */
  async events(
    agentId: string,
    runId: string,
    after: number,
    signal: AbortSignal,
  ): Promise<{ events: QueuedEvent[]; ended?: boolean }> {
    const live = this.live.get(runId);
    if (!live || live.record.agentId !== agentId)
      throw new BridgeError('not_found', 'This run has ended.');
    live.events = live.events.filter((e) => e.seq > after);
    // Ended here (cancelled): its host stops it.
    if (live.ended) return { events: [], ended: true };
    live.lastSeen = this.deps.clock().getTime();
    live.polling++;
    try {
      if (!live.events.length) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            live.waiters.delete(done);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, this.deps.pollMs ?? 25_000);
          timer.unref?.();
          live.waiters.add(done);
          signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      live.polling--;
      live.lastSeen = this.deps.clock().getTime();
    }
    if (live.ended) return { events: [], ended: true };
    return { events: live.events.filter((e) => e.seq > after) };
  }

  /**
   * The renderer could not draw an open interface (a bug its tree ran into). It leaves the screen
   * and its run hears it as if `present` had been refused, at the line that presented it. With
   * no live run, the agent is woken: the run that resumes presents it again and hears it then.
   * Returns false for a tree no longer shown (a newer one may draw; the renderer tries).
   */
  uiFailed(runId: string, key: string, rev: number, detail: string): boolean {
    const record = this.get(runId);
    const state = record && this.state(record.agentId);
    const ui = state?.ui[key];
    if (!record || !state || ui?.status !== 'open' || ui.runId !== runId || ui.rev !== rev)
      return false;
    delete state.ui[key];
    const live = this.live.get(runId);
    if (live && !live.ended) {
      if (!this.openUis(record).length && record.status === 'waiting_user')
        record.status = 'running';
      this.queueEvent(live, key, {
        handler: UI_FAILED,
        rev,
        value: `The interface "${key}" could not be shown: the app failed to draw ${detail}. Change what you pass to it and present it again.`,
      });
    } else this.deps.onDetachedEvent?.(record);
    this.persistSoon(record.agentId);
    this.emit(record);
    return true;
  }

  private queueEvent(live: Live, key: string, event: UiEvent): void {
    live.events.push({ seq: ++live.seq, key, event });
    if (live.events.length > MAX_QUEUED_EVENTS) live.events.shift();
    for (const wake of [...live.waiters]) wake();
  }

  /**
   * The user acted on an interface (from the renderer). Unknown or closed interfaces are
   * ignored (the tree on screen was stale). Returns false then.
   */
  userEvent(runId: string, key: string, event: UiEvent): boolean {
    const record = this.get(runId);
    const ui = record && this.state(record.agentId).ui[key];
    if (!record || ui?.status !== 'open' || ui.runId !== runId) return false;
    const live = this.live.get(runId);
    if (live && !live.ended) {
      this.queueEvent(live, key, event);
      return true;
    }
    const queued = this.detachedEvents.get(runId) ?? [];
    queued.push({ key, event });
    if (queued.length > MAX_QUEUED_EVENTS) queued.shift();
    this.detachedEvents.set(runId, queued);
    this.deps.onDetachedEvent?.(record);
    return true;
  }

  /** The run is over: its interfaces leave the screen (their durable values stay), its record goes. */
  private drop(record: RunRecord): void {
    const state = this.state(record.agentId);
    for (const ui of Object.values(state.ui))
      if (ui.status === 'open' && ui.runId === record.id) {
        ui.status = 'withdrawn';
        delete ui.runId;
        delete ui.tree;
      }
    delete state.runs[record.id];
    record.updatedAt = this.now();
    this.persistSoon(record.agentId);
  }

  async end(
    agentId: string,
    runId: string,
    outcome: RunEnd['outcome'],
    deliver: boolean,
  ): Promise<void> {
    const live = this.live.get(runId);
    if (!live || live.record.agentId !== agentId)
      throw new BridgeError('not_found', 'This run has ended.');
    this.live.delete(runId);
    for (const wake of [...live.waiters]) wake();
    const { record } = live;
    if (live.ended) {
      // Cancelled from outside: the record already went; its agent hears it now.
      if (live.cancelled?.tell)
        this.deps.onEnd?.({
          run: record,
          agentId,
          outcome: {
            status: 'cancelled',
            ...(live.cancelled.reason ? { error: live.cancelled.reason } : {}),
          },
          deliver,
        });
      return;
    }
    record.status = outcome.status;
    if (outcome.error) record.error = outcome.error.slice(0, 10_000);
    this.drop(record);
    await this.flush();
    // Its agent hears the result first: the meter goes from the run to the agent's turn without
    // showing it idle in between.
    this.deps.onEnd?.({ run: record, agentId, outcome, deliver });
    this.emit(record);
  }

  /**
   * Stops a run from outside (its agent in another run, the coordinator): its live run ends (the
   * host's poll says so and it cancels the run), its interfaces are withdrawn. Its agent hears
   * it, as it hears any end (when the host ends the run, or now when no process runs it),
   * unless `by` that agent itself.
   */
  async cancel(runId: string, reason?: string, by?: string): Promise<boolean> {
    const record = this.get(runId);
    if (!record) return false;
    const live = this.live.get(runId);
    const tell = by !== record.agentId;
    if (live && !live.ended) {
      live.ended = true;
      live.cancelled = { tell, ...(reason ? { reason } : {}) };
      for (const wake of [...live.waiters]) wake();
    }
    this.detachedEvents.delete(runId);
    record.status = 'cancelled';
    record.error = reason ? `Cancelled: ${reason}` : 'Cancelled';
    this.drop(record);
    await this.flush();
    this.emit(record);
    if (tell && !live)
      this.deps.onEnd?.({
        run: record,
        agentId: record.agentId,
        outcome: { status: 'cancelled', ...(reason ? { error: reason } : {}) },
        deliver: true,
      });
    return true;
  }

  /**
   * An agent's process ended: its live runs end with it. Runs waiting for the user stay so
   * (their interfaces stay on screen and resume later); running ones are interrupted, and noted
   * on the agent's next message (`takeInterrupted`). Returns the interrupted ones.
   */
  detachAgent(agentId: string): RunRecord[] {
    const interrupted: RunRecord[] = [];
    for (const live of [...this.live.values()]) {
      const { record } = live;
      if (record.agentId !== agentId) continue;
      this.live.delete(record.id);
      for (const wake of [...live.waiters]) wake();
      if (record.status === 'running') {
        record.status = 'interrupted';
        record.updatedAt = this.now();
        interrupted.push(record);
      }
      this.persistSoon(agentId);
      this.emit(record);
    }
    return interrupted;
  }

  /** The agent's runs interrupted while it was away, forgotten once taken (told once). */
  takeInterrupted(agentId: string): RunRecord[] {
    const state = this.state(agentId);
    const taken = Object.values(state.runs).filter((r) => r.status === 'interrupted');
    for (const r of taken) delete state.runs[r.id];
    if (taken.length) this.persistSoon(agentId);
    return taken;
  }

  /** Runs of this agent to resume when its process starts: they wait for the user. */
  resumable(agentId: string): RunRecord[] {
    return Object.values(this.state(agentId).runs).filter(
      (r) => r.status === 'waiting_user' && this.live.get(r.id)?.ended !== false,
    );
  }

  /** The agent's runs with interfaces on screen, each with their keys. */
  waiting(agentId: string): { run: RunRecord; keys: string[] }[] {
    return Object.values(this.state(agentId).runs)
      .map((run) => ({ run, keys: this.openUis(run).map((u) => u.key) }))
      .filter((w) => w.keys.length);
  }

  /** Whether a process executes the run right now. */
  isLive(runId: string): boolean {
    return this.live.get(runId)?.ended === false;
  }

  /** Everything is gone (the agents' folders go with them). */
  async deleteAll(): Promise<void> {
    this.dispose();
    await this.writer.flush().catch(() => {});
    for (const live of this.live.values()) for (const wake of [...live.waiters]) wake();
    this.live.clear();
    this.states.clear();
    this.detachedEvents.clear();
    this.places.clear();
  }

  // --- maps ----------------------------------------------------------------------------------

  /** Every map address of a tree must be found before it is shown (no partial maps). */
  private async locate(agentId: string, tree: UiNode, signal: AbortSignal): Promise<void> {
    const lookup = this.deps.placeLookup;
    const addresses = uiTreeAddresses(tree);
    if (!lookup || !addresses.length) return;
    const known = this.places.get(agentId) ?? new Map<string, MapPoint | null>();
    this.places.set(agentId, known);
    const missing: string[] = [];
    for (const address of addresses) {
      if (known.has(address)) {
        if (known.get(address) === null) missing.push(address);
        continue;
      }
      let point: MapPoint | undefined;
      try {
        point = await lookup(address, signal);
      } catch (err) {
        signal.throwIfAborted();
        // Lookups used up: the map shows its list only (pins null), as forms do.
        if (err instanceof MapQuotaError) return;
        throw new BridgeError(
          'unavailable',
          'Place lookup unavailable: the interface was not shown. Retry later.',
        );
      }
      known.set(address, point ?? null);
      if (!point) missing.push(address);
    }
    if (missing.length)
      throw new BridgeError(
        'bad_request',
        `No matching place in Spain for: ${missing.join('; ')}. Nothing was shown. Find their street addresses (number and municipality) in official directories and present again; never drop places silently.`,
      );
  }

  private shownUi(runId: string, key: string): { agentId: string; ui: UiRecord } | undefined {
    const record = this.get(runId);
    const ui = record && this.state(record.agentId).ui[key];
    return record && ui?.status === 'open' && ui.runId === runId && ui.tree
      ? { agentId: record.agentId, ui }
      : undefined;
  }

  /** Pins of the given addresses of an open interface, for its map (null: not found). */
  pins(runId: string, key: string, addresses: string[]): (MapPoint | null)[] {
    const shown = this.shownUi(runId, key);
    if (!shown) return addresses.map(() => null);
    const allowed = new Set(uiTreeAddresses(shown.ui.tree as UiNode));
    const known = this.places.get(shown.agentId);
    return addresses.map((a) => (allowed.has(a) ? (known?.get(a) ?? null) : null));
  }

  /** Looks up the pins of an open interface restored after a restart (once, then kept in memory). */
  async locateOpen(runId: string, key: string, signal: AbortSignal): Promise<void> {
    const shown = this.shownUi(runId, key);
    if (!shown) return;
    await this.locate(shown.agentId, shown.ui.tree as UiNode, signal).catch(() => {});
  }
}

/** Refuses a value too large or too deeply nested to keep. */
function checkValue(what: string, value: unknown): void {
  const size = JSON.stringify(value ?? null).length;
  if (size > MAX_MEMO_BYTES)
    throw new BridgeError(
      'bad_request',
      `${what} is too large to keep (${size} characters): keep less.`,
    );
  if (deeperThan(value, MAX_VALUE_DEPTH))
    throw new BridgeError(
      'bad_request',
      `${what} nests deeper than ${MAX_VALUE_DEPTH} levels: keep it flatter.`,
    );
}

/** Without recursion: the value may nest deeper than the stack allows. */
function deeperThan(value: unknown, limit: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [v, depth] = stack.pop() as [unknown, number];
    if (!v || typeof v !== 'object') continue;
    if (depth >= limit) return true;
    for (const child of Object.values(v)) stack.push([child, depth + 1]);
  }
  return false;
}

function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
