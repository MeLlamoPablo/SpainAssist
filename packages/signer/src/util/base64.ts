/** Base64 helpers matching what AutoFirma accepts and produces. */

const STANDARD_B64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes standard or URL-safe Base64, ignoring whitespace and missing padding.
 * Returns null when the text is not Base64 at all.
 */
export function decodeBase64(text: string): Buffer | null {
  const s = text.replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const unpadded = s.replace(/=+$/, '');
  if (!STANDARD_B64.test(unpadded) || unpadded.length % 4 === 1) return null;
  return Buffer.from(unpadded, 'base64');
}

/** Standard Base64 with padding (what the page receives). */
export function toBase64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

/** URL-safe Base64 keeping the '=' padding, like AutoFirma's `Base64.encode(data, true)`. */
export function toBase64Url(data: Uint8Array): string {
  return toBase64(data).replace(/\+/g, '-').replace(/\//g, '_');
}

/** Copies a Uint8Array/Buffer view into a standalone ArrayBuffer. */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}

export function asBuffer(data: Uint8Array | ArrayBuffer): Buffer {
  return data instanceof ArrayBuffer
    ? Buffer.from(data)
    : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}
