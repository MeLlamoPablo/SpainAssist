import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import { alignIds, pairIds } from '../../src/llm/align';
import { parseSse } from '../../src/llm/sse';

const OLD = '11111111-2222-4333-8444-555555555555';
const NEW = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROCEDURE_OLD = 'p_0123456789abcdef';
const PROCEDURE_NEW = 'p_fedcba9876543210';

/** A body cut into pieces of `size` characters, as the model streams it. */
const pieces = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const sse = (events: unknown[]): string =>
  `${events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')}`;

const chatChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

const data = (body: string): Record<string, unknown>[] =>
  parseSse(body)
    .filter((event) => event.data !== '[DONE]')
    .map((event) => JSON.parse(event.data) as Record<string, unknown>);

describe('alignIds', () => {
  it('leaves an answer alone when no id changes', () => {
    const body = sse([chatChunk({ content: `la ${OLD}` }), '[DONE]']);
    expect(alignIds(body, [OLD], [OLD])).toBe(body);
    expect(alignIds(body, [], [NEW])).toBe(body);
    expect(alignIds(body, [OLD], [])).toBe(body);
  });

  it('rewrites a JSON body that is not a stream', () => {
    const body = JSON.stringify({
      choices: [{ message: { content: `Saved ${OLD}`, tool_calls: [{ id: PROCEDURE_OLD }] } }],
    });
    const aligned = alignIds(body, [OLD, PROCEDURE_OLD], [NEW, PROCEDURE_NEW]);
    expect(aligned).toBe(body.replace(OLD, NEW).replace(PROCEDURE_OLD, PROCEDURE_NEW));
  });

  it('puts the live ids in an id that a model streamed over several pieces', () => {
    const args = JSON.stringify({
      credentialId: OLD,
      procedureId: PROCEDURE_OLD,
      field: 'password',
    });
    const text = `Con ${OLD} entro.`;
    const events = [
      ...pieces(text, 5).map((piece) => chatChunk({ content: piece })),
      ...pieces(args, 7).map((piece, i) =>
        chatChunk({
          tool_calls: [
            {
              index: 0,
              function: {
                ...(i === 0 ? { name: 'browser_fill_from_vault' } : {}),
                arguments: piece,
              },
            },
          ],
        }),
      ),
      chatChunk({}, 'tool_calls'),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 3 } },
      '[DONE]',
    ];
    const body = sse(events);
    const aligned = alignIds(body, [OLD, PROCEDURE_OLD], [NEW, PROCEDURE_NEW]);

    const chunks = data(aligned);
    const content = chunks.flatMap((c) => {
      const delta = (c.choices as { delta?: { content?: string } }[])[0]?.delta;
      return typeof delta?.content === 'string' ? [delta.content] : [];
    });
    expect(content.join('')).toBe(`Con ${NEW} entro.`);
    // The pieces keep their sizes: only the characters of the ids changed.
    expect(content.map((piece) => piece.length)).toEqual(pieces(text, 5).map((p) => p.length));
    const argument = chunks.flatMap((c) => {
      const call = (
        c.choices as { delta?: { tool_calls?: { function: { arguments: string } }[] } }[]
      )[0]?.delta?.tool_calls?.[0];
      return call ? [call.function.arguments] : [];
    });
    expect(JSON.parse(argument.join(''))).toEqual({
      credentialId: NEW,
      procedureId: PROCEDURE_NEW,
      field: 'password',
    });
    expect(argument.map((piece) => piece.length)).toEqual(pieces(args, 7).map((p) => p.length));
    // Everything else is untouched: the tool name, the finish, the usage and the end of the stream.
    expect(aligned).toContain('"name":"browser_fill_from_vault"');
    expect(aligned).toContain('"finish_reason":"tool_calls"');
    expect(aligned).toContain('"usage":{"prompt_tokens":10,"completion_tokens":3}');
    expect(aligned.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(aligned).not.toContain(OLD);
  });

  it('keeps the streams of two tool calls apart', () => {
    const one = JSON.stringify({ id: OLD });
    const two = JSON.stringify({ id: PROCEDURE_OLD });
    const events = [
      ...pieces(one, 6).map((piece) =>
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }),
      ),
      ...pieces(two, 6).map((piece) =>
        chatChunk({ tool_calls: [{ index: 1, function: { arguments: piece } }] }),
      ),
      '[DONE]',
    ];
    const aligned = alignIds(sse(events), [OLD, PROCEDURE_OLD], [NEW, PROCEDURE_NEW]);
    const byCall = new Map<number, string>();
    for (const chunk of data(aligned)) {
      const call = (
        chunk.choices as {
          delta: { tool_calls: { index: number; function: { arguments: string } }[] };
        }[]
      )[0]?.delta.tool_calls[0];
      if (call) byCall.set(call.index, (byCall.get(call.index) ?? '') + call.function.arguments);
    }
    expect(JSON.parse(byCall.get(0) ?? '')).toEqual({ id: NEW });
    expect(JSON.parse(byCall.get(1) ?? '')).toEqual({ id: PROCEDURE_NEW });
  });

  it('swaps two ids in one pass instead of replacing one by the other twice', () => {
    const body = sse([chatChunk({ content: `${OLD} y ${NEW}` }), '[DONE]']);
    const aligned = alignIds(body, [OLD, NEW], [NEW, OLD]);
    expect(data(aligned)[0]).toMatchObject({
      choices: [{ delta: { content: `${NEW} y ${OLD}` } }],
    });
  });

  it('rewrites a Responses stream: the deltas of the arguments and the whole texts that repeat them', () => {
    const args = JSON.stringify({ documentId: OLD });
    const events = [
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', arguments: '' },
      },
      ...pieces(args, 6).map((delta) => ({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta,
      })),
      { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: args },
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', id: 'fc_1', arguments: args },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', output: [{ type: 'function_call', arguments: args }] },
      },
    ];
    const aligned = alignIds(sse(events), [OLD], [NEW]);
    expect(aligned).not.toContain(OLD);
    const parsed = data(aligned);
    const deltas = parsed
      .filter((e) => e.type === 'response.function_call_arguments.delta')
      .map((e) => e.delta as string);
    expect(deltas.join('')).toBe(args.replace(OLD, NEW));
    expect(deltas.map((d) => d.length)).toEqual(pieces(args, 6).map((p) => p.length));
    expect(parsed.find((e) => e.type === 'response.function_call_arguments.done')).toMatchObject({
      arguments: args.replace(OLD, NEW),
    });
    expect(parsed.at(-1)).toMatchObject({
      response: { output: [{ arguments: args.replace(OLD, NEW) }] },
    });
  });

  it('keeps named events and lines that are not JSON', () => {
    const body = 'event: ping\ndata: hello\n\nevent: message\ndata: {"delta":"a"}\n\n';
    expect(alignIds(body, [OLD], [NEW])).toBe(body);
    const changed = `event: message\ndata: {"type":"x.delta","delta":"${OLD}"}\n\n`;
    expect(alignIds(changed, [OLD], [NEW])).toBe(
      `event: message\ndata: {"type":"x.delta","delta":"${NEW}"}\n\n`,
    );
  });
});

