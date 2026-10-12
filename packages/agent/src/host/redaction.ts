import type { ContextEvent } from '@earendil-works/pi-coding-agent';
import { redactSnapshot } from '../tools/browser';

type AgentMessage = ContextEvent['messages'][number];

const SCREENSHOT_REMOVED = 'Screenshot removed: this page is no longer current.';

/**
 * Models (`model.id`) whose old pages are redacted. Opt-in: weaker models forget what they read
 * once a snapshot is gone and loop re-opening the same elements (claude-haiku-5.5 did), so for now
 * no model is redacted and every page result stays in the context.
 */
const REDACTED_MODELS: ReadonlySet<string> = new Set<string>([]);

export function redactsPages(modelId: string): boolean {
  return REDACTED_MODELS.has(modelId);
}

/**
 * Redaction (only for `redactsPages` models): before each LLM call, the model sees every page result (`details.page`) since its
 * latest page snapshot. Older ones lose their snapshot and screenshots: they are most of a
 * procedure's context and show pages that are no longer current, with stale refs. A screenshot
 * (a page result with an image) never replaces the snapshot, so the latest refs always stay.
 * Only the sent copy changes (the session keeps everything), and a result is redacted the same
 * way on every call, so all but the newest messages remain a cached prompt prefix.
 */
export function redactOldPages(messages: AgentMessage[]): AgentMessage[] {
  const latestSnapshot = messages.findLastIndex((message) => isPage(message) && !hasImage(message));
  if (!messages.some((message, index) => index < latestSnapshot && isPage(message))) {
    return messages;
  }
  return messages.map((message, index) => {
    if (index >= latestSnapshot || !isPage(message) || message.role !== 'toolResult') {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'text'
          ? { ...part, text: redactSnapshot(part.text) }
          : { type: 'text' as const, text: SCREENSHOT_REMOVED },
      ),
    };
  });
}

function isPage(message: AgentMessage): boolean {
  if (message.role !== 'toolResult') return false;
  const details = message.details as { page?: unknown } | undefined;
  return details?.page === true;
}

function hasImage(message: AgentMessage): boolean {
  return message.role === 'toolResult' && message.content.some((part) => part.type === 'image');
}
