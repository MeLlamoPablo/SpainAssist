import { createHash } from 'node:crypto';
import type { WireApi } from './sse';

/**
 * The canonical form of a model request, and its hash: the key of the record/replay cache. Chat
 * completions and Responses requests are stateless (the whole conversation is in every request),
 * so a content hash is a perfect key. Volatile parts are normalised away so that the same
 * conversation hashes the same on another day, in another run directory, with other session ids:
 *
 * - top-level `prompt_cache_key`, `user`, `metadata`, `store`, `stream`, `stream_options`;
 * - `Today is <weekday> <date> (<zone>).` in every string (the prompts' clock line);
 * - screenshots (`data:image/...;base64,...`), unless `strictImages` keeps a hash of each: pixels
 *   are not reproducible between runs. The hash of each is in `images`, so a replay can tell that
 *   a hit answered another picture;
 * - anything the run registers: its directory, ids, ports, timestamps in tool results;
 * - the ids the app mints for its own objects (UUIDs of documents and credentials, `p_<hex>` of
 *   procedures, `dl_<hex>` of downloads) and the time of day of a saved document: they differ in
 *   every run. An id counts by the order it first appears in the request (`ids`), so the same
 *   conversation hashes the same, and a replayed answer gets this run's ids back (`alignIds`, in
 *   `align.ts`).
 *
 * Besides the exact `key` a request is described for a looser replay (`ResponseCache.takeLoose`),
 * which exists because Chromium takes its snapshot when the network goes quiet: a page that
 * redirects by itself is caught at another hop in every run, and its refs (`[ref=f3e46]`) number
 * the elements of whatever frames came before. The page observations of the browser (a tool result
 * that starts with `URL:` and `Title:`) are listed in `pages`, each with what the page IS: its
 * URL without the query, its title and a hash of what it says (`contentOf`: the names and texts of
 * its elements and its links in order, not how they are nested, whether an image had loaded or
 * what their refs are). The `skeleton` is the hash of everything else, pages replaced by a
 * marker: the system prompt, the tools, the model and every other message must be the same.
 *
 * Object keys are sorted; arrays keep their order. Headers are never part of the key.
 */

export interface VolatilePattern {
  /** A regex (replace all matches; add the `g` flag yourself or it is added) or a literal. */
  pattern: RegExp | string;
  replacement: string;
}

export interface CanonicalOptions {
  api: WireApi;
  /** Independent samples of the same conversation (record n stochastic runs once, replay them free). */
  variant?: string;
  /** Keep the hash of each screenshot in the key instead of treating all as equal. */
  strictImages?: boolean;
  volatile?: readonly VolatilePattern[];
}

/** What the model did after a page, as far as a replay needs to know. */
export interface Reaction {
  /** It only waited or looked again (`browser_wait`, `browser_snapshot`): nothing about the page's content. */
  waits: boolean;
  /** It named an element ref: it only makes sense on the page with those refs. */
  refs: boolean;
}

/** A page of the browser as a tool result shows it to the model. */
export interface PageObservation {
  /** The message (chat) or input item (Responses) that holds it. */
  index: number;
  /** Host and path of the page: no query, no fragment, ids as `<ID>`. */
  url: string;
  title: string;
  /** Hash of what the page says (`contentOf`), not of how the snapshot lays it out. */
  shape: string;
  /** The model's next message, when the request has one: what it made of the page. */
  next?: Reaction;
}

export interface CanonicalRequest {
  /** sha256 hex of the canonical request, the API and the variant. */
  key: string;
  /** The app's ids in the request, in the order they first appear: what a recording is aligned by. */
  ids: string[];
  /**
   * What surrounds the first appearance of each id (its kind and the label before it), in the same
   * order as `ids`: a looser replay aligns the ids of a recording to the live ones by it, never
   * by position alone.
   */
  idContexts: string[];
  /** Hash of each screenshot (a data URL), in order of appearance. */
  images: string[];
  /** The browser pages of the request, in order. */
  pages: PageObservation[];
  /** As `key`, with every page replaced by a marker: what a looser replay looks recordings up by. */
  skeleton: string;
  api: WireApi;
  variant: string;
  /** Short hash of every top-level field except the message list (model, tools, params). */
  head: Record<string, string>;
  /** Short hash of each message (chat) or input item (Responses), in order. */
  messageHashes: string[];
  /** One line per message, for the miss diagnostic. */
  messagePreviews: string[];
  summary: { messages: number; tools: number; bytes: number; lastUser: string };
}

