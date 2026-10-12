import { describe, expect, it } from 'vitest';
import {
  type AgentEvent,
  classifyAgentError,
  EventNormalizer,
  summarizeToolResult,
} from '../src/rpc/events';
import { JsonlSplitter } from '../src/rpc/jsonl';

describe('JsonlSplitter', () => {
  it('splits on \\n only, across chunk boundaries, keeping U+2028/U+2029 inside records', () => {
    const lines: string[] = [];
    const splitter = new JsonlSplitter((line) => lines.push(line));
    const record = JSON.stringify({ text: 'a b c' });
    splitter.push(`${record.slice(0, 5)}`);
    splitter.push(`${record.slice(5)}\r\n{"x":1}\n\n{"y"`);
    splitter.push(':2}');
    expect(lines).toEqual([record, '{"x":1}']);
    splitter.end();
    expect(lines).toEqual([record, '{"x":1}', '{"y":2}']);
    expect(JSON.parse(lines[0] ?? '').text).toBe('a b c');
  });
});

function feed(normalizer: EventNormalizer, events: Record<string, unknown>[]): AgentEvent[] {
  return events.flatMap((event) => normalizer.push(event));
}

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  role: 'assistant',
  content,
  usage: { input: 100, output: 20, cacheRead: 10, cost: { total: 0.0012 } },
  stopReason: 'stop',
  ...extra,
});

