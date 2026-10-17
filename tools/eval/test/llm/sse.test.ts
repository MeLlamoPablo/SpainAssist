import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import { isSseBody, parseErrorBody, parseSse, summarizeBody, toolCallsOf } from '../../src/llm/sse';
import { codexFrames } from './helpers/codex-backend';

const chunk = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const usageChunk = (usage: unknown) => `data: ${JSON.stringify({ choices: [], usage })}\n\n`;

describe('SSE parsing', () => {
  it('handles LF, CRLF, comments, multi-line data and a last event without its blank line', () => {
    const text =
      ': keep-alive\r\nevent: a\r\ndata: one\r\n\r\ndata: two\ndata: three\n\ndata: tail';
    expect(parseSse(text)).toEqual([
      { event: 'a', data: 'one' },
      { data: 'two\nthree' },
      { data: 'tail' },
    ]);
    expect(parseSse('')).toEqual([]);
  });
});

describe('chat completion bodies', () => {
  const stream =
    chunk({ role: 'assistant', content: '' }) +
    chunk({ content: 'Hola' }) +
    chunk({ reasoning_content: 'pienso' }) +
    chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: '{"a":1}' } }] }) +
    chunk({}, 'tool_calls') +
    usageChunk({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 60 },
    }) +
    'data: [DONE]\n\n';

  it('reads usage, finish reason, output size and completeness from a stream', () => {
    const summary = summarizeBody('chat-completions', stream, 'text/event-stream; charset=utf-8');
    expect(summary.complete).toBe(true);
    expect(summary.finishReason).toBe('tool_calls');
    expect(summary.usage?.counts).toMatchObject({ prompt: 100, cacheRead: 60, completion: 20 });
    expect(summary.outputText).toBe('Holapienso{"a":1}');
    expect(summary.error).toBeUndefined();
  });

  it('does not call a stream without [DONE] complete (it was cut)', () => {
    const cut = stream.replace('data: [DONE]\n\n', '');
    expect(summarizeBody('chat-completions', cut, 'text/event-stream').complete).toBe(false);
    const torn = `${chunk({ content: 'Ho' })}data: {"choices":[{"delta":{"cont`;
    const summary = summarizeBody('chat-completions', torn, 'text/event-stream');
    expect(summary.complete).toBe(false);
    expect(summary.outputText).toBe('Ho');
  });

  it('reports an error chunk inside a 200 stream', () => {
    const body = `data: ${JSON.stringify({ error: { message: 'boom', type: 'server_error' } })}\n\ndata: [DONE]\n\n`;
    expect(summarizeBody('chat-completions', body, 'text/event-stream').error).toEqual({
      message: 'boom',
      type: 'server_error',
    });
  });

  it('reads a plain JSON completion', () => {
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const summary = summarizeBody('chat-completions', body, 'application/json');
    expect(summary).toMatchObject({ complete: true, finishReason: 'stop' });
    expect(summary.usage?.counts).toMatchObject({ prompt: 5, completion: 2 });
    expect(summarizeBody('chat-completions', '{ nope', 'application/json').complete).toBe(false);
    expect(
      summarizeBody('chat-completions', '{"error":{"message":"x"}}', 'application/json'),
    ).toMatchObject({
      complete: false,
      error: { message: 'x' },
    });
  });
});

