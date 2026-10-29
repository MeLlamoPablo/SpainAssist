/**
 * A persona's documents: rendering them from their specs, and picking the one a form's document
 * field asks for. See `spec.ts`.
 */
import { createHash } from 'node:crypto';
import { stripDiacritics } from '../answers/text';
import { renderFactura, renderModelo621, renderTasa791 } from './pdf';
import { renderPhoto } from './photo';
import { type DocumentSpec, documentMimeType, type FixtureDocument } from './spec';

export type * from './spec';
export { documentMimeType } from './spec';

export interface RenderedDocument {
  name: string;
  mimeType: 'image/jpeg' | 'application/pdf';
  bytes: Uint8Array;
  /** Hex SHA-256 of `bytes`. */
  sha256: string;
}

const cache = new Map<string, Uint8Array>();

function draw(spec: DocumentSpec): Uint8Array {
  switch (spec.kind) {
    case 'contrato':
    case 'permiso':
    case 'ficha':
      return renderPhoto(spec);
    case 'modelo621':
      return renderModelo621(spec);
    case 'tasa791':
      return renderTasa791(spec);
    case 'factura':
      return renderFactura(spec);
  }
}

/** The file of a document. Drawn once per process and spec (a photo takes a moment). */
export function renderDocument(document: FixtureDocument): RenderedDocument {
  const key = JSON.stringify(document.spec);
  let bytes = cache.get(key);
  if (!bytes) {
    bytes = draw(document.spec);
    cache.set(key, bytes);
  }
  return {
    name: document.name,
    mimeType: documentMimeType(document.spec),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function fold(text: string): string {
  return stripDiacritics(text).toLowerCase();
}

/**
 * The document that answers a form's document field: the first of `documents`, not in `taken`,
 * whose `match` finds the field's label or key (accents and case ignored).
 */
export function documentForField(
  field: { key: string; label: string },
  documents: readonly FixtureDocument[],
  taken: ReadonlySet<string> = new Set(),
): FixtureDocument | undefined {
  const haystack = `${fold(field.label)}\n${fold(field.key)}`;
  return documents.find(
    (document) => !taken.has(document.key) && new RegExp(fold(document.match), 'i').test(haystack),
  );
}
