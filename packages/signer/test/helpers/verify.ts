/** Independent verification helpers (pkijs) for CMS signatures. */
import crypto from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

pkijs.setEngine(
  'node',
  new pkijs.CryptoEngine({ name: 'node', crypto: crypto.webcrypto as Crypto }),
);

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export function parseSignedData(der: Uint8Array): pkijs.SignedData {
  const ci = pkijs.ContentInfo.fromBER(ab(der));
  return new pkijs.SignedData({ schema: ci.content });
}

/** Verifies signer `index` with pkijs (signature + message digest). */
export async function pkijsVerify(
  der: Uint8Array,
  index = 0,
  detachedData?: Uint8Array,
): Promise<boolean> {
  const sd = parseSignedData(der);
  return sd.verify({
    signer: index,
    data: detachedData ? ab(detachedData) : undefined,
    checkChain: false,
  });
}

export interface AttributeSummary {
  types: string[];
  signedAttrsDer: Buffer;
}

export function signedAttributeTypes(der: Uint8Array, index = 0): string[] {
  const sd = parseSignedData(der);
  return (sd.signerInfos[index].signedAttrs?.attributes ?? []).map((a) => a.type);
}

export function signedAttribute(
  der: Uint8Array,
  type: string,
  index = 0,
): asn1js.AsnType | undefined {
  const sd = parseSignedData(der);
  return sd.signerInfos[index].signedAttrs?.attributes.find((a) => a.type === type)?.values[0];
}

export { asn1js, pkijs };