const DROPPED_KEYS = new Set([
  'prompt_cache_key',
  'user',
  'metadata',
  'store',
  'stream',
  'stream_options',
]);
const TODAY_LINE = /Today is [A-Za-z]+ \d{4}-\d{2}-\d{2} \([^)\n]+\)\./g;
/** A UUID, or an id of the app: a short prefix, an underscore and 16 hex digits (`newId`). */
const APP_ID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[a-z]{1,8}_[0-9a-f]{16}\b/gi;
/** The vault lists a document's time as `dd/mm/yyyy hh:mm:ss` on the run's own clock. */
const DOCUMENT_TIME = /\b\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}\b/g;
const IMAGE_DATA_URL = /data:image\/([A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/g;
const PREVIEW_CHARS = 100;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const short = (text: string) => sha(text).slice(0, 16);

/** What a browser tool or `fetch_url` says first about a page: `URL: ...` then `Title: ...`. */
const PAGE_OBSERVATION = /^URL: (\S+)\nTitle: ([^\n]*)/;
/** An element ref of a page snapshot (`[ref=e12]`, `[ref=f3e46]`): numbered by when it was seen. */
const REF = /\[ref=[^\]]*\]/g;
/** The marker of the element that has the focus: it depends on timing. */
const ACTIVE = / \[active\]/g;
/** How much of the line before an id says what the id is. */
const CONTEXT_CHARS = 24;
/** Tools whose use says nothing about the page that came before: the model waits or looks again. */
const WAITING_TOOLS: ReadonlySet<string> = new Set(['browser_wait', 'browser_snapshot']);

/** What the normalisation of a request collects on the way. */
interface Collected {
  /** The ids met so far, by order of first appearance. */
  ids: Map<string, number>;
  idContexts: string[];
  images: string[];
}

/** The kind of an id: `uuid`, or the prefix of an id of the app (`p`, `dl`, ...). */
function idKind(id: string): string {
  return id.includes('-') ? 'uuid' : id.slice(0, id.indexOf('_')).toLowerCase();
}

/** A text with what changes from run to run taken out: refs, the focus marker, id numbers. */
function steady(text: string): string {
  return text
    .replace(REF, '[ref]')
    .replace(ACTIVE, '')
    .replace(/<ID:\d+>/g, '<ID>');
}

function normalizeString(
  text: string,
  options: CanonicalOptions,
  volatile: readonly VolatilePattern[],
  collected: Collected,
): string {
  let out = text.replace(TODAY_LINE, 'Today is <DATE>.');
  out = out.replace(IMAGE_DATA_URL, (_match, mime: string, data: string) => {
    const hash = short(data);
    collected.images.push(hash);
    return options.strictImages ? `data:image/${mime};base64,<sha:${hash}>` : 'data:image/<IMG>';
  });
  for (const { pattern, replacement } of volatile) {
    out =
      typeof pattern === 'string'
        ? out.split(pattern).join(replacement)
        : out.replace(
            pattern.global ? pattern : new RegExp(pattern.source, `${pattern.flags}g`),
            replacement,
          );
  }
  out = out.replace(DOCUMENT_TIME, '<TIME>');
  return out.replace(APP_ID, (id, offset: number, whole: string) => {
    let position = collected.ids.get(id);
    if (position === undefined) {
      position = collected.ids.size + 1;
      collected.ids.set(id, position);
      // The label of the id: the text before it on its own line (an element of a snapshot, a row),
      // with the volatile parts of a page taken out.
      const window = whole.slice(Math.max(0, offset - 200), offset);
      const label = window
        .slice(window.lastIndexOf('\n') + 1)
        .replace(APP_ID, '<ID>')
        .replace(REF, '[ref]')
        .replace(ACTIVE, '')
        .replace(/\s+/g, ' ')
        .slice(-CONTEXT_CHARS);
      collected.idContexts.push(`${idKind(id)}|${label}`);
    }
    return `<ID:${position}>`;
  });
}

function canonicalValue(
  value: unknown,
  options: CanonicalOptions,
  volatile: readonly VolatilePattern[],
  collected: Collected,
): unknown {
  if (typeof value === 'string') return normalizeString(value, options, volatile, collected);
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item, options, volatile, collected));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonicalValue(record[key], options, volatile, collected)]),
    );
  }
  return value;
}

