import type { ChatItem, NoticeItem, ProcedureRuntime } from '@sa/shared';

/**
 * Where an agent's events end up: the conversation (for the assistant) or a procedure's
 * activity log (for that procedure's agent). See TranscriptMapper.
 */
export interface TranscriptSink {
  /** False once the target is gone (e.g. the procedure was deleted). */
  exists(): boolean;
  findItem(itemId: string): ChatItem | undefined;
  upsertItem(item: ChatItem): void;
  appendDelta(itemId: string, delta: string): void;
  addNotice(level: NoticeItem['level'], text: string): void;
  newItemId(prefix: string): string;
  setRunning(running: boolean): void;
  setError(error: string | undefined): void;
  /** New output the user has not seen. */
  setUnread(): void;
  /** What the agent is doing right now (procedures only). */
  setNow?(now: ProcedureRuntime['now']): void;
}
