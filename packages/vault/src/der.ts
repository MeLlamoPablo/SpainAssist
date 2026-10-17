/**
 * Minimal ASN.1 reader (BER) and writer (DER) for the PKCS#12, PKCS#8 and X.509 structures the
 * vault handles. The reader accepts BER (indefinite lengths, constructed strings) because real
 * PKCS#12 exports from browsers and Java use it; the writer always emits DER.
 */

export class Asn1Error extends Error {
  override readonly name = 'Asn1Error';
}

export const TAG = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OID: 6,
  UTF8_STRING: 12,
  SEQUENCE: 16,
  SET: 17,
  NUMERIC_STRING: 18,
  PRINTABLE_STRING: 19,
  T61_STRING: 20,
  IA5_STRING: 22,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
  VISIBLE_STRING: 26,
  UNIVERSAL_STRING: 28,
  BMP_STRING: 30,
} as const;

const CLASS_UNIVERSAL = 0;
const CLASS_CONTEXT = 2;

export interface Asn1Node {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  tag: number;
  /** Content octets (for constructed nodes: the encoded children). */
  content: Buffer;
  children: Asn1Node[];
  /** The whole encoding of this node (identifier, length, content). */
  raw: Buffer;
}

const MAX_DEPTH = 48;

/** Parses one BER/DER element that must span the whole buffer. */
export function parseAsn1(buf: Buffer): Asn1Node {
  const { node, end } = readNode(buf, 0, buf.length, 0);
  if (end !== buf.length) throw new Asn1Error('Trailing data after ASN.1 element');
  return node;
}

