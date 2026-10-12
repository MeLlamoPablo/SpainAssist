/** Base64url without padding (room ids, the pairing link). */
export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not Base64url');
  return Buffer.from(text, 'base64url');
}

export function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}
