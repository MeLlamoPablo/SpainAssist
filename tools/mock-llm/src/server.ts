import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  chatUsage,
  type KeyState,
  LiteLlmKey,
  type LiteLlmOptions,
  type TokenCounts,
} from './litellm';
import {
  decodeRequestBody,
  type ResponsesRequest,
  responsesBody,
  responsesEvents,
  responsesToChatRequest,
  responsesUsage,
} from './responses';
import {
  analyzeRequest,
  applyStateChange,
  type Captures,
  type ChatRequest,
  matchRule,
  parseScenario,
  type RenderedReply,
  type ReplySpec,
  renderTemplate,
  renderValue,
  type Scenario,
  type ScenarioInput,
  type ScenarioState,
} from './scenario';
import { BUILTIN_SCENARIOS, builtinScenario } from './scenarios';

export interface MockLlmOptions {
  /** Port to listen on (0 = random). Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Initial scenario (object) or the name of a built-in scenario. Default "demo". */
  scenario?: ScenarioInput | string;
  /** Characters per streamed text chunk. Default 16. */
  chunkSize?: number;
  /** Delay between streamed chunks in ms. Default 0. */
  chunkDelayMs?: number;
  /** Model ids listed by GET /v1/models. Default ["mock-model"]. */
  models?: string[];
  /** Log one line per request to stderr. */
  verbose?: boolean;
  /**
   * Emulate a LiteLLM gateway: a simulated virtual key with `x-litellm-*` headers, cache and
   * reasoning tokens in the usage, and the 422 "Budget has been exceeded!" answer. Off by
   * default: replies keep their plain OpenAI shape.
   */
  litellm?: LiteLlmOptions;
}

export interface RecordedRequest {
  /** 1-based sequence number since start/reset. */
  seq: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Parsed JSON body (or the raw string when it is not JSON). */
  body: unknown;
  /** Rule that answered (chat completions only). */
  ruleId?: string;
  at: string;
}

