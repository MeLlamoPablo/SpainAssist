/**
 * A zip reader for the browser and Node: reads the central directory at once and inflates each
 * entry only when asked (`DecompressionStream`), so a large export or trace opens quickly.
 * Classic zip and Zip64, stored or deflated entries: what Playwright, the app's export
 * (`apps/desktop/src/main/export/zip.ts`) and browser captures (`@sa/browser` zip.ts) write.
 */

export interface ZipFile {
  /** Entry names, in the zip's order (no directories). */
  readonly names: string[];
  has(name: string): boolean;
  read(name: string): Promise<Uint8Array>;
  text(name: string): Promise<string>;
}

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

interface Entry {
  method: number;
  compressedSize: number;
  localOffset: number;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3;
}

export function readZip(bytes: Uint8Array): ZipFile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a zip file');
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const locator = end - 20;
  if (locator >= 0 && view.getUint32(locator, true) === END64_LOCATOR) {
    const end64 = Number(view.getBigUint64(locator + 8, true));
    if (view.getUint32(end64, true) === END64) {
      count = Number(view.getBigUint64(end64 + 32, true));
      at = Number(view.getBigUint64(end64 + 48, true));
    }
  }
  const decoder = new TextDecoder();
  const entries = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('Corrupt zip directory');
    const method = view.getUint16(at + 10, true);
    let compressedSize = view.getUint32(at + 20, true);
    let uncompressedSize = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    let localOffset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // Zip64 extra field: the 64-bit values of the fields set to 0xffffffff, in this order.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = view.getUint16(extra, true);
      const size = view.getUint16(extra + 2, true);
      if (id === 1) {
        let p = extra + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = Number(view.getBigUint64(p, true));
          p += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = Number(view.getBigUint64(p, true));
          p += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(p, true));
      }
      extra += 4 + size;
    }
    if (!name.endsWith('/')) entries.set(name, { method, compressedSize, localOffset });
    at = extraEnd + commentLength;
  }

  const read = async (name: string): Promise<Uint8Array> => {
    const entry = entries.get(name);
    if (!entry) throw new Error(`${name} is not in the zip`);
    const local = entry.localOffset;
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`Corrupt zip entry ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method !== 8) throw new Error(`Unsupported zip compression ${entry.method}`);
    return inflateRaw(data);
  };
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: async (name) => decoder.decode(await read(name)),
  };
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
