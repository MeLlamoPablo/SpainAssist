import { z } from 'zod';
import { DniAccessNumber, DniePin } from './vault';

/**
 * Contract between the desktop app and the phone app ("Spain Assist") that signs with
 * the user's DNIe over NFC. Messages are JSON, end-to-end encrypted by `@sa/companion` and
 * carried by `services/relay-server`, which sees only ciphertext. The Android app mirrors these
 * schemas in Kotlin (`apps/mobile/shared/src/commonMain/kotlin/es/spainassist/firma/protocol`).
 * Change both sides together, and bump COMPANION_PROTOCOL when old apps can't follow.
 *
 * A signature, seen from the desktop (the user typed the CAN and the PIN on the desktop first,
 * DECISIONS D20; the phone never asks for them):
 *   sign.request (with can, pin) ─▶ phone shows what and for whom, the user approves and holds
 *                   the card to the phone
 *   ◀─ sign.progress (reviewing → card → reading → signing), any number of times
 *   ◀─ sign.certificate (read from the card, for `purpose: "document"` and `"certificate"`)
 *   sign.toBeSigned (seq 1..n) ─▶ ◀─ sign.signature (same seq), while the card stays near
 *   ◀─ sign.need, when the card refused the CAN or the PIN: the desktop asks the user and
 *      answers with sign.unlock ─▶, and the request goes on
 *   sign.done ─▶  (or sign.cancel from the desktop, sign.error from the phone, at any point)
 */
export const COMPANION_PROTOCOL = 6;

/** Standard Base64 (with padding), as both JSON encoders produce it. */
const Base64 = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);

const RequestId = z.uuid();

/** Largest document the desktop sends to the phone for review (the PDF or XML itself). */
export const COMPANION_MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
/** Largest decrypted message, after joining fragments. */
export const COMPANION_MAX_MESSAGE_BYTES = 24 * 1024 * 1024;
const DOCUMENT_B64 = Math.ceil(COMPANION_MAX_DOCUMENT_BYTES / 3) * 4;

/** RSA PKCS#1 v1.5 algorithms the DNIe can compute (the host hashes; the card pads and signs). */
export const CompanionAlgorithm = z.enum([
  'SHA1withRSA',
  'SHA256withRSA',
  'SHA384withRSA',
  'SHA512withRSA',
]);
export type CompanionAlgorithm = z.infer<typeof CompanionAlgorithm>;

// ---------------------------------------------------------------------------------------------
// Handshake payloads (inside the HELLO / WELCOME frames)
// ---------------------------------------------------------------------------------------------

export const CompanionHello = z.strictObject({
  type: z.literal('hello'),
  protocol: z.number().int().positive(),
  /** Phone app version, e.g. "1.0.0". */
  app: z.string().min(1).max(40),
  platform: z.enum(['android', 'ios', 'test']),
  /** Device model shown on the desktop ("Pixel 8"). */
  device: z.string().min(1).max(80),
});
export type CompanionHello = z.infer<typeof CompanionHello>;

export const CompanionWelcome = z.strictObject({
  type: z.literal('welcome'),
  protocol: z.number().int().positive(),
  /** Desktop app version. */
  app: z.string().min(1).max(40),
  /** When the pairing ends (ISO 8601); the phone forgets it then. */
  expiresAt: z.iso.datetime(),
  /**
   * The pairing's own secret (32 bytes, Base64), only in the WELCOME that answers the QR's secret. The
   * phone keeps it and uses it in every later handshake; the desktop stops accepting the QR's, so
   * a leaked QR is useless once a phone has paired (D26).
   */
  session: z
    .string()
    .regex(/^[A-Za-z0-9+/]{43}=$/)
    .optional(),
});
export type CompanionWelcome = z.infer<typeof CompanionWelcome>;

// ---------------------------------------------------------------------------------------------
// Desktop → phone
// ---------------------------------------------------------------------------------------------

export const CompanionDocument = z.strictObject({
  /** File name when known ("solicitud.pdf"). */
  name: z.string().min(1).max(200).optional(),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().nonnegative(),
  /** Hex SHA-256 of the bytes, shown for documents too large to send. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** The document (Base64) when it is at most COMPANION_MAX_DOCUMENT_BYTES. */
  data: Base64(DOCUMENT_B64).optional(),
});
export type CompanionDocument = z.infer<typeof CompanionDocument>;

/**
 * What a sign request asks for:
 * - `login`: approve a site and use AUTENTICACIÓN for already-hashed TLS handshake digests;
 * - `document`: sign one or more documents (`documents`), after the user reviews them;
 * - `certificate`: only read the signing certificate (AutoScript `selectCertificate`); nothing
 *   is signed.
 */
export const CompanionPurpose = z.enum(['document', 'certificate', 'login']);
export type CompanionPurpose = z.infer<typeof CompanionPurpose>;

