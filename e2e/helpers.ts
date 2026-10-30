import type { RuleSpec } from '@sa/mock-llm';
import type { ChatItem, ProcedureListItem, PromptItem } from '@sa/shared';
import { expect, type Harness, invoke, test } from './fixtures';

/**
 * The app runs one conversation with the assistant (an orchestrator agent) and one agent per
 * procedure. Mock LLM rules tell them apart by the tools each declares: only the assistant has
 * procedure_start; only procedure agents have browser_open.
 */
export const ASSISTANT = '^procedure_start$';
export const PROCEDURE = '^browser_open$';

/** The assistant starts one procedure on the first message and relays its report. */
export function assistantRules(title: string, brief: string, reply: string): RuleSpec[] {
  return [
    {
      when: { hasTool: ASSISTANT, lastUser: '^\\[Report from procedure' },
      reply: { text: reply },
    },
    {
      when: { hasTool: ASSISTANT, lastTool: 'procedure_start' },
      reply: { text: 'Me pongo con ello.' },
    },
    {
      when: { hasTool: ASSISTANT, turn: 0 },
      reply: { toolCalls: [{ name: 'procedure_start', arguments: { title, brief } }] },
    },
  ];
}

export async function connect(h: Harness) {
  const result = await invoke(h.page, 'providers.redeemVoucher', 'SA-DEMO42');
  expect(result.ok).toBe(true);
  await invoke(h.page, 'settings.update', { onboardingCompleted: true });
}

async function attachDebug(h: Harness) {
  await test.info().attach('conversation.json', {
    body: JSON.stringify(await invoke(h.page, 'chat.transcript'), null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('requests.json', {
    body: JSON.stringify(h.llm.requests(), null, 2),
    contentType: 'application/json',
  });
}

/** Waits for a procedure the assistant started. */
export async function procedureTitled(h: Harness, title: string): Promise<ProcedureListItem> {
  let found: ProcedureListItem | undefined;
  try {
    await expect
      .poll(async () => {
        found = (await invoke(h.page, 'procedures.list')).find((p) => p.title === title);
        return Boolean(found);
      })
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
  return found as ProcedureListItem;
}

/** Waits for a question of a procedure's agent, in the conversation. */
export async function pending(h: Harness, procedureId: string): Promise<PromptItem> {
  let found: PromptItem | undefined;
  try {
    await expect
      .poll(async () => {
        // A procedure's questions wait on its card (runtime), not in the conversation.
        found = (await invoke(h.page, 'procedures.get', procedureId))?.runtime.prompts?.[0];
        return Boolean(found);
      })
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
  return found as PromptItem;
}

export async function idle(h: Harness, procedureId: string): Promise<ChatItem[]> {
  await expect
    .poll(async () => (await invoke(h.page, 'procedures.get', procedureId))?.runtime.activity)
    .toBe('idle');
  return invoke(h.page, 'procedures.log', procedureId);
}

export async function assistantSaid(h: Harness, text: string) {
  try {
    await expect
      .poll(async () =>
        (await invoke(h.page, 'chat.transcript')).some(
          (i) => i.type === 'assistant' && i.status === 'complete' && i.text.includes(text),
        ),
      )
      .toBe(true);
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
}
