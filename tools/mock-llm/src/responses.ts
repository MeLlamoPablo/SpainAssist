import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
import type { TokenCounts } from './litellm';
import type { ChatMessage, ChatRequest, RenderedReply } from './scenario';

/**
 * The OpenAI Responses API shape, as far as pi's `openai-responses` and `openai-codex-responses`
 * providers use it: request items are turned into the chat-shaped request the rule engine
 * understands, and a rendered reply becomes the SSE events (or the JSON body) pi parses.
 */

/** Decodes a request body by its `content-encoding` (pi compresses Codex requests with zstd). */
export function decodeRequestBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  if (!contentEncoding) return body;
  let out = body;
  for (const encoding of contentEncoding
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .reverse()) {
    if (encoding === 'zstd') out = zstdDecompressSync(out);
    else if (encoding === 'gzip') out = gunzipSync(out);
    else if (encoding === 'deflate') out = inflateSync(out);
    else if (encoding === 'br') out = brotliDecompressSync(out);
    else if (encoding !== 'identity' && encoding !== '') {
      throw new Error(`Unsupported content-encoding ${encoding}`);
    }
  }
  return out;
}

export interface ResponsesRequest {
  model?: string;
  stream?: boolean;
  instructions?: string;
  input?: unknown;
  tools?: { type?: string; name?: string }[];
  max_output_tokens?: number;
}

function partsToChat(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    const p = (part ?? {}) as Record<string, unknown>;
    if (p.type === 'input_image') return { type: 'image_url', image_url: { url: p.image_url } };
    if (typeof p.text === 'string') return { type: 'text', text: p.text };
    return { type: 'text', text: '' };
  });
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((part) => ((part as { text?: unknown })?.text as string | undefined) ?? '')
      .join('');
  }
  return '';
}

/** `instructions` become the system message; `input` items become chat messages. */
export function responsesToChatRequest(body: ResponsesRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  if (typeof body.instructions === 'string' && body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }
  const items: unknown[] =
    typeof body.input === 'string'
      ? [{ role: 'user', content: body.input }]
      : Array.isArray(body.input)
        ? body.input
        : [];
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const type = typeof item.type === 'string' ? item.type : 'message';
    if (type === 'function_call') {
      const call = {
        id: String(item.call_id ?? ''),
        function: { name: String(item.name ?? ''), arguments: String(item.arguments ?? '') },
      };
      const previous = messages.at(-1);
      if (previous?.role === 'assistant' && previous.tool_calls && !previous.content) {
        previous.tool_calls.push(call);
      } else {
        messages.push({ role: 'assistant', content: '', tool_calls: [call] });
      }
    } else if (type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id ?? ''),
        content: outputText(item.output),
      });
    } else if (type === 'message') {
      const role = item.role === 'developer' ? 'system' : String(item.role ?? 'user');
      messages.push({ role, content: partsToChat(item.content) });
    }
    // Reasoning items and other types carry nothing the rules match on.
  }
  return {
    ...(body.model ? { model: body.model } : {}),
    ...(body.stream !== undefined ? { stream: body.stream } : {}),
    messages,
    tools: (body.tools ?? [])
      .map((tool) => tool.name ?? tool.type)
      .filter((name): name is string => typeof name === 'string')
      .map((name) => ({ type: 'function', function: { name } })),
  };
}

export function responsesUsage(counts: TokenCounts): Record<string, unknown> {
  return {
    input_tokens: counts.promptTokens,
    input_tokens_details: {
      cached_tokens: counts.cachedTokens,
      ...(counts.cacheWriteTokens > 0 ? { cache_write_tokens: counts.cacheWriteTokens } : {}),
    },
    output_tokens: counts.completionTokens,
    output_tokens_details: { reasoning_tokens: counts.reasoningTokens },
    total_tokens: counts.promptTokens + counts.completionTokens,
  };
}

export interface ResponsesBuild {
  id: string;
  model: string;
  reply: RenderedReply;
  usage: Record<string, unknown>;
  /** Splits streamed text/arguments into pieces of this many characters. */
  chunk: (text: string) => string[];
  /** Ids derive from this number so replies are distinguishable. */
  n: number;
}

type Item = Record<string, unknown>;

/** The output items of a reply, finished (as in `response.completed.response.output`). */
function outputItems(b: ResponsesBuild): Item[] {
  const items: Item[] = [];
  if (b.reply.reasoning) {
    items.push({
      id: `rs_${b.n}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: b.reply.reasoning }],
      encrypted_content: `mock-encrypted-${b.n}`,
    });
  }
  if (b.reply.text !== '' || b.reply.toolCalls.length === 0) {
    items.push({
      id: `msg_${b.n}`,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: b.reply.text, annotations: [] }],
    });
  }
  for (const [i, call] of b.reply.toolCalls.entries()) {
    items.push({
      id: `fc_${b.n}_${i}`,
      type: 'function_call',
      status: 'completed',
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return items;
}

function terminal(b: ResponsesBuild, output: Item[]): Item {
  const incomplete = b.reply.finishReason === 'length';
  return {
    type: incomplete ? 'response.incomplete' : 'response.completed',
    response: {
      id: b.id,
      object: 'response',
      status: incomplete ? 'incomplete' : 'completed',
      ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      model: b.model,
      output,
      usage: b.usage,
    },
  };
}

/** The JSON body of a non-streamed response. */
export function responsesBody(b: ResponsesBuild): Item {
  return (terminal(b, outputItems(b)) as { response: Item }).response;
}

/** The SSE events of a streamed response, in the order the Codex backend sends them. */
export function responsesEvents(b: ResponsesBuild): Item[] {
  const events: Item[] = [];
  events.push({
    type: 'response.created',
    response: { id: b.id, object: 'response', status: 'in_progress', model: b.model, output: [] },
  });
  const items = outputItems(b);
  for (const [index, item] of items.entries()) {
    const base = { output_index: index, item_id: item.id };
    if (item.type === 'reasoning') {
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: { id: item.id, type: 'reasoning', summary: [] },
      });
      events.push({
        type: 'response.reasoning_summary_part.added',
        ...base,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      });
      for (const delta of b.chunk(b.reply.reasoning)) {
        events.push({
          type: 'response.reasoning_summary_text.delta',
          ...base,
          summary_index: 0,
          delta,
        });
      }
      events.push({
        type: 'response.reasoning_summary_part.done',
        ...base,
        summary_index: 0,
        part: { type: 'summary_text', text: b.reply.reasoning },
      });
    } else if (item.type === 'message') {
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: {
          id: item.id,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      });
      events.push({
        type: 'response.content_part.added',
        ...base,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      for (const delta of b.chunk(b.reply.text)) {
        events.push({ type: 'response.output_text.delta', ...base, content_index: 0, delta });
      }
      events.push({
        type: 'response.output_text.done',
        ...base,
        content_index: 0,
        text: b.reply.text,
      });
      events.push({
        type: 'response.content_part.done',
        ...base,
        content_index: 0,
        part: { type: 'output_text', text: b.reply.text, annotations: [] },
      });
    } else {
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: { ...item, arguments: '', status: 'in_progress' },
      });
      const args = String(item.arguments ?? '');
      for (const delta of b.chunk(args)) {
        events.push({ type: 'response.function_call_arguments.delta', ...base, delta });
      }
      events.push({ type: 'response.function_call_arguments.done', ...base, arguments: args });
    }
    events.push({ type: 'response.output_item.done', output_index: index, item });
  }
  events.push(terminal(b, items));
  return events;
}
