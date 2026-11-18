/**
 * The fonts @sa/signer draws PDFs with, bundled into the main process as data URLs (OFL): the
 * script font of visible signatures (Great Vibes) and the font of filled-in text Helvetica can't
 * write (Noto Sans). Only the Electron entry imports them: `?inline` needs the Vite build.
 */
import signatureFontUrl from '@sa/signer/assets/great-vibes-latin.ttf?inline';
import formFontUrl from '@sa/signer/assets/noto-sans-regular.ttf?inline';

function bytes(dataUrl: string): Uint8Array {
  return new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
}

export const signatureFont = bytes(signatureFontUrl);
export const formFont = bytes(formFontUrl);
