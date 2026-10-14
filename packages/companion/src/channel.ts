/**
 * End-to-end channel between the desktop and the phone, over the relay's binary frames.
 *
 * Frames (first byte is the type):
 *   CHALLENGE  0x01 | desktop nonce (16)                                     desktop → phone
 *   HELLO      0x02 | phone key (65) | phone nonce (16) | desktop nonce (16) | seq (8) | sealed
 *   WELCOME    0x03 | seq (8) | sealed                                       desktop → phone
 *   RECORD     0x10 | seq (8) | sealed                                       both ways
 *
 * Keys: Z = ECDH-P256(phone key, desktop key from the pairing link);
 *   HKDF-SHA256(ikm Z, salt = pairing secret, info = "sa-companion v1" | desktop key | phone key |
 *   desktop nonce | phone nonce) → 64 bytes: desktop→phone key, then phone→desktop key.
 * The pairing secret is the link's for the first handshake, then the one its WELCOME carries
 * (`session`): only the phone that paired knows it, and only the desktop holds its private key.
 * The fresh nonces on both sides make every connection's keys new (no replays).
 *
 * Sealed = AES-256-GCM(key, nonce = direction (4) | seq (8), AAD = the frame's header, i.e.
 * every byte before the ciphertext). Each direction counts from 0 (HELLO and WELCOME) and the
 * receiver requires exactly the next number. The plaintext of a record is flags (1) | bytes:
 * a message is split into fragments of at most FRAGMENT_BYTES; flag 0x01 marks the last one.
 */
import crypto from 'node:crypto';
import { COMPANION_MAX_MESSAGE_BYTES } from '@sa/shared';
import { u64 } from './bytes';
import { PUBLIC_KEY_BYTES } from './link';

export const FRAME = { challenge: 0x01, hello: 0x02, welcome: 0x03, record: 0x10 } as const;
export const NONCE_BYTES = 16;
export const FRAGMENT_BYTES = 256 * 1024;
const TAG_BYTES = 16;
const LAST = 0x01;
const INFO = Buffer.from('sa-companion v1', 'utf8');

export type Direction = 'desktopToPhone' | 'phoneToDesktop';
const DIRECTION_PREFIX: Record<Direction, Buffer> = {
  desktopToPhone: Buffer.from([0, 0, 0, 1]),
  phoneToDesktop: Buffer.from([0, 0, 0, 2]),
};

export class ChannelError extends Error {}

/** RFC 5869 with HMAC-SHA256 (built from HMAC so it runs on Electron's BoringSSL too). */
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let i = 1; blocks.length * 32 < length; i++) {
    previous = crypto
      .createHmac('sha256', prk)
      .update(previous)
      .update(info)
      .update(Buffer.from([i]))
      .digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

export interface KeyPair {
  publicKey: Buffer;
  /** ECDH secret (32 bytes). */
  privateKey: Buffer;
}

export function generateKeyPair(): KeyPair {
  const ecdh = crypto.createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  return { publicKey, privateKey: ecdh.getPrivateKey() };
}

export function ecdh(privateKey: Uint8Array, peerPublicKey: Uint8Array): Buffer {
  if (peerPublicKey.length !== PUBLIC_KEY_BYTES || peerPublicKey[0] !== 0x04)
    throw new ChannelError('Bad public key');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey));
  try {
    return ecdh.computeSecret(Buffer.from(peerPublicKey));
  } catch {
    throw new ChannelError('Bad public key');
  }
}

export interface SessionKeys {
  desktopToPhone: Buffer;
  phoneToDesktop: Buffer;
}

export function deriveSessionKeys(input: {
  shared: Uint8Array;
  secret: Uint8Array;
  desktopKey: Uint8Array;
  phoneKey: Uint8Array;
  desktopNonce: Uint8Array;
  phoneNonce: Uint8Array;
}): SessionKeys {
  const info = Buffer.concat([
    INFO,
    input.desktopKey,
    input.phoneKey,
    input.desktopNonce,
    input.phoneNonce,
  ]);
  const okm = hkdfSha256(input.shared, input.secret, info, 64);
  return { desktopToPhone: okm.subarray(0, 32), phoneToDesktop: okm.subarray(32, 64) };
}

