import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { ExtensionToolContext, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ResearchMode } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { BUNDLED_MODEL_LISTS, type FixedModel } from '../src/providers/defaults';
import {
  CHATGPT_RESEARCH_MODELS,
  createChatGPTResearchTool,
} from '../src/research/chatgpt-research';
import type { ToolResult } from '../src/tools/common';

const ctx = {} as ExtensionToolContext;
type Options = NonNullable<Parameters<ModelRuntime['streamSimple']>[2]>;

interface Sent {
  model: Model<Api>;
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
    streamSimple: (model: Model<Api>, _context: unknown, options: Options) => ({
      result: async () => {
        const payload = (await options.onPayload?.(
          { model: model.id, include: ['reasoning.encrypted_content'], store: false },
          model,
        )) as Record<string, unknown>;
        sent.push({ model, options, payload });
        for (const event of events) await options.onProviderStreamEvent?.(event as never, model);
        return { stopReason: 'stop', content: [], ...reply } as AssistantMessage;
      },
    }),
  } as unknown as Pick<ModelRuntime, 'streamSimple'>;
  return { runtime, sent };
}

function tool(
  runtime: Pick<ModelRuntime, 'streamSimple'>,
  models?: Record<ResearchMode, FixedModel>,
) {
  return createChatGPTResearchTool({
    runtime,
    model: (id) => ({ id, provider: 'openai' }) as Model<Api>,
    language: 'es',
    ...(models ? { models } : {}),
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

  it.each(ResearchMode.options)(
    'runs %s research on the first model of its bundled list, with OpenAI web search',
    async (mode) => {
      const { id, thinkingLevel: effort } = BUNDLED_MODEL_LISTS.chatgpt.research[mode][0]!;
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

  it("runs on the models the app picked from the account's plan", async () => {
    const models: Record<ResearchMode, FixedModel> = {
      fast: { id: 'gpt-plan-fast', thinkingLevel: 'low' },
      balanced: { id: 'gpt-plan-balanced', thinkingLevel: 'max' },
      deep: { id: 'gpt-plan-deep', thinkingLevel: 'off' },
    };
    for (const mode of ['balanced', 'deep'] as const) {
      const fake = fakeRuntime(answer('Información oficial'));
      await tool(fake.runtime, models).execute(
        'call',
        { query: 'renovar el permiso', mode },
        undefined,
        undefined,
        ctx,
      );
      expect(fake.sent[0]!.model.id).toBe(models[mode].id);
      // "off" sends no reasoning effort: pi has no such option.
      expect(fake.sent[0]!.options.reasoning).toBe(mode === 'deep' ? undefined : 'max');
    }
  });

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
});
