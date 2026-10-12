import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatMessage,
  type ChatRequest,
  createMockLlm,
  type MockLlm,
  type RecordedRequest,
  type ScenarioInput,
} from '../src/index';

interface Completion {
  object: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: { function: { name: string; arguments: string } }[];
    };
    finish_reason: string;
  }[];
  usage: { total_tokens: number };
}

async function json<T = unknown>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface StreamResult {
  chunks: Record<string, unknown>[];
  done: boolean;
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

async function chat(llm: MockLlm, messages: ChatMessage[], extra: Record<string, unknown> = {}) {
  return fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body: JSON.stringify({
      model: 'mock-model',
      stream: true,
      stream_options: { include_usage: true },
      messages,
      tools: [{ type: 'function', function: { name: 'fetch_url', parameters: {} } }],
      ...extra,
    }),
  });
}

async function readStream(res: Response): Promise<StreamResult> {
  const raw = await res.text();
  const result: StreamResult = {
    chunks: [],
    done: false,
    text: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
  };
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line) continue;
    expect(line.startsWith('data: ')).toBe(true);
    const data = line.slice(6);
    if (data === '[DONE]') {
      result.done = true;
      continue;
    }
    const chunk = JSON.parse(data);
    result.chunks.push(chunk);
    if (chunk.usage) result.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.content === 'string') result.text += delta.content;
      if (typeof delta.reasoning_content === 'string') result.reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls ?? []) {
        const existing = result.toolCalls[call.index];
        if (!existing) {
          result.toolCalls[call.index] = {
            id: call.id,
            name: call.function?.name ?? '',
            arguments: call.function?.arguments ?? '',
          };
        } else {
          existing.arguments += call.function?.arguments ?? '';
        }
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
  }
  return result;
}

const user = (text: string): ChatMessage => ({ role: 'user', content: text });

