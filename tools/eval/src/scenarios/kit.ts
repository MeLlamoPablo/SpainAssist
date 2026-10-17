/**
 * The vocabulary scripted models are written in: `tools/mock-llm` rules, told apart by who is
 * asking (the orchestrator, a procedure agent, the answerer), and `sequence`, which turns a list
 * of stages into rules that walk them in order. Everything here is data: a scenario is a plain
 * object that can be written to a JSON file and read by `tools/mock-llm`.
 */
import type { MatchSpec, ScenarioInput } from '@sa/mock-llm';

export type Rule = NonNullable<ScenarioInput['rules']>[number];
export type When = MatchSpec;

interface ToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** The orchestrator (the app's "assistant" agent) is the one that can start procedures. */
export const ORCHESTRATOR: When = { hasTool: '^procedure_start$' };

/** A procedure agent is the one that keeps a plan card. */
export const PROCEDURE_AGENT: When = { hasTool: '^procedure_update$' };

/** The answerer (the user simulator's model) announces itself in its system prompt. */
export const ANSWERER: When = { systemPrompt: '^You play the user in an automated test' };

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A control of the page snapshot as the model reads it (`button "Entrar" [ref=e12]`), with its ref
 * captured under `group`. The name is a prefix: the snapshot keeps trailing blanks of icons.
 */
export function control(role: string, name: string, group = 'ref'): string {
  return `${role} "${escapeRegExp(name)}[^"]*"[^\\n]*\\[ref=(?<${group}>\\w+)\\]`;
}

/** One step of an agent's way: what it calls (or says) once its condition holds. */
export interface Stage {
  /** Names the rule (`<key>-<id>`) and tells recorded requests apart. */
  id: string;
  /**
   * What the request must show for this step, with named captures that `calls` may use as
   * `{{name}}`. Without it the step happens at once.
   */
  when?: When;
  /**
   * When `when` does not hold yet, look at the page again after waiting: a second (`true`), or
   * until this text shows on the page (a string: for a page that may take long to settle).
   */
  wait?: boolean | string;
  /** The tool calls of this turn; none means the agent only talks (its last turn). */
  calls?: ToolCall[];
  /** What the agent says in this turn (with calls: before them). */
  text?: string;
}

/** `browser_wait` for a second: the page is changing by itself (redirects, scripts). */
const WAIT_A_SECOND: ToolCall = {
  name: 'browser_wait',
  arguments: { seconds: 1 },
};

/** How long one wait for a text of a page lasts at most. */
const PAGE_WAIT_SECONDS = 30;

/** `browser_wait` until `text` shows on the page (up to 30 s): the page is ready for the next step. */
export function waitForText(id: string, text: string): Stage {
  return {
    id,
    calls: [{ id, name: 'browser_wait', arguments: { text, seconds: PAGE_WAIT_SECONDS } }],
  };
}

/**
 * How many times a stage may look again for its page. A page that never shows what the stage needs
 * ends the run (the agent has nothing more to say) instead of looping until a budget runs out; a
 * wait for a text lasts up to 30 s, so a machine that is merely slow has minutes of patience.
 */
const MAX_WAITS = 45;

/**
 * Rules that walk `stages` in order. The position is the scenario state `key` (shared by every
 * request of the scenario, so one agent per key): stage `i` fires when the state is `i` (unset for
 * the first) and its `when` holds, and moves it to `i + 1`. A stage with `wait` that does not see
 * what it needs waits and looks again, so a page that is slow to settle never breaks the way.
 */
export function sequence(agent: When, key: string, stages: readonly Stage[]): Rule[] {
  const rules: Rule[] = [];
  stages.forEach((stage, index) => {
    const at = { [key]: index === 0 ? null : index };
    const reply = {
      ...(stage.text !== undefined ? { text: stage.text } : {}),
      ...(stage.calls ? { toolCalls: stage.calls } : {}),
    };
    if (!reply.text && !reply.toolCalls) {
      throw new Error(`Stage "${stage.id}" neither says nor calls anything`);
    }
    rules.push({
      id: `${key}-${stage.id}`,
      when: { ...agent, ...stage.when, state: { ...stage.when?.state, ...at } },
      set: { [key]: index + 1 },
      reply,
    });
    if (stage.when && stage.wait) {
      rules.push({
        id: `${key}-${stage.id}-wait`,
        when: { ...agent, state: at },
        times: MAX_WAITS,
        reply: {
          toolCalls: [
            typeof stage.wait === 'string'
              ? {
                  name: 'browser_wait',
                  arguments: { text: stage.wait, seconds: PAGE_WAIT_SECONDS },
                }
              : WAIT_A_SECOND,
          ],
        },
      });
    }
  });
  return rules;
}
