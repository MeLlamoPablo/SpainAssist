import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AnyToolDefinition, createKeyServerResearchTool } from '@sa/agent/host-runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResearchAnswer } from '../../src/contracts';
import {
  answerText,
  citationsOf,
  createKeyServerFetch,
  createResearchStub,
  resolveResearchShape,
} from '../../src/host/research-stub';
import { NetLog } from '../../src/net/netlog';
import { readNetLog } from '../../src/net/netlog-reader';
import { withCallContext } from '../../src/net/world-fetch';
import { recordedAnswer } from './support';

let dir: string;
let log: NetLog;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-eval-research-'));
  log = new NetLog({ worldId: 'run-research', file: join(dir, 'host.jsonl') });
});
afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The app's scrubber, a no-op: the queries here hold no personal data. */
const scrub = async (text: string) => ({ text, redactions: 0 });
const noRuntime = { config: {} as never, bridge: {} as never, scrub };

function webResearch(
  shape: 'auto' | 'key-server' | 'chatgpt',
  provider: string,
  answer = recordedAnswer(),
) {
  const stub = createResearchStub({
    config: { shape, answers: [answer] },
    provider,
    log,
  });
  const [tool, ...rest] = stub.tools({ ...noRuntime, language: 'es' });
  expect(rest).toEqual([]);
  return { stub, tool: tool as AnyToolDefinition };
}

type Update = { content: { type: string; text?: string }[]; details?: unknown };

async function run(
  tool: AnyToolDefinition,
  params: Record<string, unknown> = { query: 'vida laboral, adulto en Madrid', mode: 'balanced' },
  toolCallId = 'call-research',
) {
  const updates: Update[] = [];
  const result = await withCallContext({ tool: tool.name, toolCallId }, () =>
    tool.execute(
      toolCallId,
      params,
      undefined,
      (update: Update) => updates.push(update),
      {} as never,
    ),
  );
  return { result, updates, text: (result.content[0] as { text: string }).text };
}

describe('resolveResearchShape', () => {
  it('follows the provider on auto and obeys a forced shape', () => {
    expect(resolveResearchShape('auto', 'litellm')).toBe('key-server');
    expect(resolveResearchShape('auto', 'custom')).toBe('key-server');
    expect(resolveResearchShape('auto', 'anthropic')).toBe('key-server');
    expect(resolveResearchShape('auto', 'openai-codex')).toBe('chatgpt');
    expect(resolveResearchShape('auto', 'openai')).toBe('chatgpt');
    expect(resolveResearchShape('key-server', 'openai-codex')).toBe('key-server');
    expect(resolveResearchShape('chatgpt', 'litellm')).toBe('chatgpt');
  });
});

