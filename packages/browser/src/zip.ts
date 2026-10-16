/**
 * Minimal in-memory zip reading and writing for browser captures (capture.ts): enough to
 * rewrite a Playwright trace with its secrets scrubbed. Classic zip only (no Zip64), stored or
 * deflated entries.
 */
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8 = 0x0800;
const STORED = 0;
const DEFLATE = 8;

export function readZip(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== CENTRAL) throw new Error('corrupt zip directory');
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (zip.readUInt32LE(offset) !== LOCAL) throw new Error('corrupt zip entry');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(start, start + compressed);
    if (method === STORED) entries.push({ name, data: Buffer.from(raw) });
    else if (method === DEFLATE) entries.push({ name, data: inflateRawSync(raw) });
    else throw new Error(`unsupported zip compression ${method}`);
  }
  return entries;
}

export function writeZip(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(UTF8, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    chunks.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
