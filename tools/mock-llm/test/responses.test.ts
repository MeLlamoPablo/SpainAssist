import { zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMockLlm, type MockLlm } from '../src/index';
import { parseSseBody, tryUpgrade } from './helpers';

const CODEX_HEADERS = {
  'content-type': 'application/json',
  authorization: 'Bearer token',
  'chatgpt-account-id': 'acct-1',
};

function codexRequest(
  llm: MockLlm,
  body: unknown,
  options: { zstd?: boolean; headers?: Record<string, string> } = {},
) {
  const json = JSON.stringify(body);
  return fetch(`${llm.url}/backend-api/codex/responses`, {
    method: 'POST',
    headers: {
      ...CODEX_HEADERS,
      ...(options.zstd ? { 'content-encoding': 'zstd' } : {}),
      ...options.headers,
    },
    body: options.zstd ? zstdCompressSync(Buffer.from(json)) : json,
  });
}

const userItem = (text: string) => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

describe('Responses API and the Codex backend shape', () => {
  let llm: MockLlm;
  beforeEach(async () => {
    llm = await createMockLlm({ scenario: { rules: [] }, chunkSize: 4 });
  });
  afterEach(async () => {
    await llm.close();
  });

  it('streams the events pi parses, with usage in response.completed', async () => {
    llm.setScenario({
      rules: [],
      fallback: {
        reasoning: 'Pienso.',
        text: 'Hola, mundo',
        toolCalls: [{ id: 'call_x', name: 'fetch_url', arguments: { url: 'https://a.example' } }],
        usage: { promptTokens: 120, completionTokens: 30, cachedTokens: 100, reasoningTokens: 5 },
      },
    });
    const res = await codexRequest(llm, {
      model: 'gpt-6.1-sol',
      stream: true,
      store: false,
      instructions: 'Be helpful.',
      input: [userItem('hola')],
      tools: [{ type: 'function', name: 'fetch_url', parameters: {} }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSseBody(await res.text()).map((e) => e.data as Record<string, unknown>);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('response.created');
    expect(types.at(-1)).toBe('response.completed');
    expect(types).toEqual(
      expect.arrayContaining([
        'response.output_item.added',
        'response.reasoning_summary_text.delta',
        'response.output_text.delta',
        'response.function_call_arguments.delta',
        'response.function_call_arguments.done',
        'response.output_item.done',
      ]),
    );
    const text = events
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('');
    expect(text).toBe('Hola, mundo');
    const done = events
      .filter((e) => e.type === 'response.output_item.done')
      .map((e) => e.item) as {
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }[];
    expect(done.map((i) => i.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect(done[2]).toMatchObject({
      call_id: 'call_x',
      name: 'fetch_url',
      arguments: '{"url":"https://a.example"}',
    });
    const completed = events.at(-1) as { response: { usage: unknown; output: unknown[] } };
    expect(completed.response.usage).toEqual({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 30,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 150,
    });
    expect(completed.response.output).toHaveLength(3);
  });

  it('requires the ChatGPT credentials on the Codex path only', async () => {
    llm.setScenario({ rules: [], fallback: { text: 'ok' } });
    const body = { model: 'm', input: [userItem('x')] };
    const noAccount = await codexRequest(llm, body, {
      headers: { 'chatgpt-account-id': '' },
    });
    expect(noAccount.status).toBe(401);
    const plain = await fetch(`${llm.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true }),
    });
    expect(plain.status).toBe(200);
    await plain.text();
  });

  it('decodes zstd request bodies and records them readable', async () => {
    llm.setScenario({ rules: [], fallback: { text: 'ok' } });
    const res = await codexRequest(
      llm,
      {
        model: 'gpt-6-luna',
        stream: true,
        instructions: 'sys',
        input: [userItem('compressed hola')],
      },
      { zstd: true },
    );
    expect(res.status).toBe(200);
    await res.text();
    const recorded = llm.requests().at(-1)!;
    expect(recorded.headers['content-encoding']).toBe('zstd');
    expect(recorded.path).toBe('/backend-api/codex/responses');
    expect((recorded.body as { instructions: string }).instructions).toBe('sys');
  });

  it('answers JSON on /v1/responses unless the client asks to stream', async () => {
    llm.setScenario({
      rules: [],
      fallback: { text: 'plain json', usage: { promptTokens: 7, completionTokens: 2 } },
    });
    const res = await fetch(`${llm.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'hola' }),
    });
    const body = (await res.json()) as {
      status: string;
      output: { content: { text: string }[] }[];
      usage: { input_tokens: number };
    };
    expect(body.status).toBe('completed');
    expect(body.output[0]!.content[0]!.text).toBe('plain json');
    expect(body.usage.input_tokens).toBe(7);
  });

  it('runs the rule engine over Responses items: tool results, history, system prompt', async () => {
    llm.setScenario({
      rules: [
        {
          when: {
            systemPrompt: 'procedure agent',
            lastTool: 'browser_snapshot',
            lastToolResult: 'ref=(?<ref>e\\d+)',
          },
          reply: { toolCalls: [{ name: 'browser_click', arguments: { ref: '{{ref}}' } }] },
        },
        {
          when: {
            systemPrompt: 'procedure agent',
            toolCalled: { name: 'browser_click', args: 'e9' },
          },
          reply: { text: 'clicked before' },
        },
        { when: { hasTool: '^web_search$' }, reply: { text: 'search tool declared' } },
      ],
      fallback: { text: 'fallback' },
    });
    const run = async (input: unknown[], tools: unknown[] = []) => {
      const res = await codexRequest(llm, {
        model: 'm',
        stream: true,
        instructions: 'You are a procedure agent.',
        input,
        tools,
      });
      return (parseSseBody(await res.text()).map((e) => e.data) as Record<string, unknown>[])
        .filter((e) => e.type === 'response.output_item.done')
        .map((e) => e.item) as { type: string; arguments?: string; content?: { text: string }[] }[];
    };

    const clicked = await run([
      userItem('go'),
      { type: 'function_call', call_id: 'c1', name: 'browser_snapshot', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'button [ref=e9]' },
    ]);
    expect(clicked[0]).toMatchObject({ type: 'function_call', arguments: '{"ref":"e9"}' });

    const history = await run([
      userItem('go'),
      { type: 'function_call', call_id: 'c2', name: 'browser_click', arguments: '{"ref":"e9"}' },
      { type: 'function_call_output', call_id: 'c2', output: 'done' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      userItem('again'),
    ]);
    expect(history[0]!.content![0]!.text).toBe('clicked before');

    const tools = await run([userItem('hi')], [{ type: 'web_search' }]);
    expect(tools[0]!.content![0]!.text).toBe('search tool declared');

    // Tools declared in the input, as pi sends them to Codex models that take tool changes.
    const additional = await run([
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'x' }] },
      { type: 'additional_tools', role: 'developer', tools: [{ type: 'web_search' }] },
      userItem('hi'),
    ]);
    expect(additional[0]!.content![0]!.text).toBe('search tool declared');
  });

  it('answers errors in the backend shape (usage limit) with headers', async () => {
    llm.setScenario({
      rules: [],
      fallback: {
        error: {
          status: 429,
          message: 'The usage limit has been reached',
          type: 'usage_limit_reached',
          fields: { plan_type: 'plus', resets_at: 1893456000 },
        },
        headers: { 'x-codex-primary-used-percent': '100' },
      },
    });
    const res = await codexRequest(llm, { model: 'm', stream: true, input: [userItem('x')] });
    expect(res.status).toBe(429);
    expect(res.headers.get('x-codex-primary-used-percent')).toBe('100');
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      type: 'usage_limit_reached',
      plan_type: 'plus',
      resets_at: 1893456000,
    });
  });

  it('ends an over-long reply with response.incomplete', async () => {
    llm.setScenario({ rules: [], fallback: { text: 'cut', finishReason: 'length' } });
    const res = await codexRequest(llm, { model: 'm', stream: true, input: [userItem('x')] });
    const last = parseSseBody(await res.text()).at(-1)!.data as {
      type: string;
      response: Record<string, unknown>;
    };
    expect(last.type).toBe('response.incomplete');
    expect(last.response.incomplete_details).toEqual({ reason: 'max_output_tokens' });
  });

  it('refuses WebSocket upgrades with 426 and records the attempt', async () => {
    expect(await tryUpgrade(llm.url, '/backend-api/codex/responses')).toBe(426);
    const last = llm.requests().at(-1)!;
    expect(last.method).toBe('UPGRADE');
    expect(last.path).toBe('/backend-api/codex/responses');
  });

  it('applies the LiteLLM emulation to /v1/responses but not to the Codex path', async () => {
    await llm.close();
    llm = await createMockLlm({
      scenario: {
        rules: [],
        fallback: { text: 'x', usage: { promptTokens: 1000, completionTokens: 100 } },
      },
      litellm: { maxBudgetUsd: 10 },
    });
    const viaGateway = await fetch(`${llm.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', input: 'hola' }),
    });
    expect(Number(viaGateway.headers.get('x-litellm-response-cost'))).toBeCloseTo(0.00015, 10);
    await viaGateway.text();
    const viaCodex = await codexRequest(llm, { model: 'm', stream: true, input: [userItem('x')] });
    expect(viaCodex.headers.get('x-litellm-response-cost')).toBeNull();
    await viaCodex.text();
    expect(llm.litellm?.state().spendUsd).toBeCloseTo(0.00015, 10);
  });
});
