/**
 * The web research stub of the eval host. Web research is the one tool whose real backend cannot
 * be reproduced (Parallel through our key server, OpenAI's hosted search, Exa), so every provider
 * gets the same recorded answer, and nothing real is called, whatever the provider is (a Codex run
 * must never spend plan usage on a hosted web search).
 *
 * The real tool factories of the product stay: only their transport is replaced, so the text the
 * model reads (description, progress, result JSON, error texts) is produced by the product code.
 *   key-server shape  `createKeyServerResearchTool` over a fake `fetch` that answers
 *                     `POST /v1/research` with the SSE stream of a finished run.
 *   chatgpt shape     `createChatGPTResearchTool` over a fake `runtime.streamSimple` that replays
 *                     the Responses events of a hosted web search (a search call, then the answer
 *                     with its URL citations).
 *
 * Each request becomes a `NetRecord` (channel `web_research`, route `mapped`, host
 * `research.invalid`): the query leaves the device in production, so protected values in it are
 * as much an exfiltration finding as in any other request.
 *
 * Plain Node: bundled into the eval host. Never print to stdout (the host's RPC channel).
 */

import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  type AnyToolDefinition,
  createChatGPTResearchTool,
  createKeyServerResearchTool,
  type HostResearchStub,
} from '@sa/agent/host-runtime';
import type { HostEvalConfig, ResearchAnswer } from '../contracts';
import { bodyFields, headersToRecord, type NetLog } from '../net/netlog';
import { currentCallContext } from '../net/world-fetch';

export type ResearchShape = 'key-server' | 'chatgpt';

/** Providers whose product backend is OpenAI's hosted web search (the ChatGPT plans). */
const CHATGPT_PROVIDERS: ReadonlySet<string> = new Set(['openai', 'openai-codex']);

/**
 * The shape of the stub for a provider: what the product would use there. `litellm` (vouchers) and
 * every other provider get the key-server shape: the eval's own default for providers the product
 * gives no hosted search (`custom` mock endpoints).
 */
export function resolveResearchShape(
  shape: HostEvalConfig['research']['shape'],
  provider: string,
): ResearchShape {
  if (shape !== 'auto') return shape;
  return CHATGPT_PROVIDERS.has(provider) ? 'chatgpt' : 'key-server';
}

/** Not a real host (RFC 2606): the research requests of the log never name anything reachable. */
const RESEARCH_ORIGIN = 'https://research.invalid';

/** The key the stub gives the product tool: a placeholder, never a credential. */
const STUB_KEY = 'sk-eval-research-stub';

type ResearchOutput = ResearchAnswer['output'];

interface StubContext {
  log: NetLog;
}

/** One `NetRecord` for a research request that the stub answered. */
function recordRequest(
  { log }: StubContext,
  request: {
    method: string;
    url: URL;
    headers?: Record<string, string>;
    body?: string;
    status: number;
    started: number;
    seq: number;
    t: string;
  },
): void {
  const bytes = request.body === undefined ? undefined : Buffer.from(request.body);
  const toolCallId = currentCallContext()?.toolCallId;
  log.append({
    seq: request.seq,
    t: request.t,
    channel: 'web_research',
    ...(toolCallId ? { toolCallId } : {}),
    method: request.method,
    url: request.url.href,
    host: request.url.hostname,
    route: 'mapped',
    reqHeaders: request.headers ?? {},
    ...bodyFields(bytes, bytes?.length ?? 0),
    status: request.status,
    durationMs: Math.round(performance.now() - request.started),
  });
}

// ---------------------------------------------------------------------------------------------
// Key-server shape
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** One server-sent event, as the key server writes it (`event:` and `data:` lines). */
function frame(event: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
}

function sse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of frames) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

/**
 * The key server's research API as a `fetch`: `POST /v1/research` starts the recorded run and
 * streams `created`, two `progress` events and `completed`; `GET /v1/research/:id/events` (the
 * product tool's reconnection) answers the finished run; anything else is a 404.
 */
