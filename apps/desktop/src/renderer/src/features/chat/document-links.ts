import { parseAppLink } from '@sa/shared';

/** The parts of a hast node (react-markdown's `node` prop) this module reads. */
export interface MdNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: MdNode[];
}

/**
 * The document ids of a paragraph made only of `sa:document/<id>` links (one or more, separated
 * by whitespace or line breaks): the chat shows those as document cards. Null for any other
 * paragraph, where document links stay inline links.
 */
export function standaloneDocumentIds(paragraph: MdNode | undefined): string[] | null {
  const ids: string[] = [];
  for (const child of paragraph?.children ?? []) {
    if (child.type === 'text' && !child.value?.trim()) continue;
    if (child.type === 'element' && child.tagName === 'br') continue;
    if (child.type !== 'element' || child.tagName !== 'a') return null;
    const href = child.properties?.href;
    const link = parseAppLink(typeof href === 'string' ? href : undefined);
    if (link?.kind !== 'document') return null;
    ids.push(link.id);
  }
  return ids.length ? ids : null;
}

const TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/heic': 'HEIC',
  'image/webp': 'WEBP',
  'text/plain': 'TXT',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.oasis.opendocument.text': 'ODT',
};

/** A short file type for people ("PDF"), from the MIME type or else the name's extension. */
export function fileTypeLabel(mimeType: string, name: string): string | null {
  const known = TYPE_LABELS[mimeType];
  if (known) return known;
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1];
  return ext ? ext.toUpperCase() : null;
}
