import { type NormalizedUsage, normalizeChatUsage, normalizeResponsesUsage } from './cost';

/**
 * Reads what the meter needs from a model response (a Server-Sent Events stream or a JSON body)
 * once it has been teed: the usage, whether it ended properly (only complete responses are
 * cached), an error that arrived inside a 200 stream, and how much text was generated (to charge
 * an aborted stream). Pure functions over the text; the response itself is never altered.
 */

export type WireApi = 'chat-completions' | 'responses';

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parses an SSE body. A final event without its blank line is still returned. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event: string | undefined;
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) events.push({ ...(event ? { event } : {}), data: data.join('\n') });
    event = undefined;
    data = [];
  };
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  flush();
  return events;
}

/** An error the upstream reported, in a status body or inside a stream. */
export interface UpstreamError {
  type?: string;
  code?: string;
  message?: string;
  /** Codex usage limits: when the window resets, epoch seconds. */
  resetsAt?: number;
  resetsInSeconds?: number;
  planType?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorFrom(value: unknown): UpstreamError | undefined {
  if (!value || typeof value !== 'object')
    return typeof value === 'string' ? { message: value } : undefined;
  const e = value as Record<string, unknown>;
  const type = str(e.type);
  const code = str(e.code) ?? (typeof e.code === 'number' ? String(e.code) : undefined);
  const message = str(e.message);
  const resetsAt = numeric(e.resets_at);
  const resetsInSeconds = numeric(e.resets_in_seconds);
  const planType = str(e.plan_type);
  return {
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(resetsInSeconds !== undefined ? { resetsInSeconds } : {}),
    ...(planType ? { planType } : {}),
  };
}

/** The error of a non-2xx JSON body (`{ error: {...} }`, `{ detail: ... }`) or of a stream event. */
export function parseErrorBody(text: string): UpstreamError | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!json || typeof json !== 'object') return undefined;
  const body = json as Record<string, unknown>;
  if (body.error !== undefined) return errorFrom(body.error);
  if (body.detail !== undefined) return errorFrom(body.detail);
  return body.type === 'error' || body.message ? errorFrom(body) : undefined;
}

export interface BodySummary {
  /** The response finished normally: `[DONE]`, `response.completed`, or a whole JSON body. */
  complete: boolean;
  usage?: NormalizedUsage;
  finishReason?: string;
  /** An error event inside a 200 stream (`response.failed`, `error`). */
  error?: UpstreamError;
  /** The generated text, reasoning and tool arguments, concatenated (a stream's pieces joined). */
  outputText: string;
}

function summarizeChatStream(events: SseEvent[]): BodySummary {
  const summary: BodySummary = { complete: false, outputText: '' };
  for (const { data } of events) {
    if (data.trim() === '[DONE]') {
      summary.complete = true;
      continue;
    }
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (chunk.error !== undefined) summary.error = errorFrom(chunk.error) ?? {};
    const usage = normalizeChatUsage(chunk.usage);
    if (usage) summary.usage = usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices as Record<string, unknown>[]) {
      const delta = (choice.delta ?? {}) as Record<string, unknown>;
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        if (typeof delta[field] === 'string') summary.outputText += delta[field] as string;
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const call of calls as { function?: { arguments?: unknown } }[]) {
        if (typeof call.function?.arguments === 'string') {
          summary.outputText += call.function.arguments;
        }
      }
      const finish = str(choice.finish_reason);
      if (finish) summary.finishReason = finish;
    }
  }
  return summary;
}

const RESPONSES_TERMINAL = new Set(['response.completed', 'response.done', 'response.incomplete']);

function summarizeResponsesStream(events: SseEvent[]): BodySummary {
  const summary: BodySummary = { complete: false, outputText: '' };
  for (const { data } of events) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = str(event.type) ?? '';
    if (RESPONSES_TERMINAL.has(type)) {
      const response = (event.response ?? {}) as Record<string, unknown>;
      summary.complete = true;
      summary.finishReason = str(response.status) ?? type.slice('response.'.length);
      const usage = normalizeResponsesUsage(response.usage);
      if (usage) summary.usage = usage;
    } else if (type === 'response.failed') {
      const response = (event.response ?? {}) as Record<string, unknown>;
      summary.error = errorFrom(response.error) ?? {};
    } else if (type === 'error') {
      summary.error = errorFrom(event.error ?? event) ?? {};
    } else if (type.endsWith('.delta') && typeof event.delta === 'string') {
      summary.outputText += event.delta;
    }
  }
  return summary;
}

