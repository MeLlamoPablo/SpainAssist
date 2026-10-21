import { createHash, createPublicKey, verify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

/**
 * Chrome's CRX3 packages, as Google's component updater serves them: checks the signature of the
 * key the package's id comes from, then unzips it. https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/crx3.proto
 */

const MAGIC = 'Cr24';
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');
/** The unpacked files of one package; a CRLSet is a few tens of KB. */
const MAX_UNPACKED = 16 * 1024 * 1024;

/** A component's id: the first 16 bytes of its key's SHA-256, each hex digit as a-p. */
function crxId(publicKeyDer: Buffer): string {
  const hex = createHash('sha256').update(publicKeyDer).digest('hex').slice(0, 32);
  return [...hex].map((d) => String.fromCharCode(97 + Number.parseInt(d, 16))).join('');
}

/**
 * The files of the CRX3 package `crx`, after checking it is signed by the key of component
 * `expectedId`. Throws on anything else.
 */
export function unpackCrx(crx: Buffer, expectedId: string): Map<string, Buffer> {
  if (crx.length < 12 || crx.toString('latin1', 0, 4) !== MAGIC) throw new Error('Not a CRX file');
  if (crx.readUInt32LE(4) !== 3) throw new Error('Not a CRX3 file');
  const headerEnd = 12 + crx.readUInt32LE(8);
  if (headerEnd > crx.length) throw new Error('Truncated CRX header');
  const header = readFields(crx.subarray(12, headerEnd));
  const archive = crx.subarray(headerEnd);

  const signedHeader = header.get(10000)?.[0];
  if (!signedHeader) throw new Error('CRX without signed data');
  const id = readFields(signedHeader).get(1)?.[0];
  if (id?.length !== 16) throw new Error('CRX without an id');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const message = Buffer.concat([SIGNED_DATA_PREFIX, length, signedHeader, archive]);

  // The proof of the key the id comes from; packages also carry others (Google's own).
  const proofs = [...(header.get(2) ?? []), ...(header.get(3) ?? [])].map(readFields);
  const proof = proofs.find((p) => {
    const key = p.get(1)?.[0];
    return key && createHash('sha256').update(key).digest().subarray(0, 16).equals(id);
  });
  const key = proof?.get(1)?.[0];
  const signature = proof?.get(2)?.[0];
  if (!key || !signature) throw new Error('CRX without a proof for its id');
  if (crxId(key) !== expectedId) throw new Error(`CRX of another component (${crxId(key)})`);
  const publicKey = createPublicKey({ key, format: 'der', type: 'spki' });
  if (!verify('sha256', message, publicKey, signature)) throw new Error('Bad CRX signature');
  return unzip(archive);
}

/** Length-delimited fields of a protobuf message, by field number (others are skipped). */
function readFields(buf: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  let pos = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (pos >= buf.length) throw new Error('Truncated protobuf');
      const byte = buf[pos++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    throw new Error('Bad protobuf varint');
  };
  while (pos < buf.length) {
    const tag = varint();
    const wire = tag % 8;
    const field = Math.floor(tag / 8);
    if (wire === 0) varint();
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      const len = varint();
      if (pos + len > buf.length) throw new Error('Truncated protobuf');
      fields.set(field, [...(fields.get(field) ?? []), buf.subarray(pos, pos + len)]);
      pos += len;
    } else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
  return fields;
}

/** The files of a zip archive (stored or deflated, no directories kept). */
function unzip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = zip.readUInt16LE(eocd + 10);
  let pos = zip.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('Bad zip');
    const method = zip.readUInt16LE(pos + 10);
    const compressed = zip.readUInt32LE(pos + 20);
    const size = zip.readUInt32LE(pos + 24);
    const nameLength = zip.readUInt16LE(pos + 28);
    const name = zip.toString('utf8', pos + 46, pos + 46 + nameLength);
    const local = zip.readUInt32LE(pos + 42);
    pos += 46 + nameLength + zip.readUInt16LE(pos + 30) + zip.readUInt16LE(pos + 32);
    if (name.endsWith('/')) continue;
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
      throw new Error(`Unsafe zip entry ${name}`);
    total += size;
    if (total > MAX_UNPACKED) throw new Error('Zip too large');
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50)
      throw new Error('Bad zip');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    const content =
      method === 0 ? Buffer.from(data) : method === 8 ? inflateRawSync(data) : undefined;
    if (!content || content.length !== size) throw new Error(`Bad zip entry ${name}`);
    files.set(name, content);
  }
  return files;
}
