import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRuntime,
  SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import { hostLog } from './log';

type StreamOptions = NonNullable<Parameters<ModelRuntime['streamSimple']>[2]>;

/**
 * Smallest context worth compacting while idle (tokens). Compaction keeps the latest 20k tokens
 * verbatim (pi's keepRecentTokens), so smaller contexts would barely shrink.
 */
export const IDLE_COMPACTION_MIN_TOKENS = 50_000;

/** One model request of the agent's own turns, exactly as sent, and its response once done. */
export interface SessionRequest {
  model: Model<Api>;
  context: Context;
  options: StreamOptions;
  sentAt: number;
  response?: AssistantMessage;
}

/**
 * Records the latest request of the session's turns (pi's agent sends them through
 * `runtime.streamSimple` with the session id; compaction and other one-off requests use their
 * own ids). Replaying that request with more messages at the end reuses its prompt cache entry.
 */
export class SessionRequests {
  private latest?: SessionRequest;
  private readonly send: ModelRuntime['streamSimple'];

  constructor(runtime: ModelRuntime, sessionId: () => string) {
    const send = runtime.streamSimple.bind(runtime);
    this.send = send;
    runtime.streamSimple = (model, context, options) => {
      const sentAt = Date.now();
      const stream = send(model, context, options);
      if (options?.sessionId !== undefined && options.sessionId === sessionId()) {
        const request: SessionRequest = { model, context, options, sentAt };
        this.latest = request;
        stream.result().then(
          (response) => {
            request.response = response;
          },
          () => {},
        );
      }
      return stream;
    };
  }

  get last(): SessionRequest | undefined {
    return this.latest;
  }

  clear(): void {
    this.latest = undefined;
  }

  /** Sends `request` again with `messages` appended. Not recorded as a session request. */
  extend(request: SessionRequest, messages: Message[], signal: AbortSignal) {
    const context = { ...request.context, messages: [...request.context.messages, ...messages] };
    return this.send(request.model, context, { ...request.options, signal }).result();
  }
}

/**
 * How long the provider keeps the prompt cache entry `request` wrote. Undefined when it does not
 * cache or the model declares no lifetime (`promptCache`): idle compaction is then off.
 */
function cacheTtlMs(request: SessionRequest): number | undefined {
  const retention =
    request.options.cacheRetention ??
    (process.env.PI_CACHE_RETENTION === 'long' ? 'long' : 'short');
  if (retention === 'none') return undefined;
  const seconds = request.model.promptCache?.[retention];
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Act at 90% of the lifetime, keeping at least ten seconds of margin (as pi's cache warmer). */
function beforeExpiryMs(ttlMs: number): number {
  return Math.min(ttlMs * 0.9, ttlMs - 10_000);
}

const SUMMARY_REQUEST = `The conversation pauses here. Write a summary that replaces it: work continues later from your summary and the latest messages only. Do not call tools. Reply only with the summary, in English, with these sections:

## Goal
## Constraints & Preferences
## Progress
### Done
### In Progress
### Blocked
## Key Decisions
## Next Steps
## Critical Context

Keep exact names, identifiers, reference numbers, dates, URLs and the user's answers. Leave out page snapshots and anything already done that no longer matters.`;

export interface IdleCompactionOptions {
  requests: SessionRequests;
  /** Compact only contexts at least this large (tokens). */
  minTokens: number;
  /** Override of the cache lifetime (tests). */
  cacheTtlMs?: number;
}

/**
 * Compaction while the user is away: when a run settles, a timer fires just before the prompt
 * cache of its last request expires. If the agent is still idle and its context is large, it
 * compacts then, so the user's next message sends a short context instead of rewriting the
 * whole one to the cache. Every compaction whose transcript still ends with the last recorded
 * response asks for its summary by extending that request, so the summary reads the cached
 * prompt instead of sending the conversation again (pi's own summarizer cannot use the cache).
 */
export function registerIdleCompaction(pi: ExtensionAPI, options: IdleCompactionOptions): void {
  const { requests } = options;
  let timer: NodeJS.Timeout | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const compactIfLarge = (ctx: ExtensionContext) => {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    const tokens = ctx.getContextUsage()?.tokens;
    if (tokens == null || tokens < options.minTokens) return;
    hostLog('info', `idle compaction of ${tokens} tokens before the prompt cache expires`);
    ctx.compact({
      onError: (error) => hostLog('warn', `idle compaction failed: ${error.message}`),
    });
  };

  pi.on('agent_start', cancel);
  pi.on('input', () => {
    cancel();
  });
  pi.on('session_shutdown', cancel);
  pi.on('model_select', () => {
    cancel();
    requests.clear();
  });
  pi.on('session_compact', () => {
    cancel();
    requests.clear();
  });

  pi.on('agent_settled', (event, ctx) => {
    cancel();
    const request = requests.last;
    if (event.aborted || !request) return;
    const ttl = options.cacheTtlMs ?? cacheTtlMs(request);
    if (ttl === undefined) return;
    const delay = request.sentAt + beforeExpiryMs(ttl) - Date.now();
    if (delay <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      compactIfLarge(ctx);
    }, delay);
    timer.unref();
  });

  pi.on(
    'session_before_compact',
    async (event, ctx): Promise<SessionBeforeCompactResult | undefined> => {
      // An overflowing request cannot be extended; pi's summarizer handles it.
      if (event.reason === 'overflow') return undefined;
      const request = requests.last;
      const response = request?.response;
      if (!request || response?.stopReason !== 'stop') return undefined;
      if (ctx.model?.provider !== request.model.provider || ctx.model.id !== request.model.id) {
        return undefined;
      }
      // The summary request extends the recorded one: the transcript must still end there.
      const last = event.branchEntries.findLast((entry) => entry.type === 'message');
      if (
        last?.type !== 'message' ||
        last.message.role !== 'assistant' ||
        last.message.timestamp !== response.timestamp
      ) {
        return undefined;
      }
      const instructions = event.customInstructions
        ? `${SUMMARY_REQUEST}\n\nAlso: ${event.customInstructions}`
        : SUMMARY_REQUEST;
      try {
        const reply = await requests.extend(
          request,
          [response, { role: 'user', content: instructions, timestamp: Date.now() }],
          event.signal,
        );
        if (event.signal.aborted) return { cancel: true };
        const summary = reply.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .trim();
        if (reply.stopReason !== 'stop' || !summary) {
          hostLog('warn', `cached summary unusable (${reply.stopReason}); using pi's summarizer`);
          return undefined;
        }
        const { usage } = reply;
        hostLog(
          'info',
          `compaction summary: ${usage.cacheRead} of ${usage.input + usage.cacheRead + usage.cacheWrite} prompt tokens from the cache`,
        );
        return {
          compaction: {
            summary,
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            usage,
          },
        };
      } catch (error) {
        if (event.signal.aborted) return { cancel: true };
        hostLog('warn', `cached summary failed: ${String(error)}; using pi's summarizer`);
        return undefined;
      }
    },
  );
}
