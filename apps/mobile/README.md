# Spain Assist (phone app)

Signs documents and approves certificate logins with the user's DNIe over NFC when SpainAssist on the computer asks. The desktop
shows a QR code; the phone pairs, shows each request (the PDF itself, or the XML or text), and
signs after the user approves and holds the card to the phone. The user types the DNIe's CAN
and PIN on the computer only (DECISIONS D20): they come with each request, and the phone never
asks for them. The protocol is in
`packages/companion/README.md`.

Compose Multiplatform. Android is the app today. The shared module also compiles for iOS (the
`iosArm64` and `iosSimulatorArm64` targets), so the common code stays portable.

| Module | What |
| --- | --- |
| `shared` (KMP library) | `protocol` (messages, mirroring `packages/shared/src/companion.ts`), `channel` (link, E2E channel on cryptography-kotlin), `relay` (ktor WebSocket client, `PhoneLink` handshake), `sign/Binding.kt` (CMS and PAdES checks), `app/FirmaController.kt` (the state machine), `ui` (Compose screens), strings in Spanish (default) and English |
| `androidApp` | `MainActivity` (deep links, NFC reader mode while waiting for the card), `nfc/` (`AndroidCardReader`, `JmulticardCard`, `IsoDepConnection`), `KeystoreStore`, CameraX + ML Kit QR scanner, `PdfRenderer` preview |

## How it handles the card

