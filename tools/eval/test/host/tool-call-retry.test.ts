import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  MAX_TOOL_CALL_RETRIES,
  TOOL_CALL_RETRY_MESSAGE_TYPE,
  toolCallRetry,
  writtenToolCall,
} from '../../src/host/tool-call-retry';

const TOOLS = ['codemode', 'agent_start'];

// Two of the replies Inkling 2 Mini gave on 2026-11-23, shortened: neither is valid JSON.
/** The body ends in the middle of a string. */
const CUT_CALL =
  '{"name":"codemode","args":{"source":"export async function main(api) {\\n  const labels = [...document.querySelectorAll(\\"label';
/** The body is complete, but the quote that closes `source` is escaped. */
const BROKEN_CALL =
  '{"name":"codemode","args":{"source":"export async function main(api) {\\n  return 1;\\n}\\n\\",\\"title\\":\\"datos compra coche\\"}}';
const REPORT = 'He descargado el informe de vida laboral y lo he guardado en tus documentos.';

describe('writtenToolCall', () => {
  it('names the tool of a call that was cut and of one whose JSON is broken', () => {
    expect(writtenToolCall(CUT_CALL, TOOLS)).toBe('codemode');
    expect(writtenToolCall(BROKEN_CALL, TOOLS)).toBe('codemode');
  });

  it('reads the "arguments" spelling and leading white space', () => {
    expect(writtenToolCall('\n {"name": "agent_start", "arguments": {"brief": "x"}}', TOOLS)).toBe(
      'agent_start',
    );
  });

  it('finds no call in a report, even one that quotes a call', () => {
    expect(writtenToolCall(REPORT, TOOLS)).toBeUndefined();
    expect(writtenToolCall(`No pude ejecutar ${CUT_CALL}`, TOOLS)).toBeUndefined();
  });

  it('finds no call in JSON that names no tool of the agent', () => {
    expect(writtenToolCall('{"name":"bash","args":{"command":"ls"}}', TOOLS)).toBeUndefined();
    expect(writtenToolCall('{"name":"codemode"}', TOOLS)).toBeUndefined();
    expect(writtenToolCall('{"matricula":"1234ABC","name":"codemode"}', TOOLS)).toBeUndefined();
  });
});

type Handler = (event: unknown) => unknown;

/** A host with the retry loaded: what pi would call, and what the retry logged. */
function hostWithRetry() {
  const handlers = new Map<string, Handler>();
  const warnings: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getActiveTools: () => TOOLS,
  } as unknown as ExtensionAPI;
  toolCallRetry((message) => warnings.push(message))(pi);
  const turnEnd = (content: unknown[], stopReason = 'stop') =>
    handlers.get('turn_end')?.({
      type: 'turn_end',
      message: { role: 'assistant', stopReason, content },
      entries: [{ type: 'custom_message', customType: 'earlier' }],
    });
  return {
    warnings,
    newPrompt: () => handlers.get('before_agent_start')?.({}),
    replyWithText: (text: string, stopReason?: string) =>
      turnEnd(
        [
          { type: 'thinking', thinking: 'Let me do that.' },
          { type: 'text', text },
        ],
        stopReason,
      ),
    replyWithToolCall: () => turnEnd([{ type: 'toolCall', name: 'codemode', arguments: {} }]),
  };
}

const ASKED_AGAIN = {
  entries: [
    { type: 'custom_message', customType: 'earlier' },
    { type: 'custom_message', customType: TOOL_CALL_RETRY_MESSAGE_TYPE, display: false },
  ],
  continue: true,
};

describe('toolCallRetry', () => {
  it('has the model send a call again when it wrote it as text, after the entries of the turn', () => {
    const host = hostWithRetry();
    expect(host.replyWithText(CUT_CALL)).toMatchObject(ASKED_AGAIN);
    expect(host.warnings).toEqual([
      'the reply is a codemode call written as text: asking the model to send it again',
    ]);
  });

  it('leaves a report and a real tool call as they are', () => {
    const host = hostWithRetry();
    expect(host.replyWithText(REPORT)).toBeUndefined();
    expect(host.replyWithToolCall()).toBeUndefined();
    expect(host.warnings).toEqual([]);
  });

  it('leaves a reply that hit the output limit to pi', () => {
    const host = hostWithRetry();
    expect(host.replyWithText(CUT_CALL, 'length')).toBeUndefined();
  });

  it('gives up after two retries in a row, and says so', () => {
    const host = hostWithRetry();
    for (let retry = 0; retry < MAX_TOOL_CALL_RETRIES; retry++) {
      expect(host.replyWithText(BROKEN_CALL)).toMatchObject(ASKED_AGAIN);
    }
    expect(host.replyWithText(BROKEN_CALL)).toBeUndefined();
    expect(host.warnings.at(-1)).toBe(
      'the reply is again a codemode call written as text: no more retries',
    );
  });

  it('counts from zero again after a real tool call, and on a new prompt', () => {
    const host = hostWithRetry();
    const useUpTheRetries = () => {
      for (let retry = 0; retry < MAX_TOOL_CALL_RETRIES; retry++) host.replyWithText(CUT_CALL);
    };

    useUpTheRetries();
    host.replyWithToolCall();
    expect(host.replyWithText(CUT_CALL)).toMatchObject(ASKED_AGAIN);

    useUpTheRetries();
    host.newPrompt();
    expect(host.replyWithText(CUT_CALL)).toMatchObject(ASKED_AGAIN);
  });
});
