import { z } from 'zod';

/**
 * Scripted scenarios for the mock LLM.
 *
 * A scenario is an ordered list of rules. For every chat completion request the first rule whose
 * `when` conditions all hold produces the reply; if none matches, `fallback` is used. Regexes are
 * JavaScript regex sources, matched case-insensitively. Named capture groups (e.g.
 * `(?<resultId>[a-z0-9-]+)`) become template variables usable as `{{resultId}}` in the reply text and
 * in string values of tool-call arguments. Built-in variables: `{{lastUser}}`, `{{turn}}`,
 * `{{date}}` (YYYY-MM-DD).
 */

export const ToolCallSpec = z.object({
  /** Tool-call id; generated when omitted. */
  id: z.string().optional(),
  name: z.string().min(1),
  /** JSON arguments (an object, or a raw JSON string to test malformed arguments). */
  arguments: z.union([z.record(z.string(), z.unknown()), z.string()]).default({}),
});
export type ToolCallSpec = z.infer<typeof ToolCallSpec>;

export const ReplySpec = z.object({
  /** Assistant text, streamed in chunks. */
  text: z.string().optional(),
  /** Reasoning text streamed as `reasoning_content` deltas before the answer. */
  reasoning: z.string().optional(),
  toolCalls: z.array(ToolCallSpec).optional(),
  /** Defaults to "tool_calls" when there are tool calls, else "stop". */
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter']).optional(),
  /** Respond with an HTTP error instead (e.g. 402 "Key limit exceeded", 500, 429). */
  error: z
    .object({
      status: z.number().int().min(400).max(599),
      message: z.string(),
      code: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  /** Wait before sending the first byte (e.g. to test aborts). */
  delayMs: z.number().int().min(0).max(600_000).optional(),
  /** Delay between streamed chunks (overrides the server default). */
  chunkDelayMs: z.number().int().min(0).max(10_000).optional(),
  /** Override reported usage. */
  usage: z
    .object({
      promptTokens: z.number().int().min(0),
      completionTokens: z.number().int().min(0),
    })
    .optional(),
});
export type ReplySpec = z.infer<typeof ReplySpec>;

export const MatchSpec = z.object({
  /** Regex tested against the text of the last user message. */
  lastUser: z.string().optional(),
  /**
   * Exact name (or regex when it contains regex metacharacters) of a tool whose result is among
   * the trailing tool results (the tool messages after the last assistant message).
   */
  lastTool: z.string().optional(),
  /** Regex tested against the content of a trailing tool result (of `lastTool` when given). */
  lastToolResult: z.string().optional(),
  /** Number of assistant messages since the last user message (0 = first reply to the user). */
  turn: z.number().int().min(0).optional(),
  /** Regex tested against the requested model id. */
  model: z.string().optional(),
  /** Regex that must match the name of at least one tool declared in the request. */
  hasTool: z.string().optional(),
});
export type MatchSpec = z.infer<typeof MatchSpec>;

export const RuleSpec = z.object({
  id: z.string().optional(),
  when: MatchSpec.default({}),
  reply: ReplySpec,
  /** Maximum number of times this rule may fire (unlimited by default). */
  times: z.number().int().min(1).optional(),
});
export type RuleSpec = z.infer<typeof RuleSpec>;

export const ScenarioSpec = z.object({
  name: z.string().default('custom'),
  rules: z.array(RuleSpec).default([]),
  fallback: ReplySpec.optional(),
});
export type Scenario = z.infer<typeof ScenarioSpec>;
export type ScenarioInput = z.input<typeof ScenarioSpec>;

// ---------------------------------------------------------------------------------------------
// Request analysis
// ---------------------------------------------------------------------------------------------

/** Subset of the OpenAI chat-completions request we look at. */
export interface ChatRequest {
  model?: string;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  messages?: ChatMessage[];
  tools?: { type?: string; function?: { name?: string } }[];
}

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface ToolResultInfo {
  toolCallId?: string;
  name?: string;
  content: string;
}

export interface RequestFacts {
  model: string;
  lastUser: string;
  turn: number;
  /** Tool results after the last assistant message, in order. */
  trailingToolResults: ToolResultInfo[];
  declaredTools: string[];
}

const IMAGE_FOLLOW_UP = /^Attached image\(s\) from tool result/i;

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function analyzeRequest(request: ChatRequest): RequestFacts {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call.id && call.function?.name) toolNames.set(call.id, call.function.name);
    }
  }

  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'user' && !IMAGE_FOLLOW_UP.test(contentText(message.content))) {
      lastUserIndex = i;
      break;
    }
  }
  const lastUser = lastUserIndex >= 0 ? contentText(messages[lastUserIndex]?.content) : '';
  const turn = messages.slice(lastUserIndex + 1).filter((m) => m.role === 'assistant').length;

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistantIndex = i;
      break;
    }
  }
  const trailingToolResults: ToolResultInfo[] =
    lastAssistantIndex > lastUserIndex
      ? messages
          .slice(lastAssistantIndex + 1)
          .filter((m) => m.role === 'tool')
          .map((m) => ({
            toolCallId: m.tool_call_id,
            name: m.name ?? (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined),
            content: contentText(m.content),
          }))
      : [];

  const declaredTools = (request.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === 'string');

  return {
    model: request.model ?? '',
    lastUser,
    turn,
    trailingToolResults,
    declaredTools,
  };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

export type Captures = Record<string, string>;

function regex(source: string): RegExp {
  return new RegExp(source, 'i');
}

const REGEX_META = /[\\^$.*+?()[\]{}|]/;

function nameMatches(pattern: string, name: string | undefined): boolean {
  if (!name) return false;
  return REGEX_META.test(pattern) ? regex(`^(?:${pattern})$`).test(name) : pattern === name;
}

/** Returns the captured variables when the rule matches, or null. */
export function matchRule(when: MatchSpec, facts: RequestFacts): Captures | null {
  const captures: Captures = {};
  const addGroups = (match: RegExpExecArray | null) => {
    if (!match?.groups) return;
    for (const [key, value] of Object.entries(match.groups)) {
      if (value !== undefined) captures[key] = value;
    }
  };

  if (when.turn !== undefined && when.turn !== facts.turn) return null;
  if (when.model !== undefined && !regex(when.model).test(facts.model)) return null;
  if (when.hasTool !== undefined) {
    const re = regex(when.hasTool);
    if (!facts.declaredTools.some((name) => re.test(name))) return null;
  }
  if (when.lastUser !== undefined) {
    const match = regex(when.lastUser).exec(facts.lastUser);
    if (!match) return null;
    addGroups(match);
  }
  if (when.lastTool !== undefined || when.lastToolResult !== undefined) {
    const candidates = facts.trailingToolResults.filter(
      (result) => when.lastTool === undefined || nameMatches(when.lastTool, result.name),
    );
    if (candidates.length === 0) return null;
    if (when.lastToolResult !== undefined) {
      const re = regex(when.lastToolResult);
      let found: RegExpExecArray | null = null;
      for (const candidate of candidates) {
        found = re.exec(candidate.content);
        if (found) break;
      }
      if (!found) return null;
      addGroups(found);
    }
  }
  return captures;
}

// ---------------------------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------------------------

export function renderTemplate(template: string, vars: Captures): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? '') : '',
  );
}

export function renderValue(value: unknown, vars: Captures): unknown {
  if (typeof value === 'string') return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((item) => renderValue(item, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, renderValue(v, vars)]),
    );
  }
  return value;
}

export function parseScenario(input: unknown): Scenario {
  return ScenarioSpec.parse(input);
}
