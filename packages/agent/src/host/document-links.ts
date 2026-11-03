import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { REWRITE_MESSAGE_TYPE } from '../rpc/events';
import { hostLog } from './log';

/** A saved document of the vault, as the check lists it to the model. */
export interface SavedDocument {
  id: string;
  name: string;
}

const DOCUMENT_LINK = /\]\(sa:document\/([^)\s]*)\)/g;

/** The ids of the documents `text` links (`[name](sa:document/<id>)`), each once. */
export function linkedDocumentIds(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(DOCUMENT_LINK), (match) => match[1] ?? ''))];
}

/** What the model reads when its message links documents that are not saved. */
export function unknownDocumentsMessage(unknown: string[], documents: SavedDocument[]): string {
  const lines = [
    `Your last message links ${unknown.map((id) => `sa:document/${id}`).join(', ')}, but no saved document has ${unknown.length === 1 ? 'that id' : 'those ids'}: the user sees "Document unavailable".`,
  ];
  if (documents.length > 0) {
    lines.push('Saved documents:', ...documents.map((doc) => `- ${doc.id}: ${doc.name}`));
  } else {
    lines.push('There are no saved documents.');
  }
  lines.push(
    'Write the whole message again, copying ids exactly from this list, or without the link if the document is not saved. The user sees your new message instead of the last one. Do not mention this correction.',
  );
  return lines.join('\n');
}

/**
 * The assistant links saved documents by id (`sa:document/<id>`), copying them from reports and
 * vault_read, and models miscopy long ids (gpt-6-luna changed the last characters of a UUID).
 * When its final message links an id the vault does not have, the host tells the model which one
 * and which documents are saved, and has it write the message again, once per prompt; the app
 * shows the new message in place of the old one (`assistant_rewrite`).
 */
export function registerDocumentLinkCheck(
  pi: ExtensionAPI,
  documents: () => Promise<SavedDocument[]>,
): void {
  let rewritten = false;
  pi.on('before_agent_start', () => {
    rewritten = false;
  });

  pi.on('turn_end', async (event) => {
    const { message } = event;
    if (rewritten || message.role !== 'assistant' || message.stopReason !== 'stop') return;
    const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const ids = linkedDocumentIds(text);
    if (ids.length === 0) return;
    let saved: SavedDocument[];
    try {
      saved = await documents();
    } catch (err) {
      hostLog('warn', `document links not checked: ${String(err)}`);
      return;
    }
    const known = new Set(saved.map((doc) => doc.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length === 0) return;
    rewritten = true;
    hostLog('warn', `the message links unknown documents (${unknown.join(', ')}): rewriting it`);
    return {
      entries: [
        ...event.entries,
        {
          type: 'custom_message',
          customType: REWRITE_MESSAGE_TYPE,
          content: unknownDocumentsMessage(unknown, saved),
          display: false,
        },
      ],
      continue: true,
    };
  });
}
