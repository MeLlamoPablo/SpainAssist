# Google Play listing (phone app)

Drafts for `es.spainassist.firma`, checked 2026-10-30 against the code in `apps/mobile`, the
published [privacy policy](https://spainassist.es/legal/politica-de-privacidad) and
`docs/research/play-policy.md`. Paste them into Play Console (Grow users > Store presence >
Main store listing, and Policy and programs > App content). The last section says how to keep the
listing up to date.

Rules for every text here and in the graphics (`play-policy.md`): never call the app "official"
or "la app del DNI", no government logos or coats of arms, the non-affiliation disclaimer stays
visible near the top of the description, and the official sources stay listed.

## Store listing

Spanish (es-ES) is the default language; English (en-US) is a translation.

### App name (30 characters max)

| | Text | Length |
| --- | --- | --- |
| es-ES | `Spain Assist` | 12 |
| en-US | `Spain Assist` | 12 |

### Short description (80 characters max)

| | Text | Length |
| --- | --- | --- |
| es-ES | `Firma y entra en sedes con tu DNI y Spain Assist en tu ordenador` | 64 |
| en-US | `Sign and log in to e-government sites with your DNI and Spain Assist on your PC` | 79 |

### Full description, es-ES

```text
Spain Assist para Android te permite usar tu DNI electrónico para firmar documentos y entrar en sedes electrónicas mientras haces trámites con Spain Assist en tu ordenador. No necesitas lector de tarjetas, solo un móvil con NFC.

Aviso: Spain Assist es una app privada; no está afiliada a la Policía Nacional, la FNMT ni a ninguna administración pública.

CÓMO FUNCIONA
1. Abre Spain Assist en tu ordenador y escanea con el móvil el código QR que te muestra.
2. Cuando un trámite necesita tu firma o tu certificado, el móvil te enseña qué vas a firmar y qué sitio lo pide.
3. Si estás de acuerdo, pulsa «Firmar con mi DNI», pon el DNI sobre una mesa y apoya el móvil encima.
4. La firma vuelve a tu ordenador y el trámite sigue allí.

QUÉ PUEDES HACER
• Firmar documentos con el certificado de firma de tu DNI.
• Identificarte en sedes electrónicas con el certificado de autenticación de tu DNI.
• Ver siempre el documento y el sitio que lo pide antes de aprobar.

PRIVACIDAD Y SEGURIDAD
• El CAN y el PIN se escriben en el ordenador, nunca en el móvil. Llegan cifrados con cada petición, sirven solo para esa petición y el móvil no los guarda.
• Las claves privadas de tu DNI nunca salen de la tarjeta.
• El ordenador y el móvil se comunican con cifrado de extremo a extremo. Nuestro servidor de enlace solo ve datos cifrados y no guarda nada.
• El móvil solo guarda la vinculación, cifrada con el almacén de claves de Android y fuera de las copias de seguridad.
• El código QR se lee en el propio móvil, con ML Kit de Google.
• Sin anuncios y sin cuentas.
• Software libre: la app se distribuye con licencia EUPL 1.2 y puedes descargar todo su código fuente.

Spain Assist es una app privada; no está afiliada a ninguna administración pública.

Política de privacidad: https://spainassist.es/legal/politica-de-privacidad
Contacto: hola@spainassist.es
```

### Full description, en-US

```text
Spain Assist for Android lets you use your Spanish electronic ID card (DNIe 3.0 or 4.0) with your phone to sign documents and log in to Spanish e-government sites while you handle paperwork with Spain Assist on your computer. No card reader needed: your phone reads the DNIe over NFC.

Notice: Spain Assist is a private app. It is not affiliated with the Policía Nacional, the FNMT or any public administration.

HOW IT WORKS
1. Open Spain Assist on your computer and scan the QR code it shows with your phone. The phone stays paired for up to 72 hours, or until you close Spain Assist on the computer.
2. When a procedure needs your signature or your certificate, the phone shows you what you are signing (the PDF, the XML or the text) and which site is asking.
3. If you agree, tap "Sign with my DNI", put the card on a table and rest the phone on it.
4. The signature goes back to your computer, and the procedure carries on there.

WHAT YOU CAN DO
• Sign documents with your DNIe's signing certificate.
• Log in to e-government sites with your DNIe's authentication certificate.
• Always see the document and the site asking for it before you approve. If we don't recognise the site, we warn you.

PRIVACY AND SECURITY
• You type the CAN and the PIN on the computer, never on the phone. They arrive encrypted with each request, serve that request only, and the phone never stores them.
• Your DNIe's private keys never leave the card.
• The computer and the phone talk with end-to-end encryption. Our relay server only sees encrypted data and keeps nothing.
• The phone only keeps the pairing, encrypted with the Android Keystore and excluded from backups.
• The QR code is read on the phone itself, with Google's ML Kit.
• No ads and no accounts.
• Free software: the app is distributed under the EUPL 1.2, and you can download its complete source code.

WHAT YOU NEED
• Spain Assist on your computer. Download it at spainassist.es.
• A DNIe 3.0 or 4.0 with active certificates, and its PIN.
• An Android phone with NFC.

OFFICIAL SOURCES
To learn about the Spanish electronic ID card and electronic signatures, see the official sources:
• Electronic ID card portal: https://www.dnielectronico.es
• Electronic Signature portal: https://firmaelectronica.gob.es

Spain Assist is a private app. It is not affiliated with the Policía Nacional, the FNMT or any public administration, and it does not replace any official service.

Privacy policy: https://spainassist.es/legal/politica-de-privacidad
Contact: hola@spainassist.es
```

The app is in Spanish and English (`composeResources/values-en`), so the English listing
describes the same app. It has its own graphics with the English UI (Framer branch "Play Store ·
English (en-US)"), exported to `~/Desktop/SpainAssist-play/listing/en/` and uploaded as `en-*.png`:
`en-feature-graphic.png` and `en-01-sign.png` … `en-05-encrypted.png`, in the Spanish order. The
Modelo 100 page stays in Spanish, since it is a Spanish tax form.

### Contact details and links

- Website: https://spainassist.es
- Email: hola@spainassist.es
- Privacy policy: https://spainassist.es/legal/politica-de-privacidad

### Category and tags

- **Category:** Tools (Herramientas), the category of most DNIe signing apps. Productivity is
  the alternative.
- **Tags** (pick up to 5 from Play's list in Store settings; the list depends on the category,
  so check which exist): document signing / electronic signature, security, productivity tools,
  document management.

### Graphics

Exported to `~/Desktop/SpainAssist-play/listing/` (outside the repo: binary, regenerated from
Framer, and the repo is no place for 1 MB of marketing PNGs per release). Designed on the
"Play Store" page of the Framer project "Spain Assistant".

| File | Size | Play slot |
| --- | --- | --- |
| `icon-512.png` | 512×512, 32-bit PNG | App icon (the launcher's flag on white) |
| `feature-graphic-1024x500.png` | 1024×500, 24-bit PNG | Feature graphic |
| `01-firma.png` … `05-cifrado.png` | 1080×1920, 24-bit PNG | Phone screenshots, in this order |

Screenshots, by headline (frame slug in brackets):

1. Firma con tu DNI desde el móvil (`revisar`): the Modelo 100 from the DNI video.
2. Vincúlalo con un QR. Escanea el código que muestra Spain Assist en tu ordenador. (`inicio`):
   the scanner filming the desktop pairing dialog, as in the DNI video.
3. Acerca el DNI y listo. El móvil lee tu DNI por NFC. Sin lector de tarjetas. (`acerca`)
4. Identifícate en sedes electrónicas (`entrar-revisar`)
5. Cifrado de extremo a extremo. Tus documentos y firmas viajan seguros en todo momento. (`firmado`)

Screens 1 and 2 are images rendered from `marketing/dni-video` (the Framer component takes one
image per screen), not emulator captures.

Play's limits: 2 to 8 phone screenshots, each side 320 to 3840 px and the long side at most twice
the short one (so 1080×2400 raw captures don't qualify; 1080×1920 does).

**Retaking the captures.** Debug build, `PreviewActivity` (`apps/mobile/README.md`, "Screen
preview") on the `sa_preview` AVD (1080×2400, 420 dpi), light theme
(`adb shell cmd uimode night no`), and System UI demo mode for a clean status bar:

```sh
adb shell settings put global sysui_demo_allowed 1
demo() { adb shell am broadcast -a com.android.systemui.demo -e command "$@"; }
demo enter; demo clock -e hhmm 0941
demo battery -e level 100 -e plugged false
demo network -e wifi show -e level 4 -e fully true
demo network -e mobile show -e datatype none -e level 4 -e fully true
demo notifications -e visible false
adb shell am start -S -n es.spainassist.firma.debug/es.spainassist.firma.android.PreviewActivity --es screen revisar
adb exec-out screencap -p > revisar.png
```

With the emulator's host GPU, `screencap` returned blank white frames; start the emulator with
`-gpu swiftshader_indirect` to capture.

## App content

### Data safety

Play counts data as collected when it leaves the device, including through SDKs, except data
processed only on the device and data sent end-to-end encrypted so that only the sender and
recipient can read it ([Play's guide](https://support.google.com/googleplay/android-developer/answer/10787469)).

What leaves the phone:

| Data | Where it goes | Collected? |
| --- | --- | --- |
| Certificates from the DNIe (name, DNI number), signatures | The user's own computer, through the E2E channel; the relay sees ciphertext only | No (end-to-end encrypted) |
| Documents to sign (PDF, XML, text) | Arrive from the computer through the E2E channel; the phone deletes its viewing copy | No (end-to-end encrypted) |
| CAN and PIN | Typed on the computer, arrive E2E with each request, never stored on the phone | No (end-to-end encrypted) |
| Camera frames for the QR | ML Kit on the device; never sent (privacy policy) | No (on-device only) |
| Pairing | Stays on the phone, Keystore-encrypted, no backup | No (on-device only) |
| Random room ID, IP address at the relay | The relay keeps the room in memory during the pairing and uses the address only for in-memory rate limiting; it logs neither | Not a Play data type here (the IP isn't used for location) |
| ML Kit telemetry (`com.google.mlkit:barcode-scanning`, bundled model) | Google, over HTTPS | **Yes**, see below |

Google's [ML Kit Data safety guidance](https://developers.google.com/ml-kit/android-data-disclosure)
lists, for all ML Kit features: device information, application information, per-installation
identifiers (bundled features; "not intended to uniquely identify a user or physical device"),
performance metrics, API configuration, feature input/output size, version, event type and error
codes; purpose diagnostics and usage analytics; not transferred to third parties; encrypted in
transit. The auto-zoom data applies only when auto-zoom is enabled (the app doesn't enable it).

Answers:

- Does your app collect or share any of the required user data types? **Yes** (ML Kit).
- Is all of the user data collected by your app encrypted in transit? **Yes**.
- Do you provide a way for users to request that their data is deleted? **No**: the app has no
  accounts and we hold no user data; ML Kit's diagnostics stay with Google. (Rights requests go
  to hola@spainassist.es per the privacy policy.)
- Data types:
  - **App info and performance > Diagnostics** (and **Other app performance data**): collected,
    not shared, not ephemeral, required (users can't turn it off), purpose **Analytics**.
  - **Device or other IDs**: collected, not shared, not ephemeral, required, purpose
    **Analytics**.
  - Everything else (Personal info, Financial info, Location, Files and docs, Photos and videos,
    Messages, Contacts, etc.): not collected, for the reasons in the table.
- Independent security review: No.

### Content rating (IARC questionnaire)

- Category: **Utility, productivity, communication, or other**.
- Violence, fear, sexuality, profanity, controlled substances, crude humour: **No**.
- Gambling or simulated gambling: **No**.
- Users can interact or exchange content with other users: **No** (the phone talks only to the
  user's own computer).
- Shares the user's current physical location with other users: **No**.
- Allows users to purchase digital goods: **No**.
- Unrestricted internet access (web browser or search engine): **No**.
- Expected result: PEGI 3 / USK 0 / Everyone.

### Target audience and content

- Target age group: **18 and over** only. The app does not appeal to children.
- Ads: **No ads**.
- Government apps: **Not** developed by or on behalf of a government (`play-policy.md`).
- Financial features, health, news: none.
- Privacy policy URL: https://spainassist.es/legal/politica-de-privacidad.

### App access (instructions for reviewers)

Answer "Yes, some functionality is restricted" and add one set of details, "Pairing with the Spain
Assist desktop app", with no username or password and this in the instructions field (500
characters at most; saved 2026-10-31):

```text
No account needed. The app pairs with the free Spain Assist desktop app (Windows/macOS/Linux, spainassist.es) by a one-time QR, so no static QR exists. On the desktop: Mis datos > DNI con el movil > Probar > Ya tengo la app, habilitar DNI; scan the QR with this app. Signing needs a Spanish DNIe 3.0+ and NFC; without a card you can review pairing and the approve screens. Video of the full flow: https://drive.google.com/file/d/1ufvmXVwlVxgixzeB_bNAs0WdXlJvbdA8
```

It gives no invitation code on purpose: the desktop app also works with the user's own AI key, and
reviewers rarely have a DNIe, so the recording is what they will judge. Before each submission,
check the desktop labels against the current build.

The recording (2026-10-31, 23 s): the phone's screen only, pairing, a CAdES signature for
sede.sevilla.org, the card read and "Firma completada". It was made with a debug build from master
(0.3.3 from Play sets `FLAG_SECURE`, which records black) via `scrcpy --no-audio --no-window
--record=…`, with System UI demo mode and Do Not Disturb on (see Graphics above). It is
`SpainAssist-Android-review-demo.mp4` in the Spain Assist Google Drive, shared with anyone who has
the link. YouTube is unavailable to the Workspace account until it is 30 days old or has paid $30.

## Keeping the listing up to date

Options, checked 2026-10-30:

- **Play Console by hand.** No setup. Text lives only in Console, two languages mean every change
  is made twice, and screenshots are dragged in one by one. Fine while the listing changes rarely.
- **Terraform.** No maintained provider manages Play listings (none on the Terraform Registry;
  Google's provider doesn't cover the Android Publisher API). Listings are content, not
  infrastructure, and an edit-and-commit API doesn't map well onto Terraform's state model. Rejected.
- **fastlane supply.** Keeps metadata in the repo (`metadata/android/<locale>/title.txt`,
  `short_description.txt`, `full_description.txt`, `images/phoneScreenshots/…`) and uploads it
  through the Play Developer API. Its `json_key` now accepts a Workload Identity credential file,
  so the existing GitHub OIDC setup (`google-github-actions/auth` without `token_format`, which
  writes an `external_account` file) would work without a stored key. The cost is Ruby and
  Bundler in CI and a Gemfile.lock to keep updated, for what is a handful of API calls.
- **Extend `scripts/store-submissions.mjs`.** The job already gets a short-lived Android Publisher
  token through OIDC and opens Play edits. A listing upload is three more calls in the same edit:
  [`edits.listings.update`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.listings/update)
  per language, [`edits.images.deleteall`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/deleteall)
  and [`edits.images.upload`](https://developers.google.com/android-publisher/api-ref/rest/v3/edits.images/upload)
  per image type, then commit. No new dependency, the same fixture-tested style, and no secrets.

Weighing it: Android releases are tag-driven and occasional, the listing changes even less often
than the app, two languages double manual edits, and screenshots change with UI changes. The
Workload Identity pool only trusts `refs/tags/`, so any automation runs from a tag (the release
job, or a dedicated tag such as `android/listing-…`), unless the condition is widened.

**Recommendation.** Now, during closed testing: set the listing up by hand from this file. Data
safety, content rating, target audience, app access and the government declaration have to be
done in Console anyway (only Data safety has an API, and it changes about once a year). Once the
listing starts changing more than a couple of times a year, move the text into the repo in
fastlane's directory layout (`apps/mobile/play/<locale>/…`, screenshots exported from Framer)
and add a listing step to `store-submissions.mjs` in the existing release job, skipping it when
the files match what Play has. That keeps one language, no Ruby and no secrets, and the
fastlane-compatible layout leaves fastlane open as a drop-in if needs grow (e.g. many locales).