describe('mock LLM', () => {
  let llm: MockLlm;

  beforeEach(async () => {
    llm = await createMockLlm({ scenario: 'demo', chunkSize: 5 });
  });
  afterEach(async () => {
    await llm.close();
  });

  it('streams text in OpenAI SSE format with usage and [DONE]', async () => {
    llm.setScenario({ rules: [{ reply: { text: 'Hola, ¿qué tal? Soy una prueba.' } }] });
    const res = await chat(llm, [user('hola')]);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const out = await readStream(res);
    expect(out.text).toBe('Hola, ¿qué tal? Soy una prueba.');
    expect(out.chunks.length).toBeGreaterThan(3);
    expect(out.finishReason).toBe('stop');
    expect(out.done).toBe(true);
    expect(out.usage?.total_tokens).toBeGreaterThan(0);
    const first = out.chunks[0] as { object: string; choices: { delta: { role: string } }[] };
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.choices[0]?.delta.role).toBe('assistant');
  });

  it('streams tool calls with fragmented JSON arguments', async () => {
    llm.setScenario({
      rules: [
        {
          reply: {
            text: 'Miro la página.',
            toolCalls: [{ name: 'fetch_url', arguments: { id: 'renovar-dni', section: 'Pasos' } }],
          },
        },
      ],
    });
    const out = await readStream(await chat(llm, [user('dni')]));
    expect(out.text).toBe('Miro la página.');
    expect(out.finishReason).toBe('tool_calls');
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]?.name).toBe('fetch_url');
    expect(out.toolCalls[0]?.id).toMatch(/^call_/);
    expect(JSON.parse(out.toolCalls[0]?.arguments ?? '')).toEqual({
      id: 'renovar-dni',
      section: 'Pasos',
    });
    const argChunks = out.chunks.filter(
      (c) => JSON.stringify(c).includes('"arguments":"') && !JSON.stringify(c).includes('"name"'),
    );
    expect(argChunks.length).toBeGreaterThan(1);
  });

  it('matches rules on last user, last tool (via tool_call_id), turn and captures', async () => {
    const scenario: ScenarioInput = {
      rules: [
        {
          id: 'after-search',
          when: { lastTool: 'feedback_search', lastToolResult: '\\[(?<gid>[a-z-]+)\\]' },
          reply: { toolCalls: [{ name: 'fetch_url', arguments: { id: '{{gid}}' } }] },
        },
        { id: 'second-turn', when: { turn: 1 }, reply: { text: 'turno uno' } },
        {
          id: 'greet',
          when: { lastUser: 'me llamo (?<name>\\w+)' },
          reply: { text: 'Hola {{name}} ({{turn}})' },
        },
      ],
      fallback: { text: 'fallback' },
    };
    llm.setScenario(scenario);

    const greet = await readStream(await chat(llm, [user('Hola, me llamo Ana')]));
    expect(greet.text).toBe('Hola Ana (0)');

    const afterTool = await readStream(
      await chat(llm, [
        user('busca'),
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', function: { name: 'feedback_search', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', content: '1. [renovar-dni] Renovar el DNI' },
      ]),
    );
    expect(JSON.parse(afterTool.toolCalls[0]?.arguments ?? '')).toEqual({ id: 'renovar-dni' });

    const turnOne = await readStream(
      await chat(llm, [
        user('x'),
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c2', function: { name: 'other', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c2', content: [{ type: 'text', text: 'ok' }] },
      ]),
    );
    expect(turnOne.text).toBe('turno uno');

    const fallback = await readStream(await chat(llm, [user('nada')]));
    expect(fallback.text).toBe('fallback');

    const ids = llm.requests().map((r) => r.ruleId);
    expect(ids).toEqual(['greet', 'after-search', 'second-turn', 'fallback']);
  });

  it('honours rule times limits', async () => {
    llm.setScenario({
      rules: [{ times: 1, reply: { text: 'primera' } }],
      fallback: { text: 'resto' },
    });
    expect((await readStream(await chat(llm, [user('a')]))).text).toBe('primera');
    expect((await readStream(await chat(llm, [user('a')]))).text).toBe('resto');
    llm.reset();
    expect((await readStream(await chat(llm, [user('a')]))).text).toBe('primera');
  });

  it('answers non-streaming requests', async () => {
    llm.setScenario({
      rules: [{ reply: { text: 'hecho', toolCalls: [{ name: 't', arguments: { a: 1 } }] } }],
    });
    const res = await chat(llm, [user('x')], { stream: false });
    const body = await json<Completion>(res);
    const choice = body.choices[0];
    expect(body.object).toBe('chat.completion');
    expect(choice?.message.content).toBe('hecho');
    expect(choice?.message.tool_calls?.[0]?.function).toEqual({
      name: 't',
      arguments: '{"a":1}',
    });
    expect(choice?.finish_reason).toBe('tool_calls');
    expect(body.usage.total_tokens).toBeGreaterThan(0);
  });

  it('returns scripted HTTP errors', async () => {
    llm.setScenario({
      rules: [{ reply: { error: { status: 402, message: 'Key limit exceeded' } } }],
    });
    const res = await chat(llm, [user('x')]);
    expect(res.status).toBe(402);
    expect((await json<{ error: { message: string } }>(res)).error.message).toBe(
      'Key limit exceeded',
    );
  });

  it('lists models and exposes control endpoints', async () => {
    const models = await json<{ data: { id: string }[] }>(await fetch(`${llm.baseUrl}/models`));
    expect(models.data[0]?.id).toBe('mock-model');
    // LiteLLM-style key info, for mock voucher keys.
    expect(await json(await fetch(`${llm.url}/key/info`))).toEqual({
      key: 'mock',
      info: { spend: 0, max_budget: null },
    });

    const set = await fetch(`${llm.url}/__scenario`, {
      method: 'POST',
      body: JSON.stringify({ name: 'x', rules: [{ reply: { text: 'desde HTTP' } }] }),
    });
    expect((await json<{ ok: boolean }>(set)).ok).toBe(true);
    expect((await readStream(await chat(llm, [user('a')]))).text).toBe('desde HTTP');

    const byName = await fetch(`${llm.url}/__scenario`, {
      method: 'POST',
      body: JSON.stringify({ name: 'echo' }),
    });
    expect((await json<{ name: string }>(byName)).name).toBe('echo');
    expect((await readStream(await chat(llm, [user('repite esto')]))).text).toBe(
      'Echo: repite esto',
    );

    const bad = await fetch(`${llm.url}/__scenario`, {
      method: 'POST',
      body: JSON.stringify({ rules: [{ reply: { error: { status: 200 } } }] }),
    });
    expect(bad.status).toBe(400);

    const recorded = await json<RecordedRequest[]>(await fetch(`${llm.url}/__requests`));
    expect(recorded.length).toBe(4);
    expect(recorded.map((r) => r.path).slice(0, 2)).toEqual(['/v1/models', '/key/info']);
    expect(recorded[2]?.headers.authorization).toBe('Bearer test-key');
    const firstChat = recorded[2]?.body as ChatRequest | undefined;
    expect(firstChat?.messages?.[0]?.content).toBe('a');

    await fetch(`${llm.url}/__reset`, { method: 'POST' });
    expect(await json(await fetch(`${llm.url}/__requests`))).toEqual([]);
  });

  it('runs the demo scenario end to end', async () => {
    const history: ChatMessage[] = [user('Hola, quiero renovar el DNI')];
    let callId = 0;
    const step = async (toolResults: (name: string) => string) => {
      const out = await readStream(await chat(llm, history));
      const calls = out.toolCalls.map((call) => ({ ...call, id: `t${++callId}` }));
      history.push({
        role: 'assistant',
        content: out.text,
        tool_calls: calls.map((c) => ({
          id: c.id,
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const call of calls) {
        history.push({ role: 'tool', tool_call_id: call.id, content: toolResults(call.name) });
      }
      return { out, calls };
    };
    const results = (name: string) =>
      ({
        feedback_search: 'No community learnings found.',
        ask_user: 'The user answered: addressProvince = Madrid; documentExpiry = 2026-12-01',
      })[name] ?? '';

    const s1 = await step(results);
    expect(s1.calls.map((c) => c.name)).toEqual(['feedback_search']);
    const s3 = await step(() => 'Plan card updated. Status: researching. Steps: 3.');
    expect(s3.calls[0]?.name).toBe('procedure_update');
    expect(JSON.parse(s3.calls[0]?.arguments ?? '{}').steps).toHaveLength(3);
    const s4 = await step(results);
    expect(s4.calls[0]?.name).toBe('ask_user');
    const s5 = await step(() => 'Plan card updated. Status: planned.');
    expect(s5.calls[0]?.name).toBe('procedure_update');
    const s6 = await step(results);
    expect(s6.calls).toHaveLength(0);
    expect(s6.out.text).toContain('cita previa');
  });

  it('plays the assistant in the demo scenario: starts the procedure, relays its report', async () => {
    const tools = { tools: [{ type: 'function', function: { name: 'procedure_start' } }] };
    const start = await readStream(await chat(llm, [user('Quiero renovar el DNI')], tools));
    expect(start.toolCalls.map((c) => c.name)).toEqual(['procedure_start']);
    expect(JSON.parse(start.toolCalls[0]?.arguments ?? '{}').title).toBe('Renovar el DNI');
    const report = await readStream(
      await chat(
        llm,
        [user('[Report from procedure p_1 "Renovar el DNI" · status: planned]\nOk')],
        tools,
      ),
    );
    expect(report.toolCalls).toHaveLength(0);
    expect(report.text).toContain('pedir cita previa');
  });
});
