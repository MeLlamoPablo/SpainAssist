import type { AgentEvent } from '@sa/agent';
import type { ActivityItem, AssistantItem, Language } from '@sa/shared';
import { friendlyAgentError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import type { Clock } from '../core/util';
import type { TranscriptSink } from './sink';

const SECRET_ARG_KEYS = /^(password|passphrase|secret|token|api_?key|otp|pin|sms_?code)$/i;
const MAX_ARG_STRING = 300;
const MAX_SUMMARY = 500;

/** Tool arguments as shown in the UI: secrets dropped, strings and arrays truncated. */
export function sanitizeArgs(args: unknown): Record<string, unknown> {
  const out = sanitizeValue(args, 0);
  return out && typeof out === 'object' && !Array.isArray(out)
    ? (out as Record<string, unknown>)
    : {};
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string')
    return value.length > MAX_ARG_STRING ? `${value.slice(0, MAX_ARG_STRING)}…` : value;
  if (depth >= 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_ARG_KEYS.test(k)) continue;
      const clean = sanitizeValue(v, depth + 1);
      if (clean !== undefined) out[k] = clean;
    }
    return out;
  }
  return undefined;
}

function truncateSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const s = summary.trim();
  return s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY)}…` : s;
}

function imageIdOf(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const id = (details as { imageId?: unknown }).imageId;
  return typeof id === 'string' && id.length > 0 && id.length < 200 ? id : undefined;
}

interface AssistantState {
  itemId?: string;
  text: string;
  createdAt: string;
}

export interface TranscriptMapperDeps {
  /** Where items and runtime state go: the conversation or a procedure's activity log. */
  sink: TranscriptSink;
  clock: Clock;
  lang: () => Language;
  logger: Logger;
  /** Validates screenshot ids coming from tool details. */
  mediaExists?(mediaId: string): boolean;
}

/** How a run ended: what the agent said last and whether it failed. */
export interface RunResult {
  aborted: boolean;
  error?: string;
  /** The last complete assistant message of the run. */
  text: string;
}

/**
 * Turns the normalized events of one agent into transcript items: streaming assistant messages,
 * tool activity rows and error notices; and keeps the agent's runtime state (working / error /
 * unread / current tool) in sync.
 */
export class TranscriptMapper {
  private readonly assistant = new Map<string, AssistantState>();
  private readonly tools = new Map<string, string>();
  private lastError?: string;
  private runText = '';
  /** Set when a run ends (read by AgentManager to route reports). */
  lastRun?: RunResult;

  constructor(
    private readonly agentId: string,
    private readonly deps: TranscriptMapperDeps,
  ) {}

  private now(): string {
    return this.deps.clock().toISOString();
  }

  handle(event: AgentEvent): void {
    const { sink } = this.deps;
    switch (event.type) {
      case 'run_start':
        this.lastError = undefined;
        this.runText = '';
        this.lastRun = undefined;
        sink.setError(undefined);
        sink.setRunning(true);
        return;
      case 'run_end': {
        const error = event.aborted ? undefined : (event.error ?? this.lastError);
        if (event.aborted) this.finalize('aborted');
        else this.closeStreaming(error ? 'error' : 'complete');
        sink.setNow?.(undefined);
        sink.setRunning(false);
        this.lastError = undefined;
        this.lastRun = {
          aborted: Boolean(event.aborted),
          text: this.runText,
          ...(error ? { error } : {}),
        };
        if (error) this.reportError(error);
        return;
      }
      case 'assistant_start':
        this.assistant.set(event.messageId, { text: '', createdAt: this.now() });
        return;
      case 'assistant_delta':
        this.onDelta(event.messageId, event.delta);
        return;
      case 'assistant_end':
        this.onAssistantEnd(event.messageId, event.text, event.error);
        return;
      case 'tool_start': {
        const args = sanitizeArgs(event.args);
        const item: ActivityItem = {
          id: sink.newItemId('a'),
          createdAt: this.now(),
          type: 'activity',
          toolCallId: event.toolCallId,
          tool: event.tool,
          args,
          status: 'running',
        };
        this.tools.set(event.toolCallId, item.id);
        sink.upsertItem(item);
        sink.setNow?.({ tool: event.tool, args });
        return;
      }
      case 'tool_update': {
        const itemId = this.tools.get(event.toolCallId);
        const item = itemId ? sink.findItem(itemId) : undefined;
        const summary = truncateSummary(event.summary);
        if (item?.type === 'activity' && summary) sink.upsertItem({ ...item, summary });
        return;
      }
      case 'tool_end': {
        const itemId = this.tools.get(event.toolCallId);
        this.tools.delete(event.toolCallId);
        const existing = itemId ? sink.findItem(itemId) : undefined;
        const base: ActivityItem =
          existing?.type === 'activity'
            ? existing
            : {
                id: sink.newItemId('a'),
                createdAt: this.now(),
                type: 'activity',
                toolCallId: event.toolCallId,
                tool: event.tool,
                args: {},
                status: 'running',
              };
        const imageId = imageIdOf(event.details);
        const validImage =
          imageId && (this.deps.mediaExists?.(imageId) ?? true) ? imageId : undefined;
        const summary = truncateSummary(event.summary);
        if (this.tools.size === 0) sink.setNow?.(undefined);
        sink.upsertItem({
          ...base,
          status: event.isError ? 'error' : 'done',
          ...(summary ? { summary } : {}),
          ...(validImage ? { imageId: validImage } : {}),
          finishedAt: this.now(),
        });
        return;
      }
      case 'log':
        this.deps.logger[event.level](`agent: ${event.message}`);
        return;
      default:
        return;
    }
  }

  private onDelta(messageId: string, delta: string): void {
    if (!delta) return;
    const { sink } = this.deps;
    let state = this.assistant.get(messageId);
    if (!state) {
      state = { text: '', createdAt: this.now() };
      this.assistant.set(messageId, state);
    }
    state.text += delta;
    if (state.itemId) {
      sink.appendDelta(state.itemId, delta);
      return;
    }
    if (!state.text.trim()) return;
    const item: AssistantItem = {
      id: sink.newItemId('m'),
      createdAt: state.createdAt,
      type: 'assistant',
      text: state.text,
      status: 'streaming',
    };
    state.itemId = item.id;
    sink.upsertItem(item);
  }

  private onAssistantEnd(messageId: string, text: string, error?: string): void {
    const { sink } = this.deps;
    const state = this.assistant.get(messageId) ?? { text: '', createdAt: this.now() };
    this.assistant.delete(messageId);
    const aborted = !!error && /abort/i.test(error);
    if (error && !aborted) this.lastError = error;
    const finalText = text || state.text;
    const status: AssistantItem['status'] = aborted ? 'aborted' : error ? 'error' : 'complete';
    if (status === 'complete' && finalText.trim()) this.runText = finalText.trim();
    if (state.itemId) {
      sink.upsertItem({
        id: state.itemId,
        createdAt: state.createdAt,
        type: 'assistant',
        text: finalText,
        status,
      });
    } else if (finalText.trim()) {
      sink.upsertItem({
        id: sink.newItemId('m'),
        createdAt: state.createdAt,
        type: 'assistant',
        text: finalText,
        status,
      });
    } else {
      return;
    }
    if (status === 'complete') sink.setUnread();
  }

  /** Shows a provider/agent error as a notice and as the agent's runtime error. */
  reportError(raw: string): void {
    const message = friendlyAgentError(raw, this.deps.lang());
    this.deps.logger.warn('agent run failed', { agent: this.agentId, error: raw });
    this.deps.sink.addNotice('error', message);
    this.deps.sink.setError(message);
    this.deps.sink.setUnread();
  }

  private closeStreaming(status: AssistantItem['status']): void {
    const { sink } = this.deps;
    for (const state of this.assistant.values()) {
      if (!state.itemId) continue;
      const item = sink.findItem(state.itemId);
      if (item?.type === 'assistant' && item.status === 'streaming')
        sink.upsertItem({ ...item, status });
    }
    this.assistant.clear();
  }

  /** Closes everything still in flight (abort, process exit, stop). */
  finalize(reason: 'aborted' | 'error'): void {
    const { sink } = this.deps;
    this.closeStreaming(reason);
    for (const itemId of this.tools.values()) {
      const item = sink.findItem(itemId);
      if (item?.type === 'activity' && item.status === 'running') {
        sink.upsertItem({
          ...item,
          status: 'error',
          summary: t(this.deps.lang(), 'cancelled'),
          finishedAt: this.now(),
        });
      }
    }
    this.tools.clear();
    sink.setNow?.(undefined);
    sink.setRunning(false);
  }
}
