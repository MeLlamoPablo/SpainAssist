import type { DocumentKind, DocumentMeta } from '@sa/shared';
import { api } from './api';

export async function readFileBytes(file: File | Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

export function guessDocumentKind(file: File): DocumentKind {
  if (file.type.startsWith('image/')) return 'photo';
  return 'other';
}

/** Upload a user-picked file to the vault. */
export async function uploadToVault(
  file: File,
  opts: { kind?: DocumentKind; procedureId?: string; source?: 'user' | 'scan' } = {},
): Promise<DocumentMeta> {
  return api.invoke('vault.addDocument', {
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    kind: opts.kind ?? guessDocumentKind(file),
    bytes: await readFileBytes(file),
    procedureId: opts.procedureId,
    source: opts.source ?? 'user',
  });
}

/** Opens the OS file picker and resolves with the chosen files (empty if cancelled). */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files ? [...input.files] : []);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve([]);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}
