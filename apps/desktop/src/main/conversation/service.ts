import { readFileSync } from 'node:fs';
import { ChatItem, type ConversationState, type NoticeItem, type Prompt } from '@sa/shared';
import type { TranscriptSink } from '../chat/sink';
import type { EventBus } from '../core/events';
import { DebouncedWriter, ensurePrivateDir, writeFileAtomic } from '../core/fs';
import type { Logger } from '../core/logger';
import type { Clock, IdFactory } from '../core/util';

/** Older items are dropped from the saved transcript (the assistant keeps its own summary). */
export const MAX_CONVERSATION_ITEMS = 1500;

export interface ConversationServiceDeps {
  /** Directory of the assistant: transcript.json, session.jsonl, work/. */
  dir: string;
  transcriptFile: string;
  events: EventBus;
  logger: Logger;
  ids: IdFactory;
  clock: Clock;
  debounceMs?: number;
}

/**
 * The single, perpetual conversation with the assistant: its items (persisted, debounced and
 * atomic) and the assistant's runtime state. Every change is pushed to the renderer
 * (`chat.item`, `chat.delta`, `chat.state`). Prompts of procedure agents land here too.
 */
export class ConversationService implements TranscriptSink {
  private items: ChatItem[] = [];
  private running = false;
  private pendingPrompts = 0;
  private error?: string;
  private lastState = JSON.stringify({ activity: 'idle' });
  private readonly writer: DebouncedWriter;

  constructor(private readonly deps: ConversationServiceDeps) {
    this.writer = new DebouncedWriter(deps.debounceMs ?? 250, (key, err) =>
      deps.logger.error(`write failed: ${key}`, err),
    );
  }

  /** Loads the saved transcript (items left in flight by a previous run are closed). */
  async init(): Promise<void> {
    await ensurePrivateDir(this.deps.dir);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.deps.transcriptFile, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        this.deps.logger.warn('conversation transcript unreadable', err);
      raw = [];
    }
    const now = this.now();
    this.items = (Array.isArray(raw) ? raw : []).flatMap((value) => {
      const parsed = ChatItem.safeParse(value);
      return parsed.success ? [closeStaleItem(parsed.data, now)] : [];
    });
  }

  private now(): string {
    return this.deps.clock().toISOString();
  }

  transcript(): ChatItem[] {
    return this.items;
  }

  state(): ConversationState {
    const activity =
      this.pendingPrompts > 0 ? 'needs_user' : this.running ? 'working' : ('idle' as const);
    return { activity, ...(this.error ? { error: this.error } : {}) };
  }

  // --- TranscriptSink --------------------------------------------------------------------------

  exists(): boolean {
    return true;
  }

  findItem(itemId: string): ChatItem | undefined {
    return this.items.find((i) => i.id === itemId);
  }

  upsertItem(item: ChatItem): void {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
    if (this.items.length > MAX_CONVERSATION_ITEMS)
      this.items.splice(0, this.items.length - MAX_CONVERSATION_ITEMS);
    this.persist();
    this.deps.events.emit({ type: 'chat.item', item: structuredClone(item) });
  }

  appendDelta(itemId: string, delta: string): void {
    if (!delta) return;
    const item = this.findItem(itemId);
    if (item?.type !== 'assistant') return;
    item.text += delta;
    this.persist();
    this.deps.events.emit({ type: 'chat.delta', itemId, delta });
  }

  addNotice(level: NoticeItem['level'], text: string, procedureId?: string): NoticeItem {
    const item: NoticeItem = {
      id: this.deps.ids('n'),
      createdAt: this.now(),
      type: 'notice',
      level,
      text,
      ...(procedureId ? { procedureId } : {}),
    };
    this.upsertItem(item);
    return item;
  }

  newItemId(prefix = 'i'): string {
    return this.deps.ids(prefix);
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.emitState();
  }

  setError(error: string | undefined): void {
    this.error = error;
    this.emitState();
  }

  setUnread(): void {
    // The conversation is always on screen.
  }

  setPendingPrompts(count: number): void {
    this.pendingPrompts = Math.max(0, count);
    this.emitState();
  }

  // --- persistence -----------------------------------------------------------------------------

  private emitState(): void {
    const state = this.state();
    const json = JSON.stringify(state);
    if (json === this.lastState) return;
    this.lastState = json;
    this.deps.events.emit({ type: 'chat.state', state });
  }

  private persist(): void {
    const file = this.deps.transcriptFile;
    this.writer.schedule('conversation', () => writeFileAtomic(file, JSON.stringify(this.items)));
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  /** Forgets everything (wipe). */
  async clear(): Promise<void> {
    await this.writer.cancel('');
    this.items = [];
    this.running = false;
    this.pendingPrompts = 0;
    this.error = undefined;
    this.emitState();
  }
}

/**
 * Questions that stay pending across a restart: data forms and phone calls (the user may call
 * hours later, when the office opens). Nothing live depends on them, unlike confirmations and
 * manual actions, which refer to a browser page that is gone.
 */
export function promptSurvivesRestart(prompt: Prompt): boolean {
  return prompt.kind === 'form' || prompt.kind === 'phone_call';
}

/** Close interrupted work; unanswered forms and phone calls can be restored by PromptManager. */
export function closeStaleItem(item: ChatItem, now: string): ChatItem {
  if (item.type === 'prompt' && item.status === 'pending' && !promptSurvivesRestart(item.prompt))
    return { ...item, status: 'cancelled' };
  if (item.type === 'assistant' && item.status === 'streaming')
    return { ...item, status: 'aborted' };
  if (item.type === 'activity' && item.status === 'running')
    return { ...item, status: 'error', finishedAt: now };
  return item;
}