function readNode(
  buf: Buffer,
  offset: number,
  limit: number,
  depth: number,
): { node: Asn1Node; end: number } {
  if (depth > MAX_DEPTH) throw new Asn1Error('ASN.1 nesting too deep');
  const start = offset;
  if (offset >= limit) throw new Asn1Error('Unexpected end of ASN.1 data');
  let b = buf[offset++]!;
  const cls = b >> 6;
  const constructed = (b & 0x20) !== 0;
  let tag = b & 0x1f;
  if (tag === 0x1f) {
    tag = 0;
    do {
      if (offset >= limit) throw new Asn1Error('Truncated ASN.1 tag');
      b = buf[offset++]!;
      tag = tag * 128 + (b & 0x7f);
      if (tag > 0x1fffff) throw new Asn1Error('ASN.1 tag too large');
    } while (b & 0x80);
  }
  if (offset >= limit) throw new Asn1Error('Truncated ASN.1 length');
  const lengthByte = buf[offset++]!;

  if (lengthByte === 0x80) {
    // BER indefinite length: children until an end-of-contents marker (00 00).
    if (!constructed) throw new Asn1Error('Indefinite length on a primitive ASN.1 element');
    const children: Asn1Node[] = [];
    const contentStart = offset;
    for (;;) {
      if (offset + 2 > limit) throw new Asn1Error('Missing ASN.1 end-of-contents');
      if (buf[offset] === 0 && buf[offset + 1] === 0) {
        const content = buf.subarray(contentStart, offset);
        offset += 2;
        return {
          node: { cls, constructed, tag, content, children, raw: buf.subarray(start, offset) },
          end: offset,
        };
      }
      const child = readNode(buf, offset, limit, depth + 1);
      children.push(child.node);
      offset = child.end;
    }
  }

  let length: number;
  if (lengthByte < 0x80) {
    length = lengthByte;
  } else {
    const count = lengthByte & 0x7f;
    if (count > 4) throw new Asn1Error('ASN.1 length too large');
    if (offset + count > limit) throw new Asn1Error('Truncated ASN.1 length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[offset++]!;
  }
  const end = offset + length;
  if (end > limit) throw new Asn1Error('ASN.1 length exceeds the available data');
  const content = buf.subarray(offset, end);
  const children: Asn1Node[] = [];
  if (constructed) {
    let pos = offset;
    while (pos < end) {
      const child = readNode(buf, pos, end, depth + 1);
      children.push(child.node);
      pos = child.end;
    }
  }
  return {
    node: { cls, constructed, tag, content, children, raw: buf.subarray(start, end) },
    end,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------------------------

export function isUniversal(node: Asn1Node | undefined, tag: number): node is Asn1Node {
  return node !== undefined && node.cls === CLASS_UNIVERSAL && node.tag === tag;
}

export function isContext(node: Asn1Node | undefined, tag: number): node is Asn1Node {
  return node !== undefined && node.cls === CLASS_CONTEXT && node.tag === tag;
}

/** Children of a SEQUENCE (or SET), checking the tag. */
export function sequence(
  node: Asn1Node | undefined,
  what: string,
  tag: number = TAG.SEQUENCE,
): Asn1Node[] {
  if (!isUniversal(node, tag) || !node.constructed) throw new Asn1Error(`Expected ${what}`);
  return node.children;
}

/** The single element inside an EXPLICIT context tag `[n]`. */
export function explicit(node: Asn1Node | undefined, tag: number, what: string): Asn1Node {
  if (!isContext(node, tag) || !node.constructed || node.children.length !== 1) {
    throw new Asn1Error(`Expected [${tag}] ${what}`);
  }
  return node.children[0]!;
}

export function readOid(node: Asn1Node | undefined): string {
  if (!isUniversal(node, TAG.OID) || node.constructed || node.content.length === 0) {
    throw new Asn1Error('Expected OBJECT IDENTIFIER');
  }
  const bytes = node.content;
  const arcs: number[] = [];
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    value = value * 128 + (b & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER / 128) throw new Asn1Error('OID arc too large');
    if ((b & 0x80) === 0) {
      if (arcs.length === 0) {
        const first = value < 40 ? 0 : value < 80 ? 1 : 2;
        arcs.push(first, value - first * 40);
      } else {
        arcs.push(value);
      }
      value = 0;
    } else if (i === bytes.length - 1) {
      throw new Asn1Error('Truncated OID');
    }
  }
  return arcs.join('.');
}

/**
 * Contents of an OCTET STRING, including BER constructed strings and IMPLICIT context tags
 * (pass `implicit` to skip the tag check).
 */
export function readOctets(node: Asn1Node | undefined, implicit = false): Buffer {
  if (!node) throw new Asn1Error('Expected OCTET STRING');
  if (!implicit && !isUniversal(node, TAG.OCTET_STRING))
    throw new Asn1Error('Expected OCTET STRING');
  if (!node.constructed) return node.content;
  return Buffer.concat(node.children.map((c) => readOctets(c, true)));
}

/** Small non-negative INTEGER (iteration counts, versions, key lengths). */
export function readSmallInt(node: Asn1Node | undefined): number {
  if (!isUniversal(node, TAG.INTEGER) || node.constructed || node.content.length === 0) {
    throw new Asn1Error('Expected INTEGER');
  }
  const bytes = node.content;
  if (bytes[0]! & 0x80) throw new Asn1Error('Negative INTEGER');
  if (bytes.length > 6) throw new Asn1Error('INTEGER too large');
  let value = 0;
  for (const b of bytes) value = value * 256 + b;
  return value;
}

/** Decodes any ASN.1 string type to a JS string. */
export function readString(node: Asn1Node | undefined): string {
  if (!node || node.cls !== CLASS_UNIVERSAL) throw new Asn1Error('Expected a string');
  const bytes = node.constructed ? readOctets(node, true) : node.content;
  switch (node.tag) {
    case TAG.UTF8_STRING:
      return bytes.toString('utf8');
    case TAG.BMP_STRING:
      return decodeUtf16be(bytes);
    case TAG.UNIVERSAL_STRING: {
      let out = '';
      for (let i = 0; i + 3 < bytes.length; i += 4)
        out += String.fromCodePoint(bytes.readUInt32BE(i));
      return out;
    }
    case TAG.PRINTABLE_STRING:
    case TAG.IA5_STRING:
    case TAG.NUMERIC_STRING:
    case TAG.VISIBLE_STRING:
    case TAG.T61_STRING:
      // T61 is treated as Latin-1, which is what real certificates put in it.
      return bytes.toString('latin1');
    default:
      throw new Asn1Error(`Unsupported string type ${node.tag}`);
  }
}

function decodeUtf16be(bytes: Buffer): string {
  const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return swapped.toString('utf16le');
}

// ---------------------------------------------------------------------------------------------
// DER writer
// ---------------------------------------------------------------------------------------------

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Encodes one element; `identifier` is the full first byte (class | constructed | tag < 31). */
export function tlv(identifier: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([identifier]), encodeLength(content.length), content]);
}

