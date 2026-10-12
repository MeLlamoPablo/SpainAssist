import {
  type ChatItem,
  emptyProcedure,
  type Language,
  type NoticeItem,
  Procedure,
  type ProcedureBrief,
  type ProcedureListItem,
  type ProcedureRuntime,
  type ProcedureUpdate,
  type PromptItem,
} from '@sa/shared';
import type { ProcedurePaths } from '../app/paths';
import type { TranscriptSink } from '../chat/sink';
import { closeStaleItem } from '../conversation/service';
import { UserError } from '../core/errors';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import type { Clock, IdFactory } from '../core/util';
import type { ProcedureStore } from './store';

interface RuntimeState {
  /** The agent is running (between run start and run end), or a message is being delivered. */
  running: boolean;
  /** Questions waiting for the user, oldest first. */
  prompts: PromptItem[];
  unread: boolean;
  error?: string;
  /** When the agent last started working: `running` turned on or the user answered (ISO). */
  since?: string;
  now?: ProcedureRuntime['now'];
}

export interface ProcedureServiceDeps {
  store: ProcedureStore;
  events: EventBus;
  logger: Logger;
  ids: IdFactory;
  clock: Clock;
  lang: () => Language;
}

/**
 * Procedures, their runtime state and their agents' activity logs (in memory, persisted through
 * ProcedureStore). Every change is pushed to the renderer: `procedure.upserted`,
 * `procedure.log`, `procedure.deleted`.
 */
export class ProcedureService {
  private readonly procedures = new Map<string, Procedure>();
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly transcripts = new Map<string, ChatItem[]>();
  private readonly lastEmitted = new Map<string, string>();

  constructor(private readonly deps: ProcedureServiceDeps) {}

