/**
 * The tool-call retry, an experiment of the eval: off unless a run asks for it
 * (`eval run --retry-tool-calls`), and only in the eval host. The product host does not have it.
 *
 * A local model sometimes breaks a tool call: the JSON of a long call has a wrong escape, or the
 * model writes the call in a text message and stops in the middle (Inkling 2 Mini on MTPLX, 7 of
 * 1,225 calls on 2026-11-23). The server then hands the body over as plain text, pi takes a reply
 * with no tool call as the end of the agent's work, and the app passes the JSON on as the agent's
 * report. This check has the model send the call again instead. No such text can be run as it is:
 * none of the 7 was valid JSON.
 *
 * Everything of the retry is in this file. To remove it: delete the file and what the compiler
 * then names (the `retryToolCalls` option from the CLI to `HostEvalConfig`, the hook in hooks.ts,
 * the note in observers.ts and loop.ts).
 *
 * Only types are imported, so the harness can import the constants without loading a host.
 */
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/** `customType` of the hidden message that asks for the call again: one session entry per retry. */
export const TOOL_CALL_RETRY_MESSAGE_TYPE = 'sa-eval-tool-call-retry';

/** How a retry's note in the event log starts: the run counts them (`tool-call-retries:<n>`). */
export const TOOL_CALL_RETRY_NOTE = 'tool-call-retry';

/** At most this many retries in a row: a model that keeps doing it gets to end. */
export const MAX_TOOL_CALL_RETRIES = 2;

/** What the model reads when its reply was a tool call written as text. */
const TOOL_CALL_RETRY_MESSAGE =
  'Your last reply was a tool call written as plain text, or its JSON was cut or not valid: no tool ran. Send the same call again as a real tool call. If it is long, make it shorter. Do not mention this.';

/** `{"name":"<tool>","args":` (or `"arguments"`), how a model's own tool-call body starts. */
const WRITTEN_TOOL_CALL = /^\s*\{\s*"name"\s*:\s*"([^"]+)"\s*,\s*"(?:args|arguments)"\s*:/;

/** The tool that `text` calls when it is a tool call written as text, else undefined. */
export function writtenToolCall(text: string, tools: readonly string[]): string | undefined {
  const name = WRITTEN_TOOL_CALL.exec(text)?.[1];
  return name !== undefined && tools.includes(name) ? name : undefined;
}

/** The pi extension of the retry (`HostHooks.extension`). `warn` writes to the host's log. */
export function toolCallRetry(warn: (message: string) => void): ExtensionFactory {
  return (pi) => {
    let retries = 0;
    pi.on('before_agent_start', () => {
      retries = 0;
    });

    pi.on('turn_end', (event) => {
      const { message } = event;
      if (message.role !== 'assistant') return;
      if (message.content.some((part) => part.type === 'toolCall')) {
        retries = 0;
        return;
      }
      if (message.stopReason !== 'stop') return;
      const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      const tool = writtenToolCall(text, pi.getActiveTools());
      if (tool === undefined) return;
      if (retries >= MAX_TOOL_CALL_RETRIES) {
        warn(`the reply is again a ${tool} call written as text: no more retries`);
        return;
      }
      retries += 1;
      warn(`the reply is a ${tool} call written as text: asking the model to send it again`);
      return {
        entries: [
          ...event.entries,
          {
            type: 'custom_message',
            customType: TOOL_CALL_RETRY_MESSAGE_TYPE,
            content: TOOL_CALL_RETRY_MESSAGE,
            display: false,
          },
        ],
        continue: true,
      };
    });
  };
}
