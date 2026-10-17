/**
 * Small helpers over asn1js for hand-built structures (PKCS#12, ad-hoc attributes). asn1js parses
 * BER (indefinite lengths, constructed strings), which real-world .p12 files use.
 */
import * as asn1js from 'asn1js';
import { asBuffer, toArrayBuffer } from './base64';

export type Asn1 = asn1js.AsnType;

class Asn1Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Asn1Error';
  }
}

export function parseBer(data: Uint8Array): Asn1 {
  const res = asn1js.fromBER(toArrayBuffer(data));
  if (res.offset === -1) throw new Asn1Error(`Invalid ASN.1: ${res.result.error}`);
  return res.result;
}

export function encodeDer(node: Asn1): Buffer {
  return Buffer.from((node as asn1js.BaseBlock).toBER(false));
}

/** The exact bytes a parsed element was decoded from (falls back to re-encoding). */
export function rawBytes(node: Asn1): Buffer {
  const view = (node as asn1js.BaseBlock).valueBeforeDecodeView;
  return view && view.byteLength > 0 ? Buffer.from(view) : encodeDer(node);
}

// --- builders ---------------------------------------------------------------------------------

export const seq = (...value: Asn1[]) =>
  new asn1js.Sequence({ value: value as asn1js.BaseBlock[] });
export const set = (...value: Asn1[]) => new asn1js.Set({ value: value as asn1js.BaseBlock[] });
export const oid = (value: string) => new asn1js.ObjectIdentifier({ value });
export const int = (value: number) => new asn1js.Integer({ value });
export const nul = () => new asn1js.Null();
export const octets = (value: Uint8Array) =>
  new asn1js.OctetString({ valueHex: toArrayBuffer(value) });
export const bmp = (value: string) => new asn1js.BmpString({ value });
export const utf8 = (value: string) => new asn1js.Utf8String({ value });
export const utcTime = (value: Date) => new asn1js.UTCTime({ valueDate: value });
/** Context-specific [n] EXPLICIT wrapper. */
export const explicit = (tagNumber: number, ...value: Asn1[]) =>
  new asn1js.Constructed({
    idBlock: { tagClass: 3, tagNumber },
    value: value as asn1js.BaseBlock[],
  });
/** Context-specific [n] IMPLICIT OCTET STRING. */
export const implicitOctets = (tagNumber: number, value: Uint8Array) =>
  new asn1js.Primitive({
    idBlock: { tagClass: 3, tagNumber },
    valueHex: toArrayBuffer(value),
  });

/** DER SET OF: elements sorted by their encodings (X.690 §11.6). */
export function derSetOf(elements: Uint8Array[]): Buffer {
  const sorted = [...elements].map((e) => asBuffer(e)).sort(Buffer.compare);
  const body = Buffer.concat(sorted);
  return Buffer.concat([Buffer.from([0x31]), derLength(body.length), body]);
}

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

// --- readers ----------------------------------------------------------------------------------

export function children(node: Asn1): Asn1[] {
  const vb = (node as asn1js.BaseBlock & { valueBlock: { value?: unknown } }).valueBlock;
  return Array.isArray(vb.value) ? (vb.value as Asn1[]) : [];
}

export function child(node: Asn1, index: number, what = 'element'): Asn1 {
  const c = children(node)[index];
  if (!c) throw new Asn1Error(`Missing ${what}`);
  return c;
}

export function isContext(node: Asn1 | undefined, tagNumber: number): boolean {
  const id = (node as asn1js.BaseBlock | undefined)?.idBlock;
  return !!id && id.tagClass === 3 && id.tagNumber === tagNumber;
}

export function oidOf(node: Asn1, what = 'OID'): string {
  if (!(node instanceof asn1js.ObjectIdentifier)) throw new Asn1Error(`Expected ${what}`);
  return node.valueBlock.toString();
}

export function intOf(node: Asn1, what = 'INTEGER'): number {
  if (!(node instanceof asn1js.Integer)) throw new Asn1Error(`Expected ${what}`);
  return Number(node.toBigInt());
}

/**
 * Bytes of an OCTET STRING, primitive or constructed (BER), or of an IMPLICIT [n] string.
 */
export function octetsOf(node: Asn1, what = 'OCTET STRING'): Buffer {
  if (node instanceof asn1js.OctetString) return Buffer.from(node.getValue());
  const block = node as asn1js.BaseBlock & {
    valueBlock: { valueHexView?: Uint8Array; value?: Asn1[] };
  };
  if (block.idBlock?.isConstructed) {
    return Buffer.concat((block.valueBlock.value ?? []).map((c) => octetsOf(c, what)));
  }
  if (block.valueBlock?.valueHexView) return Buffer.from(block.valueBlock.valueHexView);
  throw new Asn1Error(`Expected ${what}`);
}

export function stringOf(node: Asn1): string {
  const v = (node as { valueBlock?: { value?: unknown } }).valueBlock?.value;
  return typeof v === 'string' ? v : '';
}