/** The text of a tool result (chat `tool` message, Responses `function_call_output`), if it has one. */
function toolResultText(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  const content =
    record.role === 'tool'
      ? record.content
      : record.type === 'function_call_output'
        ? record.output
        : undefined;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === 'string' && PAGE_OBSERVATION.test(text)) return text;
  }
  return undefined;
}

/** The calls of the model's message that follows a page, or undefined when the request ends first. */
function nextCalls(
  list: readonly unknown[],
  after: number,
): { name: string; args: string }[] | undefined {
  const calls: { name: string; args: string }[] = [];
  let reacted = false;
  for (let i = after + 1; i < list.length; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    // Chat: the assistant message, with its tool calls; Responses: an assistant message of text.
    if (m.role === 'assistant') {
      const chatCalls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const call of chatCalls as { function?: { name?: unknown; arguments?: unknown } }[]) {
        calls.push({
          name: String(call.function?.name ?? ''),
          args: String(call.function?.arguments ?? ''),
        });
      }
      return calls;
    }
    // Responses: the model's calls are items of their own, with their results after them.
    if (m.type === 'function_call') {
      calls.push({ name: String(m.name ?? ''), args: String(m.arguments ?? '') });
      reacted = true;
    } else if (reacted && m.type !== 'function_call_output' && m.type !== 'reasoning') {
      return calls;
    }
  }
  return reacted ? calls : undefined;
}

/** What a set of calls says about the page it answers. */
export function reactionTo(calls: readonly { name: string; args: string }[]): Reaction {
  return {
    waits: calls.length > 0 && calls.every((call) => WAITING_TOOLS.has(call.name)),
    refs: calls.some((call) => /"ref"\s*:/.test(call.args)),
  };
}

/** One line of a page snapshot: `- role "name" [attribute]: text`, or `- /url: ...`. */
const SNAPSHOT_LINE =
  /^\s*- (?:\/url: (.*)|([A-Za-z]+)( "(?:[^"\\]|\\.)*")?((?: \[[^\]]*\])*)(?::(?: (.*))?)?)$/;
/** The attributes of a snapshot line that say nothing about the page's content. */
const LAYOUT_ATTRIBUTES: ReadonlySet<string> = new Set(['ref', 'active', 'cursor']);

/**
 * What a page says: the lines before its snapshot (URL without the query, title, downloads,
 * dialogs...) and, in order, the name, text and state of each element of the snapshot that has
 * any, and the target of each link. Not how the elements are nested, nor their refs, nor whether a
 * wrapper has one: a snapshot taken before the images had loaded nests and numbers the same page
 * differently, and says the same. Text added to a page (an injected instruction) is content.
 */
function contentOf(text: string, url: string): string {
  const tokens = [`URL: ${url}`];
  let inSnapshot = false;
  for (const line of steady(text).split('\n').slice(1)) {
    if (!inSnapshot) {
      tokens.push(line);
      inSnapshot = line.startsWith('Page snapshot');
      continue;
    }
    const match = SNAPSHOT_LINE.exec(line);
    if (!match) {
      if (line.trim()) tokens.push(line.trim());
      continue;
    }
    const [, target, role, name, attributes, content] = match;
    if (target !== undefined) {
      tokens.push(`link to ${target}`);
      continue;
    }
    const states = [...(attributes ?? '').matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)]
      .filter((attribute) => !LAYOUT_ATTRIBUTES.has(attribute[1]!))
      .map((attribute) => attribute[0]);
    if (!name && !content && states.length === 0) continue;
    tokens.push(`${role}|${name ?? ''}|${content ?? ''}|${states.join('')}`);
  }
  return tokens.join('\n');
}