export function createKeyServerFetch(answer: ResearchAnswer, context: StubContext): typeof fetch {
  const finished = (id: string, output: ResearchOutput) => frame({ type: 'completed', id, output });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const started = performance.now();
    const t = context.log.stamp();
    const seq = context.log.nextSeq();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const headers = headersToRecord(new Headers(init?.headers));
    const answered = (status: number, response: Response) => {
      recordRequest(context, { method, url, headers, body, status, started, seq, t });
      return response;
    };
    if (method === 'POST' && url.pathname === '/v1/research') {
      return answered(
        200,
        sse([
          frame({ type: 'created', id: answer.id, priceUsd: 0 }),
          frame({ type: 'progress', id: answer.id, status: 'queued', elapsedSeconds: 0 }),
          frame({ type: 'progress', id: answer.id, status: 'running', elapsedSeconds: 20 }),
          finished(answer.id, answer.output),
        ]),
      );
    }
    if (method === 'GET' && url.pathname === `/v1/research/${answer.id}/events`) {
      return answered(200, sse([finished(answer.id, answer.output)]));
    }
    return answered(
      404,
      new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------
// ChatGPT shape
// ---------------------------------------------------------------------------------------------

/** The longest title a citation keeps: Parallel's recorded titles can be a page's whole menu. */
const MAX_TITLE_CHARS = 200;

/** Unique `{url, title}` sources of a recorded answer (Parallel's basis lists them per field). */
export function citationsOf(output: ResearchOutput): { url: string; title?: string }[] {
  const found = new Map<string, { url: string; title?: string }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.url === 'string' && !found.has(record.url)) {
      const title =
        typeof record.title === 'string' ? record.title.replace(/\s+/g, ' ').trim() : '';
      found.set(record.url, {
        url: record.url,
        ...(title
          ? {
              title:
                title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title,
            }
          : {}),
      });
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(output.basis);
  return [...found.values()];
}

/**
 * The answer an OpenAI model would write for the recorded content: a text as it is; a structured
 * answer with one text field (Parallel's `{ output: "..." }`) as that text; anything else as JSON.
 */
export function answerText(output: ResearchOutput): string {
  const { content } = output;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && !Array.isArray(content)) {
    const values = Object.values(content);
    if (values.length === 1 && typeof values[0] === 'string') return values[0];
  }
  return JSON.stringify(content);
}

type StreamSimple = ModelRuntime['streamSimple'];
type StreamOptions = NonNullable<Parameters<StreamSimple>[2]>;

/** The agent's provider as a `Model`, which the stub only passes back to its own `streamSimple`. */
function stubModel(id: string, provider: string): Model<Api> {
  return {
    id,
    name: id,
    api: 'openai-responses',
    provider,
    baseUrl: RESEARCH_ORIGIN,
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  } as Model<Api>;
}

/**
 * A `runtime.streamSimple` that answers the recorded research: the product tool's `onPayload` and
 * `onProviderStreamEvent` hooks run as they would on a real stream (so the request asks for the
 * hosted `web_search` tool and the citations are read from the stream), and the final message
 * carries the answer text.
 */
function createResearchRuntime(
  answer: ResearchAnswer,
  context: StubContext,
): Pick<ModelRuntime, 'streamSimple'> {
  const citations = citationsOf(answer.output);
  const text = answerText(answer.output);
  const streamSimple = (
    model: Model<Api>,
    request: { systemPrompt?: string; messages: { content: unknown }[] },
    options: StreamOptions = {},
  ) => ({
    result: async () => {
      const started = performance.now();
      const t = context.log.stamp();
      const seq = context.log.nextSeq();
      const payload = (await options.onPayload?.(
        { model: model.id, include: ['reasoning.encrypted_content'], store: false },
        model,
      )) as Record<string, unknown> | undefined;
      const user = request.messages[0]?.content;
      recordRequest(context, {
        method: 'POST',
        url: new URL('/v1/responses', RESEARCH_ORIGIN),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(payload ?? { model: model.id }),
          instructions: request.systemPrompt,
          input: typeof user === 'string' ? user : JSON.stringify(user),
          reasoning: { effort: options.reasoning },
        }),
        status: 200,
        started,
        seq,
        t,
      });
      const events = [
        {
          type: 'response.output_item.done',
          item: { type: 'web_search_call', action: { type: 'search' } },
        },
        {
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [
              {
                type: 'output_text',
                annotations: citations.map((citation) => ({ type: 'url_citation', ...citation })),
              },
            ],
          },
        },
      ];
      for (const event of events) await options.onProviderStreamEvent?.(event as never, model);
      return { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] };
    },
  });
  return { streamSimple: streamSimple as unknown as StreamSimple };
}

// ---------------------------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------------------------

export interface ResearchStubOptions {
  config: HostEvalConfig['research'];
  /** pi provider id of the agent (`litellm`, `openai-codex`...): what `shape: 'auto'` follows. */
  provider: string;
  log: NetLog;
}

/**
 * The `HostHooks.research` of the eval host: the backend the system prompt and tool shape emulate,
 * and the research tools. `backend` is `chatgpt` or `key server` (the prompt text is the same for
 * both: `web_research`), so the prompt and the tool name never depend on the provider.
 */
export function createResearchStub(options: ResearchStubOptions): HostResearchStub {
  const shape = resolveResearchShape(options.config.shape, options.provider);
  const [answer] = options.config.answers;
  if (!answer) throw new Error('The eval host config has no recorded research answer');
  const context: StubContext = { log: options.log };
  return {
    backend: shape === 'chatgpt' ? 'chatgpt' : 'key server',
    tools({ language }): AnyToolDefinition[] {
      if (shape === 'chatgpt') {
        return [
          createChatGPTResearchTool({
            runtime: createResearchRuntime(answer, context),
            model: (id) => stubModel(id, options.provider),
            language,
          }),
        ];
      }
      return [
        createKeyServerResearchTool({
          keyServerUrl: RESEARCH_ORIGIN,
          apiKey: async () => STUB_KEY,
          language,
          fetch: createKeyServerFetch(answer, context),
        }),
      ];
    },
  };
}
