import type { AgentToolResult, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { BridgeMethod, BridgeParamsOf, BridgeResults } from '@sa/shared';
import { type TSchema, type TUnsafe, Type } from 'typebox';
import { BridgeError, type BridgeTransport } from '../bridge/client';

// biome-ignore lint/suspicious/noExplicitAny: same erasure pi uses for heterogeneous tool lists
export type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Identity helper that keeps parameter inference and erases the type for tool lists. */
export function defineSaTool<P extends TSchema, D>(tool: ToolDefinition<P, D>): AnyToolDefinition {
  return tool as AnyToolDefinition;
}

/** String enum as `{type:"string", enum:[...]}` (works with every provider, unlike anyOf/const). */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  options: { description?: string; default?: T[number] } = {},
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    ...(options.description ? { description: options.description } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  });
}

export type ToolResult = AgentToolResult<unknown>;

export function textResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details };
}

export function errorResult(text: string, details?: unknown): ToolResult {
  return { content: [{ type: 'text', text }], details, isError: true };
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof BridgeError) return error.code === 'aborted';
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'CanceledError');
}

/** Model-facing explanation of a bridge failure. */
function bridgeErrorText(error: unknown): string {
  if (!(error instanceof BridgeError)) {
    return `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const message = error.message.trim();
  switch (error.code) {
    case 'user_rejected':
      return `The user declined${message && message !== 'Cancelled' ? ` (${message})` : ''}. Do not retry the same action; ask the user how they want to continue.`;
    case 'policy_denied':
      return `Blocked by the app's safety policy: ${message}. Do not try to work around it (credentials and certificates only work on the sites allowed for them): only follow the steps this message gives, if any. If this blocks the procedure, tell the user.`;
    case 'not_found':
      return `Not found: ${message}.`;
    case 'browser_error':
      return `Browser error: ${message}. Call browser_snapshot to see the current page before trying again.`;
    case 'unavailable':
      return `Service unavailable: ${message}. Try again later or continue without it.`;
    case 'bad_request':
      return `Invalid request: ${message}. Fix the arguments and try again.`;
    case 'unauthorized':
      return `The app rejected this request (${message}). This is an internal error; if it persists, tell the user to restart the procedure.`;
    case 'timeout':
      return 'The app did not answer in time. Try again in a moment.';
    case 'network':
      return `Could not reach the Spain Assist app (${message}).`;
    case 'aborted':
      return 'Cancelled.';
    default:
      return `App error: ${message}`;
  }
}

/**
 * Calls a bridge method and renders the result. Bridge failures become error results with a
 * helpful message for the model; aborts propagate so pi can stop the run.
 */
export async function callBridge<M extends BridgeMethod>(
  bridge: BridgeTransport,
  method: M,
  params: BridgeParamsOf<M>,
  signal: AbortSignal | undefined,
  render: (result: BridgeResults[M]) => ToolResult | Promise<ToolResult>,
): Promise<ToolResult> {
  let result: BridgeResults[M];
  try {
    result = await bridge.call(method, params, { signal });
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    return errorResult(bridgeErrorText(error), {
      error: error instanceof BridgeError ? error.code : 'internal',
    });
  }
  return render(result);
}

/** Collapse whitespace and cut to `max` characters with an ellipsis. */
export function clip(text: string | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…` : flat;
}

/** Remove keys whose value is undefined (zod `.optional()` rejects explicit nulls elsewhere). */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** True for an absolute http(s) URL. */
export function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