describe('pairIds: the ids of a recording and of this request, by what surrounds them', () => {
  const DL_A = 'dl_aaaaaaaaaaaaaaaa';
  const DL_B = 'dl_bbbbbbbbbbbbbbbb';
  const DL_C = 'dl_cccccccccccccccc';

  it('pairs ids in the same place whatever the other ids shift', () => {
    // The page of this request shows an id (a link) that the recorded page did not, before the download.
    const pairs = pairIds(
      { ids: [DL_A], contexts: ['dl|downloadId '] },
      { ids: [OLD, DL_B], contexts: ['uuid|/HerramientasWeb/', 'dl|downloadId '] },
      `Guardo ${DL_A}`,
    );
    expect(pairs).toEqual({ recorded: [DL_A], live: [DL_B] });
    // Applied to a stream of the answer, the id is this request's, not the one at the same position.
    const body = sse([chatChunk({ content: `Guardo ${DL_A}` }, 'stop')]);
    expect(alignIds(body, pairs!.recorded, pairs!.live)).toContain(DL_B);
    expect(alignIds(body, pairs!.recorded, pairs!.live)).not.toContain(OLD);
  });

  it('pairs ids that surround alike in order of appearance', () => {
    const pairs = pairIds(
      { ids: [DL_A, DL_B], contexts: ['dl|- ', 'dl|- '] },
      { ids: [DL_C, NEW], contexts: ['dl|- ', 'dl|- '] },
      `${DL_B}`,
    );
    expect(pairs).toEqual({ recorded: [DL_A, DL_B], live: [DL_C, NEW] });
  });

  it('is ambiguous, and gives nothing, when an id the answer names has no counterpart', () => {
    const recorded = { ids: [DL_A, DL_B], contexts: ['dl|- ', 'dl|- '] };
    const live = { ids: [DL_C], contexts: ['dl|- '] };
    expect(pairIds(recorded, live, `Guardo ${DL_B}`)).toBeUndefined();
    // An id the answer does not mention does not matter.
    expect(pairIds(recorded, live, 'Espero.')).toEqual({ recorded: [], live: [] });
    // Another label is another id, never matched by position.
    expect(
      pairIds(
        { ids: [DL_A], contexts: ['dl|downloadId '] },
        { ids: [DL_B], contexts: ['dl|other '] },
        DL_A,
      ),
    ).toBeUndefined();
  });
});
