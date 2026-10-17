import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A fake ChatGPT backend (`/backend-api/codex/responses`) with the quirks of the real one, seen on
 * a real request (October 2026): the SSE stream carries NO content type; frames are `event:` plus
 * `data:` with a `response.metadata` event in the middle, `obfuscation` and `logprobs` on every
 * text delta and a full `response.completed` whose usage has `input_tokens_details` with
 * `cache_write_tokens`; the plan's limits come as `x-codex-*` headers, including a large opaque
 * `x-codex-turn-state`; and the last chunk of the (chunked) response can arrive after the client
 * already stopped reading at `response.completed`, which is what pi does. All values are made up.
 */

export interface RealisticUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export const REAL_USAGE: RealisticUsage = { input: 214, cached: 0, output: 10, reasoning: 0 };

/** The real events carry the ChatGPT user id of the account as `safety_identifier` (made up here). */
export const SAFETY_IDENTIFIER = 'user-FakeSafetyIdentifier0123456789';

const frame = (type: string, body: Record<string, unknown>, seq: number): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq, ...body })}\n\n`;

/** The frames of one reply, like the backend sends them (text split into small deltas). */
export function codexFrames(text: string, usage: RealisticUsage = REAL_USAGE): string[] {
  const response = (status: string, extra: Record<string, unknown> = {}) => ({
    id: 'resp_0000000000000000000000000000000000000000000000000000',
    object: 'response',
    created_at: 1_792_221_623,
    completed_at: status === 'completed' ? 1_792_221_623 : null,
    status,
    model: 'gpt-6-luna',
    instructions: 'You play the user.',
    output: [],
    error: null,
    incomplete_details: null,
    tools: [],
    usage: null,
    store: false,
    metadata: {},
    user: null,
    safety_identifier: SAFETY_IDENTIFIER,
    service_tier: status === 'completed' ? 'default' : 'auto',
    ...extra,
  });
  const itemId = 'msg_00000000000000000000000000000000000000000000000000';
  const pieces = text.match(/.{1,3}/gs) ?? [text];
  let seq = 0;
  const frames: string[] = [
    frame('response.created', { response: response('in_progress') }, seq++),
    frame('response.in_progress', { response: response('in_progress') }, seq++),
    frame(
      'response.output_item.added',
      {
        output_index: 0,
        item: {
          type: 'message',
          id: itemId,
          role: 'assistant',
          status: 'in_progress',
          content: [],
          phase: 'final_answer',
        },
      },
      seq++,
    ),
    frame(
      'response.content_part.added',
      {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
      },
      seq++,
    ),
    ...pieces.map((delta) =>
      frame(
        'response.output_text.delta',
        {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
          obfuscation: 'yXTn7nprbaO7Al',
        },
        seq++,
      ),
    ),
    frame(
      'response.metadata',
      {
        response_id: 'resp_0000000000000000000000000000000000000000000000000000',
        metadata: { moderation: { prompt: { outputs: [{ is_blocked: false }] } } },
      },
      seq++,
    ),
    frame(
      'response.output_text.done',
      { item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] },
      seq++,
    ),
    frame(
      'response.content_part.done',
      {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [], logprobs: [] },
      },
      seq++,
    ),
    frame(
      'response.output_item.done',
      {
        output_index: 0,
        item: {
          type: 'message',
          id: itemId,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
          phase: 'final_answer',
        },
      },
      seq++,
    ),
    frame(
      'response.completed',
      {
        response: response('completed', {
          output: [
            {
              type: 'message',
              id: itemId,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
              phase: 'final_answer',
            },
          ],
          usage: {
            input_tokens: usage.input,
            input_tokens_details: { cached_tokens: usage.cached, cache_write_tokens: 0 },
            output_tokens: usage.output,
            output_tokens_details: { reasoning_tokens: usage.reasoning },
            total_tokens: usage.input + usage.output,
            attribution: { items: {}, request_fields: { instructions: { input_tokens: 172 } } },
          },
        }),
      },
      seq++,
    ),
  ];
  return frames;
}

/** Headers of the real backend's answer (no content type), values made up. */
const REAL_HEADERS = {
  'x-codex-active-limit': 'premium',
  'x-codex-plan-type': 'plus',
  'x-codex-primary-used-percent': '0',
  'x-codex-secondary-used-percent': '7',
  'x-codex-primary-window-minutes': '300',
  'x-codex-secondary-window-minutes': '10080',
  'x-codex-primary-reset-after-seconds': '17946',
  'x-codex-secondary-reset-after-seconds': '553623',
  'x-codex-primary-reset-at': '1792239521',
  'x-codex-secondary-reset-at': '1792775198',
  'x-codex-credits-has-credits': 'False',
  'x-codex-credits-balance': '0',
  'x-codex-credits-unlimited': 'False',
  'x-codex-turn-state': `gAAAAAB${'x'.repeat(1400)}`,
  'x-oai-request-id': '00000000-0000-0000-0000-000000000000',
} as const;

export interface RealisticBackendOptions {
  text?: string;
  usage?: RealisticUsage;
  /** How long the response stays open after its last frame (the delayed final chunk). */
  holdMs?: number;
  /** Send only this many frames, then go quiet until `holdMs` is over (a stalled stream). */
  framesSent?: number;
}

export interface RealisticBackend {
  /** The base URL the meter forwards to (`http://127.0.0.1:<port>/backend-api`). */
  url: string;
  requests: { path: string; headers: IncomingHttpHeaders }[];
  /** Whether the client had already gone when the backend finished its response. */
  clientLeftEarly(): boolean[];
  close(): Promise<void>;
}

export async function startRealisticBackend(
  options: RealisticBackendOptions = {},
): Promise<RealisticBackend> {
  const requests: RealisticBackend['requests'] = [];
  const leftEarly: boolean[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ path: req.url ?? '', headers: req.headers });
      // No content type: Node would not add one either.
      res.writeHead(200, REAL_HEADERS);
      const frames = codexFrames(options.text ?? '{"reply":"listo"}', options.usage);
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      for (const f of frames.slice(0, options.framesSent ?? frames.length)) res.write(f);
      setTimeout(() => {
        leftEarly.push(closed);
        res.end();
      }, options.holdMs ?? 150);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
    requests,
    clientLeftEarly: () => leftEarly,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