function summarizeJson(api: WireApi, text: string): BodySummary {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { complete: false, outputText: text };
  }
  if (json.error !== undefined)
    return { complete: false, outputText: '', error: errorFrom(json.error) ?? {} };
  if (api === 'responses') {
    const usage = normalizeResponsesUsage(json.usage);
    return {
      complete: json.status === 'completed' || json.status === 'incomplete',
      outputText: JSON.stringify(json.output ?? ''),
      ...(usage ? { usage } : {}),
    };
  }
  const usage = normalizeChatUsage(json.usage);
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
    | { finish_reason?: unknown; message?: unknown }
    | undefined;
  const finish = str(choice?.finish_reason);
  return {
    complete: Array.isArray(json.choices) && json.choices.length > 0,
    outputText: choice?.message ? JSON.stringify(choice.message) : '',
    ...(finish ? { finishReason: finish } : {}),
    ...(usage ? { usage } : {}),
  };
}

/**
 * Whether a response body is a Server-Sent Events stream. The content type says so, except that
 * the ChatGPT backend (`/codex/responses`) streams `event:`/`data:` frames with no content type
 * at all: a body with no JSON content type that starts like an SSE frame is one too.
 */
export function isSseBody(text: string, contentType: string | undefined): boolean {
  if (/text\/event-stream/i.test(contentType ?? '')) return true;
  if (/json/i.test(contentType ?? '')) return false;
  return /^\s*(?:event|data|id|retry):|^\s*:/.test(text.slice(0, 256));
}

/** Summarizes a whole response body (decoded text) of the given wire API. */
export function summarizeBody(
  api: WireApi,
  text: string,
  contentType: string | undefined,
): BodySummary {
  if (isSseBody(text, contentType)) {
    const events = parseSse(text);
    return api === 'responses' ? summarizeResponsesStream(events) : summarizeChatStream(events);
  }
  return summarizeJson(api, text);
}

export interface ToolCall {
  name: string;
  /** The JSON text of the arguments (a stream's pieces joined). */
  args: string;
}

/**
 * The tool calls a response made, in order: what the model did (chat completions `tool_calls`,
 * Responses `function_call` items), from a stream or a JSON body.
 */
export function toolCallsOf(
  api: WireApi,
  text: string,
  contentType: string | undefined,
): ToolCall[] {
  if (!isSseBody(text, contentType)) return toolCallsOfJson(api, text);
  const calls = new Map<string, ToolCall>();
  const call = (key: string): ToolCall => {
    let found = calls.get(key);
    if (!found) {
      found = { name: '', args: '' };
      calls.set(key, found);
    }
    return found;
  };
  for (const { data } of parseSse(text)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (api === 'chat-completions') {
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const choice of choices as Record<string, unknown>[]) {
        const delta = (choice.delta ?? {}) as Record<string, unknown>;
        const pieces = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        (
          pieces as { index?: unknown; function?: { name?: unknown; arguments?: unknown } }[]
        ).forEach((piece, position) => {
          const found = call(`${String(choice.index ?? 0)}:${String(piece.index ?? position)}`);
          if (typeof piece.function?.name === 'string') found.name += piece.function.name;
          if (typeof piece.function?.arguments === 'string') found.args += piece.function.arguments;
        });
      }
      continue;
    }
    const type = str(chunk.type) ?? '';
    const item = (chunk.item ?? {}) as Record<string, unknown>;
    if (
      (type === 'response.output_item.added' || type === 'response.output_item.done') &&
      item.type === 'function_call'
    ) {
      const found = call(String(item.id ?? item.call_id ?? calls.size));
      if (typeof item.name === 'string') found.name = item.name;
      if (typeof item.arguments === 'string' && item.arguments) found.args = item.arguments;
    } else if (
      type === 'response.function_call_arguments.delta' &&
      typeof chunk.delta === 'string'
    ) {
      call(String(chunk.item_id ?? '')).args += chunk.delta;
    }
  }
  return [...calls.values()].filter((found) => found.name !== '');
}

function toolCallsOfJson(api: WireApi, text: string): ToolCall[] {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (api === 'responses') {
    const output = Array.isArray(json.output) ? json.output : [];
    return (output as Record<string, unknown>[])
      .filter((item) => item.type === 'function_call')
      .map((item) => ({ name: String(item.name ?? ''), args: String(item.arguments ?? '') }));
  }
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as
    | { message?: { tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] } }
    | undefined;
  return (choice?.message?.tool_calls ?? []).map((call) => ({
    name: String(call.function?.name ?? ''),
    args: String(call.function?.arguments ?? ''),
  }));
}
