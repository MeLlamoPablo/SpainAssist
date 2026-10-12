import type { FileHandle } from 'node:fs/promises';
import { promisify } from 'node:util';
import { crc32, deflateRaw } from 'node:zlib';

const deflate = promisify(deflateRaw);
/** Classic zip (no Zip64): sizes and offsets are 32-bit, entry counts 16-bit. */
const MAX_SIZE = 0xffff_ffff;
const MAX_ENTRIES = 0xffff;
/** General purpose flag: names are UTF-8. */
const UTF8 = 0x0800;
const DEFLATE = 8;

export class ZipTooLargeError extends Error {
  constructor() {
    super('zip archive too large');
  }
}

interface CentralEntry {
  name: Buffer;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

/** Writes a deflated zip archive to an open file, one entry at a time (one in memory). */
export class ZipWriter {
  private readonly entries: CentralEntry[] = [];
  private offset = 0;
  private readonly time: number;
  private readonly date: number;

  constructor(
    private readonly file: FileHandle,
    modified: Date,
  ) {
    this.time =
      (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
    this.date =
      ((Math.max(modified.getFullYear(), 1980) - 1980) << 9) |
      ((modified.getMonth() + 1) << 5) |
      modified.getDate();
  }

  async add(path: string, data: Uint8Array): Promise<void> {
    const compressed = await deflate(data);
    if (
      this.entries.length >= MAX_ENTRIES ||
      data.length > MAX_SIZE ||
      this.offset + 30 + Buffer.byteLength(path) + compressed.length > MAX_SIZE
    )
      throw new ZipTooLargeError();
    const entry: CentralEntry = {
      name: Buffer.from(path, 'utf8'),
      crc: crc32(data),
      compressed: compressed.length,
      size: data.length,
      offset: this.offset,
    };
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    header.writeUInt16LE(UTF8, 6);
    header.writeUInt16LE(DEFLATE, 8);
    header.writeUInt16LE(this.time, 10);
    header.writeUInt16LE(this.date, 12);
    header.writeUInt32LE(entry.crc, 14);
    header.writeUInt32LE(entry.compressed, 18);
    header.writeUInt32LE(entry.size, 22);
    header.writeUInt16LE(entry.name.length, 26);
    await this.write(header, entry.name, compressed);
    this.entries.push(entry);
  }

  /** Writes the central directory. The caller closes the file. */
  async finish(): Promise<void> {
    const start = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // made by: 2.0
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(UTF8, 8);
      header.writeUInt16LE(DEFLATE, 10);
      header.writeUInt16LE(this.time, 12);
      header.writeUInt16LE(this.date, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.compressed, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt32LE(entry.offset, 42);
      await this.write(header, entry.name);
    }
    const size = this.offset - start;
    if (this.offset + 22 > MAX_SIZE) throw new ZipTooLargeError();
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
  }

  private async write(...chunks: Uint8Array[]): Promise<void> {
    for (const chunk of chunks) {
      await this.file.write(chunk);
      this.offset += chunk.length;
    }
  }
}
