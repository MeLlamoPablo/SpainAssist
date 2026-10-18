/**
 * @sa/companion — the desktop ↔ phone channel for DNIe signatures (see `README.md`).
 *
 *  - `DesktopPairing`: the desktop's pairing (QR link, relay connection, handshake).
 *  - `PhoneSigner`: signature requests on top of a pairing.
 *  - `PhoneClient`: the phone side in tests; the Android app mirrors it.
 *  - Link and channel primitives, shared with the Kotlin app through `vectors/v1.json`.
 *
 * Plain Node library; no Electron imports.
 */
export * from './channel';
export * from './desktop';
export * from './link';
export * from './phone';
export * from './relay-socket';
export * from './signer';