describe('the research stub: key-server shape', () => {
  it('gives the model what the product tool writes for the recorded run', async () => {
    const answer = recordedAnswer();
    const { stub, tool } = webResearch('auto', 'litellm');
    expect(stub.backend).toBe('key server');
    expect(tool.name).toBe('web_research');
    expect(tool.description).toContain('Each call costs the user credit.');
    const { result, text } = await run(tool);
    expect(result.isError).toBeFalsy();
    // The golden text: exactly the tool's result JSON for this output (the only thing the model reads).
    expect(text).toBe(
      JSON.stringify({
        success: true,
        id: answer.id,
        status: 'completed',
        outputReady: true,
        output: answer.output,
      }),
    );
    expect(result.structuredContent).toEqual({
      success: true,
      id: answer.id,
      status: 'completed',
      outputReady: true,
      output: answer.output,
    });
    // The recording itself, not a summary of it.
    expect(text).toContain('Para sacar tu vida laboral');
  });

  it('is byte-identical to the product tool reading the same stream from a real HTTP server', async () => {
    const answer = recordedAnswer();
    const stubFetch = createKeyServerFetch(answer, { log });
    const streamed = await stubFetch('https://research.invalid/v1/research', {
      method: 'POST',
      body: JSON.stringify({ input: 'x', mode: 'fast' }),
    });
    expect(streamed.headers.get('content-type')).toBe('text/event-stream');
    const bytes = await streamed.text();
    expect(bytes.startsWith('event: created\ndata: {')).toBe(true);
    expect(bytes.match(/^event: /gm)).toHaveLength(4);

    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const real = createKeyServerResearchTool({
        keyServerUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: async () => 'sk-whatever',
        language: 'es',
        scrub,
      });
      const product = await run(real as AnyToolDefinition);
      const { tool } = webResearch('key-server', 'litellm');
      const stubbed = await run(tool);
      expect(stubbed.text).toBe(product.text);
      expect(stubbed.updates).toEqual(product.updates);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('streams the same progress a real run shows the app', async () => {
    const { tool } = webResearch('auto', 'litellm');
    const { updates } = await run(tool);
    expect(updates.map((u) => u.content[0]?.text)).toEqual([
      'Investigando fuentes…',
      'Investigando fuentes…',
      'Investigando fuentes…',
    ]);
    expect(updates.map((u) => u.details)).toEqual([
      { runId: recordedAnswer().id, status: 'queued' },
      { runId: recordedAnswer().id, status: 'queued' },
      { runId: recordedAnswer().id, status: 'running' },
    ]);
    const english = createResearchStub({
      config: { shape: 'key-server', answers: [recordedAnswer()] },
      provider: 'litellm',
      log,
    }).tools({ ...noRuntime, language: 'en' })[0] as AnyToolDefinition;
    expect((await run(english)).updates[0]?.content[0]?.text).toBe('Researching sources…');
  });

  it('logs the request as a web_research record, with the query and no key', async () => {
    const { tool } = webResearch('auto', 'litellm');
    await run(
      tool,
      { query: 'vida laboral, adulto en Madrid', mode: 'deep', outputSchema: { type: 'object' } },
      'call-7',
    );
    const [record, ...others] = await readNetLog(join(dir, 'host.jsonl'));
    expect(others).toEqual([]);
    expect(record).toMatchObject({
      worldId: 'run-research',
      channel: 'web_research',
      toolCallId: 'call-7',
      method: 'POST',
      url: 'https://research.invalid/v1/research',
      host: 'research.invalid',
      route: 'mapped',
      status: 200,
    });
    expect(JSON.parse(record?.reqBody ?? '{}')).toMatchObject({
      input: 'vida laboral, adulto en Madrid',
      mode: 'deep',
      outputSchema: { type: 'object' },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(record?.reqHeaders.authorization).toBe('«redacted»');
    expect(readFileSync(join(dir, 'host.jsonl'), 'utf8')).not.toContain('sk-eval-research-stub');
  });

  it('answers the reconnection route of the same run and nothing else', async () => {
    const answer = recordedAnswer();
    const fetchStub = createKeyServerFetch(answer, { log });
    const again = await fetchStub(`https://research.invalid/v1/research/${answer.id}/events`);
    expect(again.status).toBe(200);
    const text = await again.text();
    expect(text.match(/^event: /gm)).toEqual(['event: ']);
    expect(text.startsWith('event: completed\n')).toBe(true);
    const other = await fetchStub(
      'https://research.invalid/v1/research/4c5c2b0e-6b7d-4f3a-8c58-0d9f6a1b2c3d/events',
    );
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
    expect((await fetchStub('https://research.invalid/elsewhere')).status).toBe(404);
  });

  it('requires a recorded answer', () => {
    expect(() =>
      createResearchStub({ config: { shape: 'auto', answers: [] }, provider: 'litellm', log }),
    ).toThrow(/no recorded research answer/);
  });
});

describe('the research stub: chatgpt shape', () => {
  it('runs the product tool over a hosted web search stream and keeps its result shape', async () => {
    const answer = recordedAnswer();
    const { stub, tool } = webResearch('auto', 'openai-codex');
    expect(stub.backend).toBe('chatgpt');
    expect(tool.name).toBe('web_research');
    expect(tool.description).toContain("Each call uses the user's ChatGPT plan.");
    const { result, text, updates } = await run(tool);
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(text) as Record<string, unknown> & {
      output: { type: string; content: string; basis: { url: string; title?: string }[] };
    };
    // The same envelope as the product writes for ChatGPT plans: no run id, a flat citation list.
    expect(Object.keys(parsed)).toEqual(['success', 'status', 'outputReady', 'output']);
    expect(parsed).toMatchObject({ success: true, status: 'completed', outputReady: true });
    expect(parsed.output.type).toBe('text');
    expect(parsed.output.content).toBe(answerText(answer.output));
    expect(parsed.output.content).toContain('Para sacar tu vida laboral');
    expect(parsed.output.basis).toEqual(citationsOf(answer.output));
    expect(parsed.output.basis.length).toBeGreaterThan(5);
    expect(parsed.output.basis[0]).toEqual({
      url: expect.stringContaining('portal.seg-social.gob.es'),
      title: 'Categorias',
    });
    // Progress: one when it starts and one per web search call.
    expect(updates.map((u) => u.details)).toEqual([
      { status: 'running', searches: 0 },
      { status: 'running', searches: 1 },
    ]);
  });

  it('asks for the hosted search tool on the model of the mode and logs the request', async () => {
    const { tool } = webResearch('chatgpt', 'litellm');
    await run(tool, { query: 'renovar el NIE', mode: 'fast' }, 'call-9');
    const [record, ...others] = await readNetLog(join(dir, 'host.jsonl'));
    expect(others).toEqual([]);
    expect(record).toMatchObject({
      channel: 'web_research',
      toolCallId: 'call-9',
      method: 'POST',
      url: 'https://research.invalid/v1/responses',
      route: 'mapped',
      status: 200,
    });
    expect(JSON.parse(record?.reqBody ?? '{}')).toMatchObject({
      model: 'gpt-6-luna',
      tools: [{ type: 'web_search' }],
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      input: 'renovar el NIE',
      reasoning: { effort: 'high' },
    });
  });

  it('returns a structured answer as JSON when the model asked for a schema', async () => {
    const structured: ResearchAnswer = {
      id: recordedAnswer().id,
      output: {
        type: 'json',
        content: { requisitos: ['DNI'], tasa: 0 },
        basis: [{ citations: [{ url: 'https://sede.dgt.gob.es/a', title: 'DGT' }] }],
      },
    };
    const { tool } = webResearch('chatgpt', 'openai-codex', structured);
    const { text } = await run(tool, {
      query: 'x',
      mode: 'balanced',
      outputSchema: { type: 'object' },
    });
    expect(JSON.parse(text)).toEqual({
      success: true,
      status: 'completed',
      outputReady: true,
      output: {
        type: 'json',
        content: { requisitos: ['DNI'], tasa: 0 },
        basis: [{ url: 'https://sede.dgt.gob.es/a', title: 'DGT' }],
      },
    });
  });
});

describe('what the stub reads from a recording', () => {
  it('lists each cited source once and keeps titles short', () => {
    const output: ResearchAnswer['output'] = {
      type: 'json',
      content: {},
      basis: [
        {
          field: 'a',
          citations: [
            { url: 'https://a.es/1', title: 'Uno', excerpts: ['x'] },
            { url: 'https://a.es/2' },
            { url: 'https://a.es/3', title: `${'Menú '.repeat(100)}\n` },
          ],
        },
        { field: 'b', citations: [{ url: 'https://a.es/1', title: 'Otro título' }] },
      ],
    };
    const sources = citationsOf(output);
    expect(sources.map((s) => s.url)).toEqual([
      'https://a.es/1',
      'https://a.es/2',
      'https://a.es/3',
    ]);
    expect(sources[0]).toEqual({ url: 'https://a.es/1', title: 'Uno' });
    expect(sources[1]).toEqual({ url: 'https://a.es/2' });
    expect(sources[2]?.title).toHaveLength(200);
    expect(sources[2]?.title?.endsWith('…')).toBe(true);
    expect(citationsOf({ type: 'text', content: 'x', basis: [] })).toEqual([]);
  });

  it('writes the recorded content as the text an OpenAI model would answer', () => {
    const answer = (content: unknown): ResearchAnswer['output'] =>
      ({ type: 'json', content, basis: [] }) as ResearchAnswer['output'];
    expect(answerText({ type: 'text', content: 'Hola', basis: [] })).toBe('Hola');
    expect(answerText(answer({ output: '## Título' }))).toBe('## Título');
    expect(answerText(answer({ a: 'x', b: 'y' }))).toBe('{"a":"x","b":"y"}');
    expect(answerText(answer({ output: { nested: true } }))).toBe('{"output":{"nested":true}}');
    expect(answerText(answer([1, 2]))).toBe('[1,2]');
  });
});
