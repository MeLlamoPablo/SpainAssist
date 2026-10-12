/**
 * Normalization of pi's raw RPC events (docs/research/pi.md §1.4) into the small, UI-oriented
 * `AgentEvent` stream the desktop app maps to ChatItems.
 */

export type AgentErrorKind =
  | 'auth' // missing/invalid key, expired sign-in
  | 'quota' // out of credit / plan usage limit (HTTP 402, subscription limits)
  | 'rate_limit' // HTTP 429
  | 'context' // conversation too long for the model
  | 'network' // provider unreachable
  | 'provider' // provider-side error (5xx, overloaded)
  | 'crash' // the agent process died
  | 'unknown';

export type AgentEvent =
  | { type: 'run_start' }
  | { type: 'run_end'; error?: string; errorKind?: AgentErrorKind; aborted?: boolean }
  | { type: 'assistant_start'; messageId: string }
  | { type: 'assistant_delta'; messageId: string; delta: string }
  | {
      type: 'assistant_end';
      messageId: string;
      text: string;
      error?: string;
      errorKind?: AgentErrorKind;
      aborted?: boolean;
      /** The response failed and pi retries it: the app can drop this message. */
      retrying?: boolean;
    }
  | { type: 'tool_start'; toolCallId: string; tool: string; args: Record<string, unknown> }
  | { type: 'tool_update'; toolCallId: string; tool: string; summary?: string }
  | {
      type: 'tool_end';
      toolCallId: string;
      tool: string;
      isError: boolean;
      /** Short text summary of the result (first lines). */
      summary?: string;
      /** Structured `details` returned by the tool, if any (e.g. browser imageId). */
      details?: unknown;
    }
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      costUsd?: number;
    }
  | { type: 'process_exit'; code: number | null; signal: string | null; stderrTail: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export function classifyAgentError(message: string): AgentErrorKind {
  const m = message.toLowerCase();
  if (
    /subscription_sharing_usage_limit_exceeded|\b402\b|insufficient[_ ](credits|funds|quota)|key limit exceeded|out of credits|credit limit|quota|usage limit|budget has been exceeded|budget_exceeded|exceededbudget/.test(
      m,
    )
  ) {
    return 'quota';
  }
  if (
    /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|authentication|no api key found|forbidden|oauth|not_eligible/.test(
      m,
    )
  ) {
    return 'auth';
  }
  if (/\b429\b|rate[_ ]limit|too many requests/.test(m)) return 'rate_limit';
  if (
    /context[_ ]length|context window|maximum context|too many tokens|prompt is too long/.test(m)
  ) {
    return 'context';
  }
  if (
    /econnrefused|enotfound|etimedout|econnreset|fetch failed|network|socket hang up|timed out/.test(
      m,
    )
  ) {
    return 'network';
  }
  if (/\b5\d\d\b|overloaded|server error|bad gateway|service unavailable/.test(m))
    return 'provider';
  return 'unknown';
}

type Raw = Record<string, unknown>;

interface RawContent {
  type?: string;
  text?: string;
}

interface RawAssistantMessage {
  role?: string;
  content?: RawContent[] | string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cost?: { total?: number };
  };
}

