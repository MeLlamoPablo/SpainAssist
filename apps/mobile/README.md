# Spain Assist (phone app)

Signs documents and approves certificate logins with the user's DNIe over NFC when SpainAssist on the computer asks. The desktop
shows a QR code; the phone pairs, shows each request (the PDF itself, or the XML or text), and
signs after the user approves, types the PIN (unless the computer sent the one saved in Mis
datos) and holds the card to the phone. The protocol is in
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
  and checks the PIN, as the card requires. A PIN the user types stays in memory for 60 minutes;
  it is never stored or sent. When the desktop's Mis datos has the PIN, the request carries it
  (D18) and there is no PIN step: that PIN serves that request only, is never stored or cached,
  and is dropped when the request ends. The CAN comes with the request when the desktop's Mis datos has it (scanned
  from the DNI), and then there is no CAN step; otherwise the user types it once. Either way it
  is stored in the Keystore-encrypted store once the card accepts it, and the desktop's CAN wins
  over the stored one.
- **The card moving (Autofirma's AA300103).** Reader mode checks presence every 2 seconds, not
  every 125 ms, and IsoDep waits up to 5 seconds per command. When the card does leave the field,
  `IsoDepConnection` flags it, and whatever jmulticard throws becomes "the card moved". The app
  waits for the card again, checks it's the same one, and signs what was pending. The copy tells
  users to put the card on a table and rest the phone on it.
- **Wrong PIN:** asked again, with the tries left (a warning at one), and never retried
  automatically. When the wrong one came from the desktop, the step also says the PIN saved on
  the computer is wrong (fix it in Mis datos), the phone tells the desktop (`sign.wrongPin`), and
  that PIN isn't tried again, not even from a request re-sent after a reconnect. The desktop
  then stops sending it. While the phone knows the card has fewer than three tries left (it saw a
  wrong PIN and no PIN was accepted since), it doesn't use a PIN from the desktop: the user types
  it. So a saved PIN costs at most one try. **Wrong CAN:** asked again, and the stored one is dropped. When the wrong one
  came from the desktop, the copy says the CAN saved on the computer doesn't match (fix it in
  Mis datos), and that CAN isn't tried again while the app runs. **Blocked PIN,
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
  verified. The desktop sends the card's CAN and PIN with CAdES and the login, and wrong ones with
  PAdES: the phone must ask for each only after the wrong one, try the wrong PIN once and report
  it.
- **On a phone, against a local desktop:** `corepack pnpm services` starts the relay on
  `0.0.0.0:8794`. `corepack pnpm dev:local` makes the desktop put this machine's LAN address in
  the QR. Install the debug APK and scan. Both must be on the same Wi-Fi, and the debug build
  allows `ws://`.
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
cancel from the desktop. Protocol 4 (the optional `pin` on requests and `sign.wrongPin`; protocol
3 added `can`) requires a matching desktop; old apps must update.

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
