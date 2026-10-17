import { parseSse, type SseEvent } from './sse';

/**
 * A recorded answer for another run of the same conversation, with this run's ids. The ids the
 * answer names (a credential, a procedure, a download) came from the request it answered, so the
 * ids of the recorded request (`CanonicalRequest.ids`) and of the live one correspond: by
 * position when the two requests are the same conversation (an exact hit), and by what
 * surrounds them (`pairIds`) when their browser pages differ.
 *
 * A stream is rewritten piece by piece: a model writes an id over several deltas, so the pieces of
 * one text (a message, the arguments of one tool call) are joined, aligned and cut again at the
 * same lengths (ids keep their length, being of the same kind in the same place).
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Holder = { [key: string]: Json };

/** The pieces of streamed texts in one event, grouped by the text they add up to. */
type Pieces = Map<string, { holder: Holder; field: string }[]>;

const isHolder = (value: unknown): value is Holder =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** The ids of the live request in place of the recorded request's: one pass over a text. */
function replacer(recorded: readonly string[], live: readonly string[]) {
  const changes = new Map<string, string>();
  recorded.forEach((id, index) => {
    const now = live[index];
    if (now !== undefined && now !== id) changes.set(id, now);
  });
  if (changes.size === 0) return undefined;
  const pattern = new RegExp(
    [...changes.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
  );
  // One pass: an id that is also another position's recorded id is never replaced twice.
  return (text: string): string => text.replace(pattern, (id) => changes.get(id) ?? id);
}

/** Notes where an event streams text: `key` says which text the piece is part of. */
function collectPieces(json: Json, pieces: Pieces): void {
  const add = (key: string, holder: Holder, field: string) => {
    if (typeof holder[field] !== 'string') return;
    pieces.set(key, [...(pieces.get(key) ?? []), { holder, field }]);
  };
  if (!isHolder(json)) return;
  // Chat completions: `choices[i].delta` has content, reasoning and tool-call arguments.
  if (Array.isArray(json.choices)) {
    json.choices.forEach((choice, i) => {
      const delta = isHolder(choice) ? choice.delta : undefined;
      if (!isHolder(delta)) return;
      for (const field of ['content', 'reasoning_content', 'reasoning']) {
        add(`chat|${i}|${field}`, delta, field);
      }
      if (!Array.isArray(delta.tool_calls)) return;
      delta.tool_calls.forEach((call, position) => {
        const fn = isHolder(call) ? call.function : undefined;
        if (isHolder(fn))
          add(`chat|${i}|call|${String((call as Holder).index ?? position)}`, fn, 'arguments');
      });
    });
    return;
  }
  // Responses: `response.<what>.delta` events with a `delta` string.
  if (typeof json.type === 'string' && json.type.endsWith('.delta')) {
    const item = json.item_id ?? json.output_index ?? '';
    add(`resp|${json.type}|${String(item)}|${String(json.content_index ?? '')}`, json, 'delta');
  }
}

/** Replaces the ids in every string of `json` but the streamed pieces (`skip`). */
function replaceIn(json: Json, replace: (text: string) => string, skip: Set<Json>): void {
  if (Array.isArray(json)) {
    json.forEach((item, i) => {
      if (typeof item === 'string') json[i] = replace(item);
      else replaceIn(item, replace, skip);
    });
  } else if (isHolder(json)) {
    for (const [key, value] of Object.entries(json)) {
      if (typeof value === 'string') {
        if (!skip.has(json) || !PIECE_FIELDS.has(key)) json[key] = replace(value);
      } else replaceIn(value, replace, skip);
    }
  }
}

const PIECE_FIELDS = new Set(['content', 'reasoning_content', 'reasoning', 'arguments', 'delta']);

function serializeSse(events: readonly SseEvent[]): string {
  return events
    .map((event) => {
      const data = event.data
        .split('\n')
        .map((line) => `data: ${line}`)
        .join('\n');
      return `${event.event ? `event: ${event.event}\n` : ''}${data}\n\n`;
    })
    .join('');
}

/** Gives a recorded answer the ids of the request it is now answering. */
export function alignIds(
  body: string,
  recorded: readonly string[],
  live: readonly string[],
): string {
  const replace = replacer(recorded, live);
  if (!replace) return body;
  // A body that is not a stream is one text.
  if (!/^\s*(?:data|event):/.test(body)) return replace(body);

  const events = parseSse(body);
  const parsed = events.map((event): Json | undefined => {
    try {
      return JSON.parse(event.data) as Json;
    } catch {
      return undefined;
    }
  });
  const pieces: Pieces = new Map();
  for (const json of parsed) if (json !== undefined) collectPieces(json, pieces);
  const holders = new Set<Json>([...pieces.values()].flat().map((piece) => piece.holder));
  for (const json of parsed) if (json !== undefined) replaceIn(json, replace, holders);

  for (const group of pieces.values()) {
    const joined = group.map(({ holder, field }) => String(holder[field])).join('');
    const aligned = replace(joined);
    if (aligned === joined) continue;
    let offset = 0;
    group.forEach(({ holder, field }, i) => {
      const length = String(holder[field]).length;
      // Ids keep their length; should the text change size, the first piece takes all of it.
      if (aligned.length === joined.length) {
        holder[field] = aligned.slice(offset, offset + length);
        offset += length;
      } else {
        holder[field] = i === 0 ? aligned : '';
      }
    });
  }
  return serializeSse(
    events.map((event, i) => ({
      ...(event.event ? { event: event.event } : {}),
      data: parsed[i] === undefined ? event.data : JSON.stringify(parsed[i]),
    })),
  );
}

/** The ids of a request in order of first appearance, with what surrounds each (`CanonicalRequest`). */
export interface IdSlots {
  ids: readonly string[];
  contexts: readonly string[];
}

/**
 * Pairs the ids of a recorded request with those of the live one by what surrounds them (their
 * kind and the text before them), not by position: when the pages of the two requests differ,
 * one page may hold an id the other lacks, and every later id would shift by one. Ids whose
 * surroundings are alike are paired in order of appearance. A recorded id with no counterpart is
 * only a problem when the recorded answer names it (`named` is its text): then the pairing is
 * ambiguous and nothing is returned, so a replay misses rather than guesses.
 */
export function pairIds(
  recorded: IdSlots,
  live: IdSlots,
  named: string,
): { recorded: string[]; live: string[] } | undefined {
  const groups = new Map<string, { recorded: string[]; live: string[] }>();
  const group = (context: string) => {
    let found = groups.get(context);
    if (!found) {
      found = { recorded: [], live: [] };
      groups.set(context, found);
    }
    return found;
  };
  for (const [i, id] of recorded.ids.entries()) {
    group(recorded.contexts[i] ?? '').recorded.push(id);
  }
  for (const [i, id] of live.ids.entries()) group(live.contexts[i] ?? '').live.push(id);
  const pairs: { recorded: string[]; live: string[] } = { recorded: [], live: [] };
  for (const found of groups.values()) {
    if (found.recorded.length === found.live.length) {
      found.recorded.forEach((id, i) => {
        pairs.recorded.push(id);
        pairs.live.push(found.live[i]!);
      });
    } else if (found.recorded.some((id) => named.includes(id))) {
      return undefined;
    }
  }
  return pairs;
}
