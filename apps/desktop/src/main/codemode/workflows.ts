import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CodemodeSlug,
  type MapPoint,
  UI_FAILED,
  type UiAnswer,
  type UiEvent,
  type UiNode,
  uiTreeAddresses,
  uiTreeAnswers,
  uiTreeProblem,
  type WorkflowInfo,
  WorkflowStatus,
  type WorkflowUi,
} from '@sa/shared';
import { z } from 'zod';
import { BridgeError } from '../core/errors';
import type { EventBus } from '../core/events';
import { DebouncedWriter, ensurePrivateDir, readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage, KeyedQueue, newId } from '../core/util';
import { MapQuotaError } from '../places/maps';
import type { PlaceLookup } from '../places/resolve-form';

/**
 * Codemode workflows (docs/codemode.md): durable records with a stable id, independent of the
 * agent processes that run them. Main is their source of truth; an agent host executes one run
 * at a time and reports every durable change here before its workflow continues:
 *   - memoized values (`api.state.memo`), stored before `memo` resolves;
 *   - interfaces (`api.ui.present`): the latest tree (validated before the renderer sees it),
 *     durable values, and the result once closed;
 *   - the user's events, queued per run and long-polled by the host (`events`).
 * When no process runs a workflow that waits for the user, its last tree stays on screen and
 * the user's events wait here: `onDetachedEvent` asks the coordinator to wake its agent, whose
 * host resumes it (`resumable`) by re-running it from its state.
 */

const UiRecord = z.object({
  key: z.string(),
  status: z.enum(['open', 'closed']),
  tree: z.unknown().optional(),
  rev: z.number().int().nonnegative(),
  durable: z.record(z.string(), z.unknown()),
  result: z.unknown().optional(),
  openedAt: z.string(),
  closedAt: z.string().optional(),
});
type UiRecord = z.infer<typeof UiRecord>;

