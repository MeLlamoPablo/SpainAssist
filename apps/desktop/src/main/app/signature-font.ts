/**
 * The script font of visible PDF signatures (Great Vibes, OFL), bundled into the main process as
 * a data URL. Only the Electron entry imports it: `?inline` needs the Vite build.
 */
import signatureFontUrl from '@sa/signer/assets/great-vibes-latin.ttf?inline';

export const signatureFont = new Uint8Array(
  Buffer.from(signatureFontUrl.slice(signatureFontUrl.indexOf(',') + 1), 'base64'),
);