function encodeOid(dotted: string): Buffer {
  const arcs = dotted.split('.').map((s) => {
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < 0) throw new Asn1Error(`Invalid OID ${dotted}`);
    return n;
  });
  if (arcs.length < 2) throw new Asn1Error(`Invalid OID ${dotted}`);
  const out: number[] = [];
  const push = (value: number) => {
    const stack = [value & 0x7f];
    let v = Math.floor(value / 128);
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v = Math.floor(v / 128);
    }
    out.push(...stack);
  };
  push(arcs[0]! * 40 + arcs[1]!);
  for (const arc of arcs.slice(2)) push(arc);
  return Buffer.from(out);
}

function encodeInteger(value: number | bigint | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    // Unsigned big-endian magnitude.
    let i = 0;
    while (i < value.length - 1 && value[i] === 0) i++;
    const trimmed = value.subarray(i);
    return trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed);
  }
  let n = BigInt(value);
  if (n < 0n) throw new Asn1Error('Negative integers are not supported');
  const bytes: number[] = [];
  do {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  } while (n > 0n);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return Buffer.from(bytes);
}

function encodeUtf16be(s: string): Buffer {
  const le = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < le.length; i += 2) {
    const a = le[i]!;
    le[i] = le[i + 1]!;
    le[i + 1] = a;
  }
  return le;
}

function encodeTime(date: Date): Buffer {
  const y = date.getUTCFullYear();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const rest =
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z';
  // RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
  if (y >= 1950 && y < 2050) return tlv(TAG.UTC_TIME, Buffer.from(pad(y % 100) + rest, 'ascii'));
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(pad(y, 4) + rest, 'ascii'));
}

export const der = {
  sequence: (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items)),
  /** SET OF: DER requires the encodings sorted. */
  set: (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat([...items].sort(Buffer.compare))),
  oid: (dotted: string): Buffer => tlv(TAG.OID, encodeOid(dotted)),
  octets: (bytes: Buffer): Buffer => tlv(TAG.OCTET_STRING, bytes),
  integer: (value: number | bigint | Buffer): Buffer => tlv(TAG.INTEGER, encodeInteger(value)),
  null: (): Buffer => Buffer.from([TAG.NULL, 0]),
  boolean: (value: boolean): Buffer => tlv(TAG.BOOLEAN, Buffer.from([value ? 0xff : 0])),
  bitString: (bytes: Buffer): Buffer =>
    tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), bytes])),
  utf8: (s: string): Buffer => tlv(TAG.UTF8_STRING, Buffer.from(s, 'utf8')),
  printable: (s: string): Buffer => tlv(TAG.PRINTABLE_STRING, Buffer.from(s, 'ascii')),
  bmp: (s: string): Buffer => tlv(TAG.BMP_STRING, encodeUtf16be(s)),
  time: encodeTime,
  /** `[n] EXPLICIT` wrapper around one encoded element. */
  explicit: (n: number, inner: Buffer): Buffer => tlv(0xa0 | n, inner),
  /** `[n] IMPLICIT` primitive (e.g. EncryptedContentInfo.encryptedContent). */
  implicitPrimitive: (n: number, content: Buffer): Buffer => tlv(0x80 | n, content),
};
