import { z } from 'zod';

/**
 * Scripted scenarios for the mock LLM.
 *
 * A scenario is an ordered list of rules. For every chat completion request the first rule whose
 * `when` conditions all hold produces the reply; if none matches, `fallback` is used. Regexes are
 * JavaScript regex sources, matched case-insensitively. Named capture groups (e.g.
 * `(?<resultId>[a-z0-9-]+)`) become template variables usable as `{{resultId}}` in the reply text and
 * in string values of tool-call arguments (`{{name|untag}}` decodes Unicode tag characters). Built-in
 * variables: `{{lastUser}}`, `{{turn}}`, `{{date}}` (YYYY-MM-DD).
 *
 * Deeper matching (all optional, all backward compatible): `systemPrompt` tells the assistant,
 * the procedure agents, the answerer and the research model apart; `toolCalled` looks at the
 * whole history (which tool was called, with which arguments, with which result, how many
 * times) and its named groups feed the templates like any other capture; `hasImage`,
 * `lastToolResultNot`, `anyOf` and `not` combine conditions; `state` and a rule's `set` make
 * multi-step scripts without brittle regexes (the state is shared by every request of the
 * scenario and cleared by `reset()` and `setScenario()`).
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
      /** `error.type` (default "mock_error"), e.g. "usage_limit_reached" for the Codex shape. */
      type: z.string().optional(),
      /** More fields of the `error` object (e.g. `plan_type`, `resets_at`). */
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /** Extra response headers (e.g. `x-codex-primary-used-percent`). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Wait before sending the first byte (e.g. to test aborts). */
  delayMs: z.number().int().min(0).max(600_000).optional(),
  /** Delay between streamed chunks (overrides the server default). */
  chunkDelayMs: z.number().int().min(0).max(10_000).optional(),
  /** Override reported usage; whatever is left out is estimated (or derived from the LiteLLM options). */
  usage: z
    .object({
      promptTokens: z.number().int().min(0).optional(),
      completionTokens: z.number().int().min(0).optional(),
      /** Prompt tokens read from the provider's cache. */
      cachedTokens: z.number().int().min(0).optional(),
      /** Prompt tokens written to the provider's cache. */
      cacheWriteTokens: z.number().int().min(0).optional(),
      /** Completion tokens spent on reasoning. */
      reasoningTokens: z.number().int().min(0).optional(),
      /** The cost the gateway reports for this call (`x-litellm-response-cost`), in USD. */
      costUsd: z.number().min(0).optional(),
    })
    .optional(),
});
export type ReplySpec = z.infer<typeof ReplySpec>;

const StateValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type StateValue = z.infer<typeof StateValue>;
/** Scenario state: `null` means "not set" in a `when.state` match and deletes a key in `set`. */
export type ScenarioState = Record<string, string | number | boolean>;

export const ToolCalledSpec = z.object({
  /** Exact name (or regex when it contains regex metacharacters) of the tool. */
  name: z.string(),
  /** Regex tested against the call's arguments (the raw JSON text). */
  args: z.string().optional(),
  /** Regex tested against the call's result text (a call without a result fails it). */
  result: z.string().optional(),
  /** Minimum number of such calls in the conversation (default 1, or 0 when `atMost` is given). */
  atLeast: z.number().int().min(0).optional(),
  /** Maximum number of such calls (`0`: the tool was never called that way). */
  atMost: z.number().int().min(0).optional(),
});
export type ToolCalledSpec = z.infer<typeof ToolCalledSpec>;

interface MatchFields {
  /** Regex tested against the text of the last user message. */
  lastUser?: string | undefined;
  /** Regex tested against the system prompt (system and developer messages, or `instructions`). */
  systemPrompt?: string | undefined;
  /**
   * Exact name (or regex when it contains regex metacharacters) of a tool whose result is among
   * the trailing tool results (the tool messages after the last assistant message).
   */
  lastTool?: string | undefined;
  /** Regex tested against the content of a trailing tool result (of `lastTool` when given). */
  lastToolResult?: string | undefined;
  /** Regex that must match none of the trailing tool results. */
  lastToolResultNot?: string | undefined;
  /** History: tool calls anywhere in the conversation. All listed conditions must hold. */
  toolCalled?: ToolCalledSpec | ToolCalledSpec[] | undefined;
  /** Whether the request carries an image (a screenshot) anywhere. */
  hasImage?: boolean | undefined;
  /** Number of assistant messages since the last user message (0 = first reply to the user). */
  turn?: number | undefined;
  /** Regex tested against the requested model id. */
  model?: string | undefined;
  /** Regex that must match the name of at least one tool declared in the request. */
  hasTool?: string | undefined;
  /** Scenario state that must hold (`null` = the key is not set). */
  state?: Record<string, StateValue> | undefined;
}

