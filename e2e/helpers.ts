import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuleSpec } from '@sa/mock-llm';
import type {
  ChatItem,
  CodemodeAgentInfo,
  ProcedureListItem,
  PromptItem,
  WorkflowInfo,
  WorkflowUi,
} from '@sa/shared';
import { expect, type Harness, invoke, test } from './fixtures';

/**
 * The app runs one conversation with the coordinator (the chat's agent), which starts background
 * agents; each agent's only tool is `codemode`, which runs a workflow module (docs/codemode.md).
 * Mock LLM rules tell them apart by the tools each declares.
 */
export const COORDINATOR = '^agent_start$';
export const AGENT = '^codemode$';

/**
 * The coordinator starts one agent on the first message and relays its reports: `reply` for the
 * report whose text matches `done`, a holding answer for any other (the agent's turn ended while
 * its workflow waits for the user).
 */
export function coordinatorRules(brief: string, reply: string, done: string): RuleSpec[] {
  return [
    {
      when: { hasTool: COORDINATOR, lastUser: `\\[Report from agent[\\s\\S]*${done}` },
      reply: { text: reply },
    },
    {
      when: { hasTool: COORDINATOR, lastUser: '\\[Report from agent' },
      reply: { text: 'Te he dejado una pregunta en Mis trámites.' },
    },
    {
      when: { hasTool: COORDINATOR, lastTool: 'agent_start' },
      reply: { text: 'Me pongo con ello.' },
    },
    {
      when: { hasTool: COORDINATOR, turn: 0 },
      reply: {
        toolCalls: [{ name: 'agent_start', arguments: { status: 'Trabajando en ello…', brief } }],
      },
    },
  ];
}

export interface WorkflowSpec {
  workflow: string;
  title: string;
  /** The module: `export async function main(api) { … }`. */
  source: string;
}

/**
 * The agent runs one workflow on its first message and reports `report` once it ended (in its
 * `codemode` call, or later as a `[Workflow …]` message after it waited for the user).
 */
export function agentRules(spec: WorkflowSpec, report: string): RuleSpec[] {
  const ended = `\\[Workflow "${spec.workflow}"`;
  return [
    {
      when: { hasTool: AGENT, lastUser: `${ended}[^\\]]*succeeded` },
      reply: { text: report },
    },
    {
      when: { hasTool: AGENT, lastUser: ended },
      reply: { text: 'El flujo no terminó bien.' },
    },
    {
      when: { hasTool: AGENT, lastTool: 'codemode', lastToolResult: 'waiting for the user' },
      reply: { text: 'Le he dejado una pregunta.' },
    },
    {
      when: { hasTool: AGENT, lastTool: 'codemode', lastToolResult: 'succeeded' },
      reply: { text: report },
    },
    {
      when: { hasTool: AGENT, lastTool: 'codemode' },
      reply: { text: 'El flujo no terminó bien.' },
    },
    { when: { hasTool: AGENT, turn: 0 }, reply: { toolCalls: [codemodeCall(spec)] } },
  ];
}

export function codemodeCall(spec: WorkflowSpec) {
  return { name: 'codemode', arguments: { ...spec } };
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
  const state = await invoke(h.page, 'codemode.state');
  const logs = await Promise.all(
    state.agents.map(async (a) => ({ ...a, log: await invoke(h.page, 'codemode.agentLog', a.id) })),
  );
  await test.info().attach('agents.json', {
    body: JSON.stringify({ agents: logs, workflows: state.workflows }, null, 2),
    contentType: 'application/json',
  });
  await test.info().attach('requests.json', {
    body: JSON.stringify(h.llm.requests(), null, 2),
    contentType: 'application/json',
  });
}

async function debugOnFailure<T>(h: Harness, wait: () => Promise<T>): Promise<T> {
  try {
    return await wait();
  } catch (error) {
    await attachDebug(h);
    throw error;
  }
}

/** Waits for a procedure an agent created. */
export async function procedureTitled(h: Harness, title: string): Promise<ProcedureListItem> {
  let found: ProcedureListItem | undefined;
  await debugOnFailure(h, () =>
    expect
      .poll(async () => {
        found = (await invoke(h.page, 'procedures.list')).find((p) => p.title === title);
        return Boolean(found);
      })
      .toBe(true),
  );
  return found as ProcedureListItem;
}

/** Waits for the open interface `key` of some workflow (what "Para ti" shows). */
export async function openUi(
  h: Harness,
  key: string,
): Promise<{ workflow: WorkflowInfo; ui: WorkflowUi }> {
  let found: { workflow: WorkflowInfo; ui: WorkflowUi } | undefined;
  await debugOnFailure(h, () =>
    expect
      .poll(async () => {
        for (const workflow of (await invoke(h.page, 'codemode.state')).workflows) {
          const ui = workflow.ui.find((u) => u.key === key && u.tree);
          if (ui) found = { workflow, ui };
        }
        return Boolean(found);
      })
      .toBe(true),
  );
  return found as { workflow: WorkflowInfo; ui: WorkflowUi };
}

/** Waits for a host prompt (approval, secret code…) an agent showed for a procedure. */
export async function pending(h: Harness, procedureId: string): Promise<PromptItem> {
  let found: PromptItem | undefined;
  await debugOnFailure(h, () =>
    expect
      .poll(async () => {
        found = (await invoke(h.page, 'procedures.get', procedureId))?.runtime.prompts?.[0];
        return Boolean(found);
      })
      .toBe(true),
  );
  return found as PromptItem;
}

/** The one background agent the coordinator started. */
export async function theAgent(h: Harness): Promise<CodemodeAgentInfo> {
  let found: CodemodeAgentInfo | undefined;
  await debugOnFailure(h, () =>
    expect
      .poll(async () => {
        const agents = (await invoke(h.page, 'codemode.state')).agents.filter(
          (a) => a.kind === 'agent',
        );
        found = agents.length === 1 ? agents[0] : undefined;
        return Boolean(found);
      })
      .toBe(true),
  );
  return found as CodemodeAgentInfo;
}

/** Waits until the agent works no more (or only waits for the user); returns what it did. */
export async function agentIdle(
  h: Harness,
  agentId: string,
  activity: CodemodeAgentInfo['activity'] = 'idle',
): Promise<ChatItem[]> {
  await debugOnFailure(h, () =>
    expect
      .poll(
        async () =>
          (await invoke(h.page, 'codemode.state')).agents.find((a) => a.id === agentId)?.activity,
      )
      .toBe(activity),
  );
  return invoke(h.page, 'codemode.agentLog', agentId);
}

/** The agent's `codemode` calls, as its log shows them. */
export function codemodeCalls(log: ChatItem[]) {
  return log.filter(
    (i): i is Extract<ChatItem, { type: 'activity' }> =>
      i.type === 'activity' && i.tool === 'codemode',
  );
}

export async function assistantSaid(h: Harness, text: string) {
  await debugOnFailure(h, () =>
    expect
      .poll(async () =>
        (await invoke(h.page, 'chat.transcript')).some(
          (i) => i.type === 'assistant' && i.status === 'complete' && i.text.includes(text),
        ),
      )
      .toBe(true),
  );
}

/** Every saved text file of the profile (transcripts, sessions, records, logs), by path. */
export async function savedTextFiles(userData: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(userData, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(json|jsonl|log)$/.test(entry.name)) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(path, await readFile(path, 'utf8'));
  }
  return files;
}