describe('EventNormalizer', () => {
  it('normalizes a run with text, a tool call and usage, skipping system messages', () => {
    const n = new EventNormalizer('t');
    const events = feed(n, [
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_start', message: { role: 'system', content: '' } },
      { type: 'message_end', message: { role: 'system', content: '' } },
      {
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'hola' }] },
      },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Miro ' } },
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'la página.' },
      },
      {
        type: 'message_end',
        message: assistant(
          [
            { type: 'text', text: 'Miro la página.' },
            {
              type: 'toolCall',
              id: 'c1',
              name: 'fetch_url',
              arguments: { url: 'https://example.com/dni' },
            },
          ],
          { stopReason: 'toolUse' },
        ),
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'fetch_url',
        args: { url: 'https://example.com/dni' },
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'fetch_url',
        partialResult: { content: [{ type: 'text', text: 'Reading sources' }] },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'fetch_url',
        result: {
          content: [{ type: 'text', text: '# Renovar el DNI\n\nmore' }],
          details: { url: 'https://example.com/dni' },
        },
        isError: false,
      },
      { type: 'turn_end' },
      { type: 'agent_end', messages: [], willRetry: false },
      { type: 'agent_settled' },
    ]);
    expect(events).toEqual([
      { type: 'run_start' },
      { type: 'assistant_start', messageId: 't-1' },
      { type: 'assistant_delta', messageId: 't-1', delta: 'Miro ' },
      { type: 'assistant_delta', messageId: 't-1', delta: 'la página.' },
      { type: 'usage', inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, costUsd: 0.0012 },
      { type: 'assistant_end', messageId: 't-1', text: 'Miro la página.' },
      {
        type: 'tool_start',
        toolCallId: 'c1',
        tool: 'fetch_url',
        args: { url: 'https://example.com/dni' },
      },
      {
        type: 'tool_update',
        toolCallId: 'c1',
        tool: 'fetch_url',
        summary: 'Reading sources',
      },
      {
        type: 'tool_end',
        toolCallId: 'c1',
        tool: 'fetch_url',
        isError: false,
        summary: '# Renovar el DNI · more',
        details: { url: 'https://example.com/dni' },
      },
      { type: 'run_end' },
    ]);
    expect(n.isRunning).toBe(false);
  });

  it('reports provider errors such as an exhausted voucher (402)', () => {
    const n = new EventNormalizer('e');
    const events = feed(n, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      {
        type: 'message_end',
        message: assistant([], {
          stopReason: 'error',
          errorMessage: '402: {"message":"Key limit exceeded","code":402}',
          usage: undefined,
        }),
      },
      { type: 'turn_end' },
      { type: 'agent_end', willRetry: false },
      { type: 'agent_settled' },
    ]);
    expect(events.at(-2)).toMatchObject({ type: 'assistant_end', errorKind: 'quota' });
    expect(events.at(-1)).toEqual({
      type: 'run_end',
      error: '402: {"message":"Key limit exceeded","code":402}',
      errorKind: 'quota',
    });
  });

  it('marks failed attempts that pi retries and keeps a single run', () => {
    const n = new EventNormalizer('r');
    const events = feed(n, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      {
        type: 'message_end',
        message: assistant([], {
          stopReason: 'error',
          errorMessage: '500: boom',
          usage: undefined,
        }),
      },
      { type: 'turn_end' },
      { type: 'agent_end', willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '500: boom' },
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_end', message: assistant([{ type: 'text', text: 'Hola' }]) },
      { type: 'agent_end', willRetry: false },
      { type: 'auto_retry_end', success: true, attempt: 1 },
      { type: 'agent_settled' },
    ]);
    expect(events.filter((e) => e.type === 'run_start')).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'assistant_end',
      messageId: 'r-1',
      text: '',
      retrying: true,
    });
    expect(events).toContainEqual({ type: 'assistant_end', messageId: 'r-2', text: 'Hola' });
    expect(events.at(-1)).toEqual({ type: 'run_end' });
    expect(events.some((e) => e.type === 'log' && e.level === 'warn')).toBe(true);
  });

  it('reports aborts requested by the client even when no message was streaming', () => {
    const n = new EventNormalizer('a');
    feed(n, [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'c', toolName: 'ask_user', args: {} },
    ]);
    n.markAbortRequested();
    const events = feed(n, [
      {
        type: 'tool_execution_end',
        toolCallId: 'c',
        toolName: 'ask_user',
        result: { content: [] },
        isError: true,
      },
      { type: 'agent_end' },
      { type: 'agent_settled' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'run_end', aborted: true });
  });

  it('closes open messages and runs when the process dies', () => {
    const n = new EventNormalizer('d');
    feed(n, [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hol' } },
    ]);
    expect(n.terminate('The agent process exited unexpectedly')).toEqual([
      {
        type: 'assistant_end',
        messageId: 'd-1',
        text: 'Hol',
        error: 'The agent process exited unexpectedly',
        errorKind: 'crash',
      },
      { type: 'run_end', error: 'The agent process exited unexpectedly', errorKind: 'crash' },
    ]);
  });

  it('classifies common provider errors', () => {
    expect(classifyAgentError('402: Key limit exceeded')).toBe('quota');
    expect(classifyAgentError('429 subscription_sharing_usage_limit_exceeded')).toBe('quota');
    // LiteLLM v1.104 answers 422 when a virtual key has spent its max_budget.
    expect(
      classifyAgentError(
        '422 Budget has been exceeded! Key=sk-...abcd Current cost: 5.01, Max budget: 5.0',
      ),
    ).toBe('quota');
    expect(classifyAgentError('No API key found for the selected model.')).toBe('auth');
    expect(classifyAgentError('401 Unauthorized')).toBe('auth');
    expect(classifyAgentError('429: Rate limit reached')).toBe('rate_limit');
    expect(classifyAgentError('maximum context length is 128000 tokens')).toBe('context');
    expect(classifyAgentError('fetch failed (ECONNREFUSED)')).toBe('network');
    expect(classifyAgentError('503 Service Unavailable')).toBe('provider');
    expect(classifyAgentError('something odd')).toBe('unknown');
  });

  it('summarizes tool results in a few lines', () => {
    expect(
      summarizeToolResult({ content: [{ type: 'text', text: 'a\n\nb\nc\nd' }, { type: 'image' }] }),
    ).toBe('a · b · c');
    expect(summarizeToolResult({ content: [] })).toBeUndefined();
  });
});