export const CompanionSignRequest = z.strictObject({
  type: z.literal('sign.request'),
  requestId: RequestId,
  purpose: CompanionPurpose,
  /** Origin of the site that asks (https://sede.example.gob.es). */
  origin: z.url().max(2048),
  /** Plain-language description, in Spanish, built by the desktop signer (several lines). */
  description: z.string().min(1).max(4000),
  /** Signature format as the site named it ("PAdES", "CAdEStri"...). */
  format: z.string().max(64),
  documents: z.array(CompanionDocument).max(20),
  /**
   * True when every `sign.toBeSigned` of this request carries a `check` that binds it to one of
   * `documents`: the phone then refuses anything that doesn't match what the user reviewed.
   * False for formats where the phone can't check it (XAdES, triphase, precalculated hashes):
   * the phone tells the user before they approve.
   */
  verifiable: z.boolean(),
  /** How many signatures follow, when known (batches). */
  signatures: z.number().int().min(1).max(500).optional(),
  /** The desktop gives up after this (ISO 8601). */
  expiresAt: z.iso.datetime(),
  /**
   * The DNI's CAN, as the user typed it on the desktop (or Mis datos has it from the scanned
   * DNI). Only inside the encrypted channel, never in the QR. The phone never stores it.
   */
  can: DniAccessNumber,
  /**
   * The DNIe PIN the user typed on the desktop (D20). Required for `document` and `login`, left
   * out for `certificate` (reading the certificate needs no PIN). The phone uses it for this
   * request only, never stores it, and never tries a PIN the card refused again (`sign.need`).
   * The desktop sends it once: a request sent again after a reconnect leaves it out, and the
   * phone then asks for it with `sign.need`.
   */
  pin: DniePin.optional(),
});
export type CompanionSignRequest = z.infer<typeof CompanionSignRequest>;

/**
 * Proof that a to-be-signed blob belongs to a reviewed document:
 * - `cms`: `data` is the DER `SET OF Attribute` of a CMS SignerInfo; its messageDigest must be
 *   the hash of `documents[document]` (with the algorithm's digest);
 * - `pades`: the signed PDF is `documents[document]` followed by `update` (an incremental
 *   update with the signature dictionary). `byteRange` is the signature's /ByteRange; the
 *   messageDigest of `data` must be the hash of those bytes, the gap must be the hex /Contents
 *   placeholder, and the update must hold no stream except its own cross-reference stream
 *   (`/Type /XRef` in that stream's dictionary, pointed to by the update's `startxref`).
 */
export const CompanionCheck = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cms'), document: z.number().int().min(0).max(19) }),
  z.strictObject({
    kind: z.literal('pades'),
    document: z.number().int().min(0).max(19),
    update: Base64(4 * 1024 * 1024),
    byteRange: z.tuple([
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
      z.number().int().nonnegative(),
    ]),
  }),
]);
export type CompanionCheck = z.infer<typeof CompanionCheck>;

export const CompanionToBeSigned = z.strictObject({
  type: z.literal('sign.toBeSigned'),
  requestId: RequestId,
  /** 1, 2, 3... within the request. */
  seq: z.number().int().min(1).max(500),
  algorithm: CompanionAlgorithm,
  /** The bytes to sign; the phone hashes them unless prehashed is true. */
  data: Base64(256 * 1024),
  /** TLS digest, already hashed; only allowed for login requests. */
  prehashed: z.boolean().optional(),
  check: CompanionCheck.optional(),
});
export type CompanionToBeSigned = z.infer<typeof CompanionToBeSigned>;

/**
 * The CAN or the PIN the phone asked for with `sign.need`, typed by the user on the desktop.
 * Carries exactly the one asked for. `expiresAt` is the request's new deadline (the user took
 * time to type it). Sent once, like the request's `pin`.
 */
export const CompanionSignUnlock = z.strictObject({
  type: z.literal('sign.unlock'),
  requestId: RequestId,
  can: DniAccessNumber.optional(),
  pin: DniePin.optional(),
  expiresAt: z.iso.datetime(),
});
export type CompanionSignUnlock = z.infer<typeof CompanionSignUnlock>;

export const CompanionSignDone = z.strictObject({
  type: z.literal('sign.done'),
  requestId: RequestId,
});

export const CompanionCancelReason = z.enum(['cancelled', 'timeout', 'failed']);
export type CompanionCancelReason = z.infer<typeof CompanionCancelReason>;

export const CompanionSignCancel = z.strictObject({
  type: z.literal('sign.cancel'),
  requestId: RequestId,
  reason: CompanionCancelReason,
});

/** Either side ends the pairing ("Desvincular"). */
export const CompanionBye = z.strictObject({ type: z.literal('bye') });

export const DesktopToPhone = z.discriminatedUnion('type', [
  CompanionSignRequest,
  CompanionSignUnlock,
  CompanionToBeSigned,
  CompanionSignDone,
  CompanionSignCancel,
  CompanionBye,
]);
export type DesktopToPhone = z.infer<typeof DesktopToPhone>;

// ---------------------------------------------------------------------------------------------
// Phone → desktop
// ---------------------------------------------------------------------------------------------

/**
 * - `reviewing`: the request is on the phone's screen;
 * - `card`: approved, waiting for the user to hold the card to the phone;
 * - `reading`: talking to the card (secure channel, PIN, certificate);
 * - `signing`: computing signatures.
 */