describe('Responses bodies', () => {
  const event = (payload: Record<string, unknown>) =>
    `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`;

  it('reads usage from response.completed and counts the deltas', () => {
    const body =
      event({ type: 'response.created', response: { id: 'r' } }) +
      event({ type: 'response.output_text.delta', delta: 'Hola' }) +
      event({ type: 'response.function_call_arguments.delta', delta: '{}' }) +
      event({
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: {
            input_tokens: 50,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 7,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });
    const summary = summarizeBody('responses', body, 'text/event-stream');
    expect(summary).toMatchObject({
      complete: true,
      finishReason: 'completed',
      outputText: 'Hola{}',
    });
    expect(summary.usage?.counts).toEqual({
      prompt: 50,
      cacheRead: 40,
      cacheWrite: 0,
      completion: 7,
      reasoning: 3,
    });
  });

  it('treats response.incomplete as finished and response.failed / error as errors', () => {
    const incomplete = event({
      type: 'response.incomplete',
      response: { status: 'incomplete', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(summarizeBody('responses', incomplete, 'text/event-stream')).toMatchObject({
      complete: true,
    });
    const failed = event({
      type: 'response.failed',
      response: {
        error: {
          code: 'usage_limit_reached',
          message: 'too much',
          plan_type: 'plus',
          resets_at: 1893456000,
        },
      },
    });
    const failedSummary = summarizeBody('responses', failed, 'text/event-stream');
    expect(failedSummary.complete).toBe(false);
    expect(failedSummary.error).toMatchObject({
      code: 'usage_limit_reached',
      planType: 'plus',
      resetsAt: 1893456000,
    });
    const error = event({ type: 'error', code: 'rate_limit_exceeded', message: 'slow down' });
    expect(summarizeBody('responses', error, 'text/event-stream').error).toMatchObject({
      code: 'rate_limit_exceeded',
      message: 'slow down',
    });
  });

  it('reads a JSON response object', () => {
    const body = JSON.stringify({
      status: 'completed',
      output: [],
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    expect(summarizeBody('responses', body, 'application/json')).toMatchObject({ complete: true });
  });
});

describe('error bodies', () => {
  it('reads error objects, details and Codex usage limits', () => {
    expect(
      parseErrorBody(
        JSON.stringify({
          error: {
            type: 'usage_limit_reached',
            message: 'limit',
            plan_type: 'plus',
            resets_at: 1893456000,
            resets_in_seconds: 10,
          },
        }),
      ),
    ).toEqual({
      type: 'usage_limit_reached',
      message: 'limit',
      planType: 'plus',
      resetsAt: 1893456000,
      resetsInSeconds: 10,
    });
    expect(parseErrorBody('{"detail":"Unauthorized"}')).toEqual({ message: 'Unauthorized' });
    expect(parseErrorBody('{"error":{"code":429}}')).toEqual({ code: '429' });
    expect(parseErrorBody('not json')).toBeUndefined();
    expect(parseErrorBody('[]')).toBeUndefined();
  });
});

describe('streams without a content type (the ChatGPT backend sends none)', () => {
  const text = codexFrames('{"reply":"listo"}', {
    input: 214,
    cached: 100,
    output: 10,
    reasoning: 4,
  }).join('');

  it('recognises an SSE body by its first frame, unless the content type says JSON', () => {
    expect(isSseBody(text, undefined)).toBe(true);
    expect(isSseBody(text, 'application/octet-stream')).toBe(true);
    expect(isSseBody(`: ping\n\ndata: {}\n\n`, undefined)).toBe(true);
    expect(isSseBody('data: [DONE]\n\n', 'text/event-stream; charset=utf-8')).toBe(true);
    expect(isSseBody('{"id":"resp_1","status":"completed"}', undefined)).toBe(false);
    expect(isSseBody(text, 'application/json')).toBe(false);
    expect(isSseBody('', undefined)).toBe(false);
  });

  it('reads the real response.completed: usage, finish reason, output', () => {
    const summary = summarizeBody('responses', text, undefined);
    expect(summary.complete).toBe(true);
    expect(summary.finishReason).toBe('completed');
    expect(summary.usage?.counts).toEqual({
      prompt: 214,
      cacheRead: 100,
      cacheWrite: 0,
      completion: 10,
      reasoning: 4,
    });
    expect(summary.outputText).toBe('{"reply":"listo"}');
    expect(summary.error).toBeUndefined();
  });

  it('a stream cut before response.completed is not complete', () => {
    const cut = codexFrames('{"reply":"listo"}').slice(0, 6).join('');
    const summary = summarizeBody('responses', cut, undefined);
    expect(summary.complete).toBe(false);
    expect(summary.usage).toBeUndefined();
  });
});

describe('the tool calls of a response', () => {
  it('reads them from a chat stream, joining the pieces of the arguments', () => {
    const stream = [
      chunk({ content: 'Espero.' }),
      chunk({
        tool_calls: [{ index: 0, id: 'c1', function: { name: 'browser_wait', arguments: '' } }],
      }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"sec' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'onds":2}' } }] }),
      chunk({
        tool_calls: [
          { index: 1, id: 'c2', function: { name: 'browser_click', arguments: '{"ref":"e5"}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ].join('');
    expect(toolCallsOf('chat-completions', stream, 'text/event-stream')).toEqual([
      { name: 'browser_wait', args: '{"seconds":2}' },
      { name: 'browser_click', args: '{"ref":"e5"}' },
    ]);
    expect(toolCallsOf('chat-completions', chunk({ content: 'hola' }, 'stop'), undefined)).toEqual(
      [],
    );
  });

  it('reads them from a chat JSON body', () => {
    const body = JSON.stringify({
      choices: [
        { message: { tool_calls: [{ function: { name: 'browser_snapshot', arguments: '{}' } }] } },
      ],
    });
    expect(toolCallsOf('chat-completions', body, 'application/json')).toEqual([
      { name: 'browser_snapshot', args: '{}' },
    ]);
    expect(toolCallsOf('chat-completions', 'not json', 'application/json')).toEqual([]);
  });

  it('reads them from a Responses stream (no content type, as the ChatGPT backend sends it)', () => {
    const frame = (event: unknown) => `event: x\ndata: ${JSON.stringify(event)}\n\n`;
    const stream = [
      frame({ type: 'response.output_item.added', item: { type: 'reasoning', id: 'r1' } }),
      frame({
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'fc1',
          call_id: 'c1',
          name: 'browser_click',
          arguments: '',
        },
      }),
      frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"ref":' }),
      frame({ type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"f3e4"}' }),
      frame({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          id: 'fc1',
          name: 'browser_click',
          arguments: '{"ref":"f3e4"}',
        },
      }),
      frame({ type: 'response.completed', response: { status: 'completed' } }),
    ].join('');
    expect(toolCallsOf('responses', stream, undefined)).toEqual([
      { name: 'browser_click', args: '{"ref":"f3e4"}' },
    ]);
  });

  it('reads them from a Responses JSON body', () => {
    const body = JSON.stringify({
      output: [
        { type: 'message', content: [] },
        { type: 'function_call', name: 'browser_wait', arguments: '{"seconds":1}' },
      ],
    });
    expect(toolCallsOf('responses', body, 'application/json')).toEqual([
      { name: 'browser_wait', args: '{"seconds":1}' },
    ]);
  });
});