/** The browser pages of a request's message list (canonical, so ids are already numbered). */
function pagesOf(list: readonly unknown[]): PageObservation[] {
  const pages: PageObservation[] = [];
  list.forEach((item, index) => {
    const text = toolResultText(item);
    const match = text === undefined ? null : PAGE_OBSERVATION.exec(text);
    if (text === undefined || !match) return;
    const url = steady(/^[^?#]*/.exec(match[1]!)?.[0] ?? match[1]!);
    const title = steady(match[2]!);
    const calls = nextCalls(list, index);
    pages.push({
      index,
      url,
      title,
      shape: short(contentOf(text, url)),
      ...(calls ? { next: reactionTo(calls) } : {}),
    });
  });
  return pages;
}

function partText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  const p = part as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (p.type === 'image_url' || p.type === 'input_image') return '[image]';
  return '';
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(partText).join('');
  return '';
}

/** `role: text` for a chat message or `type/role: text` for a Responses input item. */
function describeMessage(message: unknown): string {
  if (typeof message === 'string') return `user: ${message}`;
  if (!message || typeof message !== 'object') return String(message);
  const m = message as Record<string, unknown>;
  const label =
    [m.type, m.role].filter((v): v is string => typeof v === 'string').join('/') || 'item';
  let text = contentText(m.content);
  if (Array.isArray(m.tool_calls)) {
    text += (m.tool_calls as { function?: { name?: string; arguments?: string } }[])
      .map((call) => ` call ${call.function?.name}(${call.function?.arguments ?? ''})`)
      .join('');
  }
  if (typeof m.type === 'string' && typeof m.name === 'string') {
    text += ` ${m.name}(${typeof m.arguments === 'string' ? m.arguments : ''})`;
  }
  if (typeof m.output === 'string') text += m.output;
  if (typeof m.tool_call_id === 'string') text = `[${m.tool_call_id}] ${text}`;
  const flat = text.replace(/\s+/g, ' ').trim();
  return `${label}: ${flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat}`;
}

function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && typeof m === 'object' && (m as { role?: unknown }).role === 'user') {
      return contentText((m as { content?: unknown }).content).slice(0, 120);
    }
  }
  return '';
}

export function canonicalizeRequest(
  body: Record<string, unknown>,
  options: CanonicalOptions,
  bytes = 0,
): CanonicalRequest {
  const volatile = options.volatile ?? [];
  const listKey = options.api === 'responses' ? 'input' : 'messages';
  const kept = Object.fromEntries(Object.entries(body).filter(([key]) => !DROPPED_KEYS.has(key)));
  const collected: Collected = { ids: new Map(), idContexts: [], images: [] };
  const canonical = canonicalValue(kept, options, volatile, collected) as Record<string, unknown>;
  const rawList = canonical[listKey];
  const list: unknown[] = Array.isArray(rawList) ? rawList : rawList === undefined ? [] : [rawList];
  const head: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonical)) {
    if (key !== listKey) head[key] = short(JSON.stringify(value));
  }
  const variant = options.variant ?? '';
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  const pages = pagesOf(list);
  const pageIndexes = new Set(pages.map((page) => page.index));
  const withoutPages = {
    ...canonical,
    [listKey]: list.map((message, index) => (pageIndexes.has(index) ? '<PAGE>' : message)),
  };
  return {
    key: sha(JSON.stringify({ api: options.api, variant, req: canonical })),
    ids: [...collected.ids.keys()],
    idContexts: collected.idContexts,
    images: collected.images,
    pages,
    skeleton: sha(JSON.stringify({ api: options.api, variant, req: withoutPages, skeleton: true })),
    api: options.api,
    variant,
    head,
    messageHashes: list.map((message) => short(JSON.stringify(message))),
    messagePreviews: list.map(describeMessage),
    summary: { messages: list.length, tools, bytes, lastUser: lastUserText(list) },
  };
}