export interface MockLlm {
  /** e.g. http://127.0.0.1:53111 */
  readonly url: string;
  /** OpenAI-compatible base URL to configure in clients: `${url}/v1`. */
  readonly baseUrl: string;
  readonly port: number;
  setScenario(scenario: ScenarioInput | string): Scenario;
  getScenario(): Scenario;
  /** Recorded requests (all endpoints except the /__ control endpoints). */
  requests(): RecordedRequest[];
  /** Clear recorded requests, rule usage counters and the scenario state. */
  reset(): void;
  /** The scenario state that rules read (`when.state`) and write (`set`). */
  state(): ScenarioState;
  /** The simulated LiteLLM key (only with the `litellm` option). */
  readonly litellm?: {
    state(): KeyState;
    set(patch: { spendUsd?: number; maxBudgetUsd?: number | null }): void;
  };
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 50 * 1024 * 1024;

/** Requests the Responses handler answers; the Codex ones need the ChatGPT credentials. */
const RESPONSES_PATHS = [
  '/v1/responses',
  '/responses',
  '/backend-api/codex/responses',
  '/codex/responses',
];

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function chunkString(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.max(1, Math.ceil(text.length / 4));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createMockLlm(options: MockLlmOptions = {}): Promise<MockLlm> {
  const chunkSize = Math.max(1, options.chunkSize ?? 16);
  const defaultChunkDelay = options.chunkDelayMs ?? 0;
  const models = options.models?.length ? options.models : ['mock-model'];
  const key = options.litellm ? new LiteLlmKey(options.litellm) : undefined;
  let scenario = resolveScenario(options.scenario ?? 'demo');
  let ruleUses = new Map<number, number>();
  let state: ScenarioState = {};
  let recorded: RecordedRequest[] = [];
  let seq = 0;
  let completionCounter = 0;

  function resolveScenario(input: ScenarioInput | string): Scenario {
    if (typeof input === 'string') {
      const found = builtinScenario(input);
      if (!found) {
        throw new Error(
          `Unknown built-in scenario "${input}". Available: ${Object.keys(BUILTIN_SCENARIOS).join(', ')}`,
        );
      }
      return found;
    }
    return parseScenario(input);
  }

  function record(req: IncomingMessage, path: string, rawBody: string): RecordedRequest {
    let body: unknown = rawBody;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const entry: RecordedRequest = {
      seq: ++seq,
      method: req.method ?? 'GET',
      path,
      headers,
      body,
      at: new Date().toISOString(),
    };
    recorded.push(entry);
    return entry;
  }

  function pickReply(request: ChatRequest): { reply: ReplySpec; vars: Captures; ruleId: string } {
    const facts = analyzeRequest(request);
    const builtins: Captures = {
      lastUser: facts.lastUser,
      turn: String(facts.turn),
      date: todayIso(),
    };
    for (const [index, rule] of scenario.rules.entries()) {
      const used = ruleUses.get(index) ?? 0;
      if (rule.times !== undefined && used >= rule.times) continue;
      const captures = matchRule(rule.when, facts, state);
      if (!captures) continue;
      ruleUses.set(index, used + 1);
      if (rule.set) applyStateChange(state, rule.set);
      return {
        reply: rule.reply,
        vars: { ...builtins, ...captures },
        ruleId: rule.id ?? `rule-${index}`,
      };
    }
    return {
      reply: scenario.fallback ?? {
        text: 'Mock LLM: no rule matched this request.',
      },
      vars: builtins,
      ruleId: 'fallback',
    };
  }

  function renderReply(reply: ReplySpec, vars: Captures): RenderedReply {
    const n = ++completionCounter;
    const toolCalls = (reply.toolCalls ?? []).map((call, i) => ({
      id: call.id ?? `call_${n}_${i}`,
      name: call.name,
      arguments:
        typeof call.arguments === 'string'
          ? renderTemplate(call.arguments, vars)
          : JSON.stringify(renderValue(call.arguments, vars)),
    }));
    return {
      text: reply.text !== undefined ? renderTemplate(reply.text, vars) : '',
      reasoning: reply.reasoning !== undefined ? renderTemplate(reply.reasoning, vars) : '',
      toolCalls,
      finishReason: reply.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
    };
  }

  /** The error a rule asked for, in the OpenAI error shape. */
  function sendReplyError(res: ServerResponse, reply: ReplySpec): void {
    const error = reply.error;
    if (!error) return;
    sendJson(
      res,
      error.status,
      {
        error: {
          message: error.message,
          code: error.code ?? error.status,
          type: error.type ?? 'mock_error',
          ...error.fields,
        },
      },
      reply.headers,
    );
  }

  /** The token counts to report, honouring explicit overrides and the LiteLLM emulation. */
  function tokenCounts(
    reply: ReplySpec,
    promptEstimate: number,
    completionEstimate: number,
  ): TokenCounts {
    const base = {
      promptTokens: reply.usage?.promptTokens ?? promptEstimate,
      completionTokens: reply.usage?.completionTokens ?? completionEstimate,
      cachedTokens: reply.usage?.cachedTokens,
      cacheWriteTokens: reply.usage?.cacheWriteTokens,
      reasoningTokens: reply.usage?.reasoningTokens,
    };
    if (key) return key.counts(base);
    return {
      promptTokens: base.promptTokens,
      completionTokens: base.completionTokens,
      cachedTokens: base.cachedTokens ?? 0,
      cacheWriteTokens: base.cacheWriteTokens ?? 0,
      reasoningTokens: base.reasoningTokens ?? 0,
    };
  }

  /** Charges the simulated key and returns the gateway headers of this call. */
  function gatewayHeaders(
    counts: TokenCounts,
    reply: ReplySpec,
  ): { headers: Record<string, string>; costUsd?: number } {
    if (!key) return { headers: { ...reply.headers } };
    const before = key.state().spendUsd;
    const costUsd = reply.usage?.costUsd ?? key.cost(counts);
    key.charge(costUsd);
    return { headers: { ...key.headers(costUsd, before), ...reply.headers }, costUsd };
  }

  function budgetCheck(res: ServerResponse): boolean {
    if (!key?.exceeded()) return false;
    const refusal = key.budgetError();
    sendJson(res, refusal.status, refusal.body);
    return true;
  }

  async function handleChat(
    req: IncomingMessage,
    res: ServerResponse,
    entry: RecordedRequest,
  ): Promise<void> {
    const request = (entry.body && typeof entry.body === 'object' ? entry.body : {}) as ChatRequest;
    if (budgetCheck(res)) return;
    const { reply, vars, ruleId } = pickReply(request);
    entry.ruleId = ruleId;
    if (options.verbose) {
      process.stderr.write(`[mock-llm] #${entry.seq} ${entry.path} -> ${ruleId}\n`);
    }

    const closed = new AbortController();
    res.on('close', () => closed.abort());
    req.on('aborted', () => closed.abort());

    if (reply.delayMs) await sleep(reply.delayMs, closed.signal);
    if (closed.signal.aborted) return;

    if (reply.error) {
      sendReplyError(res, reply);
      return;
    }

    const rendered = renderReply(reply, vars);
    const model = request.model ?? models[0] ?? 'mock-model';
    const id = `chatcmpl-mock-${completionCounter}`;
    const created = Math.floor(Date.now() / 1000);
    const counts = tokenCounts(
      reply,
      estimateTokens(request.messages),
      estimateTokens(rendered.text + rendered.reasoning) +
        rendered.toolCalls.reduce((sum, call) => sum + estimateTokens(call.arguments), 0),
    );
    const gateway = gatewayHeaders(counts, reply);
    const usage = chatUsage(
      counts,
      options.litellm?.usageShape,
      options.litellm?.costInUsage ? gateway.costUsd : undefined,
    );

    if (!request.stream) {
      sendJson(
        res,
        200,
        {
          id,
          object: 'chat.completion',
          created,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: rendered.text || null,
                ...(rendered.reasoning ? { reasoning_content: rendered.reasoning } : {}),
                ...(rendered.toolCalls.length
                  ? {
                      tool_calls: rendered.toolCalls.map((call) => ({
                        id: call.id,
                        type: 'function',
                        function: { name: call.name, arguments: call.arguments },
                      })),
                    }
                  : {}),
              },
              finish_reason: rendered.finishReason,
            },
          ],
          usage,
        },
        gateway.headers,
      );
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...gateway.headers,
    });
    const delay = reply.chunkDelayMs ?? defaultChunkDelay;
    const send = (payload: unknown) => {
      if (!closed.signal.aborted) res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });

    send(chunk({ role: 'assistant', content: '' }));
    for (const piece of chunkString(rendered.reasoning, chunkSize)) {
      await sleep(delay, closed.signal);
      send(chunk({ reasoning_content: piece }));
    }
    for (const piece of chunkString(rendered.text, chunkSize)) {
      await sleep(delay, closed.signal);
      send(chunk({ content: piece }));
    }
    for (const [index, call] of rendered.toolCalls.entries()) {
      await sleep(delay, closed.signal);
      send(
        chunk({
          tool_calls: [
            { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
          ],
        }),
      );
      // Split the arguments in a few fragments, like real providers do.
      const fragments = chunkString(
        call.arguments,
        Math.max(8, Math.ceil(call.arguments.length / 3)),
      );
      for (const fragment of fragments) {
        await sleep(delay, closed.signal);
        send(chunk({ tool_calls: [{ index, function: { arguments: fragment } }] }));
      }
    }
    await sleep(delay, closed.signal);
    send(chunk({}, rendered.finishReason));
    if (request.stream_options?.include_usage) {
      send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    }
    if (!closed.signal.aborted) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }

  /** The Responses API: `/v1/responses` (OpenAI/LiteLLM) and the ChatGPT backend's `/codex/responses`. */
  async function handleResponses(
    req: IncomingMessage,
    res: ServerResponse,
    entry: RecordedRequest,
    codex: boolean,
  ): Promise<void> {
    if (codex) {
      const bearer = /^Bearer\s+\S+/i.test(req.headers.authorization ?? '');
      if (!bearer || !req.headers['chatgpt-account-id']) {
        sendJson(res, 401, {
          error: {
            message: 'Missing Authorization or chatgpt-account-id header',
            type: 'invalid_request_error',
            code: 'missing_credentials',
          },
        });
        return;
      }
    } else if (budgetCheck(res)) {
      return;
    }
    const request = (
      entry.body && typeof entry.body === 'object' ? entry.body : {}
    ) as ResponsesRequest;
    const { reply, vars, ruleId } = pickReply(responsesToChatRequest(request));
    entry.ruleId = ruleId;
    if (options.verbose) {
      process.stderr.write(`[mock-llm] #${entry.seq} ${entry.path} -> ${ruleId}\n`);
    }

    const closed = new AbortController();
    res.on('close', () => closed.abort());
    req.on('aborted', () => closed.abort());

    if (reply.delayMs) await sleep(reply.delayMs, closed.signal);
    if (closed.signal.aborted) return;

    if (reply.error) {
      sendReplyError(res, reply);
      return;
    }

    const rendered = renderReply(reply, vars);
    const model = request.model ?? models[0] ?? 'mock-model';
    const counts = tokenCounts(
      reply,
      estimateTokens(request.input) + estimateTokens(request.instructions),
      estimateTokens(rendered.text + rendered.reasoning) +
        rendered.toolCalls.reduce((sum, call) => sum + estimateTokens(call.arguments), 0),
    );
    const gateway = codex ? { headers: { ...reply.headers } } : gatewayHeaders(counts, reply);
    const build = {
      id: `resp_mock_${completionCounter}`,
      model,
      reply: rendered,
      usage: responsesUsage(counts),
      chunk: (text: string) => chunkString(text, chunkSize),
      n: completionCounter,
    };

    // The Codex backend always streams; `/v1/responses` answers JSON unless asked to stream.
    if (!codex && request.stream !== true) {
      sendJson(res, 200, responsesBody(build), gateway.headers);
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...gateway.headers,
    });
    const delay = reply.chunkDelayMs ?? defaultChunkDelay;
    for (const event of responsesEvents(build)) {
      await sleep(delay, closed.signal);
      if (closed.signal.aborted) return;
      res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (!closed.signal.aborted) res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

    // Control endpoints (not recorded).
    if (path === '/__scenario') {
      if (method === 'GET') return sendJson(res, 200, scenario);
      if (method !== 'POST') return sendJson(res, 405, { error: { message: 'Use POST' } });
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8') || '{}');
        const isNameOnly =
          parsed !== null &&
          typeof parsed === 'object' &&
          !('rules' in parsed) &&
          typeof (parsed as { name?: unknown }).name === 'string';
        scenario = resolveScenario(
          isNameOnly ? (parsed as { name: string }).name : (parsed as ScenarioInput),
        );
        ruleUses = new Map();
        state = {};
        return sendJson(res, 200, { ok: true, name: scenario.name, rules: scenario.rules.length });
      } catch (error) {
        return sendJson(res, 400, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    if (path === '/__requests') return sendJson(res, 200, recorded);
    if (path === '/__reset') {
      recorded = [];
      ruleUses = new Map();
      state = {};
      seq = 0;
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/__health') return sendJson(res, 200, { ok: true });
    if (path === '/__litellm') {
      if (!key) return sendJson(res, 404, { error: { message: 'LiteLLM emulation is off' } });
      if (method === 'POST') {
        try {
          key.set(
            JSON.parse(rawBody.toString('utf8') || '{}') as {
              spendUsd?: number;
              maxBudgetUsd?: number | null;
            },
          );
        } catch (error) {
          return sendJson(res, 400, {
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      return sendJson(res, 200, key.state());
    }

    let decoded: string;
    try {
      decoded = decodeRequestBody(rawBody, req.headers['content-encoding']).toString('utf8');
    } catch (error) {
      record(req, path, rawBody.toString('latin1'));
      return sendJson(res, 400, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
    const entry = record(req, path, decoded);
    if ((path === '/v1/chat/completions' || path === '/chat/completions') && method === 'POST') {
      return handleChat(req, res, entry);
    }
    if (RESPONSES_PATHS.includes(path) && method === 'POST') {
      return handleResponses(req, res, entry, path.endsWith('/codex/responses'));
    }
    if ((path === '/v1/models' || path === '/models') && method === 'GET') {
      return sendJson(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock-llm' })),
      });
    }
    // LiteLLM's self-service key info (mock voucher keys from the key server): nothing spent and
    // no budget known here, unless the LiteLLM emulation is on.
    if (path === '/key/info' && method === 'GET') {
      const info = key?.state();
      return sendJson(res, 200, {
        key: 'mock',
        info: { spend: info?.spendUsd ?? 0, max_budget: info?.maxBudgetUsd ?? null },
      });
    }
    return sendJson(res, 404, { error: { message: `Not found: ${method} ${path}` } });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      } else {
        res.end();
      }
    });
  });
  // The Codex backend is tried over a WebSocket first: this mock only speaks SSE.
  server.on('upgrade', (req, socket) => {
    record(req, new URL(req.url ?? '/', 'http://localhost').pathname, '').method = 'UPGRADE';
    socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      const host = options.host ?? '127.0.0.1';
      const url = `http://${host.includes(':') ? `[${host}]` : host}:${address.port}`;
      resolve({
        url,
        baseUrl: `${url}/v1`,
        port: address.port,
        setScenario(next) {
          scenario = resolveScenario(next);
          ruleUses = new Map();
          state = {};
          return scenario;
        },
        getScenario: () => scenario,
        requests: () => recorded.slice(),
        reset() {
          recorded = [];
          ruleUses = new Map();
          state = {};
          seq = 0;
        },
        state: () => state,
        ...(key
          ? {
              litellm: {
                state: () => key.state(),
                set: (patch: { spendUsd?: number; maxBudgetUsd?: number | null }) => key.set(patch),
              },
            }
          : {}),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