function textOf(content: RawContent[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** First lines of a tool result's text content, for activity rows. */
export function summarizeToolResult(result: unknown, maxChars = 280): string | undefined {
  const content = (result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content as RawContent[]) {
    if (part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    else if (part?.type === 'image') parts.push('[image]');
  }
  const lines = parts
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (lines.length === 0) return undefined;
  const summary = lines.join(' · ');
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary;
}

export class EventNormalizer {
  private running = false;
  private runError?: string;
  private runAborted = false;
  private abortRequested = false;
  private current?: { id: string; text: string };
  private pendingErrorEnd?: Extract<AgentEvent, { type: 'assistant_end' }>;
  private seq = 0;
  private readonly prefix: string;

  constructor(prefix = Date.now().toString(36)) {
    this.prefix = prefix;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The client asked pi to abort: the run will be reported as aborted. */
  markAbortRequested(): void {
    if (this.running) this.abortRequested = true;
  }

  push(raw: Raw): AgentEvent[] {
    const out: AgentEvent[] = [];
    const type = raw.type;
    if (this.pendingErrorEnd && type !== 'turn_end' && type !== 'agent_end') {
      out.push(this.pendingErrorEnd);
      this.pendingErrorEnd = undefined;
    }
    switch (type) {
      case 'agent_start':
        if (!this.running) {
          this.running = true;
          this.runError = undefined;
          this.runAborted = false;
          out.push({ type: 'run_start' });
        }
        break;
      case 'message_start': {
        const message = raw.message as RawAssistantMessage | undefined;
        if (message?.role === 'assistant') this.begin(out);
        break;
      }
      case 'message_update': {
        const event = raw.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
        if (event?.type === 'text_delta' && typeof event.delta === 'string' && event.delta) {
          const current = this.current ?? this.begin(out);
          current.text += event.delta;
          out.push({ type: 'assistant_delta', messageId: current.id, delta: event.delta });
        }
        break;
      }
      case 'message_end': {
        const message = raw.message as RawAssistantMessage | undefined;
        if (message?.role !== 'assistant') break;
        const current = this.current ?? this.begin(out);
        this.current = undefined;
        const text = textOf(message.content) || current.text;
        const end: Extract<AgentEvent, { type: 'assistant_end' }> = {
          type: 'assistant_end',
          messageId: current.id,
          text,
        };
        if (message.stopReason === 'aborted') {
          end.aborted = true;
          this.runAborted = true;
        } else if (message.stopReason === 'error') {
          const error = message.errorMessage || 'The model returned an error';
          end.error = error;
          end.errorKind = classifyAgentError(error);
          this.runError = error;
        }
        const usage = message.usage;
        if (usage && (usage.input || usage.output)) {
          out.push({
            type: 'usage',
            inputTokens: usage.input ?? 0,
            outputTokens: usage.output ?? 0,
            ...(usage.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
            ...(typeof usage.cost?.total === 'number' ? { costUsd: usage.cost.total } : {}),
          });
        }
        if (end.error) this.pendingErrorEnd = end;
        else out.push(end);
        break;
      }
      case 'agent_end':
        if (this.pendingErrorEnd) {
          const pending = this.pendingErrorEnd;
          this.pendingErrorEnd = undefined;
          if (raw.willRetry === true) {
            out.push({
              type: 'assistant_end',
              messageId: pending.messageId,
              text: pending.text,
              retrying: true,
            });
            this.runError = undefined;
          } else {
            out.push(pending);
          }
        }
        break;
      case 'tool_execution_start':
        out.push({
          type: 'tool_start',
          toolCallId: String(raw.toolCallId ?? ''),
          tool: String(raw.toolName ?? ''),
          args:
            raw.args && typeof raw.args === 'object' ? (raw.args as Record<string, unknown>) : {},
        });
        break;
      case 'tool_execution_update': {
        const summary = summarizeToolResult(raw.partialResult);
        out.push({
          type: 'tool_update',
          toolCallId: String(raw.toolCallId ?? ''),
          tool: String(raw.toolName ?? ''),
          ...(summary ? { summary } : {}),
        });
        break;
      }
      case 'tool_execution_end': {
        const result = raw.result as { details?: unknown } | undefined;
        const summary = summarizeToolResult(result);
        out.push({
          type: 'tool_end',
          toolCallId: String(raw.toolCallId ?? ''),
          tool: String(raw.toolName ?? ''),
          isError: raw.isError === true,
          ...(summary ? { summary } : {}),
          ...(result?.details !== undefined ? { details: result.details } : {}),
        });
        break;
      }
      case 'auto_retry_start':
        out.push({
          type: 'log',
          level: 'warn',
          message: `Retrying after a provider error (attempt ${raw.attempt}/${raw.maxAttempts}): ${raw.errorMessage ?? ''}`,
        });
        break;
      case 'auto_retry_end':
        if (raw.success === false && typeof raw.finalError === 'string')
          this.runError = raw.finalError;
        break;
      case 'compaction_start':
        out.push({
          type: 'log',
          level: 'info',
          message: `Compacting the conversation (${raw.reason})`,
        });
        break;
      case 'compaction_end':
        if (typeof raw.errorMessage === 'string') {
          out.push({
            type: 'log',
            level: 'warn',
            message: `Compaction failed: ${raw.errorMessage}`,
          });
        }
        break;
      case 'extension_error':
        out.push({
          type: 'log',
          level: 'error',
          message: `Extension error in ${raw.event}: ${raw.error}`,
        });
        break;
      case 'agent_settled':
        if (this.running) out.push(...this.finishRun());
        break;
      default:
        break;
    }
    return out;
  }

  /** The process died: close any open message and run. */
  terminate(reason: string): AgentEvent[] {
    const out: AgentEvent[] = [];
    if (this.pendingErrorEnd) {
      out.push(this.pendingErrorEnd);
      this.pendingErrorEnd = undefined;
    }
    if (this.current) {
      out.push(
        this.abortRequested
          ? {
              type: 'assistant_end',
              messageId: this.current.id,
              text: this.current.text,
              aborted: true,
            }
          : {
              type: 'assistant_end',
              messageId: this.current.id,
              text: this.current.text,
              error: reason,
              errorKind: 'crash',
            },
      );
      this.current = undefined;
    }
    if (this.running) {
      this.runError = this.runError ?? reason;
      out.push(...this.finishRun('crash'));
    }
    return out;
  }

  private begin(out: AgentEvent[]): { id: string; text: string } {
    const current = { id: `${this.prefix}-${++this.seq}`, text: '' };
    this.current = current;
    out.push({ type: 'assistant_start', messageId: current.id });
    return current;
  }

  private finishRun(forcedKind?: AgentErrorKind): AgentEvent[] {
    const aborted = this.runAborted || this.abortRequested;
    const end: Extract<AgentEvent, { type: 'run_end' }> = { type: 'run_end' };
    if (aborted) end.aborted = true;
    else if (this.runError) {
      end.error = this.runError;
      end.errorKind = forcedKind ?? classifyAgentError(this.runError);
    }
    this.running = false;
    this.runError = undefined;
    this.runAborted = false;
    this.abortRequested = false;
    this.current = undefined;
    return [end];
  }
}
