/**
 * Envelope encryption: a random 256-bit data key (wrapped by the KeyProvider in key.bin)
 * protects every vault file with AES-256-GCM.
 *
 * Encrypted file layout (vault.bin, documents/<id>.bin):
 *   0  "SAVF"                 magic
 *   4  u8  format version (1)
 *   5  u8  purpose (1 = state, 2 = document)
 *   6  8 bytes key check      first 8 bytes of HKDF(dataKey, "key-check"): tells "wrong key"
 *                             apart from "tampered file" in error messages
 *  14  12 bytes IV            random per write
 *  26  ciphertext
 * end  16 bytes GCM tag
 * AAD = the 26 header bytes + UTF-8 context ("vault.bin" or "document:<id>"), so a file cannot
 * be swapped for another document or re-labelled with another purpose or version.
 *
 * key.bin layout: "SAVK" | u8 version (1) | KeyProvider-wrapped data key.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { VaultError } from './errors';

const FILE_MAGIC = Buffer.from('SAVF', 'ascii');
const KEY_MAGIC = Buffer.from('SAVK', 'ascii');
const VERSION = 1;
const HEADER_LENGTH = 26;
const TAG_LENGTH = 16;

export const PURPOSE = { state: 1, document: 2 } as const;
export type Purpose = (typeof PURPOSE)[keyof typeof PURPOSE];

export interface DerivedKeys {
  state: Buffer;
  document: Buffer;
  check: Buffer;
}

export const DATA_KEY_LENGTH = 32;

export function deriveKeys(dataKey: Buffer): DerivedKeys {
  const derive = (info: string, length = 32) =>
    Buffer.from(hkdfSync('sha256', dataKey, Buffer.alloc(0), `sa-vault/v1/${info}`, length));
  return { state: derive('state'), document: derive('document'), check: derive('key-check', 8) };
}

function keyFor(keys: DerivedKeys, purpose: Purpose): Buffer {
  return purpose === PURPOSE.state ? keys.state : keys.document;
}

export function seal(keys: DerivedKeys, purpose: Purpose, context: string, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const header = Buffer.concat([FILE_MAGIC, Buffer.from([VERSION, purpose]), keys.check, iv]);
  const cipher = createCipheriv('aes-256-gcm', keyFor(keys, purpose), iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(context, 'utf8')]));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}

export function unseal(keys: DerivedKeys, purpose: Purpose, context: string, blob: Buffer): Buffer {
  const what = purpose === PURPOSE.state ? 'The vault file' : 'A document file';
  if (blob.length < HEADER_LENGTH + TAG_LENGTH || !blob.subarray(0, 4).equals(FILE_MAGIC)) {
    throw new VaultError('corrupted', `${what} is damaged or not a vault file`);
  }
  if (blob[4] !== VERSION) {
    throw new VaultError('corrupted', `${what} uses an unsupported format version (${blob[4]})`);
  }
  if (blob[5] !== purpose) throw new VaultError('corrupted', `${what} has the wrong type`);
  if (!blob.subarray(6, 14).equals(keys.check)) {
    throw new VaultError('corrupted', `${what} was encrypted with a different key`);
  }
  const header = blob.subarray(0, HEADER_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', keyFor(keys, purpose), blob.subarray(14, 26));
  decipher.setAAD(Buffer.concat([header, Buffer.from(context, 'utf8')]));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_LENGTH));
  try {
    return Buffer.concat([
      decipher.update(blob.subarray(HEADER_LENGTH, blob.length - TAG_LENGTH)),
      decipher.final(),
    ]);
  } catch (e) {
    throw new VaultError('corrupted', `${what} failed its integrity check (modified or damaged)`, {
      cause: e,
    });
  }
}

export function encodeKeyFile(wrapped: Buffer): Buffer {
  return Buffer.concat([KEY_MAGIC, Buffer.from([VERSION]), wrapped]);
}

export function decodeKeyFile(file: Buffer): Buffer {
  if (file.length <= 5 || !file.subarray(0, 4).equals(KEY_MAGIC) || file[4] !== VERSION) {
    throw new VaultError('corrupted', 'The vault key file is damaged');
  }
  return file.subarray(5);
}