export interface MatchSpec extends MatchFields {
  /** At least one of these must match (the first match's captures are used). */
  anyOf?: MatchSpec[] | undefined;
  /** This must not match. */
  not?: MatchSpec | undefined;
}

export const MatchSpec: z.ZodType<MatchSpec> = z.lazy(() =>
  z.object({
    lastUser: z.string().optional(),
    systemPrompt: z.string().optional(),
    lastTool: z.string().optional(),
    lastToolResult: z.string().optional(),
    lastToolResultNot: z.string().optional(),
    toolCalled: z.union([ToolCalledSpec, z.array(ToolCalledSpec)]).optional(),
    hasImage: z.boolean().optional(),
    turn: z.number().int().min(0).optional(),
    model: z.string().optional(),
    hasTool: z.string().optional(),
    state: z.record(z.string(), StateValue).optional(),
    anyOf: z.array(MatchSpec).min(1).optional(),
    not: MatchSpec.optional(),
  }),
);

export const RuleSpec = z.object({
  id: z.string().optional(),
  when: MatchSpec.default({}),
  reply: ReplySpec,
  /** Maximum number of times this rule may fire (unlimited by default). */
  times: z.number().int().min(1).optional(),
  /** State changes applied when the rule fires (`null` deletes a key). */
  set: z.record(z.string(), StateValue).optional(),
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

/** One tool call of the conversation and its result, when the request carries it. */
export interface CallInfo {
  id?: string;
  name: string;
  /** The raw JSON text of the arguments. */
  args: string;
  result?: string;
}

export interface RequestFacts {
  model: string;
  lastUser: string;
  /** System and developer messages (or `instructions`), joined. */
  systemPrompt: string;
  turn: number;
  /** Tool results after the last assistant message, in order. */
  trailingToolResults: ToolResultInfo[];
  /** Every tool call of the conversation, oldest first. */
  calls: CallInfo[];
  /** Image parts (screenshots) anywhere in the conversation. */
  imageCount: number;
  declaredTools: string[];
}

/** The reply a rule produced, with its templates filled in. */
export interface RenderedReply {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; arguments: string }[];
  finishReason: string;
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

function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(
    (part) =>
      part &&
      typeof part === 'object' &&
      ((part as { type?: unknown }).type === 'image_url' ||
        (part as { type?: unknown }).type === 'input_image' ||
        (part as { type?: unknown }).type === 'image'),
  ).length;
}

export function analyzeRequest(request: ChatRequest): RequestFacts {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const toolNames = new Map<string, string>();
  const calls: CallInfo[] = [];
  const callById = new Map<string, CallInfo>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      if (call.id && call.function?.name) toolNames.set(call.id, call.function.name);
      if (!call.function?.name) continue;
      const info: CallInfo = {
        ...(call.id ? { id: call.id } : {}),
        name: call.function.name,
        args: call.function.arguments ?? '',
      };
      calls.push(info);
      if (call.id) callById.set(call.id, info);
    }
  }
  for (const message of messages) {
    if (message.role !== 'tool' || !message.tool_call_id) continue;
    const call = callById.get(message.tool_call_id);
    if (call) call.result = contentText(message.content);
  }
  const imageCount = messages.reduce((sum, message) => sum + countImages(message.content), 0);
  const systemPrompt = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => contentText(message.content))
    .join('\n');

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
    systemPrompt,
    turn,
    trailingToolResults,
    calls,
    imageCount,
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

function stateHolds(expected: Record<string, StateValue>, state: ScenarioState): boolean {
  return Object.entries(expected).every(([key, value]) =>
    value === null ? !Object.hasOwn(state, key) : state[key] === value,
  );
}

