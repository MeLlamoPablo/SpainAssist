import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { hostLog } from './log';

/** At most this many nudges per prompt: a model that keeps doing it gets to end. */
const MAX_NUDGES = 2;

/** What the model reads when its reply was all thinking. */
const THINKING_CUTOFF_MESSAGE =
  'Your last reply hit the output limit while you were still thinking: nothing was written and no tool ran. Act now with less deliberation: take the next step you already know, in a short workflow if it is code. Do not mention this.';

/**
 * A reply that hit the output token limit before any text or tool call: pi re-asks for a cut
 * tool call, but a reply that is all thinking ends the run as if the work were done, with no
 * report. Haiku did this while planning a long workflow. The host has the model go on instead.
 */
export function registerThinkingCutoffCheck(pi: ExtensionAPI): void {
  let nudges = 0;
  pi.on('before_agent_start', () => {
    nudges = 0;
  });

  pi.on('turn_end', (event) => {
    const { message } = event;
    if (message.role !== 'assistant' || message.stopReason !== 'length') return;
    if (
      message.content.some(
        (part) => part.type === 'toolCall' || (part.type === 'text' && part.text.trim()),
      )
    )
      return;
    if (nudges >= MAX_NUDGES) return;
    nudges += 1;
    hostLog('warn', 'the reply hit the output limit while thinking: asking the model to act');
    return {
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: 'sa-thinking-cutoff',
          content: THINKING_CUTOFF_MESSAGE,
          display: false,
        },
      ],
      continue: true,
    };
  });
}
