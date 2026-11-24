import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { findDocumentByName } from '@sa/shared';
import { REWRITE_MESSAGE_TYPE } from '../rpc/events';
import { hostLog } from './log';

/** A saved document of the vault, as the host sees it: the model sees only its name. */
export interface SavedDocument {
  id: string;
  name: string;
  previousNames?: string[];
}

/**
 * A link to a saved document, in the three forms models write: `[x](<sa:document/A name.pdf>)`
 * (the one the prompt teaches), `[x](sa:document/A name (2).pdf)` (spaces, balanced parentheses)
 * and `[x](sa:document/A%20name.pdf)`. The app's own form is `[x](sa:document/<id>)`.
 */
const DOCUMENT_LINK =
  /\]\((?:<sa:document\/([^<>\n]*)>|sa:document\/((?:[^()<>\n]|\([^()\n]*\))*))\)/g;

/** What a link points at, as written (percent-encoding undone). */
function targetOf(match: RegExpMatchArray): string {
  const bracketed = match[1];
  if (bracketed !== undefined) return bracketed.trim();
  const raw = (match[2] ?? '').trim();
  if (!/%[0-9A-Fa-f]{2}/.test(raw)) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The documents `text` links, as written (names, or ids in the app's form), each once. */
export function linkedDocuments(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(DOCUMENT_LINK), targetOf))];
}

/** The saved document a link means: its id, its name (with or without extension) or an earlier name. */
function documentFor(target: string, documents: SavedDocument[]): SavedDocument | undefined {
  const byId = documents.find((doc) => doc.id === target);
  if (byId) return byId;
  const lookup = findDocumentByName(documents, target);
  if ('found' in lookup) return lookup.found;
  if ('renamed' in lookup) return lookup.renamed;
  return undefined;
}

/**
 * The links of the model's message in the app's form, `](sa:document/<id>)`: what the session
 * keeps and the chat shows, so a later rename breaks no link. Links to no saved document stay.
 */
export function linkDocumentsById(text: string, documents: SavedDocument[]): string {
  return text.replace(DOCUMENT_LINK, (...args) => {
    const doc = documentFor(targetOf(args as unknown as RegExpMatchArray), documents);
    return doc ? `](sa:document/${doc.id})` : args[0];
  });
}

/**
 * The app's links as the model reads them, `](<sa:document/Current name.pdf>)`: the model never
 * sees an id, and a renamed document shows its new name in old messages.
 */
export function linkDocumentsByName(text: string, documents: SavedDocument[]): string {
  return text.replace(DOCUMENT_LINK, (...args) => {
    const target = targetOf(args as unknown as RegExpMatchArray);
    const doc = documents.find((d) => d.id === target);
    if (doc) return `](<sa:document/${doc.name}>)`;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(target)
      ? '](<sa:document/(deleted document)>)'
      : args[0];
  });
}

/** What the model reads when its message links documents that are not saved. */
export function unknownDocumentsMessage(unknown: string[], documents: SavedDocument[]): string {
  const lines = [
    `Your last message links ${unknown.map((name) => `"${name}"`).join(', ')}, but no saved document has ${unknown.length === 1 ? 'that name' : 'those names'}: the user sees "Document unavailable".`,
  ];
  if (documents.length > 0) {
    lines.push('Saved documents:', ...documents.map((doc) => `- ${doc.name}`));
  } else {
    lines.push('There are no saved documents.');
  }
  lines.push(
    'Write the whole message again, copying names exactly from this list ([Nombre](<sa:document/Exact name.pdf>)), or without the link if the document is not saved. The user sees your new message instead of the last one. Do not mention this correction.',
  );
  return lines.join('\n');
}

type TextPart = { type: string; text?: string };

/** `content` with `edit` applied to its text parts; the same array when nothing changed. */
function editText<T extends TextPart>(content: T[], edit: (text: string) => string): T[] {
  let changed = false;
  const next = content.map((part) => {
    if (part.type !== 'text' || typeof part.text !== 'string') return part;
    const text = edit(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? next : content;
}

const linksDocuments = (content: TextPart[]) =>
  content.some((part) => part.type === 'text' && part.text?.includes('sa:document/'));

/**
 * The assistant links saved documents by name, copying them from reports and vault_read. The
 * host keeps those links as ids (`message_end`), shows the model names again (`context`), and
 * when the final message links a document the vault does not have, tells the model which ones
 * are saved and has it write the message again, once per prompt; the app shows the new message
 * in place of the old one (`assistant_rewrite`).
 */
export function registerDocumentLinkCheck(
  pi: ExtensionAPI,
  documents: () => Promise<SavedDocument[]>,
): void {
  /** The saved documents, or undefined (logged) when the app can't say. */
  const saved = async (what: string): Promise<SavedDocument[] | undefined> => {
    try {
      return await documents();
    } catch (err) {
      hostLog('warn', `document links not ${what}: ${String(err)}`);
      return undefined;
    }
  };

  pi.on('message_end', async (event) => {
    const { message } = event;
    if (message.role !== 'assistant' || !linksDocuments(message.content)) return;
    const docs = await saved('stored by id');
    if (!docs) return;
    const content = editText(message.content, (text) => linkDocumentsById(text, docs));
    return content === message.content ? undefined : { message: { ...message, content } };
  });

  pi.on('context', async (event) => {
    const linking = event.messages.filter(
      (m) => m.role === 'assistant' && linksDocuments(m.content),
    );
    if (linking.length === 0) return;
    const docs = await saved('shown by name');
    if (!docs) return;
    // pi gives each handler its own copy of the messages: editing them in place is safe.
    for (const message of linking)
      if (message.role === 'assistant')
        message.content = editText(message.content, (text) => linkDocumentsByName(text, docs));
    return { messages: event.messages };
  });

  let rewritten = false;
  pi.on('before_agent_start', () => {
    rewritten = false;
  });

  pi.on('turn_end', async (event) => {
    const { message } = event;
    if (rewritten || message.role !== 'assistant' || message.stopReason !== 'stop') return;
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const targets = linkedDocuments(text);
    if (targets.length === 0) return;
    const docs = await saved('checked');
    if (!docs) return;
    const unknown = targets.filter((target) => !documentFor(target, docs));
    if (unknown.length === 0) return;
    rewritten = true;
    hostLog('warn', `the message links unknown documents (${unknown.join(', ')}): rewriting it`);
    return {
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: REWRITE_MESSAGE_TYPE,
          content: unknownDocumentsMessage(unknown, docs),
          display: false,
        },
      ],
      continue: true,
    };
  });
}
