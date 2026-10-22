# Spain Assist (phone app)

Signs documents and approves certificate logins with the user's DNIe over NFC when SpainAssist
on the computer asks. The desktop shows a QR code; the phone pairs, shows each request (the PDF
itself, or the XML or text), and signs after the user approves and holds the card to the phone.
The user types the DNIe's CAN and PIN on the computer only: they come with each request, and
the phone never asks for them. The protocol is in `packages/companion/README.md`.

Compose Multiplatform. There is only an Android app. The shared module also compiles for iOS
(the `iosArm64` and `iosSimulatorArm64` targets), so the common code stays portable.

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
  desktop asked the user for them and may keep them in its vault: the CAN with the DNI's data,
  the PIN with the DNIe credential). They serve that request only, are never stored or cached
  on the phone, and are dropped when the request ends.
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
  the desktop too.
- **Blocked PIN, no FIRMA certificate, expired certificate, not a DNIe 3.0/4.0, no NFC:** the
  request ends, and the desktop shows why.
- Reader mode is on only while the app waits for a card and is in front. The screen stays on
  meanwhile. Release builds set `FLAG_SECURE` (no screenshots or recents preview of documents).

## Build and test

JDK 17 (Gradle downloads it automatically from Adoptium: the URLs in
`gradle/gradle-daemon-jvm.properties` come from
`./gradlew updateDaemonJvm --jvm-version=17 --jvm-vendor=adoptium`; rerun it after bumping the
foojay resolver or the JDK), the Android SDK with
platform 37 (Gradle downloads what's missing), and `local.properties` with `sdk.dir`
(gitignored).

```sh
cd apps/mobile
./gradlew :shared:testAndroidHostTest          # channel vectors, bindings, controller (JVM)
./gradlew :shared:compileKotlinIosSimulatorArm64  # the common code still builds for iOS
./gradlew :androidApp:assembleDebug            # es.spainassist.firma.debug, ws:// allowed
./gradlew :androidApp:assembleRelease          # R8, wss:// only, unsigned (see "Releasing")
```

Debug builds appear as **Spain Assist Dev** with the blue Blueprint launcher icon (including
Android's themed icons). Their `.debug` application ID lets them coexist with production.

- **Interop with the desktop**, without a phone or a card:
  `corepack pnpm --filter @sa/relay-server interop`. It runs the relay and a `DesktopPairing`,
  starts `InteropTest` (this app's controller, channel and ktor client, with a software RSA key
  as the DNIe), and signs CAdES, PAdES and XAdES through `@sa/signer`. Every signature is
  verified. The desktop sends the card's CAN and PIN with CAdES, XAdES and the login, and wrong
  ones with PAdES: the phone must try each wrong one once and ask the desktop for a new one.
  Before the login it restarts the relay with the desktop held away, so the phone is refused
  its room (4404) first: it must keep the pairing and sign once the desktop is back.
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

## Releasing

Google Play with Play App Signing: Google keeps the app signing key and signs what users
install. We sign each bundle with our **upload key**, which Play Console can reset if it's lost.

**Once: the upload key.** The existing upload key is
`infra/terraform/secrets/android-upload.jks` in the main checkout. Its password is
`android_upload_keystore_password` in `terraform.tfvars`. Terraform sets the four signing
secrets below (`github_release.tf`). Keep backups in the password manager; only store keys in
the repo under the git-crypt encrypted `secrets/` path. For a new app, generate a new key:

```sh
keytool -genkeypair -v -keystore ~/spainassist-upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 9125 -dname "CN=Spain Assist"
```

Then add these repository secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
| --- | --- |
| `SA_UPLOAD_KEYSTORE_BASE64` | `base64 -i ~/spainassist-upload.jks \| pbcopy` |
| `SA_UPLOAD_KEYSTORE_PASSWORD` | the keystore password |
| `SA_UPLOAD_KEY_ALIAS` | `upload` |
| `SA_UPLOAD_KEY_PASSWORD` | the key password (with `keytool`'s default PKCS12, the same as the keystore's) |

**Signing and version in the build** (`androidApp/build.gradle.kts`). Nothing comes from the
repo. Release builds are signed when `SA_UPLOAD_KEYSTORE` (a path to the .jks, or the .jks in
base64), `SA_UPLOAD_KEYSTORE_PASSWORD`, `SA_UPLOAD_KEY_ALIAS` and `SA_UPLOAD_KEY_PASSWORD` are
set, as environment variables or as the Gradle properties `saUploadKeystore`,
`saUploadKeystorePassword`, `saUploadKeyAlias` and `saUploadKeyPassword`. With none of them,
they are unsigned, as in CI; with only some, the build fails. The version is
`-PappVersion=X.Y.Z` (or `SA_APP_VERSION`), and the versionCode X×10000 + Y×100 + Z (0.3.0 is
300), unless `-PversionCode=N` (or `SA_VERSION_CODE`) sets it. It must be above 4, the last
legacy build numbered by hand; without a version, the build is 0.2.1 (4). Minor and patch stay
below 100. Play has already consumed codes 300 and 301 (both named 0.3.0), so the first
automated release must be 0.3.2 (302) or higher.

```sh
SA_UPLOAD_KEYSTORE=~/spainassist-upload.jks SA_UPLOAD_KEYSTORE_PASSWORD=… SA_UPLOAD_KEY_ALIAS=upload \
  SA_UPLOAD_KEY_PASSWORD=… ./gradlew :androidApp:bundleRelease -PappVersion=0.3.3
```

**Google Play access.** Releases use GitHub OIDC / Workload Identity Federation to impersonate
`github-play-releases@deep-mark-512418-h5.iam.gserviceaccount.com`, in the **SpainAssist Play
Releases** Google Cloud project (`deep-mark-512418-h5`, owned by `pablo@spainassist.es`).
The Google Play Android Developer API is enabled. Play Console grants the service account
access to Spain Assist (`es.spainassist.firma`): app information, draft apps and testing releases.
Production additionally needs the production release permission.

The provider is
`projects/1031188171407/locations/global/workloadIdentityPools/github-play-releases/providers/github`.
The identity pool trusts only this repository's numeric ID (`1402133301`, owner `11708035`)
and release tags. Its provider maps `google.subject=assertion.sub` and
`attribute.repository_id=assertion.repository_id`; its condition restricts the repository,
owner and `refs/tags/` prefix. The service account grants Workload Identity User only to that
repository ID in the pool. Google blocks private-key creation here; the workflow uses a
short-lived credential file, removed by the authentication action after the job.

Terraform sets `PLAY_WORKLOAD_IDENTITY_PROVIDER` and `PLAY_SERVICE_ACCOUNT` as repository
Actions variables, from `google_play_workload_identity_provider` and
`google_play_service_account` in `terraform.tfvars`. The workflow fails clearly if either
is absent and keeps the signed bundle artifact available. To recreate the Google Cloud side,
follow [Google's deployment-pipeline federation guide](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
with the same mappings, conditions, service-account binding and Play app permissions.

Repository Actions variables select the destination:

| Variable | Default | When to change it |
| --- | --- | --- |
| `PLAY_TRACK` | `internal` | The Play track ID, e.g. `alpha` for the default closed test or `production` after approval |
| `PLAY_RELEASE_STATUS` | `draft` | Set `completed` once Play allows releases on that track |

The initial draft also sets `changesNotSentForReview=true`: bundles are saved in Play Console,
where the first app setup/review must be completed. With `completed`, changes are submitted to
Play normally; Google's review and rollout rules still apply.

**Each release.** The main `.github/workflows/release.yml` now calls the phone workflow on
stable `vX.Y.Z` tags, using the same version. Desktop prereleases skip Android because they
would consume the stable versionCode. To release the phone separately, tag a commit on `master`:

```sh
git tag mobile-v0.3.3 && git push origin mobile-v0.3.3
```

`.github/workflows/mobile-release.yml` checks the tag and the secrets (it fails, naming the
missing ones), builds `:androidApp:bundleRelease` with that version, checks the bundle is
signed, and keeps `SpainAssist-X.Y.Z.aab` and R8's `mapping.txt` as the workflow artifact
`android-bundle`, alongside `version.json` with AGP's actual built versionCode. A separate job
checks Google Play before uploading: it skips a version already saved on the requested track,
or reuses its existing bundle to finish a submission or promote a draft to completed. It keeps
the existing bundle's mapping when reusing it. Another draft/rollout or a newer version on the
track fails clearly instead of being overwritten. Submissions are serialized across tags to
avoid conflicting Play edits. Branch dispatches with the `version` input only build; they never
upload. Re-run a failed submission job to reuse its artifact, or re-run the release: each store
checks its own state independently. Already submitted Windows versions also skip, including
those still in certification. See [the retry rules](../../docs/research/store-submissions.md).
Play still refuses a versionCode it has already accepted; changes to the app need a new X.Y.Z,
even when a previous build with that code was only a draft. Keep released tags fixed.

- **Licence.** Every build must come with its complete source (see "Licence" below). The tag
  is that source: `Licenses.SOURCE_URL` points at the public repo, so push the tag before
  publishing the build, and never move or delete a released tag.
- **App Links.** The Terraform variable `android_cert_sha256` (the relay's
  `ANDROID_CERT_SHA256`) takes both SHA-256 fingerprints, comma-separated: the app signing
  key's (Play Console > Test and release > App integrity > Play app signing) and the upload
  key's (shown there too, or
  `keytool -list -v -keystore ~/spainassist-upload.jks -alias upload | grep SHA256:`; the
  workflow's "Check the signature" step prints it as well). Without them, links open the
  relay's `/p` page, which offers "Abrir en la app".
- **NFC.** The app requires `android.hardware.nfc`.

## The relay

The relay keeps rooms in memory, and only the desktop creates them, so after a relay restart
(every deploy) the phone may come back first and be refused (4404). That doesn't end the
pairing: the phone shows "your computer isn't connected" and retries, backing off to a minute,
until the desktop recreates the room. It gives up when the pairing expires, or after the room
has been missing for 24 hours (the desktop doesn't keep a pairing across its own restarts);
`FirmaController.roomMissing` has the rule. An expired room (4408), another phone taking the
room (4409) and the desktop's "Desvincular" still end it at once.

## Logins and protocol

Login uses the AUTENTICACIÓN certificate; documents use FIRMA. A `login` review shows the site
without a document. TLS digests arrive already hashed (`prehashed`); the card adapter wraps
DigestInfo without hashing them again, while preserving PACE/CWA cryptography. After approval,
cancel from the desktop. `COMPANION_PROTOCOL` in `protocol/Messages.kt` must match the one in
`packages/shared/src/companion.ts`; when it changes, old apps must update.

## Licence

Our code here is MIT (`LICENSE`). The Android app as distributed is EUPL-1.2 as a whole,
because the EUPL is the only licence every jmulticard file offers (`NOTICE`).
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
