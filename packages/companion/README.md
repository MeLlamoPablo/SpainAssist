# @sa/companion

The channel between the desktop app and the phone app ("Spain Assist", `apps/mobile`),
which signs documents and TLS login digests with the user's DNIe over NFC. The relay
(`services/relay-server`) carries the frames and can't read them. The messages are a contract
in `@sa/shared` (`companion.ts`), and the Kotlin app mirrors this package
(`apps/mobile/shared/.../channel`, `relay`).

| Export | What |
| --- | --- |
| `DesktopPairing` | The desktop's pairing: QR link, relay connection, handshake, messages |
| `PhoneSigner` | Signature requests on top of a pairing, with an outbox re-sent after reconnects |
| `PhoneClient` | The phone side in TypeScript (tests; the Kotlin app follows it) |
| `@sa/companion/testing` | `MemoryRelay`, an in-memory relay for unit tests |

## Pairing link

The desktop shows `https://<relay host>/p#<payload>` as a QR code. The payload (Base64url, in
the fragment, so browsers never send it) holds:

```
version (1) = 1 | room id (16) | secret (32) | desktop public key (65, P-256 uncompressed)
| relay base URL (UTF-8: wss://, or ws:// for a development relay)
```

The phone app opens it as an App Link or scans it, and asks the user to confirm before pairing.
The relay's `/p` page also opens it as `sa-firma://pair?d=<payload>`. A pairing lasts 72 hours
(the desktop's lifetime). It ends earlier with "Desvincular" on either side, or when the
desktop app quits.

The QR works once. The WELCOME that answers its secret carries `session`, the pairing's
own secret; the phone stores the pairing with it in place of the QR's, and the desktop stops
accepting the QR's. A leaked QR is useless once a phone has paired. The desktop shows the QR
only until then; another phone pairs with a new QR (`companion.pairAnother`).

## Frames and keys

```
CHALLENGE  0x01 | desktop nonce (16)                                       desktop → phone
HELLO      0x02 | phone key (65) | phone nonce (16) | desktop nonce (16) | seq (8) | sealed
WELCOME    0x03 | seq (8) | sealed                                         desktop → phone
RECORD     0x10 | seq (8) | sealed                                         both ways
```

- Whenever the relay reports the phone present (either side connected or reconnected), the
  desktop sends a fresh CHALLENGE. The phone answers with HELLO, using a new P-256 key and nonce.
- Both sides compute `ECDH(phone key, desktop key)`. They feed it to HKDF-SHA256 with the
  pairing secret as salt (the link's for the first handshake, then the WELCOME's `session`)
  and `"sa-companion v1" | desktop key | phone key | desktop nonce | phone nonce` as info, which gives a desktop→phone key and a phone→desktop key (32 bytes each).
- Only the phone that paired knows the secret, and only the desktop holds its private key.
  The fresh nonces on both sides make each connection's keys new, so frames can't be replayed
  across connections.
- Sealed = AES-256-GCM with nonce `direction (4) | seq (8)` and AAD = the frame header. Each
  direction counts from 0 (HELLO and WELCOME), and the receiver requires exactly the next
  number. Any failure drops the session, and the next CHALLENGE starts a new one.
- A record's plaintext is `flags (1) | bytes`. Messages are JSON split into fragments of at
  most 256 KiB, with flag `0x01` on the last one. A joined message can be at most 24 MiB.
- `vectors/v1.json` holds fixed inputs and the exact bytes produced from them (and, under
  `bindings`, what `@sa/signer` sends for a CAdES and a PAdES signature). The Kotlin tests check
  against it. Regenerate it with `corepack pnpm --filter @sa/companion vectors` after changing
  the channel; `test/vectors.test.ts` fails while it's out of date.

The primitives are Node/BoringSSL and JCA/CryptoKit built-ins (P-256, HMAC, AES-GCM). HKDF is
built from HMAC so that it also runs on Electron.

## A signature

```
desktop                                            phone
(the user typed the CAN and the PIN on the desktop)
sign.request (documents, verifiable, can, pin?) ─▶ shows what, for whom; user approves and
                                                   holds the card
         ◀────────────────────────────────────    sign.progress reviewing / card / reading
         ◀────────────────────────────────────    sign.certificate (read from the card)
sign.toBeSigned seq 1 (+ check) ───────────────▶   checks the binding, card signs
         ◀────────────────────────────────────    sign.need, if the card refused the CAN or
                                                   the PIN (the phone waits)
sign.unlock (the new one the user typed) ──────▶   tries it
         ◀────────────────────────────────────    sign.progress signing, sign.signature 1
… more seqs (batches, triphase) …
sign.done ─────────────────────────────────────▶   "Firmado"
```

- **Bindings.** With `verifiable: true`, every `sign.toBeSigned` carries a `check`, and the
  phone refuses anything that doesn't match the documents the user reviewed (`binding_mismatch`):
  - `cms`: the bytes are CMS signed attributes whose messageDigest is the document's hash
    (CAdES built on the desktop).
  - `pades`: the signed PDF is the reviewed PDF plus an incremental update. The messageDigest
    covers its /ByteRange, the gap is the zero-filled /Contents placeholder, and the update adds
    no content streams.

  XAdES, triphase formats, precalculated hashes, cosignatures and countersignatures are not
  verifiable: the phone says so before the user approves. Documents over 12 MB are sent without
  their bytes, which also makes the request not verifiable.
- **Reconnects.** `PhoneSigner` keeps the request and every unanswered `sign.toBeSigned` in an
  outbox, and sends them again when a new session starts. The phone sends its last progress, the
  certificate and every signature again. Both sides ignore duplicates (same request id, same seq),
  so the card never signs a blob twice. A certificate that changes after a reconnect ends the
  request with `wrong_card`.
- **The CAN and the PIN**. The user types them on the desktop. `PhoneSignRequest.can`
  (six digits) always goes in the request; `pin` (8 to 16 characters) goes unless it's a
  certificate read. The pairing link never carries them. The PIN goes once: as soon as the phone
  answers anything for the request, `PhoneSigner` drops it from its outbox, so a request re-sent
  after a reconnect leaves it out. The phone uses them for that request only and never stores
  them. When the card refuses one, or the request came without the PIN, the phone sends
  `sign.need` (`what`, `refused`, `triesLeft`; again after a reconnect) and waits.
  `PhoneSigner` calls `onNeed` once, with the request's timers stopped, and sends what it
  resolves with as `sign.unlock` (once, like the PIN; with a new `expiresAt`), or cancels the
  request on null. The phone keeps a hash of each refused CAN and PIN in memory and never tries
  one again. The phone never sends a CAN or a PIN.
- **One request at a time.** A second request while one is active gets `busy`. A request that
  arrives right after `sign.done` (batches) replaces the finished one.
- **Timeouts (desktop).** 5 minutes for the user to review and read the card, then 90 seconds per
  signature. On expiry the desktop sends `sign.cancel` with `timeout`.

## Tests

`corepack pnpm --filter @sa/companion test`: the link, the channel (HKDF test vector, replay,
reordering, tampering, fragments), pairing and signing through `MemoryRelay` (reconnects, forged
secrets, unpairing, cancel, timeouts, large documents), and the vectors.
`services/relay-server` tests the same flow over real sockets. Its `interop` script runs the
Android app's Kotlin code against this package (see `apps/mobile/README.md`).

## Logins and versions

`login` requests show the site without a document, and `PhoneKey.sign(..., undefined, true)`
sends a pre-hashed TLS digest. The phone rejects this flag on document requests and requires it
on login requests. AUTENTICACIÓN is used for login, FIRMA for documents. `vectors/v1.json` also
holds login wire messages (with a `can` and a `pin`), a `sign.need` and a `sign.unlock`.

The application handshake carries `COMPANION_PROTOCOL` (6, in `@sa/shared`). Bump it when old
apps can't follow; phone and desktop must then be released together.
