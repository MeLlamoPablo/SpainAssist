import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** HMAC-SHA256 with domain separation, so one pepper can safely serve several purposes. */
function hmacHex(pepper: string, purpose: string, value: string): string {
  return createHmac('sha256', pepper).update(`${purpose}:${value}`).digest('hex');
}

/** What we store for a voucher code: HMAC-SHA256 of its canonical body (see codes.ts). */
export function hashVoucherCode(normalizedBody: string, pepper: string): string {
  return hmacHex(pepper, 'voucher', normalizedBody);
}

/**
 * What we store for an OpenAI account: an HMAC of the ID token's issuer and subject (`sub` is a
 * public subject, the same for every client), never the id or e-mail itself.
 */
export function hashChatGPTAccount(issuer: string, subject: string, pepper: string): string {
  return hmacHex(pepper, 'chatgpt-account', `${issuer}|${subject}`);
}

const SEALED_PREFIX = 'v1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Parses KEY_ENCRYPTION_KEY: 32 random bytes as 64 hex characters or base64. Returns undefined
 * when the value has the wrong length.
 */
export function parseEncryptionKey(value: string): Buffer | undefined {
  const trimmed = value.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  return key.length === 32 ? key : undefined;
}

/**
 * AES-256-GCM: `v1.` + base64(iv | tag | ciphertext). `context` (e.g. the account hash) is
 * authenticated, so a ciphertext copied to another row does not decrypt.
 */
export function sealSecret(plaintext: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Inverse of sealSecret. Throws on a wrong key, a wrong context or tampering. */
export function openSecret(sealed: string, key: Buffer, context: string): string {
  if (!sealed.startsWith(SEALED_PREFIX)) throw new Error('unknown secret format');
  const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64');
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('secret too short');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison (hashes first, so lengths do not leak either). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