- [jmulticard](https://github.com/ctt-gob-es/jmulticard) 2.1 (the library Autofirma uses)
  provides PACE with the CAN (ECDH on Brainpool P-256r1), the CWA-14890 secure channel and PSO
  signatures with the FIRMA key. `jmulticard-crypto` bundles the BouncyCastle classes it needs:
  don't add BouncyCastle separately.
- It reads the certificates after PACE without the PIN. Every signature opens a new PACE channel
  and checks the PIN, as the card requires. The CAN and the PIN come with the request (the
  desktop asked the user for them, and keeps the PIN in memory for an hour). They serve that
  request only, are never stored or cached on the phone, and are dropped when the request ends.
- **The card moving (Autofirma's AA300103).** Reader mode checks presence every 2 seconds, not
  every 125 ms, and IsoDep waits up to 5 seconds per command. When the card does leave the field,
  `IsoDepConnection` flags it, and whatever jmulticard throws becomes "the card moved". The app
  waits for the card again, checks it's the same one, and signs what was pending. The copy tells
  users to put the card on a table and rest the phone on it.
- **Wrong PIN or CAN:** the phone asks the desktop for another (`sign.need`, with the tries left
  after a wrong PIN) and shows "type it on the computer" (a warning at one try left); the desktop
  asks the user and answers with `sign.unlock`. A CAN or PIN the card refused is never tried
  again while the app runs (the phone keeps only a SHA-256 of it in memory), not even from a
  request re-sent after a reconnect or a stale copy on the desktop: it asks again instead. So a
  wrong PIN costs one try. A request that comes without a PIN (re-sent to a restarted app) asks
  the desktop too. **Blocked PIN,
  no FIRMA certificate, expired certificate, not a DNIe 3.0/4.0, no NFC:** the request ends, and
  the desktop shows why.
- Reader mode is on only while the app waits for a card and is in front. The screen stays on
  meanwhile. Release builds set `FLAG_SECURE` (no screenshots or recents preview of documents).

## Build and test

JDK 17 (Gradle picks it from `gradle/gradle-daemon-jvm.properties`), the Android SDK with
platform 37 (Gradle downloads what's missing), and `local.properties` with `sdk.dir`
(gitignored).

```sh
cd apps/mobile
./gradlew :shared:testAndroidHostTest          # channel vectors, bindings, controller (JVM)
./gradlew :shared:compileKotlinIosSimulatorArm64  # the common code still builds for iOS
./gradlew :androidApp:assembleDebug            # es.spainassist.firma.debug, ws:// allowed
./gradlew :androidApp:assembleRelease          # R8, wss:// only (sign it for distribution)
```

- **Interop with the desktop**, without a phone or a card:
  `corepack pnpm --filter @sa/relay-server interop`. It runs the relay and a `DesktopPairing`,
  starts `InteropTest` (this app's controller, channel and ktor client, with a software RSA key
  as the DNIe), and signs CAdES, PAdES and XAdES through `@sa/signer`. Every signature is
  verified. The desktop sends the card's CAN and PIN with CAdES, XAdES and the login, and wrong
  ones with PAdES: the phone must try each wrong one once and ask the desktop for a new one.
- **On a phone, against a local desktop:** `corepack pnpm services` starts the relay on
  `0.0.0.0:8794`. `corepack pnpm dev:local` makes the desktop put this machine's LAN address in
  the QR. Install the debug APK and scan. Both must be on the same Wi-Fi, and the debug build
  allows `ws://`.
- **Screen preview** (debug builds): `PreviewActivity` shows any screen with mock data and no
  controller, at the design frames' layout (status bar, no navigation bar). Open it with
  `adb shell am start -n es.spainassist.firma.debug/es.spainassist.firma.android.PreviewActivity --es screen conectado`;
  the names (`inicio`, `vincular`, `revisar`, `pin`, `firmado`, `entrar-revisar`…) are in the
  file. A 1080×2400, 420 dpi emulator matches the Framer frames (411×914).
- **On an emulator** (no NFC, so up to "hold your DNIe"): `adb reverse tcp:8794 tcp:8794`, then
  open the link with `adb shell am start -a android.intent.action.VIEW -d "sa-firma://pair?d=<payload>"`.

## Before publishing

- **Licence.** Every APK must come with its complete source (see "Licence" below and
  `PRODUCTION_CHECKLIST.md`).
- **App Links.** Set `ANDROID_CERT_SHA256` on the relay to the Play App Signing and upload key
  fingerprints. Without them, links open the relay's `/p` page, which offers "Abrir en la app".
- **Play Store.** The listing ("Spain Assist", `es.spainassist.firma`), the
  release signing key, and the NFC requirement (`android.hardware.nfc` required).

Login uses the AUTENTICACIÓN certificate; documents use FIRMA. A `login` review shows the site
without a document. TLS digests arrive already hashed (`prehashed`); the card adapter wraps
DigestInfo without hashing them again, while preserving PACE/CWA cryptography. After approval,
cancel from the desktop. Protocol 6 (WELCOME's `session`, the pairing's own secret that replaces
the QR's, D26; protocol 5 the required `can`, `sign.need` and `sign.unlock`; protocol 4 the
optional `pin`, protocol 3 `can`) requires a matching desktop; old apps must update.

## Licence

Our code here is MIT (`LICENSE`). The Android app as distributed is EUPL-1.2 as a whole,
because the EUPL is the only licence every jmulticard file offers (`NOTICE`, DECISIONS D16).
So:

- every APK must come with its complete source (`Licenses.SOURCE_URL`, for every release);
- the app shows the licences under "Licencias de código abierto", on the start and home
  screens (`ui/LicensesScreen.kt`): the full texts in `composeResources/files/licenses`, the
  components in `AndroidLicenses.kt` (update it when a dependency changes), and the notices
  that ML Kit and Play services keep in their AARs, which the `merge<Variant>GoogleNotices`
  task copies into the APK's assets;
- ML Kit is proprietary: fine under the European Commission's reading of the EUPL, a risk
  under a strict one. ZXing (Apache-2.0) would remove the question.

The iOS app won't include jmulticard, so it will be plain MIT. Our own PACE and secure-channel
code would make Android plain MIT too, and iOS needs it anyway: CryptoKit has no Brainpool, so
iOS needs OpenSSL or pure-Kotlin EC.
