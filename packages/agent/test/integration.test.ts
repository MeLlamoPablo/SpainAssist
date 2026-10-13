/**
 * End-to-end tests of the real agent host: builds dist/host.js, spawns it with `node` through
 * buildAgentLaunch + PiRpcClient, with the mock LLM as the model and a fake host bridge.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChatRequest, createMockLlm, type MockLlm, type ScenarioInput } from '@sa/mock-llm';
import type { Procedure } from '@sa/shared';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AgentHostConfig, buildAgentLaunch, PiRpcClient } from '../src/index';
import type { AgentEvent } from '../src/rpc/events';
import {
  ASSISTANT_TOOL_NAMES,
  EXA_TOOL_NAMES,
  TOOL_NAMES,
  WEB_RESEARCH_TOOL_NAME,
} from '../src/tools/names';
import { createFakeBridge, type FakeBridge, hang } from './helpers/fake-bridge';
import { createFakeSse, sseEvent } from './helpers/fake-sse';

const packageRoot = join(import.meta.dirname, '..');
const hostPath = join(packageRoot, 'dist', 'host.js');

const scenario: ScenarioInput = {
  name: 'integration',
  rules: [
    {
      id: 'start',
      when: { turn: 0, lastUser: 'renovar el DNI' },
      reply: {
        text: 'Te ayudo a renovar el DNI. Apunto el plan.',
        toolCalls: [
          {
            name: 'procedure_update',
            arguments: {
              title: 'Renovar el DNI',
              status: 'researching',
              steps: [{ id: 'cita', title: 'Pedir cita previa', status: 'current', owner: 'user' }],
            },
          },
        ],
      },
    },
    {
      id: 'ask',
      when: { lastTool: 'procedure_update', lastToolResult: 'Status: researching' },
      reply: {
        toolCalls: [
          {
            name: 'ask_user',
            arguments: {
              title: 'Un dato para la cita',
              fields: [
                {
                  key: 'addressProvince',
                  label: '¿Provincia?',
                  type: 'text',
                  vaultKey: 'addressProvince',
                },
              ],
            },
          },
        ],
      },
    },
    {
      id: 'answer',
      when: { lastTool: 'ask_user', lastToolResult: '\\(addressProvince\\): (?<province>[^\\n]+)' },
      reply: { text: 'Perfecto: pide cita en {{province}}.' },
    },
    { id: 'resume', when: { lastUser: 'sigues' }, reply: { text: 'Sí, seguimos con tu DNI.' } },
  ],
  fallback: { text: 'fallback' },
};

function procedure(patch: Record<string, unknown>): Procedure {
  return {
    id: 'p1',
    title: 'Trámite',
    status: 'researching',
    steps: [],
    requirements: [],
    facts: [],
    sources: [],
    createdAt: '2026-10-03T00:00:00Z',
    updatedAt: '2026-10-03T00:00:00Z',
    archived: false,
    ...patch,
  } as Procedure;
}

async function waitFor(
  events: AgentEvent[],
  predicate: (event: AgentEvent) => boolean,
  options: { from?: number; timeoutMs?: number } = {},
): Promise<AgentEvent> {
  const started = Date.now();
  for (;;) {
    const found = events.slice(options.from ?? 0).find(predicate);
    if (found) return found;
    if (Date.now() - started > (options.timeoutMs ?? 30_000)) {
      throw new Error(`Timed out. Events: ${events.map((e) => e.type).join(', ')}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const isRunEnd = (event: AgentEvent) => event.type === 'run_end';

beforeAll(() => {
  execFileSync(process.execPath, [join(packageRoot, 'scripts', 'build-host.mjs')], {
    stdio: 'pipe',
  });
  expect(existsSync(hostPath)).toBe(true);
}, 120_000);

describe('agent host over RPC (integration)', () => {
  let llm: MockLlm;
  let bridge: FakeBridge;
  let workDir: string;
  let clients: PiRpcClient[];

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'sa-agent-it-'));
    clients = [];
    llm = await createMockLlm({ scenario, chunkSize: 7 });
    bridge = await createFakeBridge({
      'agent.credential': () => ({ credential: { type: 'api_key', key: 'llm-key-from-bridge' } }),
      'procedure.update': (params) => procedure(params),
      'prompt.form': () => ({
        kind: 'form',
        values: { addressProvince: 'Madrid' },
        dismissed: false,
        savedToVault: ['addressProvince'],
      }),
    });
  });

  afterEach(async () => {
    for (const client of clients) await client.stop();
    await llm.close();
    await bridge.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  interface StartOptions {
    role?: AgentHostConfig['role'];
    research?: AgentHostConfig['research'];
    idleCompaction?: AgentHostConfig['idleCompaction'];
  }

  function config(
    model?: AgentHostConfig['model'],
    research?: AgentHostConfig['research'],
    role?: AgentHostConfig['role'],
    idleCompaction?: AgentHostConfig['idleCompaction'],
  ): AgentHostConfig {
    return {
      ...(role ? { role } : {}),
      ...(idleCompaction ? { idleCompaction } : {}),
      procedureId: 'p1',
      sessionFile: join(workDir, 'sessions', 'p1.jsonl'),
      language: 'es',
      model: model ?? { provider: 'custom', id: 'mock-model', baseUrl: llm.baseUrl },
      ...(research ? { research } : {}),
      // Community learnings, sharing included: the agent has both feedback tools.
      feedback: { submit: true, vote: true },
    };
  }

  async function start(
    model?: AgentHostConfig['model'],
    electron?: string,
    options: StartOptions = {},
  ) {
    const client = new PiRpcClient(
      buildAgentLaunch({
        nodeBinary: electron ?? process.execPath,
        electronRunAsNode: electron !== undefined,
        cwd: workDir,
        config: config(model, options.research, options.role, options.idleCompaction),
        bridge: { url: bridge.url, token: bridge.token },
        hostPath,
      }),
    );
    clients.push(client);
    const events: AgentEvent[] = [];
    client.on((event) => events.push(event));
    const info = await client.start();
    return { client, events, info };
  }

  it('runs a full turn: plan update, a form answered by the user, final answer', async () => {
    const { client, events, info } = await start();
    expect(info.model).toEqual({ provider: 'custom', id: 'mock-model' });
    expect(await client.prompt('Hola, quiero renovar el DNI')).toBe('started');
    const end = await waitFor(events, isRunEnd);
    expect(end).toEqual({ type: 'run_end' });
    expect(client.running).toBe(false);

    const flow = events.filter(
      (e) => e.type !== 'log' && e.type !== 'usage' && e.type !== 'assistant_delta',
    );
    expect(flow.map((e) => (e.type === 'tool_start' ? `tool_start:${e.tool}` : e.type))).toEqual([
      'run_start',
      'assistant_start',
      'assistant_end',
      'tool_start:procedure_update',
      'tool_end',
      'assistant_start',
      'assistant_end',
      'tool_start:ask_user',
      'tool_end',
      'assistant_start',
      'assistant_end',
      'run_end',
    ]);
    const ends = events.filter((e) => e.type === 'assistant_end');
    expect(ends[0]).toMatchObject({ text: 'Te ayudo a renovar el DNI. Apunto el plan.' });
    expect(ends.at(-1)).toMatchObject({ text: 'Perfecto: pide cita en Madrid.' });
    const deltas = events.filter((e) => e.type === 'assistant_delta');
    expect(deltas.length).toBeGreaterThan(3);
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds[0]).toMatchObject({
      tool: 'procedure_update',
      isError: false,
      details: { status: 'researching' },
    });
    expect(toolEnds[0]?.type === 'tool_end' && toolEnds[0].summary).toContain(
      'Status: researching',
    );
    expect(toolEnds[1]).toMatchObject({ tool: 'ask_user', isError: false });
    expect(events.some((e) => e.type === 'usage' && e.inputTokens > 0)).toBe(true);
    expect(events.some((e) => e.type === 'log' && e.message.startsWith('ready:'))).toBe(true);

    // The app received the tool calls.
    expect(bridge.callsTo('procedure.update')[0]?.params).toMatchObject({
      title: 'Renovar el DNI',
      status: 'researching',
    });
    expect(bridge.callsTo('prompt.form')[0]?.params).toMatchObject({
      title: 'Un dato para la cita',
      allowDismiss: false,
    });
    expect(bridge.calls.every((c) => c.authorization === `Bearer ${bridge.token}`)).toBe(true);

    // What the model saw: our key, exactly our tools, exactly our prompt, no bridge secrets.
    const requests = llm.requests().filter((r) => r.path.endsWith('/chat/completions'));
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.headers.authorization).toBe('Bearer llm-key-from-bridge');
      expect(JSON.stringify(request.body)).not.toContain(bridge.token);
      expect(JSON.stringify(request)).not.toContain(workDir);
    }
    const body = requests[0]?.body as ChatRequest;
    expect((body.tools ?? []).map((t) => t.function?.name)).toEqual([...TOOL_NAMES]);
    const system = String(body.messages?.[0]?.content ?? '');
    expect(body.messages?.[0]?.role).toBe('system');
    expect(system.startsWith("You are one of Spain Assist's procedure agents")).toBe(true);
    expect(system).not.toContain('<cwd>');
    expect(system).toContain('Write for the user in Spanish');

    const sessionFile = join(workDir, 'sessions', 'p1.jsonl');
    expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(sessionFile, 'utf8')).toContain('Hola, quiero renovar el DNI');
  });

  it('runs the assistant with only its own tools and prompt, delegating through the bridge', async () => {
    bridge.setHandler('procedures.start', (params) => ({
      procedureId: 'p_0123456789abcdef',
      title: params.title,
    }));
    llm.setScenario({
      rules: [
        {
          when: { turn: 0 },
          reply: {
            toolCalls: [
              {
                name: 'procedure_start',
                arguments: { title: 'Renovar el DNI', brief: 'Caduca pronto; vive en Madrid.' },
              },
            ],
          },
        },
        { when: { lastTool: 'procedure_start' }, reply: { text: 'Me pongo con ello.' } },
      ],
    });
    const { client, events } = await start(undefined, undefined, { role: 'assistant' });
    await client.prompt('Quiero renovar el DNI');
    await waitFor(events, isRunEnd);
    expect(bridge.callsTo('procedures.start')[0]?.params).toEqual({
      title: 'Renovar el DNI',
      brief: 'Caduca pronto; vive en Madrid.',
    });
    const body = llm.requests().filter((r) => r.path.endsWith('/chat/completions'))[0]
      ?.body as ChatRequest;
    // No research or browser tools: everything goes through procedure agents.
    expect((body.tools ?? []).map((t) => t.function?.name)).toEqual([...ASSISTANT_TOOL_NAMES]);
    expect(String(body.messages?.[0]?.content).startsWith('You are Spain Assist.')).toBe(true);
    const toolResult = llm.requests().at(-1)?.body as ChatRequest;
    expect(JSON.stringify(toolResult.messages)).toContain('Started p_0123456789abcdef');
  });

  it('has no web research without a voucher', async () => {
    const { client, events } = await start();
    await client.prompt('¿Sigues ahí?');
    await waitFor(events, isRunEnd);
    const body = llm.requests().at(-1)?.body as ChatRequest;
    expect((body.tools ?? []).map((t) => t.function?.name)).toEqual([...TOOL_NAMES]);
    expect(String(body.messages?.[0]?.content)).toContain('Web research is not available');
  });

  it('resumes the session file after a restart', async () => {
    const first = await start();
    await first.client.prompt('Hola, quiero renovar el DNI');
    await waitFor(first.events, isRunEnd);
    await first.client.stop();
    expect(first.events.at(-1)).toMatchObject({ type: 'process_exit', code: 0 });
    llm.reset();

    const second = await start();
    expect(second.info.messageCount).toBeGreaterThan(4);
    await second.client.prompt('¿Sigues ahí?');
    const end = await waitFor(second.events, isRunEnd);
    expect(end).toEqual({ type: 'run_end' });
    expect(second.events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
      text: 'Sí, seguimos con tu DNI.',
    });
    const resumed = llm.requests()[0]?.body as ChatRequest | undefined;
    const messages = resumed?.messages ?? [];
    const texts = messages.map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes('Hola, quiero renovar el DNI'))).toBe(true);
    expect(texts.some((t) => t.includes('Perfecto: pide cita en Madrid.'))).toBe(true);
    expect(texts.at(-1)).toContain('Sigues');
    // Exactly one system prompt, the current one.
    expect(messages.filter((m) => m.role === 'system' || m.role === 'developer')).toHaveLength(1);
    expect(String(messages[0]?.content)).toContain(
      "You are one of Spain Assist's procedure agents",
    );
  });

  it('compacts while idle by extending the last request, so the summary reads its cache', async () => {
    llm.setScenario({
      rules: [
        {
          id: 'summary',
          when: { lastUser: '^The conversation pauses here' },
          reply: { text: '## Goal\nRenovar el DNI (resumen).' },
        },
        { id: 'resume', when: { lastUser: 'sigues' }, reply: { text: 'Sí, seguimos.' } },
      ],
      fallback: { text: 'Vale.' },
    });
    // A 15 s cache lifetime: the timer fires 5 s after the last request.
    const { client, events } = await start(undefined, undefined, {
      idleCompaction: { minTokens: 0, cacheTtlMs: 15_000 },
    });
    // Each over pi's 20k tokens kept verbatim: the first message is summarized, the second kept.
    await client.prompt(`Mis notas: ${'nota antigua. '.repeat(7_000)}`);
    await waitFor(events, isRunEnd);
    let from = events.length;
    await client.prompt(`Más notas: ${'nota reciente. '.repeat(7_000)}`);
    await waitFor(events, isRunEnd, { from });
    from = events.length;
    await waitFor(events, (e) => e.type === 'log' && e.message.startsWith('compaction summary:'), {
      from,
      timeoutMs: 15_000,
    });

    const bodies = llm.requests().map((request) => request.body as ChatRequest);
    expect(bodies).toHaveLength(3);
    const [, turn, summary] = bodies as [ChatRequest, ChatRequest, ChatRequest];
    const turnMessages = turn.messages ?? [];
    const summaryMessages = summary.messages ?? [];
    // Same tools and the same messages first: a prefix of the cached prompt.
    expect(summary.tools).toEqual(turn.tools);
    expect(summaryMessages.slice(0, turnMessages.length)).toEqual(turnMessages);
    expect(summaryMessages.slice(turnMessages.length)).toMatchObject([
      { role: 'assistant' },
      { role: 'user' },
    ]);

    from = events.length;
    await client.prompt('¿Sigues ahí?');
    await waitFor(events, isRunEnd, { from });
    const next = llm.requests().at(-1)?.body as ChatRequest;
    const texts = (next.messages ?? []).map((m) => JSON.stringify(m.content));
    expect(texts.some((t) => t.includes('Renovar el DNI (resumen).'))).toBe(true);
    expect(texts.some((t) => t.includes('nota antigua'))).toBe(false);
    expect(texts.some((t) => t.includes('nota reciente'))).toBe(true);
  });

  it('cancels an idle compaction when the user writes again', async () => {
    llm.setScenario({
      rules: [
        {
          id: 'summary',
          when: { lastUser: '^The conversation pauses here' },
          reply: { text: 'Resumen.', delayMs: 10_000 },
        },
        { id: 'resume', when: { lastUser: 'sigues' }, reply: { text: 'Sí, seguimos.' } },
      ],
      fallback: { text: 'Vale.' },
    });
    const { client, events } = await start(undefined, undefined, {
      idleCompaction: { minTokens: 0, cacheTtlMs: 15_000 },
    });
    await client.prompt(`Mis notas: ${'nota antigua. '.repeat(7_000)}`);
    await waitFor(events, isRunEnd);
    let from = events.length;
    await client.prompt(`Más notas: ${'nota reciente. '.repeat(7_000)}`);
    await waitFor(events, isRunEnd, { from });
    from = events.length;
    await waitFor(events, (e) => e.type === 'log' && e.message.startsWith('idle compaction'), {
      from,
      timeoutMs: 15_000,
    });

    const startedAt = Date.now();
    await client.prompt('¿Sigues ahí?');
    await waitFor(events, isRunEnd, { from });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
      text: 'Sí, seguimos.',
    });
    // Not compacted: the next request still has the whole conversation.
    const next = llm.requests().at(-1)?.body as ChatRequest;
    expect(
      (next.messages ?? []).some((m) => JSON.stringify(m.content).includes('nota antigua')),
    ).toBe(true);
  });

  it('aborts promptly while a tool waits for the user, and keeps working afterwards', async () => {
    bridge.setHandler('prompt.form', hang);
    const { client, events } = await start();
    await client.prompt('Hola, quiero renovar el DNI');
    const call = await bridge.waitForCall('prompt.form', 30_000);
    expect(client.running).toBe(true);
    const startedAt = Date.now();
    await client.abort();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await bridge.waitForAbort(call);
    const end = await waitFor(events, isRunEnd);
    expect(end).toMatchObject({ type: 'run_end', aborted: true });

    const from = events.length;
    await client.prompt('¿Sigues ahí?');
    expect(await waitFor(events, isRunEnd, { from })).toEqual({ type: 'run_end' });
    expect(client.alive).toBe(true);
  });

  it('stopping the host mid-run ends the run as aborted', async () => {
    bridge.setHandler('prompt.form', hang);
    const { client, events } = await start();
    await client.prompt('Hola, quiero renovar el DNI');
    await bridge.waitForCall('prompt.form', 30_000);
    await client.stop();
    expect(events.find(isRunEnd)).toMatchObject({ type: 'run_end', aborted: true });
    expect(events.at(-1)).toMatchObject({ type: 'process_exit' });
    expect(client.alive).toBe(false);
    await expect(client.prompt('hola')).rejects.toThrow(/not running/);
  });

  it('abandons a pending authentication request before running corrected instructions', async () => {
    llm.setScenario({
      rules: [
        {
          when: { turn: 0, lastUser: '^Descarga el documento$' },
          reply: {
            toolCalls: [
              {
                name: 'request_user_action',
                arguments: {
                  title: 'Confirma el acceso',
                  message: 'Escanea el QR',
                  actionKind: 'qr_scan',
                  showBrowser: false,
                },
              },
            ],
          },
        },
        {
          when: { lastUser: 'Usa otro método' },
          reply: { text: 'Revisaré el método disponible.' },
        },
      ],
      fallback: { text: 'unexpected old plan' },
    });
    bridge.setHandler('prompt.userAction', hang);
    const { client, events } = await start();
    await client.prompt('Descarga el documento');
    const call = await bridge.waitForCall('prompt.userAction', 30_000);
    await client.followUp('outdated instruction');
    const beforeAbort = llm.requests().length;
    await client.abort();
    await bridge.waitForAbort(call);
    expect(await waitFor(events, isRunEnd)).toMatchObject({ aborted: true });
    expect(llm.requests()).toHaveLength(beforeAbort);
    const from = events.length;
    expect(await client.prompt('Usa otro método')).toBe('started');
    expect(await waitFor(events, isRunEnd, { from })).toEqual({ type: 'run_end' });
    expect(events.filter((event) => event.type === 'assistant_end').at(-1)).toMatchObject({
      text: 'Revisaré el método disponible.',
    });
    expect(llm.requests()).toHaveLength(beforeAbort + 1);
    expect(bridge.callsTo('prompt.userAction')).toHaveLength(1);
  });

  it('reports provider errors (exhausted voucher) and refuses shell commands', async () => {
    llm.setScenario({
      rules: [{ reply: { error: { status: 402, message: 'Key limit exceeded' } } }],
    });
    const { client, events } = await start();
    await client.prompt('Hola');
    const end = await waitFor(events, isRunEnd);
    expect(end).toMatchObject({ type: 'run_end', errorKind: 'quota' });
    expect(end.type === 'run_end' && end.error).toContain('Key limit exceeded');
    await expect(client.send({ type: 'bash', command: 'echo hi' })).rejects.toThrow(/not allowed/);
  });

  it('uses the placeholder key for keyless custom endpoints', async () => {
    bridge.setHandler('agent.credential', () => ({ credential: null }));
    const { client, events } = await start();
    await client.prompt('¿Sigues ahí?');
    await waitFor(events, isRunEnd);
    expect(llm.requests().at(-1)?.headers.authorization).toBe('Bearer sa-no-key');
  });

  it('plays the mock LLM "demo" scenario end to end with the real tools', async () => {
    llm.setScenario('demo');
    bridge.setHandler('feedback.search', () => ({ results: [] }));
    const { client, events } = await start();
    await client.prompt('Hola, quiero renovar el DNI');
    expect(await waitFor(events, isRunEnd)).toEqual({ type: 'run_end' });
    const tools = events
      .filter((e) => e.type === 'tool_end')
      .map((e) => (e.type === 'tool_end' ? `${e.tool}:${e.isError}` : ''));
    // Without a voucher, this demo uses scripted offline research.
    expect(tools).toEqual([
      'feedback_search:false',
      'procedure_update:false',
      'ask_user:false',
      'procedure_update:false',
    ]);
    expect(bridge.callsTo('procedure.update').map((c) => c.params.status)).toEqual([
      'researching',
      'planned',
    ]);
    expect(events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
      text: expect.stringContaining('Pide cita previa'),
    });
  });

  // Optional: SA_TEST_ELECTRON=<path to the Electron binary> runs the host the way the app does.
  const electronBinary = process.env.SA_TEST_ELECTRON;
  it.skipIf(!electronBinary)('runs under Electron as Node (ELECTRON_RUN_AS_NODE=1)', async () => {
    const { client, events } = await start(undefined, electronBinary);
    await client.prompt('Hola, quiero renovar el DNI');
    expect(await waitFor(events, isRunEnd)).toEqual({ type: 'run_end' });
    expect(events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
      text: 'Perfecto: pide cita en Madrid.',
    });
  });

  it('drives the LiteLLM gateway (vouchers) as an OpenAI-compatible provider', async () => {
    bridge.setHandler('agent.credential', (params) => ({
      credential:
        params.providerId === 'litellm' ? { type: 'api_key', key: 'sk-litellm-voucher' } : null,
    }));
    const { client, events, info } = await start({
      provider: 'litellm',
      id: 'openai/gpt-6-luna',
      baseUrl: llm.baseUrl,
      maxTokens: 4096,
      thinkingLevel: 'low',
    });
    expect(info.model).toEqual({ provider: 'litellm', id: 'openai/gpt-6-luna' });
    await client.prompt('¿Sigues ahí?');
    expect(await waitFor(events, isRunEnd)).toEqual({ type: 'run_end' });
    const request = llm.requests().at(-1);
    const body = request?.body as Record<string, unknown>;
    expect(request?.path).toBe('/v1/chat/completions');
    expect(request?.headers.authorization).toBe('Bearer sk-litellm-voucher');
    expect(body.model).toBe('openai/gpt-6-luna');
    expect(body.max_tokens).toBe(4096);
    // Standard OpenAI reasoning parameter (LiteLLM maps it), not OpenRouter's `reasoning` object.
    expect(body.reasoning_effort).toBe('low');
    expect(body).not.toHaveProperty('reasoning');
    expect(body).not.toHaveProperty('store');
    expect(JSON.stringify(body.messages)).not.toContain('"developer"');
    expect(request?.headers['x-session-affinity']).toBeUndefined();
    expect(request?.headers['x-session-id']).toBeUndefined();
  });

  it('researches through the key server with the voucher key', async () => {
    const run = '0b6c1d7e-2f3a-4b5c-8d9e-0f1a2b3c4d5e';
    const keyServer = await createFakeSse({
      frames: [
        sseEvent('created', { type: 'created', id: run, priceUsd: 0.05 }),
        sseEvent('progress', { type: 'progress', id: run, status: 'running', elapsedSeconds: 1 }),
        sseEvent('completed', {
          type: 'completed',
          id: run,
          output: { type: 'text', content: 'Research complete: NIE', basis: [] },
        }),
      ],
      delayMs: 20,
    });
    bridge.setHandler('agent.credential', (params) => ({
      credential:
        params.providerId === 'litellm' ? { type: 'api_key', key: 'sk-litellm-voucher' } : null,
    }));
    try {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: {
              toolCalls: [
                { name: 'web_research', arguments: { query: 'renovar NIE', mode: 'balanced' } },
              ],
            },
          },
          {
            when: { lastTool: 'web_research', lastToolResult: 'Research complete' },
            reply: { text: 'Hecho.' },
          },
        ],
        fallback: { text: 'fallback' },
      });
      const { client, events } = await start(
        { provider: 'litellm', id: 'openai/gpt-6-luna', baseUrl: llm.baseUrl },
        undefined,
        { research: { keyServerUrl: new URL(keyServer.url).origin } },
      );
      await client.prompt('Quiero renovar el NIE');
      await waitFor(events, isRunEnd);
      expect(events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
        text: 'Hecho.',
      });
      expect(keyServer.requests).toHaveLength(1);
      expect(keyServer.requests[0]).toMatchObject({
        url: '/v1/research',
        headers: { authorization: 'Bearer sk-litellm-voucher', accept: 'text/event-stream' },
        body: { input: 'renovar NIE', mode: 'balanced' },
      });
      const requests = llm.requests().filter((r) => r.path.endsWith('/chat/completions'));
      const body = requests[0]?.body as ChatRequest;
      expect((body.tools ?? []).map((t) => t.function?.name).sort()).toEqual(
        [...TOOL_NAMES, WEB_RESEARCH_TOOL_NAME].sort(),
      );
      const prompt = String(body.messages?.[0]?.content);
      expect(prompt).toContain('call web_research once');
      expect(prompt).not.toContain('Web research is not available');
      // The voucher key reaches only the key server: never the model or the session file.
      for (const request of requests) {
        const { headers: _headers, ...rest } = request;
        expect(JSON.stringify(rest)).not.toContain('sk-litellm-voucher');
      }
      expect(readFileSync(join(workDir, 'sessions', 'p1.jsonl'), 'utf8')).not.toContain(
        'sk-litellm-voucher',
      );
    } finally {
      await keyServer.close();
    }
  });

  it('BYOK and custom endpoints research with the Exa tools and the user key, not web_research', async () => {
    const exa = await createFakeSse({
      frames: [
        sseEvent('message', {
          jsonrpc: '2.0',
          id: 1,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  results: [
                    {
                      title: 'Renovar el NIE',
                      url: 'https://sede.gob.es/nie',
                      text: 'Research complete',
                    },
                  ],
                }),
              },
            ],
          },
        }),
      ],
    });
    bridge.setHandler('agent.exaKey', () => ({ key: 'exa-user-key' }));
    try {
      llm.setScenario({
        rules: [
          {
            when: { turn: 0 },
            reply: { toolCalls: [{ name: 'exa_search', arguments: { query: 'renovar NIE' } }] },
          },
          {
            when: { lastTool: 'exa_search', lastToolResult: 'Research complete' },
            reply: { text: 'Hecho.' },
          },
        ],
        fallback: { text: 'fallback' },
      });
      const { client, events } = await start(undefined, undefined, {
        research: { exa: true, exaBaseUrl: new URL(exa.url).origin },
      });
      await client.prompt('Quiero renovar el NIE');
      await waitFor(events, isRunEnd);
      expect(events.filter((e) => e.type === 'assistant_end').at(-1)).toMatchObject({
        text: 'Hecho.',
      });
      expect(exa.requests).toHaveLength(1);
      expect(exa.requests[0]).toMatchObject({
        url: '/mcp?tools=web_search_advanced_exa,web_fetch_exa',
        headers: { 'x-api-key': 'exa-user-key' },
        body: {
          method: 'tools/call',
          params: {
            name: 'web_search_advanced_exa',
            arguments: { query: 'renovar NIE', userLocation: 'ES' },
          },
        },
      });
      const requests = llm.requests().filter((r) => r.path.endsWith('/chat/completions'));
      const body = requests[0]?.body as ChatRequest;
      expect((body.tools ?? []).map((t) => t.function?.name).sort()).toEqual(
        [...TOOL_NAMES, ...EXA_TOOL_NAMES].sort(),
      );
      const prompt = String(body.messages?.[0]?.content);
      expect(prompt).toContain('research the procedure with exa_search');
      expect(prompt).not.toContain('web_research');
      // The Exa key reaches only Exa: never the model or the session file.
      for (const request of requests) {
        expect(JSON.stringify(request)).not.toContain('exa-user-key');
      }
      expect(readFileSync(join(workDir, 'sessions', 'p1.jsonl'), 'utf8')).not.toContain(
        'exa-user-key',
      );
    } finally {
      await exa.close();
    }
  });

  it('drives a built-in provider (OpenRouter) pointed at the mock LLM with capped tokens', async () => {
    bridge.setHandler('agent.credential', (params) => ({
      credential:
        params.providerId === 'openrouter' ? { type: 'api_key', key: 'sk-mock-voucher' } : null,
    }));
    const { client, events, info } = await start({
      provider: 'openrouter',
      id: 'mock-model',
      baseUrl: llm.baseUrl,
      maxTokens: 4096,
    });
    expect(info.model).toEqual({ provider: 'openrouter', id: 'mock-model' });
    await client.prompt('¿Sigues ahí?');
    expect(await waitFor(events, isRunEnd)).toEqual({ type: 'run_end' });
    const request = llm.requests().at(-1);
    const body = request?.body as Record<string, unknown>;
    expect(request?.headers.authorization).toBe('Bearer sk-mock-voucher');
    expect(body.model).toBe('mock-model');
    expect(body.max_completion_tokens ?? body.max_tokens).toBe(4096);
    // PI_TELEMETRY=0: no pi.dev attribution headers.
    expect(request?.headers['http-referer']).toBeUndefined();
    expect(request?.headers['x-openrouter-title']).toBeUndefined();
  });
});