  async init(): Promise<void> {
    for (const p of await this.deps.store.loadAll()) this.procedures.set(p.id, p);
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  // --- procedures --------------------------------------------------------------------------

  list(): ProcedureListItem[] {
    return [...this.procedures.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((p) => this.toListItem(p));
  }

  /** What the assistant sees in `procedures.list`. */
  briefs(includeArchived: boolean): ProcedureBrief[] {
    return this.list()
      .filter((p) => includeArchived || !p.archived)
      .map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        activity: p.runtime.activity,
        ...(p.nextAction ? { nextAction: p.nextAction } : {}),
        archived: p.archived,
        updatedAt: p.updatedAt,
      }));
  }

  get(id: string): ProcedureListItem | null {
    const p = this.procedures.get(id);
    return p ? this.toListItem(p) : null;
  }

  has(id: string): boolean {
    return this.procedures.has(id);
  }

  require(id: string): Procedure {
    const p = this.procedures.get(id);
    if (!p) throw new UserError(t(this.deps.lang(), 'procedureNotFound'), 'not_found');
    return p;
  }

  paths(id: string): ProcedurePaths {
    this.require(id);
    return this.deps.store.paths(id);
  }

  async create(title: string): Promise<Procedure> {
    const id = this.deps.ids('p');
    const procedure = emptyProcedure(
      id,
      title.slice(0, 160) || t(this.deps.lang(), 'newProcedure'),
      this.now(),
    );
    await this.deps.store.create(procedure);
    this.procedures.set(id, procedure);
    this.transcripts.set(id, []);
    this.emitUpsert(id);
    return procedure;
  }

  rename(id: string, title: string): ProcedureListItem {
    this.save({ ...this.require(id), title: title.trim().slice(0, 160), updatedAt: this.now() });
    return this.get(id)!;
  }

  setArchived(id: string, archived: boolean): ProcedureListItem {
    this.save({ ...this.require(id), archived, updatedAt: this.now() });
    return this.get(id)!;
  }

  /** Bumps updatedAt (new activity in the conversation). */
  touch(id: string): void {
    const p = this.procedures.get(id);
    if (p) this.save({ ...p, updatedAt: this.now() });
  }

  /**
   * Applies an agent update (`procedure_update` tool). Arrays replace; `nextAction: null`
   * clears it.
   */
  applyUpdate(id: string, update: ProcedureUpdate): Procedure {
    const next: Procedure = { ...this.require(id) };
    if (update.title !== undefined) next.title = update.title;
    if (update.summary !== undefined) next.summary = update.summary;
    if (update.status !== undefined) next.status = update.status;
    if (update.administration !== undefined) next.administration = update.administration;
    if (update.steps !== undefined) next.steps = update.steps;
    if (update.requirements !== undefined) next.requirements = update.requirements;
    if (update.facts !== undefined) next.facts = update.facts;
    if (update.sources !== undefined) {
      next.sources = update.sources.map((s) => ({ title: s.title, url: s.url }));
    }
    if (update.nextAction === null) delete next.nextAction;
    else if (update.nextAction !== undefined) next.nextAction = update.nextAction;
    next.updatedAt = this.now();
    const valid = Procedure.parse(next);
    this.save(valid);
    return valid;
  }

  async delete(id: string): Promise<void> {
    this.require(id);
    this.procedures.delete(id);
    this.runtime.delete(id);
    this.transcripts.delete(id);
    this.lastEmitted.delete(id);
    await this.deps.store.delete(id);
    this.deps.events.emit({ type: 'procedure.deleted', procedureId: id });
  }

  /** Forgets everything (wipe). */
  async deleteAll(): Promise<void> {
    const ids = [...this.procedures.keys()];
    this.procedures.clear();
    this.runtime.clear();
    this.transcripts.clear();
    this.lastEmitted.clear();
    await this.deps.store.deleteAll();
    for (const id of ids) this.deps.events.emit({ type: 'procedure.deleted', procedureId: id });
  }

  flush(): Promise<void> {
    return this.deps.store.flush();
  }

  private save(p: Procedure): void {
    this.procedures.set(p.id, p);
    this.deps.store.saveProcedure(p);
    this.emitUpsert(p.id);
  }

  // --- runtime -----------------------------------------------------------------------------

  runtimeOf(id: string): ProcedureRuntime {
    const r = this.runtime.get(id);
    if (!r) return { activity: 'idle', unread: false };
    const activity = r.prompts.length > 0 ? 'needs_user' : r.running ? 'working' : 'idle';
    return {
      activity,
      unread: r.unread,
      ...(r.error ? { error: r.error } : {}),
      ...(activity === 'working' && r.since ? { workingSince: r.since } : {}),
      ...(r.running && r.now ? { now: r.now } : {}),
      ...(r.prompts.length ? { prompts: structuredClone(r.prompts) } : {}),
    };
  }

  private updateRuntime(id: string, fn: (r: RuntimeState) => void): void {
    if (!this.procedures.has(id)) return;
    const r = this.runtime.get(id) ?? { running: false, prompts: [], unread: false };
    fn(r);
    this.runtime.set(id, r);
    this.emitUpsert(id);
  }

  setRunning(id: string, running: boolean): void {
    this.updateRuntime(id, (r) => {
      if (running && !r.running) r.since = this.now();
      r.running = running;
      if (!running) {
        r.since = undefined;
        r.now = undefined;
      }
    });
  }

  isRunning(id: string): boolean {
    return this.runtime.get(id)?.running ?? false;
  }

  setNow(id: string, now: ProcedureRuntime['now']): void {
    this.updateRuntime(id, (r) => {
      r.now = now;
    });
  }

  /** The questions the procedure's agent is waiting on (see PromptManager). */
  setPrompts(id: string, prompts: PromptItem[]): void {
    this.updateRuntime(id, (r) => {
      // Time spent waiting on the user is not work: count again once the questions are gone.
      if (r.prompts.length > 0 && prompts.length === 0) r.since = this.now();
      r.prompts = prompts;
    });
  }

  setError(id: string, error: string | undefined): void {
    this.updateRuntime(id, (r) => {
      r.error = error;
    });
  }

  setUnread(id: string): void {
    this.updateRuntime(id, (r) => {
      r.unread = true;
    });
  }

  markRead(id: string): void {
    this.require(id);
    this.updateRuntime(id, (r) => {
      r.unread = false;
    });
  }

  private toListItem(p: Procedure): ProcedureListItem {
    return { ...p, runtime: this.runtimeOf(p.id) };
  }

  private emitUpsert(id: string): void {
    const p = this.procedures.get(id);
    if (!p) return;
    const item = this.toListItem(p);
    const json = JSON.stringify(item);
    if (this.lastEmitted.get(id) === json) return;
    this.lastEmitted.set(id, json);
    this.deps.events.emit({ type: 'procedure.upserted', procedure: item });
  }

  // --- activity log ------------------------------------------------------------------------

  /** Where the procedure's agent events go (see TranscriptMapper). */
  sinkFor(id: string): TranscriptSink {
    return {
      exists: () => this.has(id),
      findItem: (itemId) => (this.has(id) ? this.findItem(id, itemId) : undefined),
      upsertItem: (item) => this.upsertItem(id, item),
      appendDelta: (itemId, delta) => this.appendDelta(id, itemId, delta),
      addNotice: (level, text) => {
        this.addNotice(id, level, text);
      },
      newItemId: (prefix) => this.newItemId(prefix),
      setRunning: (running) => this.setRunning(id, running),
      setError: (error) => this.setError(id, error),
      setUnread: () => this.setUnread(id),
      setNow: (now) => this.setNow(id, now),
    };
  }

  /** The activity log (loaded lazily; stale pending/streaming states are closed on load). */
  transcript(id: string): ChatItem[] {
    this.require(id);
    let items = this.transcripts.get(id);
    if (!items) {
      items = this.deps.store
        .loadTranscriptSync(id)
        .map((item) => closeStaleItem(item, this.now()));
      this.transcripts.set(id, items);
    }
    return items;
  }

  findItem(id: string, itemId: string): ChatItem | undefined {
    return this.transcript(id).find((i) => i.id === itemId);
  }

  upsertItem(id: string, item: ChatItem): void {
    if (!this.procedures.has(id)) return;
    const items = this.transcript(id);
    const index = items.findIndex((i) => i.id === item.id);
    if (index >= 0) items[index] = item;
    else items.push(item);
    this.persistTranscript(id);
    this.deps.events.emit({ type: 'procedure.log', procedureId: id, item: structuredClone(item) });
  }

  appendDelta(id: string, itemId: string, delta: string): void {
    if (!this.procedures.has(id) || !delta) return;
    const item = this.findItem(id, itemId);
    if (item?.type !== 'assistant') return;
    item.text += delta;
    this.persistTranscript(id);
    this.deps.events.emit({ type: 'procedure.log', procedureId: id, item: structuredClone(item) });
  }

  addNotice(id: string, level: NoticeItem['level'], text: string): NoticeItem | undefined {
    if (!this.procedures.has(id)) return undefined;
    const item: NoticeItem = {
      id: this.deps.ids('n'),
      createdAt: this.now(),
      type: 'notice',
      level,
      text,
    };
    this.upsertItem(id, item);
    return item;
  }

  newItemId(prefix = 'i'): string {
    return this.deps.ids(prefix);
  }

  private persistTranscript(id: string): void {
    this.deps.store.saveTranscript(id, () => this.transcripts.get(id) ?? []);
  }
}
