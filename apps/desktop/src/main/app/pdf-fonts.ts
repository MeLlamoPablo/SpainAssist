/**
 * The fonts @sa/signer draws PDFs with, bundled into the main process as data URLs (OFL): the
 * script font of visible signatures (Great Vibes), the font of filled-in text Helvetica can't
 * write (Noto Sans) and the font of documents the agent writes (Lora). Only the
 * Electron entry imports them: `?inline` needs the Vite build.
 */

import type { DocumentFonts } from '@sa/signer';
import signatureFontUrl from '@sa/signer/assets/great-vibes-latin.ttf?inline';
import serifBoldUrl from '@sa/signer/assets/lora-bold.ttf?inline';
import serifBoldItalicUrl from '@sa/signer/assets/lora-bold-italic.ttf?inline';
import serifItalicUrl from '@sa/signer/assets/lora-italic.ttf?inline';
import serifRegularUrl from '@sa/signer/assets/lora-regular.ttf?inline';
import formFontUrl from '@sa/signer/assets/noto-sans-regular.ttf?inline';

function bytes(dataUrl: string): Uint8Array {
  return new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

export const signatureFont = bytes(signatureFontUrl);
export const formFont = bytes(formFontUrl);
export const documentFonts: DocumentFonts = {
  regular: bytes(serifRegularUrl),
  italic: bytes(serifItalicUrl),
  bold: bytes(serifBoldUrl),
  boldItalic: bytes(serifBoldItalicUrl),
};
