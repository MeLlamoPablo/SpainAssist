import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai';
import type { ExtensionToolContext, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  CHATGPT_RESEARCH_MODELS,
  createChatGPTResearchTool,
} from '../src/research/chatgpt-research';
import type { ScrubOutgoing } from '../src/research/scrub';
import type { ToolResult } from '../src/tools/common';
import { DNI, failingScrub, fakeScrub } from './helpers/scrub';

const ctx = {} as ExtensionToolContext;
type Options = NonNullable<Parameters<ModelRuntime['streamSimple']>[2]>;

interface Sent {
  model: Model<Api>;
  context: Context;
  options: Options;
  payload: Record<string, unknown>;
}

const searchDone = {
  type: 'response.output_item.done',
  item: { type: 'web_search_call', action: { type: 'search', query: 'renovar permiso' } },
};
const messageDone = {
  type: 'response.output_item.done',
  item: {
    type: 'message',
    content: [
      {
        type: 'output_text',
        annotations: [
          { type: 'url_citation', url: 'https://sede.dgt.gob.es/renovar', title: 'DGT' },
          { type: 'url_citation', url: 'https://sede.dgt.gob.es/renovar', title: 'DGT' },
        ],
      },
    ],
  },
};

/** Fake pi runtime: runs the request hooks, replays `events`, then answers `reply`. */
function fakeRuntime(reply: Partial<AssistantMessage>, events: unknown[] = []) {
  const sent: Sent[] = [];
  const runtime = {
    streamSimple: (model: Model<Api>, context: Context, options: Options) => ({
      result: async () => {
        const payload = (await options.onPayload?.(
          { model: model.id, include: ['reasoning.encrypted_content'], store: false },
          model,
        )) as Record<string, unknown>;
        sent.push({ model, context, options, payload });
        for (const event of events) await options.onProviderStreamEvent?.(event as never, model);
        return { stopReason: 'stop', content: [], ...reply } as AssistantMessage;
      },
    }),
  } as unknown as Pick<ModelRuntime, 'streamSimple'>;
  return { runtime, sent };
}

function tool(runtime: Pick<ModelRuntime, 'streamSimple'>, scrub: ScrubOutgoing = fakeScrub) {
  return createChatGPTResearchTool({
    runtime,
    model: (id) => ({ id, provider: 'openai' }) as Model<Api>,
    language: 'es',
    scrub,
  });
}

const answer = (text: string): Partial<AssistantMessage> => ({
  content: [{ type: 'text', text }],
});

describe('web research on a ChatGPT plan', () => {
  it('requires a mode and says nothing about which one to pick', () => {
    const { description, parameters } = tool(fakeRuntime({}).runtime);
    const schema = parameters as {
      required?: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(['query', 'mode']));
    expect(schema.properties.mode).toEqual({ type: 'string', enum: ['fast', 'balanced', 'deep'] });
    expect(description).not.toMatch(/\b(fast|balanced|deep|mode)\b/i);
  });

  it.each([
    ['fast', 'gpt-6-luna', 'high'],
    ['balanced', 'gpt-6.1-sol', 'high'],
    ['deep', 'gpt-6-astra', 'high'],
  ] as const)(
    'runs %s research on %s with %s effort and OpenAI web search',
    async (mode, id, effort) => {
      expect(CHATGPT_RESEARCH_MODELS[mode]).toEqual({ id, thinkingLevel: effort });
      const fake = fakeRuntime(answer('Información oficial'));
      await tool(fake.runtime).execute(
        'call',
        { query: 'renovar el permiso', mode },
        undefined,
        undefined,
        ctx,
      );
      expect(fake.sent).toHaveLength(1);
      const [sent] = fake.sent;
      expect(sent!.model.id).toBe(id);
      expect(sent!.options.reasoning).toBe(effort);
      expect(sent!.payload).toMatchObject({
        store: false,
        tools: [{ type: 'web_search' }],
        include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      });
    },
  );

  it('returns the answer with its cited sources and reports searches as progress', async () => {
    const fake = fakeRuntime(answer('Cita previa en la DGT.'), [
      searchDone,
      searchDone,
      messageDone,
    ]);
    const updates: ToolResult[] = [];
    const result = await tool(fake.runtime).execute(
      'call',
      { query: 'renovar el permiso, 45 años, Madrid', mode: 'balanced' },
      undefined,
      (update: ToolResult) => updates.push(update),
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      success: true,
      status: 'completed',
      outputReady: true,
      output: {
        type: 'text',
        content: 'Cita previa en la DGT.',
        basis: [{ url: 'https://sede.dgt.gob.es/renovar', title: 'DGT' }],
      },
    });
    expect(updates.map((u) => u.details)).toEqual([
      { status: 'running', searches: 0 },
      { status: 'running', searches: 1 },
      { status: 'running', searches: 2 },
    ]);
  });

  it('parses a structured answer when an output schema is given', async () => {
    const fake = fakeRuntime(answer('```json\n{"fee": 24.1}\n```'));
    const result = await tool(fake.runtime).execute(
      'call',
      { query: 'tasa', mode: 'fast', outputSchema: { type: 'object' } },
      undefined,
      undefined,
      ctx,
    );
    expect(result.structuredContent).toMatchObject({
      output: { type: 'json', content: { fee: 24.1 } },
    });
  });

  it('reports a failed request without asking for a replacement run', async () => {
    const fake = fakeRuntime({ stopReason: 'error', errorMessage: 'usage_limit_reached' });
    const result = await tool(fake.runtime).execute(
      'call',
      { query: 'renovar', mode: 'deep' },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('usage_limit_reached');
    expect(text).toContain('Do not automatically start a replacement run.');
  });

  it('propagates a user abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeRuntime(answer('x'));
    await expect(
      tool(fake.runtime).execute(
        'call',
        { query: 'x', mode: 'fast' },
        controller.signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow();
    expect(fake.sent).toHaveLength(0);
  });

  it('sends the query only after the app removed personal data from it', async () => {
    const fake = fakeRuntime(answer('Información oficial'));
    await tool(fake.runtime).execute(
      'call',
      { query: `renovar el permiso, DNI ${DNI}`, mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(fake.sent[0]!.context.messages).toMatchObject([
      { role: 'user', content: 'renovar el permiso, DNI [DNI]' },
    ]);
    expect(JSON.stringify(fake.sent[0]!.context)).not.toContain(DNI);
  });

  it('sends nothing when the app cannot scrub the query', async () => {
    const fake = fakeRuntime(answer('x'));
    const result = await tool(fake.runtime, failingScrub).execute(
      'call',
      { query: `DNI ${DNI}`, mode: 'fast' },
      undefined,
      undefined,
      ctx,
    );
    expect(fake.sent).toHaveLength(0);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('nothing was sent');
  });
});