export const CompanionStage = z.enum(['reviewing', 'card', 'reading', 'signing']);
export type CompanionStage = z.infer<typeof CompanionStage>;

export const CompanionSignProgress = z.strictObject({
  type: z.literal('sign.progress'),
  requestId: RequestId,
  stage: CompanionStage,
});

export const CompanionSignCertificate = z.strictObject({
  type: z.literal('sign.certificate'),
  requestId: RequestId,
  /** DER certificates, leaf first (AUTENTICACIÓN for login, FIRMA otherwise). */
  certificates: z
    .array(Base64(16 * 1024))
    .min(1)
    .max(4),
});
export type CompanionSignCertificate = z.infer<typeof CompanionSignCertificate>;

export const CompanionSignature = z.strictObject({
  type: z.literal('sign.signature'),
  requestId: RequestId,
  seq: z.number().int().min(1).max(500),
  /** PKCS#1 v1.5 signature (256 bytes for the DNIe's RSA-2048 keys). */
  signature: Base64(1024),
});
export type CompanionSignature = z.infer<typeof CompanionSignature>;

/**
 * Why the phone did not sign:
 * - `rejected`: the user said no; `cancelled`: the user stopped half-way;
 * - `busy`: another request is in progress on the phone;
 * - `pin_blocked`: three wrong PINs (only a police station can unblock it);
 * - `card_unsupported`: not a DNIe 3.0/4.0, or a damaged card;
 * - `no_certificate`: the card has no signing (FIRMA) certificate;
 * - `certificate_expired`: the card's certificate is expired or not yet valid;
 * - `wrong_card`: a different card than the one this request started with;
 * - `binding_mismatch`: a to-be-signed blob didn't match the reviewed document;
 * - `nfc_unavailable`: the phone has no NFC, or the user didn't turn it on;
 * - `timeout`: the request expired on the phone;
 * - `protocol`: a message the phone could not use; `internal`: anything else.
 */
export const CompanionErrorCode = z.enum([
  'rejected',
  'cancelled',
  'busy',
  'pin_blocked',
  'card_unsupported',
  'no_certificate',
  'certificate_expired',
  'wrong_card',
  'binding_mismatch',
  'nfc_unavailable',
  'timeout',
  'protocol',
  'internal',
]);
export type CompanionErrorCode = z.infer<typeof CompanionErrorCode>;

export const CompanionSignError = z.strictObject({
  type: z.literal('sign.error'),
  requestId: RequestId,
  code: CompanionErrorCode,
  /** Technical detail for logs (never shown as is). */
  message: z.string().max(300).optional(),
});
export type CompanionSignError = z.infer<typeof CompanionSignError>;

/** What the phone needs again: the card's CAN or its PIN. */
export const CompanionNeed = z.enum(['can', 'pin']);
export type CompanionNeed = z.infer<typeof CompanionNeed>;

/**
 * The phone needs a new CAN or PIN for this request and waits for `sign.unlock`: the card
 * refused the one it had (`refused`; after a wrong PIN, `triesLeft` says how many tries the card
 * has left), or the request came without it (sent again after a reconnect). The phone sends it
 * again after a reconnect while it waits. It never carries a CAN or a PIN.
 */
export const CompanionSignNeed = z.strictObject({
  type: z.literal('sign.need'),
  requestId: RequestId,
  what: CompanionNeed,
  refused: z.boolean(),
  triesLeft: z.number().int().min(1).max(2).optional(),
});
export type CompanionSignNeed = z.infer<typeof CompanionSignNeed>;

export const PhoneToDesktop = z.discriminatedUnion('type', [
  CompanionSignProgress,
  CompanionSignCertificate,
  CompanionSignature,
  CompanionSignError,
  CompanionSignNeed,
  CompanionBye,
]);
export type PhoneToDesktop = z.infer<typeof PhoneToDesktop>;

// ---------------------------------------------------------------------------------------------
// Relay (services/relay-server): WebSocket control frames. Data frames are binary and opaque.
// ---------------------------------------------------------------------------------------------

/**
 * Desktop: `GET {relay}/v1/rooms/{roomId}/desktop` with `Authorization: Bearer <desktop key>`
 * (the first connection creates the room and binds it to the key). Phone:
 * `GET {relay}/v1/rooms/{roomId}/phone`. Room ids are 16 random bytes, Base64url.
 */
export const RELAY_ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

/** Text frames from the relay. */
export const RelayControl = z.discriminatedUnion('type', [
  /** Whether the other side is connected (sent on connect and on every change). */
  z.object({ type: z.literal('peer'), present: z.boolean() }),
  z.object({ type: z.literal('pong') }),
]);
export type RelayControl = z.infer<typeof RelayControl>;

/** Close codes the relay uses (WebSocket application range). */
export const RELAY_CLOSE = {
  unauthorized: 4401,
  /** Phone: the room doesn't exist (the desktop never connected, or it expired). */
  notFound: 4404,
  /** The room reached its lifetime. */
  expired: 4408,
  /** A newer connection took this side's place. */
  replaced: 4409,
  /** A limit of the room or of the client's address. */
  limited: 4429,
} as const;
