/**
 * A Codex run (`openai-codex`, the ChatGPT backend through the meter): the same app, the other
 * provider flow. The credential is the synthetic login of replay mode and the backend is the mock's.
 */

import { BUNDLED_MODEL_LISTS } from '@sa/agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PendingPrompt } from '../../../src/contracts';
import { vidaScenario } from './scripts';
import {
  browserSuite,
  driveToIdle,
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  startStack,
} from './support';

browserSuite('a Codex run', () => {
  let host: Awaited<ReturnType<typeof prepareHostBundle>>;
  let stack: Stack;
  let agentId: string;
  let prompts: PendingPrompt[];

  beforeAll(async () => {
    host = await prepareHostBundle();
    stack = await startStack({
      hostBundle: host.bundle,
      scenario: vidaScenario(),
      provider: 'codex',
    });
    await stack.app.send('sácame la vida laboral');
    await driveToIdle(stack.app, async (prompt, app) => {
      if (prompt.kind === 'form') {
        await app.respond(prompt.itemId, {
          kind: 'form',
          values: { metodo_de_identificacion: 'clave_permanente' },
          dismissed: false,
          savedToVault: [],
        });
        return true;
      }
      return false;
    });
    prompts = stack.of('prompt_shown').map((o) => o.prompt);
    agentId = stack
      .of('tool_end')
      .map((o) => /Started agent (a_[0-9a-f]+)/.exec(o.text)?.[1])
      .find(Boolean) as string;
  }, 240_000);

  afterAll(async () => {
    await stack?.close();
    if (stack) removeRunDir(stack.runDir);
    host?.cleanup();
  });

  describe('a Codex run', () => {
    it('goes through the whole procedure like a voucher run', () => {
      expect(prompts.map((p) => p.kind)).toEqual(['form']);
      expect(stack.of('assistant_message').map((m) => m.agent)).toEqual([
        'assistant',
        'procedure',
        'assistant',
        'procedure',
        'assistant',
      ]);
      expect(stack.of('assistant_message').at(-1)?.text).toContain('sa:document/');
      expect(stack.app.secretLeaks()).toEqual([]);
    });

    it("asks the ChatGPT backend through the meter, with the product's Codex models", () => {
      const posts = stack.llm.requests().filter((r) => r.path.endsWith('/codex/responses'));
      expect(posts.length).toBeGreaterThan(0);
      type Tool = { name?: string };
      const bodies = posts.map(
        (r) =>
          r.body as {
            model: string;
            reasoning?: { effort?: string };
            tools?: Tool[];
            input?: { type?: string; tools?: Tool[] }[];
          },
      );
      // Models that take tool changes mid-conversation get their tools as `additional_tools`
      // input items instead of `tools`.
      const declares = (b: (typeof bodies)[number], name: string) =>
        [...(b.tools ?? []), ...(b.input ?? []).flatMap((item) => item.tools ?? [])].some(
          (t) => t.name === name,
        );
      const assistant = bodies.filter((b) => declares(b, 'agent_start'));
      const procedure = bodies.filter((b) => declares(b, 'codemode'));
      expect(assistant.length).toBeGreaterThan(0);
      expect(procedure.length).toBeGreaterThan(0);
      // Codex runs each list's first model of the models file.
      const [coordinator] = BUNDLED_MODEL_LISTS.chatgpt.assistant;
      const [agent] = BUNDLED_MODEL_LISTS.chatgpt.procedures;
      expect(new Set(assistant.map((b) => b.model))).toEqual(new Set([coordinator?.id]));
      expect(new Set(procedure.map((b) => b.model))).toEqual(new Set([agent?.id]));
      expect(new Set(assistant.map((b) => b.reasoning?.effort))).toEqual(
        new Set([coordinator?.thinkingLevel]),
      );
      expect(new Set(procedure.map((b) => b.reasoning?.effort))).toEqual(
        new Set([agent?.thinkingLevel]),
      );
      // Both agents are metered under their own keys, as for vouchers.
      expect(stack.run.agentKeys().sort()).toEqual(['assistant', `procedure-${agentId}`]);
    });

    it('answers web research with the recording, in the shape of a hosted search', () => {
      const research = stack
        .of('net')
        .map((o) => o.record)
        .find((r) => r.channel === 'web_research');
      expect(research).toMatchObject({ host: 'research.invalid', route: 'mapped', method: 'POST' });
      expect(new URL(research?.url ?? '').pathname).toBe('/v1/responses');
      // The workflow read the answer: its result goes on with the rest.
      const result = stack.of('tool_end').find((o) => o.toolCallId.startsWith('workflow-result-'));
      expect(result?.text).toMatch(/succeeded\]/);
    });
  });
});

afterAll(expectNoEgress);