function gcmNonce(direction: Direction, seq: bigint): Buffer {
  return Buffer.concat([DIRECTION_PREFIX[direction], u64(seq)]);
}

/** Seals frames in one direction, numbering them from 0. */
export class Sealer {
  private seq = 0n;
  constructor(
    private readonly key: Uint8Array,
    private readonly direction: Direction,
  ) {}

  /** `prefix` is the frame type and any header bytes that precede the sequence number. */
  seal(prefix: Uint8Array, plaintext: Uint8Array): Buffer {
    const seq = this.seq++;
    const header = Buffer.concat([prefix, u64(seq)]);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, gcmNonce(this.direction, seq));
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return Buffer.concat([header, body]);
  }
}

/** Opens frames of one direction, in order. Any failure means the session is broken. */
export class Opener {
  private seq = 0n;
  constructor(
    private readonly key: Uint8Array,
    private readonly direction: Direction,
  ) {}

  open(frame: Uint8Array, prefixLength: number): Buffer {
    const headerLength = prefixLength + 8;
    if (frame.length < headerLength + TAG_BYTES) throw new ChannelError('Short frame');
    const buf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    const seq = buf.readBigUInt64BE(prefixLength);
    if (seq !== this.seq) throw new ChannelError('Out of order');
    const header = buf.subarray(0, headerLength);
    const body = buf.subarray(headerLength, buf.length - TAG_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.key,
      gcmNonce(this.direction, seq),
    );
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    let plain: Buffer;
    try {
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new ChannelError('Bad frame');
    }
    this.seq++;
    return plain;
  }
}

/** Splits a JSON message into RECORD frames. */
export function sealMessage(sealer: Sealer, message: unknown): Buffer[] {
  const json = Buffer.from(JSON.stringify(message), 'utf8');
  if (json.length > COMPANION_MAX_MESSAGE_BYTES) throw new ChannelError('Message too large');
  const frames: Buffer[] = [];
  const prefix = Buffer.from([FRAME.record]);
  for (let at = 0; at === 0 || at < json.length; at += FRAGMENT_BYTES) {
    const chunk = json.subarray(at, at + FRAGMENT_BYTES);
    const last = at + FRAGMENT_BYTES >= json.length;
    frames.push(sealer.seal(prefix, Buffer.concat([Buffer.from([last ? LAST : 0]), chunk])));
  }
  return frames;
}

/** Joins the fragments of RECORD frames back into JSON messages. */
export class MessageAssembler {
  private parts: Buffer[] = [];
  private size = 0;

  /** Returns the parsed message when `plaintext` was its last fragment. */
  push(plaintext: Buffer): unknown | undefined {
    if (plaintext.length < 1) throw new ChannelError('Empty record');
    const chunk = plaintext.subarray(1);
    this.size += chunk.length;
    if (this.size > COMPANION_MAX_MESSAGE_BYTES) throw new ChannelError('Message too large');
    this.parts.push(chunk);
    if ((plaintext[0] & LAST) === 0) return undefined;
    const json = Buffer.concat(this.parts).toString('utf8');
    this.parts = [];
    this.size = 0;
    try {
      return JSON.parse(json);
    } catch {
      throw new ChannelError('Bad message');
    }
  }
}

/** Plaintext of HELLO / WELCOME: one fragment. */
export function singleRecord(message: unknown): Buffer {
  return Buffer.concat([Buffer.from([LAST]), Buffer.from(JSON.stringify(message), 'utf8')]);
}

export function parseSingleRecord(plaintext: Buffer): unknown {
  if (plaintext.length < 1 || plaintext[0] !== LAST) throw new ChannelError('Bad handshake');
  try {
    return JSON.parse(plaintext.subarray(1).toString('utf8'));
  } catch {
    throw new ChannelError('Bad handshake');
  }
}

export const HELLO_PREFIX_BYTES = 1 + PUBLIC_KEY_BYTES + NONCE_BYTES * 2;
