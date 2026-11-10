import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ChatItem,
  type CodemodeAgentInfo,
  CodemodeAgentKind,
  type NoticeItem,
  type ProcedureRuntime,
} from '@sa/shared';
import { z } from 'zod';
import type { TranscriptSink } from '../chat/sink';
import { closeStaleItem } from '../conversation/service';
import type { EventBus } from '../core/events';
import { DebouncedWriter, ensurePrivateDir, readJsonFile, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import { type Clock, isSafeId, newId } from '../core/util';

/**
 * The agents of the codemode harness, independent of procedures: background agents the
 * coordinator starts for a piece of work (`a_…`). Each has a record, an activity log and a pi
 * session in agents/<id>/. The renderer shows them as the progress meter, apart from the procedure cards.
 */

const AgentRecord = z.preprocess(
  // Records saved before the status was introduced had a title.
  (raw) =>
    raw && typeof raw === 'object' && !('status' in raw) && 'title' in raw
      ? { ...raw, status: (raw as { title: unknown }).title }
      : raw,
  z.object({
    id: z.string(),
    kind: CodemodeAgentKind,
    status: z.string(),
    brief: z.string().optional(),
    parentId: z.string().optional(),
    procedures: z.array(z.string()),
    stopped: z.boolean().default(false),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);
export type AgentRecord = z.infer<typeof AgentRecord>;

interface Runtime {
  running: boolean;
  /** One of its workflows runs on its own, after its codemode call returned: it still works. */
  workflowRunning: boolean;
  waitingUser: boolean;
  /** A prompt it showed waits for the user (it may still be running). */
  asking: boolean;
  now?: string;
  /** When its current stretch of work (runs and the workflows between them) started. */
  since?: string;
  error?: string;
}

export interface AgentPaths {
  dir: string;
  agentFile: string;
  transcriptFile: string;
  sessionFile: string;
  workDir: string;
}

const MAX_TRANSCRIPT_ITEMS = 800;

export interface CodemodeAgentsDeps {
  dir: string;
  events: EventBus;
  logger: Logger;
  clock: Clock;
  debounceMs?: number;
}

export class CodemodeAgents {
  private readonly records = new Map<string, AgentRecord>();
  private readonly runtime = new Map<string, Runtime>();
  private readonly transcripts = new Map<string, ChatItem[]>();
  private readonly writer: DebouncedWriter;
  private readonly lastEmitted = new Map<string, string>();

  constructor(private readonly deps: CodemodeAgentsDeps) {
    this.writer = new DebouncedWriter(deps.debounceMs ?? 300, (key, err) =>
      deps.logger.error(`agent write failed: ${key}`, err),
    );
  }

  async init(): Promise<void> {
    await ensurePrivateDir(this.deps.dir);
    let entries: string[] = [];
    try {
      entries = await readdir(this.deps.dir);
    } catch {
      entries = [];
    }
    for (const id of entries) {
      if (!isSafeId(id)) continue;
      const parsed = AgentRecord.safeParse(
        await readJsonFile(this.paths(id).agentFile).catch(() => undefined),
      );
      if (parsed.success) this.records.set(id, parsed.data);
    }
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  paths(id: string): AgentPaths {
    const dir = join(this.deps.dir, id);
    return {
      dir,
      agentFile: join(dir, 'agent.json'),
      transcriptFile: join(dir, 'transcript.json'),
      sessionFile: join(dir, 'session.jsonl'),
      workDir: join(dir, 'work'),
    };
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  kindOf(id: string): AgentRecord['kind'] | undefined {
    return this.records.get(id)?.kind;
  }

  /** A new background agent. */
  async create(input: {
    status: string;
    brief: string;
    parentId?: string;
    procedures?: string[];
  }): Promise<AgentRecord> {
    const now = this.now();
    const record: AgentRecord = {
      id: newId('a'),
      kind: 'agent',
      status: input.status.slice(0, 120),
      brief: input.brief,
      ...(input.parentId ? { parentId: input.parentId } : {}),
      procedures: [...(input.procedures ?? [])],
      stopped: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.store(record);
    return record;
  }

  private async store(record: AgentRecord): Promise<void> {
    this.records.set(record.id, record);
    const p = this.paths(record.id);
    await ensurePrivateDir(p.dir);
    await writeFileAtomic(p.agentFile, JSON.stringify(record));
    this.transcripts.set(record.id, this.transcripts.get(record.id) ?? []);
    this.emit(record.id);
  }

  private save(record: AgentRecord): void {
    record.updatedAt = this.now();
    this.writer.schedule(`agent:${record.id}`, () =>
      writeFileAtomic(this.paths(record.id).agentFile, JSON.stringify(record)),
    );
  }

  /** The agent worked on a procedure (most recent first). */
  touchProcedure(id: string, procedureId: string): void {
    const record = this.records.get(id);
    if (!record) return;
    const list = [procedureId, ...record.procedures.filter((p) => p !== procedureId)].slice(0, 20);
    if (JSON.stringify(list) === JSON.stringify(record.procedures)) return;
    record.procedures = list;
    this.save(record);
    this.emit(id);
  }

  /** What the agent is doing now, from the coordinator or the agent itself. */
  setStatus(id: string, status: string): void {
    const record = this.records.get(id);
    const next = status.trim().slice(0, 120);
    if (!record || !next || record.status === next) return;
    record.status = next;
    this.save(record);
    this.emit(id);
  }

  setStopped(id: string, stopped: boolean): void {
    const record = this.records.get(id);
    if (!record || record.stopped === stopped) return;
    record.stopped = stopped;
    this.save(record);
    this.emit(id);
  }

  forgetProcedure(procedureId: string): void {
    for (const record of this.records.values()) {
      if (!record.procedures.includes(procedureId)) continue;
      record.procedures = record.procedures.filter((p) => p !== procedureId);
      this.save(record);
      this.emit(record.id);
    }
  }

  // --- runtime -------------------------------------------------------------------------------

  private rt(id: string): Runtime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { running: false, workflowRunning: false, waitingUser: false, asking: false };
      this.runtime.set(id, r);
    }
    return r;
  }

  setRunning(id: string, running: boolean): void {
    const r = this.rt(id);
    if (r.running === running) return;
    const wasBusy = busy(r);
    r.running = running;
    if (!running) delete r.now;
    this.updateSince(r, wasBusy);
    this.emit(id);
  }

  /** One of its workflows runs, or none does: the meter shows it working meanwhile. */
  setWorkflowRunning(id: string, running: boolean): void {
    const r = this.rt(id);
    if (r.workflowRunning === running) return;
    const wasBusy = busy(r);
    r.workflowRunning = running;
    this.updateSince(r, wasBusy);
    this.emit(id);
  }

  /** The timer runs from the start of the work until neither a run nor a workflow goes on. */
  private updateSince(r: Runtime, wasBusy: boolean): void {
    if (!busy(r)) delete r.since;
    else if (!wasBusy) r.since = this.now();
  }

  /** It waits for the user on a prompt it showed while it works: its timer starts again after. */
  setAsking(id: string, asking: boolean): void {
    const r = this.rt(id);
    if (r.asking === asking) return;
    r.asking = asking;
    if (!asking && busy(r)) r.since = this.now();
    this.emit(id);
  }

  setWaitingUser(id: string, waiting: boolean): void {
    const r = this.rt(id);
    if (r.waitingUser === waiting) return;
    r.waitingUser = waiting;
    this.emit(id);
  }

  setNow(id: string, now: string | undefined): void {
    const r = this.rt(id);
    if (r.now === now) return;
    if (now) r.now = now.slice(0, 200);
    else delete r.now;
    this.emit(id);
  }

  setError(id: string, error: string | undefined): void {
    const r = this.rt(id);
    if (r.error === error) return;
    if (error) r.error = error;
    else delete r.error;
    this.emit(id);
  }

  isRunning(id: string): boolean {
    return this.runtime.get(id)?.running ?? false;
  }

  info(id: string): CodemodeAgentInfo | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    const r = this.runtime.get(id);
    return {
      id: record.id,
      kind: record.kind,
      status: record.status,
      ...(record.parentId ? { parentId: record.parentId } : {}),
      activity:
        r && busy(r) && !r.asking
          ? 'working'
          : r?.asking || r?.waitingUser
            ? 'waiting_user'
            : 'idle',
      ...(r?.running && r.now ? { now: r.now } : {}),
      ...(r && busy(r) && !r.asking && r.since ? { since: r.since } : {}),
      procedures: [...record.procedures],
      ...(r?.error ? { error: r.error } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  /** Agents the renderer shows: background agents, newest first. */
  infos(): CodemodeAgentInfo[] {
    return [...this.records.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => this.info(r.id))
      .filter((a): a is CodemodeAgentInfo => !!a);
  }

  private emit(id: string): void {
    const agent = this.info(id);
    if (!agent) return;
    const json = JSON.stringify(agent);
    if (this.lastEmitted.get(id) === json) return;
    this.lastEmitted.set(id, json);
    this.deps.events.emit({ type: 'codemode.agent', agent });
  }

  // --- activity logs -------------------------------------------------------------------------

  async transcript(id: string): Promise<ChatItem[]> {
    const cached = this.transcripts.get(id);
    if (cached) return cached;
    let raw: unknown = [];
    try {
      raw = JSON.parse(await readFile(this.paths(id).transcriptFile, 'utf8'));
    } catch {
      raw = [];
    }
    const now = this.now();
    const items = (Array.isArray(raw) ? raw : []).flatMap((value) => {
      const parsed = ChatItem.safeParse(value);
      return parsed.success ? [closeStaleItem(parsed.data, now)] : [];
    });
    this.transcripts.set(id, items);
    return items;
  }

  private items(id: string): ChatItem[] {
    let items = this.transcripts.get(id);
    if (!items) {
      items = [];
      this.transcripts.set(id, items);
    }
    return items;
  }

  private persistTranscript(id: string): void {
    this.writer.schedule(`log:${id}`, async () => {
      const items = this.items(id).slice(-MAX_TRANSCRIPT_ITEMS);
      await writeFileAtomic(this.paths(id).transcriptFile, JSON.stringify(items));
    });
  }

  sinkFor(id: string): TranscriptSink {
    const events = this.deps.events;
    return {
      exists: () => this.records.has(id),
      findItem: (itemId) => this.items(id).find((i) => i.id === itemId),
      upsertItem: (item) => {
        const items = this.items(id);
        const index = items.findIndex((i) => i.id === item.id);
        if (index === -1) items.push(item);
        else items[index] = item;
        if (items.length > MAX_TRANSCRIPT_ITEMS * 1.25)
          items.splice(0, items.length - MAX_TRANSCRIPT_ITEMS);
        this.persistTranscript(id);
        events.emit({ type: 'codemode.agentLog', agentId: id, item });
      },
      appendDelta: (itemId, delta) => {
        const item = this.items(id).find((i) => i.id === itemId);
        if (item?.type !== 'assistant') return;
        item.text += delta;
        this.persistTranscript(id);
        events.emit({ type: 'codemode.agentLog', agentId: id, item });
      },
      addNotice: (level: NoticeItem['level'], text: string) => {
        const item: NoticeItem = {
          id: newId('n'),
          createdAt: this.now(),
          type: 'notice',
          level,
          text,
        };
        this.sinkFor(id).upsertItem(item);
      },
      newItemId: (prefix) => newId(prefix),
      setRunning: (running) => this.setRunning(id, running),
      setError: (error) => this.setError(id, error),
      setUnread: () => {},
      setNow: (now: ProcedureRuntime['now']) =>
        this.setNow(id, now ? activityLabel(now) : undefined),
    };
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  async deleteAll(): Promise<void> {
    await this.writer.flush().catch(() => {});
    this.records.clear();
    this.runtime.clear();
    this.transcripts.clear();
    await rm(this.deps.dir, { recursive: true, force: true }).catch(() => {});
    await ensurePrivateDir(this.deps.dir);
  }
}

/** It works: a run goes on, or one of its workflows runs on its own. */
function busy(r: Runtime): boolean {
  return r.running || r.workflowRunning;
}

/**
 * A tool call in a few words for the meter: the workflow's title. Never the tool's name
 * ("codemode"): without a title the meter says it works.
 */
function activityLabel(now: NonNullable<ProcedureRuntime['now']>): string | undefined {
  const title = typeof now.args.title === 'string' ? now.args.title.trim() : '';
  return title || undefined;
}
