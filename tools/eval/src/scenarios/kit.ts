/**
 * The vocabulary scripted models are written in: `tools/mock-llm` rules, told apart by who is
 * asking (the coordinator, an agent, the answerer), and `sequence`, which turns a list of stages
 * into rules that walk them in order. An agent works in workflows (docs/codemode.md): each stage
 * is one `codemode` call, whose result comes back as its tool result or, when the workflow waited
 * for the user, as a message. Everything here is data: a scenario is a plain object that can be
 * written to a JSON file and read by `tools/mock-llm`.
 */
import type { MatchSpec, ScenarioInput } from '@sa/mock-llm';

export type Rule = NonNullable<ScenarioInput['rules']>[number];
export type When = MatchSpec;

export interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The coordinator (the chat's agent) is the one that can start agents. */
export const COORDINATOR: When = { hasTool: '^agent_start$' };

/** An agent is the one that writes workflows. */
export const AGENT: When = { hasTool: '^codemode$' };

/** The answerer (the user simulator's model) announces itself in its system prompt. */
export const ANSWERER: When = { systemPrompt: '^You play the user in an automated test' };

/** An agent's report, as the app hands it to the coordinator (`AGENT_REPORT_PREFIX`). */
export const REPORT_PREFIX = '^\\[Report from agent';

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A `codemode` call: `body` is the body of the workflow's `main(api)`, `components` what the
 * module declares before it (interfaces). Neither may hold `{{`: it is mock-llm's template syntax.
 */
export function workflow(
  id: string,
  body: string,
  options: { title?: string; procedures?: string[]; components?: string; callId?: string } = {},
): ToolCall {
  return {
    ...(options.callId ? { id: options.callId } : {}),
    name: 'codemode',
    arguments: {
      workflow: id,
      ...(options.title ? { title: options.title } : {}),
      ...(options.procedures ? { procedures: options.procedures } : {}),
      source: `${options.components ? `${options.components}\n\n` : ''}export async function main(api) {\n${body}\n}\n`,
    },
  };
}

/** The last workflow came back succeeded: as the call's result, or as a message after waiting. */
const WORKFLOW_SUCCEEDED: When = {
  anyOf: [
    { lastToolResult: '^Workflow "[^"]+" succeeded' },
    { lastUser: '^\\[Workflow "[^"]+"[^\\]\\n]* succeeded\\]' },
  ],
};

/** The text a workflow's result was delivered in matches: the call's result, or the message. */
export function resultMatches(pattern: string): When {
  return {
    anyOf: [{ lastToolResult: pattern }, { lastUser: `^\\[Workflow [\\s\\S]*?${pattern}` }],
  };
}

/** One step of an agent's way: one workflow (or, last, only a report) once its condition holds. */
export interface Stage {
  /** Names the rule (`<key>-<id>`). */
  id: string;
  /** More the request must show (named captures may be used as `{{name}}` in the call). */
  when?: Omit<When, 'anyOf' | 'state'>;
  /** The workflow of this turn; none means the agent only talks (its report: the last stage). */
  call?: ToolCall;
  /** What the agent says in this turn (with a call: before it). */
  text?: string;
}

/** What an agent says when its workflow waits for the user: it ends its turn. */
export const WAITS_TEXT = 'Le he preguntado al usuario; sigo en cuanto conteste.';

/**
 * Rules that walk `stages` in order. The position is the scenario state `key` (shared by every
 * request of the scenario, so one agent per key): stage `i` fires when the state is `i` (unset for
 * the first), the workflow before it succeeded and its own `when` holds, and moves the state to
 * `i + 1`. A workflow that waits for the user ends the agent's turn; its result wakes it later. A
 * workflow that failed fires nothing: the agent ends with the scenario's fallback.
 */
export function sequence(agent: When, key: string, stages: readonly Stage[]): Rule[] {
  const rules: Rule[] = [
    {
      id: `${key}-waits`,
      when: { ...agent, lastTool: 'codemode', lastToolResult: 'is waiting for the user' },
      reply: { text: WAITS_TEXT },
    },
  ];
  stages.forEach((stage, index) => {
    const reply = {
      ...(stage.text !== undefined ? { text: stage.text } : {}),
      ...(stage.call ? { toolCalls: [stage.call] } : {}),
    };
    if (!reply.text && !reply.toolCalls) {
      throw new Error(`Stage "${stage.id}" neither says nor calls anything`);
    }
    rules.push({
      id: `${key}-${stage.id}`,
      when: {
        ...agent,
        ...stage.when,
        ...(index === 0 ? {} : WORKFLOW_SUCCEEDED),
        state: { [key]: index === 0 ? null : index },
      },
      set: { [key]: index + 1 },
      reply,
    });
  });
  return rules;
}