const WorkflowRecord = z.object({
  id: CodemodeSlug,
  title: z.string().optional(),
  agentId: z.string(),
  procedures: z.array(z.string()),
  source: z.string(),
  status: WorkflowStatus,
  memo: z.record(z.string(), z.object({ value: z.unknown().optional() })),
  ui: z.record(z.string(), UiRecord),
  result: z.string().optional(),
  error: z.string().optional(),
  runs: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkflowRecord = z.infer<typeof WorkflowRecord>;

interface QueuedEvent {
  seq: number;
  key: string;
  event: UiEvent;
}

interface Run {
  runId: string;
  workflowId: string;
  agentId: string;
  seq: number;
  events: QueuedEvent[];
  waiters: Set<() => void>;
  ended: boolean;
  /** When the host last reached main for this run (ms), and polls in progress. */
  lastSeen: number;
  polling: number;
}

export interface WorkflowEnd {
  workflow: WorkflowRecord;
  agentId: string;
  outcome: {
    status: 'succeeded' | 'failed' | 'cancelled';
    value?: string;
    error?: string;
    code?: string;
    logs?: string;
  };
  deliver: boolean;
}

export interface WorkflowServiceDeps {
  dir: string;
  events: EventBus;
  logger: Logger;
  clock: Clock;
  /** Looks up a map address (null: not found); positions never reach the agent. */
  placeLookup?: PlaceLookup;
  /** A run ended. */
  onEnd?(end: WorkflowEnd): void;
  /** The user acted on an interface of a workflow no process is running. */
  onDetachedEvent?(workflow: WorkflowRecord): void;
  /**
   * An interface closed with values for Mis datos (its fields' `vaultKey`). Saved before its
   * `present` resolves, so the workflow reads them back from the vault.
   */
  saveAnswers?(workflow: WorkflowRecord, answers: UiAnswer[]): Promise<void>;
  /** Whether an agent's process is alive (a live run of a workflow is not taken over). */
  agentAlive(agentId: string): boolean;
  /** A run that was running stopped reaching main (its host lost it); its agent should know. */
  onStale?(workflow: WorkflowRecord): void;
  /** A run that neither polls nor calls for this long is gone (default 75 s; polls last 25 s). */
  staleMs?: number;
  debounceMs?: number;
  /** Longest a `workflow.events` poll stays open without events. */
  pollMs?: number;
}

const MAX_QUEUED_EVENTS = 500;
const MAX_MEMO_BYTES = 2 * 1024 * 1024;
/** Nesting of a stored value (deeper values break cloning when a run resumes). */
const MAX_VALUE_DEPTH = 64;
/** A whole record: main loads every record at start and sends open trees to the renderer. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
/** Interfaces of one workflow open at once ("Para ti" shows every one). */
const MAX_OPEN_UIS = 20;

export class WorkflowService {
  private readonly records = new Map<string, WorkflowRecord>();
  private readonly runs = new Map<string, Run>();
  /** workflowId -> its live run. */
  private readonly live = new Map<string, string>();
  /** Events for workflows no process runs, delivered to the next run. */
  private readonly detachedEvents = new Map<string, { key: string; event: UiEvent }[]>();
  /** Positions of map addresses per workflow (memory only: Mapbox results may not be stored). */
  private readonly places = new Map<string, Map<string, MapPoint | null>>();
  private readonly writer: DebouncedWriter;
  private readonly queue = new KeyedQueue();
  /** Recently ended runs (runId → agent), so their hosts hear `ended` instead of `not_found`. */
  private readonly endedRuns = new Map<string, string>();
  /**
   * Runs cancelled from outside (runId → workflow, reason): when their host ends them, their
   * agent hears it as it hears any end, unless it cancelled the workflow itself.
   */
  private readonly cancelledRuns = new Map<string, { workflowId: string; reason?: string }>();
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly deps: WorkflowServiceDeps) {
    this.writer = new DebouncedWriter(deps.debounceMs ?? 300, (key, err) =>
      deps.logger.error(`workflow write failed: ${key}`, err),
    );
  }

  /**
   * Ends runs whose host stopped reaching main without ending them (a "zombie": the host lost
   * the run, or its `workflow.end` never arrived). Found by the protocol's model checker
   * (docs/codemode.md, "Formal verification"): otherwise the user's events would go to a run
   * nobody executes and the workflow could never continue.
   */
  sweep(): void {
    const now = this.deps.clock().getTime();
    for (const run of [...this.runs.values()]) {
      if (run.ended || run.polling > 0 || now - run.lastSeen <= (this.deps.staleMs ?? 75_000))
        continue;
      const record = this.records.get(run.workflowId);
      const events = run.events.map(({ key, event }) => ({ key, event }));
      this.endRun(run);
      if (!record) continue;
      this.deps.logger.warn('workflow run stopped reaching main', {
        workflowId: record.id,
        agentId: run.agentId,
      });
      if (record.status === 'running') {
        record.status = 'interrupted';
        this.persistSoon(record);
        this.emit(record);
        this.deps.onStale?.(record);
      } else if (record.status === 'waiting_user') {
        // Its interfaces stay; what the user did waits for the next run, which resumes it.
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
    let files: string[] = [];
    try {
      files = await readdir(this.deps.dir);
    } catch {
      files = [];
    }
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = WorkflowRecord.safeParse(await readJsonFile(join(this.deps.dir, file)));
        if (!parsed.success) continue;
        const record = parsed.data;
        // Runs never survive the app: what was running when it quit was interrupted.
        if (record.status === 'running') record.status = 'interrupted';
        this.records.set(record.id, record);
      } catch (err) {
        this.deps.logger.warn('unreadable workflow record', { file, error: errorMessage(err) });
      }
    }
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  private file(id: string): string {
    return join(this.deps.dir, `${id}.json`);
  }

  /** Refuses a change that makes the record too large to keep: `undo` takes it back first. */
  private checkSize(record: WorkflowRecord, undo: () => void): void {
    const size = JSON.stringify(record).length;
    if (size <= MAX_RECORD_BYTES) return;
    undo();
    throw new BridgeError(
      'bad_request',
      `Workflow "${record.id}" would keep too much (${size} characters; at most ${MAX_RECORD_BYTES}): delete memoized values it no longer needs (api.state.delete) or keep less.`,
    );
  }

  /** Stores the record now (memo, open, close: the workflow waits for it). */
  private persist(record: WorkflowRecord): Promise<void> {
    record.updatedAt = this.now();
    const json = JSON.stringify(record);
    return this.queue.run(record.id, () => writeFileAtomic(this.file(record.id), json));
  }

  private persistSoon(record: WorkflowRecord): void {
    record.updatedAt = this.now();
    this.writer.schedule(record.id, () =>
      this.queue.run(record.id, () =>
        writeFileAtomic(this.file(record.id), JSON.stringify(record)),
      ),
    );
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  // --- reads ---------------------------------------------------------------------------------

  get(id: string): WorkflowRecord | undefined {
    return this.records.get(id);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  list(): WorkflowRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** What the renderer shows: workflows with open interfaces or still running, newest last. */
  infos(): WorkflowInfo[] {
    return this.list()
      .filter((w) => w.status === 'running' || w.status === 'waiting_user' || openUis(w).length > 0)
      .map((w) => this.info(w))
      .reverse();
  }

  info(w: WorkflowRecord): WorkflowInfo {
    return {
      id: w.id,
      ...(w.title ? { title: w.title } : {}),
      status: w.status,
      agentId: w.agentId,
      ui: openUis(w).map(
        (u): WorkflowUi => ({
          key: u.key,
          status: u.status,
          ...(u.tree ? { tree: u.tree as UiNode } : {}),
          rev: u.rev,
          openedAt: u.openedAt,
        }),
      ),
      attached: this.live.has(w.id),
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      ...(w.error ? { error: w.error.slice(0, 500) } : {}),
    };
  }

  private emit(w: WorkflowRecord): void {
    this.deps.events.emit({ type: 'codemode.workflow', workflow: this.info(w) });
  }

  /** The record of a run the caller owns. */
  private runOf(runId: string, agentId: string): { run: Run; record: WorkflowRecord } {
    const run = this.runs.get(runId);
    if (!run || run.ended) throw new BridgeError('not_found', 'This workflow run has ended.');
    if (run.agentId !== agentId) throw new BridgeError('unauthorized', 'Not your workflow run.');
    run.lastSeen = this.deps.clock().getTime();
    const record = this.records.get(run.workflowId);
    if (!record) throw new BridgeError('not_found', 'The workflow no longer exists.');
    return { run, record };
  }

  workflowOfRun(runId: string, agentId: string): WorkflowRecord {
    return this.runOf(runId, agentId).record;
  }

  // --- runs ----------------------------------------------------------------------------------

  /**
   * Starts a run: creates the record or resumes it. Refused while another live process runs it.
   * The new source replaces the old; durable state is kept (that is what resuming means).
   */
  async begin(
    agentId: string,
    input: { workflowId: string; title?: string; procedures?: string[]; source: string },
  ): Promise<{ runId: string; record: WorkflowRecord; resumed: boolean }> {
    const existing = this.records.get(input.workflowId);
    const liveRunId = this.live.get(input.workflowId);
    if (liveRunId) {
      const liveRun = this.runs.get(liveRunId);
      if (liveRun && !liveRun.ended && this.deps.agentAlive(liveRun.agentId)) {
        throw new BridgeError(
          'conflict',
          `Workflow "${input.workflowId}" is running${liveRun.agentId === agentId ? '' : ' in another agent'}. Wait for it, cancel it (api.workflows.cancel) or use another id.`,
        );
      }
      if (liveRun) this.endRun(liveRun);
    }
    const now = this.now();
    const record: WorkflowRecord = existing ?? {
      id: input.workflowId,
      agentId,
      procedures: [],
      source: input.source,
      status: 'running',
      memo: {},
      ui: {},
      runs: 0,
      createdAt: now,
      updatedAt: now,
    };
    record.agentId = agentId;
    record.source = input.source;
    if (input.title) record.title = input.title.slice(0, 120);
    for (const id of input.procedures ?? [])
      if (!record.procedures.includes(id)) record.procedures.push(id);
    record.status = Object.values(record.ui).some((u) => u.status === 'open')
      ? 'waiting_user'
      : 'running';
    record.runs += 1;
    delete record.error;
    delete record.result;
    this.records.set(record.id, record);
    const run: Run = {
      runId: newId('run'),
      workflowId: record.id,
      agentId,
      seq: 0,
      events: [],
      waiters: new Set(),
      ended: false,
      lastSeen: this.deps.clock().getTime(),
      polling: 0,
    };
    // Events the user caused while no process ran it go to this run, in order.
    for (const queued of this.detachedEvents.get(record.id) ?? [])
      this.queueEvent(run, queued.key, queued.event);
    this.detachedEvents.delete(record.id);
    this.runs.set(run.runId, run);
    this.live.set(record.id, run.runId);
    await this.persist(record);
    this.emit(record);
    return { runId: run.runId, record, resumed: !!existing };
  }

  /** The state a run starts from (JSON values; JSON copies any depth, structuredClone doesn't). */
  stateOf(record: WorkflowRecord) {
    return {
      memo: jsonCopy(record.memo),
      ui: Object.fromEntries(
        Object.values(record.ui).map((u) => [
          u.key,
          {
            status: u.status,
            ...(u.status === 'closed' ? { result: u.result } : {}),
            durable: jsonCopy(u.durable),
            rev: u.rev,
          },
        ]),
      ),
    };
  }

  async memo(
    agentId: string,
    runId: string,
    key: string,
    value: unknown,
    remove: boolean,
  ): Promise<void> {
    const { record } = this.runOf(runId, agentId);
    const prev = record.memo[key];
    if (remove) delete record.memo[key];
    else {
      checkValue(`The value of "${key}"`, value);
      record.memo[key] = value === undefined ? {} : { value };
      this.checkSize(record, () => {
        if (prev) record.memo[key] = prev;
        else delete record.memo[key];
      });
    }
    await this.persist(record);
  }

  /** Adds procedures to a workflow (getOrCreate). */
  addProcedure(workflowId: string, procedureId: string): void {
    const record = this.records.get(workflowId);
    if (!record || record.procedures.includes(procedureId)) return;
    record.procedures.push(procedureId);
    this.persistSoon(record);
    this.emit(record);
  }

  async openUi(
    agentId: string,
    runId: string,
    key: string,
    tree: unknown,
    rev: number,
    signal: AbortSignal,
  ): Promise<void> {
    const { record } = this.runOf(runId, agentId);
    const problem = uiTreeProblem(tree);
    if (problem)
      throw new BridgeError('bad_request', `The interface "${key}" cannot be shown: ${problem}`);
    if (record.ui[key]?.status !== 'open' && openUis(record).length >= MAX_OPEN_UIS)
      throw new BridgeError(
        'bad_request',
        `Workflow "${record.id}" has ${MAX_OPEN_UIS} interfaces open: close some (api.ui.close) before presenting more.`,
      );
    await this.locate(record, tree as UiNode, signal);
    const prev = record.ui[key];
    record.ui[key] = {
      key,
      status: 'open',
      tree,
      rev,
      durable: prev?.durable ?? {},
      openedAt: prev?.status === 'open' ? prev.openedAt : this.now(),
    };
    this.checkSize(record, () => {
      if (prev) record.ui[key] = prev;
      else delete record.ui[key];
    });
    record.status = 'waiting_user';
    await this.persist(record);
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
    const { record } = this.runOf(runId, agentId);
    const ui = record.ui[key];
    if (ui?.status !== 'open') return;
    if (rev <= ui.rev && ui.tree) return;
    const problem = uiTreeProblem(tree);
    if (problem)
      throw new BridgeError('bad_request', `The interface "${key}" cannot be shown: ${problem}`);
    await this.locate(record, tree as UiNode, signal);
    const prev = { tree: ui.tree, rev: ui.rev };
    ui.tree = tree;
    ui.rev = rev;
    this.checkSize(record, () => Object.assign(ui, prev));
    this.persistSoon(record);
    this.emit(record);
  }

  durable(agentId: string, runId: string, key: string, name: string, value: unknown): void {
    const { record } = this.runOf(runId, agentId);
    const ui = record.ui[key];
    if (ui?.status !== 'open') return;
    checkValue(`The durable value "${name}"`, value);
    const had = Object.hasOwn(ui.durable, name);
    const prev = ui.durable[name];
    ui.durable[name] = value;
    this.checkSize(record, () => {
      if (had) ui.durable[name] = prev;
      else delete ui.durable[name];
    });
    this.persistSoon(record);
  }

  async closeUi(agentId: string, runId: string, key: string, result: unknown): Promise<void> {
    const { record } = this.runOf(runId, agentId);
    checkValue(`The result of "${key}"`, result);
    const ui = record.ui[key];
    // What the user answered, as the last tree shows it (the app keeps it, not the agent).
    const answers = ui?.status === 'open' ? uiTreeAnswers(ui.tree as UiNode | undefined) : [];
    record.ui[key] = {
      key,
      status: 'closed',
      rev: ui?.rev ?? 0,
      durable: ui?.durable ?? {},
      result,
      openedAt: ui?.openedAt ?? this.now(),
      closedAt: this.now(),
    };
    this.checkSize(record, () => {
      if (ui) record.ui[key] = ui;
      else delete record.ui[key];
    });
    if (!openUis(record).length && record.status === 'waiting_user') record.status = 'running';
    await this.persist(record);
    this.emit(record);
    if (answers.length && this.deps.saveAnswers)
      await this.deps.saveAnswers(record, answers).catch((err: unknown) =>
        this.deps.logger.warn('saving an interface’s answers failed', {
          workflowId: record.id,
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
    const run = this.runs.get(runId);
    // A run ended here (cancelled, or gone stale): its host stops it.
    if (!run && this.endedRuns.get(runId) === agentId) return { events: [], ended: true };
    if (!run || run.agentId !== agentId)
      throw new BridgeError('not_found', 'This workflow run has ended.');
    run.events = run.events.filter((e) => e.seq > after);
    if (run.ended) return { events: [], ended: true };
    run.lastSeen = this.deps.clock().getTime();
    run.polling++;
    try {
      if (!run.events.length) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            run.waiters.delete(done);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, this.deps.pollMs ?? 25_000);
          timer.unref?.();
          run.waiters.add(done);
          signal.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      run.polling--;
      run.lastSeen = this.deps.clock().getTime();
    }
    if (run.ended) return { events: [], ended: true };
    return { events: run.events.filter((e) => e.seq > after) };
  }

  /**
   * The renderer could not draw an open interface (a bug its tree ran into). It leaves the screen
   * and its run hears it as if `present` had been refused, at the line that presented it. With
   * no run, the agent is woken: the run that resumes the workflow presents it again and hears it
   * then. Returns false for a tree no longer shown (a newer one may draw; the renderer tries).
   */
  uiFailed(workflowId: string, key: string, rev: number, detail: string): boolean {
    const record = this.records.get(workflowId);
    const ui = record?.ui[key];
    if (!record || ui?.status !== 'open' || ui.rev !== rev) return false;
    delete record.ui[key];
    const runId = this.live.get(workflowId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (run && !run.ended) {
      if (!openUis(record).length && record.status === 'waiting_user') record.status = 'running';
      this.queueEvent(run, key, {
        handler: UI_FAILED,
        rev,
        value: `The interface "${key}" could not be shown: the app failed to draw ${detail}. Change what you pass to it and present it again.`,
      });
    } else this.deps.onDetachedEvent?.(record);
    this.persistSoon(record);
    this.emit(record);
    return true;
  }

  private queueEvent(run: Run, key: string, event: UiEvent): void {
    run.events.push({ seq: ++run.seq, key, event });
    if (run.events.length > MAX_QUEUED_EVENTS) run.events.shift();
    for (const wake of [...run.waiters]) wake();
  }

  /**
   * The user acted on an interface (from the renderer). Unknown or closed interfaces are
   * ignored (the tree on screen was stale). Returns false then.
   */
  userEvent(workflowId: string, key: string, event: UiEvent): boolean {
    const record = this.records.get(workflowId);
    const ui = record?.ui[key];
    if (!record || !ui || ui.status !== 'open') return false;
    const runId = this.live.get(workflowId);
    const run = runId ? this.runs.get(runId) : undefined;
    if (run && !run.ended) {
      this.queueEvent(run, key, event);
      return true;
    }
    const queued = this.detachedEvents.get(workflowId) ?? [];
    queued.push({ key, event });
    if (queued.length > MAX_QUEUED_EVENTS) queued.shift();
    this.detachedEvents.set(workflowId, queued);
    this.deps.onDetachedEvent?.(record);
    return true;
  }

  private endRun(run: Run): void {
    if (run.ended) return;
    run.ended = true;
    this.endedRuns.set(run.runId, run.agentId);
    if (this.endedRuns.size > 200)
      this.endedRuns.delete(this.endedRuns.keys().next().value as string);
    for (const wake of [...run.waiters]) wake();
    if (this.live.get(run.workflowId) === run.runId) this.live.delete(run.workflowId);
    this.runs.delete(run.runId);
  }

  async end(
    agentId: string,
    runId: string,
    outcome: WorkflowEnd['outcome'],
    deliver: boolean,
  ): Promise<void> {
    const cancelled = this.cancelledRuns.get(runId);
    if (cancelled && !this.runs.has(runId) && this.endedRuns.get(runId) === agentId) {
      // Cancelled from outside: the record already says so; its agent hears it now.
      this.cancelledRuns.delete(runId);
      const record = this.records.get(cancelled.workflowId);
      if (record)
        this.deps.onEnd?.({
          workflow: record,
          agentId,
          outcome: {
            status: 'cancelled',
            ...(cancelled.reason ? { error: cancelled.reason } : {}),
          },
          deliver,
        });
      return;
    }
    const { run, record } = this.runOf(runId, agentId);
    this.endRun(run);
    record.status =
      outcome.status === 'succeeded'
        ? 'succeeded'
        : outcome.status === 'failed'
          ? 'failed'
          : 'cancelled';
    if (outcome.value !== undefined) record.result = outcome.value.slice(0, 100_000);
    if (outcome.error) record.error = outcome.error.slice(0, 10_000);
    // A finished workflow shows no interface any more.
    for (const ui of Object.values(record.ui)) if (ui.status === 'open') this.withdraw(ui);
    await this.persist(record);
    // Its agent hears the result first: the meter goes from the workflow to the agent's run
    // without showing it idle in between.
    this.deps.onEnd?.({ workflow: record, agentId, outcome, deliver });
    this.emit(record);
  }

  private withdraw(ui: UiRecord): void {
    ui.status = 'closed';
    ui.result = { withdrawn: true };
    ui.closedAt = this.now();
    delete ui.tree;
  }

  /**
   * Stops a workflow from outside (the coordinator, the user): its live run ends (the host's
   * poll says so and it cancels the run), its interfaces are withdrawn. Its agent hears it, as
   * it hears any end (when the host ends the run, or now when no process runs it), unless `by`
   * that agent itself.
   */
  async cancel(id: string, reason?: string, by?: string): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    const runId = this.live.get(id);
    const run = runId ? this.runs.get(runId) : undefined;
    const tell = by !== record.agentId;
    if (run) {
      this.endRun(run);
      if (tell) {
        this.cancelledRuns.set(run.runId, { workflowId: id, ...(reason ? { reason } : {}) });
        if (this.cancelledRuns.size > 200)
          this.cancelledRuns.delete(this.cancelledRuns.keys().next().value as string);
      }
    }
    this.detachedEvents.delete(id);
    const wasActive =
      record.status === 'running' ||
      record.status === 'waiting_user' ||
      record.status === 'interrupted';
    if (wasActive) {
      record.status = 'cancelled';
      record.error = reason ? `Cancelled: ${reason}` : 'Cancelled';
    }
    for (const ui of Object.values(record.ui)) if (ui.status === 'open') this.withdraw(ui);
    await this.persist(record);
    this.emit(record);
    if (wasActive && tell && !run)
      this.deps.onEnd?.({
        workflow: record,
        agentId: record.agentId,
        outcome: { status: 'cancelled', ...(reason ? { error: reason } : {}) },
        deliver: true,
      });
    return wasActive;
  }

  /**
   * An agent's process ended: its runs end with it. Workflows waiting for the user stay so
   * (their interfaces stay on screen and resume later); running ones are interrupted. Returns
   * the interrupted ones.
   */
  detachAgent(agentId: string): WorkflowRecord[] {
    const interrupted: WorkflowRecord[] = [];
    for (const run of [...this.runs.values()]) {
      if (run.agentId !== agentId) continue;
      this.endRun(run);
      const record = this.records.get(run.workflowId);
      if (!record) continue;
      if (record.status === 'running') {
        record.status = 'interrupted';
        interrupted.push(record);
      }
      this.persistSoon(record);
      this.emit(record);
    }
    return interrupted;
  }

  /** Workflows of this agent to resume when its process starts: they wait for the user. */
  resumable(agentId: string): WorkflowRecord[] {
    return this.list().filter(
      (w) => w.agentId === agentId && w.status === 'waiting_user' && !this.live.has(w.id),
    );
  }

  /** Workflows waiting for the user that no process runs (their agents may be woken). */
  detachedWaiting(): WorkflowRecord[] {
    return this.list().filter((w) => w.status === 'waiting_user' && !this.live.has(w.id));
  }

  isLive(id: string): boolean {
    return this.live.has(id);
  }

  /** Removes a procedure from every workflow (the procedure was deleted). */
  forgetProcedure(procedureId: string): void {
    for (const record of this.records.values()) {
      const index = record.procedures.indexOf(procedureId);
      if (index === -1) continue;
      record.procedures.splice(index, 1);
      this.persistSoon(record);
    }
  }

  async deleteAll(): Promise<void> {
    this.dispose();
    for (const run of [...this.runs.values()]) this.endRun(run);
    this.records.clear();
    this.detachedEvents.clear();
    this.places.clear();
    await this.writer.flush().catch(() => {});
    await rm(this.deps.dir, { recursive: true, force: true }).catch(() => {});
    await ensurePrivateDir(this.deps.dir);
  }

  // --- maps ----------------------------------------------------------------------------------

  /** Every map address of a tree must be found before it is shown (no partial maps). */
  private async locate(record: WorkflowRecord, tree: UiNode, signal: AbortSignal): Promise<void> {
    const lookup = this.deps.placeLookup;
    const addresses = uiTreeAddresses(tree);
    if (!lookup || !addresses.length) return;
    const known = this.places.get(record.id) ?? new Map<string, MapPoint | null>();
    this.places.set(record.id, known);
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

  /** Pins of the given addresses of an open interface, for its map (null: not found). */
  pins(workflowId: string, key: string, addresses: string[]): (MapPoint | null)[] {
    const record = this.records.get(workflowId);
    const ui = record?.ui[key];
    if (!record || !ui || ui.status !== 'open' || !ui.tree) return addresses.map(() => null);
    const allowed = new Set(uiTreeAddresses(ui.tree as UiNode));
    const known = this.places.get(workflowId);
    return addresses.map((a) => (allowed.has(a) ? (known?.get(a) ?? null) : null));
  }

  /** Looks up the pins of an open interface restored after a restart (once, then kept in memory). */
  async locateOpen(workflowId: string, key: string, signal: AbortSignal): Promise<void> {
    const record = this.records.get(workflowId);
    const ui = record?.ui[key];
    if (!record || !ui?.tree) return;
    await this.locate(record, ui.tree as UiNode, signal).catch(() => {});
  }
}

function openUis(w: WorkflowRecord): UiRecord[] {
  return Object.values(w.ui)
    .filter((u) => u.status === 'open')
    .sort((a, b) => a.openedAt.localeCompare(b.openedAt));
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
