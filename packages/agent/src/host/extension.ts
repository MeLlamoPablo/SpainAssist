import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from '../tools/common';
import { type IdleCompactionOptions, registerIdleCompaction } from './idle-compaction';
import { redactOldPages } from './redaction';

export interface SpainAssistExtensionOptions {
  tools: AnyToolDefinition[];
  /** Evaluated on every turn (today's date changes). */
  systemPrompt: () => string;
  /** Headers (lower-case names) of each LLM provider response, before its body is read. */
  onProviderResponse?: (headers: Record<string, string>) => void;
  /** Send the session id as OpenAI's `prompt_cache_key` (see `needsPromptCacheKey`). */
  promptCacheKey?: boolean;
  /** Redact old page results before each LLM call (see redaction.ts). */
  redactPages?: boolean;
  /** Compact while idle, before the prompt cache expires, with a summary read from the cache. */
  idleCompaction?: IdleCompactionOptions;
}

/**
 * The inline pi extension: our tools, the exact system prompt, and defense in
 * depth against anything that is not one of our tools (pi's shell RPC command, unknown tools).
 */
export function createSpainAssistExtension(options: SpainAssistExtensionOptions): ExtensionFactory {
  const allowed = new Set(options.tools.map((tool) => tool.name));
  return (pi: ExtensionAPI) => {
    for (const tool of options.tools) pi.registerTool(tool);

    // Replace the whole prompt (pi otherwise appends a <cwd> section that leaks local paths).
    pi.on('before_agent_start', () => ({ systemPrompt: options.systemPrompt() }));

    if (options.redactPages) {
      pi.on('context', (event) => ({ messages: redactOldPages(event.messages) }));
    }

    if (options.promptCacheKey) {
      pi.on('before_provider_request', (event, ctx) =>
        withPromptCacheKey(event.payload, ctx.sessionManager.getSessionId()),
      );
    }

    if (options.idleCompaction) registerIdleCompaction(pi, options.idleCompaction);

    const { onProviderResponse } = options;
    if (onProviderResponse)
      pi.on('after_provider_response', (event) => onProviderResponse(event.headers));

    // pi's RPC `bash` command runs a shell even with no tools: never let it execute.
    pi.on('user_bash', () => ({
      result: {
        output: 'Shell commands are disabled in Spain Assist.',
        exitCode: 1,
        cancelled: true,
        truncated: false,
      },
    }));

    pi.on('tool_call', (event) =>
      allowed.has(event.toolName)
        ? undefined
        : { block: true, reason: `Tool "${event.toolName}" is not available.` },
    );
  };
}

/** OpenAI's limit for `prompt_cache_key`. */
const PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** `payload` with `prompt_cache_key` set to `sessionId`, unless it already has one. */
export function withPromptCacheKey(payload: unknown, sessionId: string): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  if ('prompt_cache_key' in payload && payload.prompt_cache_key) return undefined;
  return { ...payload, prompt_cache_key: sessionId.slice(0, PROMPT_CACHE_KEY_MAX_LENGTH) };
}