/** Applies a rule's `set` to the scenario state (`null` deletes a key). */
export function applyStateChange(state: ScenarioState, set: Record<string, StateValue>): void {
  for (const [key, value] of Object.entries(set)) {
    if (value === null) delete state[key];
    else state[key] = value;
  }
}

/** Returns the captured variables when the rule matches, or null. */
export function matchRule(
  when: MatchSpec,
  facts: RequestFacts,
  state: ScenarioState = {},
): Captures | null {
  const captures: Captures = {};
  const addGroups = (match: RegExpExecArray | null) => {
    if (!match?.groups) return;
    for (const [key, value] of Object.entries(match.groups)) {
      if (value !== undefined) captures[key] = value;
    }
  };

  if (when.turn !== undefined && when.turn !== facts.turn) return null;
  if (when.model !== undefined && !regex(when.model).test(facts.model)) return null;
  if (when.hasImage !== undefined && when.hasImage !== facts.imageCount > 0) return null;
  if (when.state !== undefined && !stateHolds(when.state, state)) return null;
  if (when.hasTool !== undefined) {
    const re = regex(when.hasTool);
    if (!facts.declaredTools.some((name) => re.test(name))) return null;
  }
  if (when.systemPrompt !== undefined) {
    const match = regex(when.systemPrompt).exec(facts.systemPrompt);
    if (!match) return null;
    addGroups(match);
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
  if (when.lastToolResultNot !== undefined) {
    const re = regex(when.lastToolResultNot);
    if (facts.trailingToolResults.some((result) => re.test(result.content))) return null;
  }
  if (when.toolCalled !== undefined) {
    const specs = Array.isArray(when.toolCalled) ? when.toolCalled : [when.toolCalled];
    for (const spec of specs) {
      const argsRe = spec.args !== undefined ? regex(spec.args) : undefined;
      const resultRe = spec.result !== undefined ? regex(spec.result) : undefined;
      const hits: { args?: RegExpExecArray | null; result?: RegExpExecArray | null }[] = [];
      for (const call of facts.calls) {
        if (!nameMatches(spec.name, call.name)) continue;
        const argsMatch = argsRe ? argsRe.exec(call.args) : null;
        if (argsRe && !argsMatch) continue;
        const resultMatch = resultRe ? resultRe.exec(call.result ?? '') : null;
        if (resultRe && !resultMatch) continue;
        hits.push({ args: argsMatch, result: resultMatch });
      }
      const atMost = spec.atMost;
      const atLeast = spec.atLeast ?? (atMost !== undefined ? 0 : 1);
      if (hits.length < atLeast || (atMost !== undefined && hits.length > atMost)) return null;
      // History captures come from the most recent matching call.
      const last = hits.at(-1);
      if (last) {
        addGroups(last.args ?? null);
        addGroups(last.result ?? null);
      }
    }
  }
  if (when.not !== undefined && matchRule(when.not, facts, state) !== null) return null;
  if (when.anyOf !== undefined) {
    let matched: Captures | null = null;
    for (const branch of when.anyOf) {
      matched = matchRule(branch, facts, state);
      if (matched) break;
    }
    if (!matched) return null;
    Object.assign(captures, matched);
  }
  return captures;
}

// ---------------------------------------------------------------------------------------------
// Templating
// ---------------------------------------------------------------------------------------------

/**
 * What a template can do to a capture, as `{{name|filter}}`:
 * - `untag`: the ASCII text that Unicode tag characters (U+E0020..U+E007E) stand for, the other characters as they
 *   are. Invisible to a person, readable by a model that decodes them: how a scripted model "reads" smuggled text.
 */
const FILTERS: Record<string, (value: string) => string> = {
  untag: (value) =>
    [...value]
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 0xe0020 && code <= 0xe007e ? String.fromCharCode(code - 0xe0000) : char;
      })
      .join(''),
};

export function renderTemplate(template: string, vars: Captures): string {
  return template.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*([A-Za-z_][A-Za-z0-9_]*)\s*)?\}\}/g,
    (_m, key: string, filter: string | undefined) => {
      const value = Object.hasOwn(vars, key) ? (vars[key] ?? '') : '';
      if (filter === undefined) return value;
      const apply = FILTERS[filter];
      if (!apply) throw new Error(`Unknown template filter "${filter}" in {{${key}|${filter}}}`);
      return apply(value);
    },
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
