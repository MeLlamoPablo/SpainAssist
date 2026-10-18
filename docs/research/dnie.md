# DNI electrónico (DNIe): login and signing from SpainAssist

Date: 2026-10-05 (updated 2026-10-18). Scope: using the Spanish DNIe (3.0 and 4.0) for
certificate login (TLS client authentication to Cl@ve, AEAT, Seguridad Social) and for
AutoFirma-style document signing.

**What was built.** The DNIe is used only through the phone companion: the card is read over NFC
by the Android app (`apps/mobile`, its README), over the end-to-end encrypted channel in
`packages/companion` (its README) and `services/relay-server`. Logins go through the Go TLS
helper in `packages/sidecar` (its README and the Go comments describe the proxy), which asks the
phone for each handshake signature; documents are signed by `@sa/signer` through
`ExternalSigningKey` (`packages/signer/src/key.ts`). The user types the CAN and the PIN on the
desktop; the PIN is kept in the vault and goes to the phone per request, inside the encrypted
channel (`packages/companion/README.md`). Contact readers and PKCS#11 modules are not supported
(§4). Related: `browser.md` §1, `autofirma.md`, `electron-packaging.md` §6.5.

Unverified on a real DNIe and phone: authentication-key signatures, NFC dwell and presence
timing, reopening PACE/CWA after several TLS operations, and certificate chain availability. On
real hosts: TLS resumption, renegotiation timing, WAF acceptance, and whether www10 accepts DNIe
CAs. Automated tests never contact a real administration.

## How things were checked

| Tag | Meaning |
|---|---|
| `[lab]` | Ran locally: Go 1.19 stdlib proxy, `playwright-core@1.63.0` with Chromium r1243 (headless and headed), Node 24.9.0, Electron 44.5.1, macOS arm64. A Node process with an RSA-2048 key played the card. |
| `[live]` | One read-only request or TLS handshake per host on 2026-10-05. No credentials, no client certificate sent (an empty one when asked). |
| `[src]` | Read in source code or an upstream issue. |
| `[docs]` | Read in official documentation (dnielectronico.es, AEAT, BOE, La Moncloa, app stores). |
| `[bin]` | Read in a downloaded official binary (strings, symbols, manifest) on 2026-10-11. Not run. |
| UNVERIFIED | Not confirmed. Most of these need a real card and reader. |

---

## Key findings

1. **The TLS client must be a native helper, not Node or Electron.** Electron's BoringSSL has no
   engines (`ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED`), and Node's `tls` has no "sign the
   handshake for me" callback `[lab]`. Go's `crypto/tls` takes any `crypto.Signer` as the client
   key and supports TLS 1.2 renegotiation `[lab]`. Chromium trusts the helper's per-launch key
   through `--ignore-certificate-errors-spki-list`, so nothing is ignored context-wide
   `[lab][live]`.
2. **The DNIe only does RSA PKCS#1 v1.5** (no PSS, no raw RSA) `[docs][src]`. TLS 1.3 needs PSS,
   so DNIe logins must run over **TLS 1.2**. Every certificate host we probed accepts TLS 1.2
   `[live]`. Document signing (CAdES/XAdES/PAdES) uses PKCS#1 v1.5 anyway.
3. **The card asks for the PIN on every private-key operation**, for both keys `[src]`. Each new
   TLS handshake is one signature. Three wrong PINs block the card until the user visits a police
   station `[docs]` (§3.2).
4. **NFC works on phones, not (yet) on desktop.** Android and iPhone apps already sign with the
   DNIe over NFC. The official DNIeRemote (PC) + DNIe Smart Connect (Android) pair makes the
   phone a remote signer behind a PKCS#11 module, on Windows and x86 Linux only (§5.2). No desktop
   driver we found does contactless PACE `[docs][src][bin]`.

---

## 1. Why Playwright's `clientCertificates` can't do it

- It only takes key material: PFX or PEM (`browser.md` §1.1). A DNIe never releases its key.
- Playwright refuses to add PKCS#11 (issue #32003, `browser.md` Sources).
- Its proxy finishes TLS in Node, and Node's `tls` needs an in-memory key:
  - **Electron 44 (BoringSSL):** `tls.createSecureContext({ privateKeyEngine })` and
    `crypto.setEngine` both throw `ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED` `[lab]`.
  - **Node 24 (OpenSSL 3.6)** still tries to load an engine `[lab]`, but engines are deprecated
    in OpenSSL 3, and we don't ship plain Node.
  - No pure-JS TLS stack with a signing callback is maintained (UNVERIFIED that none exists; we
    found none).
- Chromium's own path (OS certificate store) shows a native certificate picker in headed mode,
  which Playwright can't click (`browser.md` §1.8). Chrome on macOS currently fails DNIe TLS
  logins anyway, with `ERR_SSL_CLIENT_AUTH_SIGNATURE_FAILED` (OpenSC issue #3553, open) `[src]`.

## 2. Design: pinned local proxy in a Go sidecar

```
Chromium ──CONNECT (proxy password)─▶ sidecar proxy ──TLS 1.2 + client cert──▶ certificate host
   │  accepts only the sidecar's            │  Sign(digest) ──▶ encrypted phone companion
   │  per-launch key (SPKI pin)             │
   └──────── every other origin: raw TCP tunnel, Chromium checks TLS itself
```

### 2.1 The proxy

Described in `packages/sidecar/README.md` and the Go sources. Lab facts behind it `[lab]`:
- Without `SupportedSignatureAlgorithms` limited to PKCS#1 schemes on the `tls.Certificate`, Go
  asks the signer for PSS and the card fails the handshake.
- Dialling upstream inside `GetConfigForClient` with the browser's ALPN offer, then giving the
  browser what upstream chose, works with h2.
- Chromium can't authenticate to a SOCKS proxy, so the proxy is HTTP CONNECT.

### 2.2 What the lab showed `[lab]`

| Check | Result |
|---|---|
| Listed origin, headless and headed | 200 over h2; the server saw the client certificate. No dialog, no window interaction. |
| Unlisted origin with an untrusted certificate | `net::ERR_CERT_AUTHORITY_INVALID`, headless and headed. Only our pinned key is accepted. |
| Unlisted real origin | 200 through the raw tunnel |
| curl without or with wrong proxy credentials | `407` / `CONNECT tunnel failed` |
| Chromium with wrong proxy credentials | Every navigation fails (`ERR_HTTP_RESPONSE_CODE_FAILURE`) |
| TLS 1.2, certificate requested in the first handshake | Works with the external signer |
| TLS 1.2 renegotiation on one path (Apache/IIS style) | Works through Chromium |
| TLS 1.3 with a PKCS#1-only certificate | Go fails before signing: `tls: certificate RSA key size too small for supported signature algorithms` (misleading: TLS 1.3 forbids PKCS#1 here) |
| PKCS#1-only certificate without declaring it | Go asks the signer for PSS and the handshake fails |

Notes:
- Each handshake makes one `Sign` call over a 32–64-byte digest. The key never leaves the card.
- Chromium's background traffic (update and Google account endpoints) also goes through the
  proxy. `--disable-background-networking` and `--disable-component-update` turn it off.
- The pin flag only works with `--user-data-dir`, which Playwright always passes
  ([Chromium source](https://chromium.googlesource.com/chromium/src.git/+/20e8909e694cab857da21d8fe9d5f1da170eaae2/services/network/ignore_errors_cert_verifier.h)) `[src]`.
- When the upstream connection fails, Chromium only sees a generic TLS error. That is why the
  sidecar finishes the browser-side handshake and serves an error page instead.

### 2.3 Real hosts `[live]`

One Go handshake per host, platform verifier, empty certificate when asked:

| Host | Chain | TLS | Asks for a cert | Schemes offered | DNIe CAs accepted |
|---|---|---|---|---|---|
| pasarela-ident.clave.gob.es | verified | 1.2 | yes | ECDSA, Ed25519, PSS, PKCS#1 | empty list (any) |
| www1.agenciatributaria.gob.es | verified | 1.2 | yes | PKCS#1, ECDSA | AC DNIE 004/005/006 |
| www8.agenciatributaria.gob.es | verified | 1.3 (1.2 when capped) | yes | PKCS#1, PSS, ECDSA | AC DNIE 004/005/006 |
| www10.agenciatributaria.gob.es | verified | 1.2 | yes | PKCS#1, ECDSA | none of 56 listed |
| w2.seg-social.es | verified | 1.2 | yes | PKCS#1 (incl. SHA-1), ECDSA | AC DNIE 004/005/006, AC RAIZ DNIE |
| ipce.seg-social.es | verified | 1.2 | yes | same as w2 | same as w2 |
| icp.administracionelectronica.gob.es | verified | 1.2 | no | — | — |

- **Every host works over TLS 1.2**, so a PKCS#1-only card can log in to all of them.
- **Missing intermediates are not a problem on macOS.** `icp.administracionelectronica.gob.es`
  fails in Node/Electron (`browser.md` §1.2) but verifies in Go. Since Go 1.18 a nil `RootCAs`
  uses the macOS system verifier, which fetches missing intermediates; Windows is similar `[src]`.
  On Linux Go uses its own verifier without AIA fetching: ship the known intermediates there
  (UNVERIFIED which hosts need them on Linux).
- **www10 lists no DNIe CA.** Whether it rejects DNIe certificates is UNVERIFIED.
- **Go's ClientHello was accepted everywhere** at the TLS level. Whether a WAF treats Go's
  fingerprint differently on real HTTP requests is UNVERIFIED; `utls` can imitate Chrome if needed.
- **HSTS and pins don't get in the way.** Through the proxy, with our pinned fake certificate,
  headless Chromium loaded `https://pasarela-ident.clave.gob.es/` (the server's own 403 for "no
  certificate") and `https://www1.agenciatributaria.gob.es/` (redirect to AEAT's "no certificate"
  page). `clave.gob.es` is HSTS-preloaded (`max-age=63072000; includeSubdomains; preload`), and
  still no HSTS, pin or Certificate Transparency error appeared. Bulk preload entries carry no
  key pins, and HSTS only forbids clicking through an error; the pin means there is none `[live][src]`.

### 2.4 Choosing TLS 1.2 per host

- `GetClientCertificate` receives `cri.Version` and `cri.SignatureSchemes` `[lab]`. On TLS 1.2 the
  callback can return the PKCS#1-only certificate for that request.
- On TLS 1.3 the version is fixed before the certificate request arrives. So for a DNIe: fail that
  handshake, remember the host, and reconnect with `MaxVersion: tls.VersionTLS12` inside
  `GetConfigForClient`. The browser-side handshake hasn't finished yet, so Chromium doesn't notice
  `[src]`. This adaptive retry was not selected.
- Implemented choice: cap DNIe-enabled origins at TLS 1.2. `.p12` identities keep normal TLS
  negotiation. Real-host resumption with a real DNIe remains unverified.

### 2.5 Security model
| Risk | Mitigation |
|---|---|
| Fake certificate accepted for other sites | New key per launch, memory only. Only listed origins are intercepted; everything else is tunnelled and checked by Chromium. |
| Weaker upstream checks (Go instead of Chromium) | Always verify (`RootCAs: nil`, hostname check), TLS ≥ 1.2. Show an error page on failure, never fall back. |
| Another local process using the proxy to log in with the card | Per-launch proxy password. Every login also needs the user's approval on the phone. |
| PIN exposure | Typed in our app, kept in the vault, sent only to the paired phone inside the encrypted channel. Never to the renderer, the model, logs or the page. |
| Bot detection on Go's TLS fingerprint | Watch for it; `utls` if needed (UNVERIFIED that any sede cares). |

## 3. The card

### 3.1 Keys and algorithms

- **RSA-2048, PKCS#1 v1.5 only.** The security target says "El esquema de firma empleado es
  PKCS#1 v2.1: RSASSA-PKCS1-v1.5" with SHA-256, and no PSS ([CC security target, DNIe-DSCF
  3.0](https://sec-certs.org/cc/3b78fd8644eead11/target.txt)) `[docs]`. OpenSC registers the keys
  with `RSA_PAD_PKCS1 | HASH_NONE` (`card-dnie.c`) `[src]`.
- **The host hashes; the card pads.** The DigestInfo goes in `PSO: COMPUTE DIGITAL SIGNATURE`.
  In PKCS#11 terms that is `CKM_RSA_PKCS`. No raw RSA (`CKM_RSA_X_509`), so PSS can't be built on
  the host `[src]`.
- **Two certificates:** AUTENTICACIÓN and FIRMA. AEAT tells DNIe users to pick **FIRMA** for its
  site ([AEAT help](https://sede.agenciatributaria.gob.es/Sede/en_gb/ayuda/consultas-informaticas/firma-digital-sistema-clave-pin-tecnica/errores-relacionados-uso-dnie/error-conexion-dni-electronico-mac-x.html)) `[docs]`.
- DNIe 4.0 keys are RSA too (`KprivAutenticacion` in OpenSC #3613); key size UNVERIFIED (likely
  2048).
- TLS 1.3 has a legacy PKCS#1 code point for client certificates (`rsa_pkcs1_sha256_legacy`,
  [draft-ietf-tls-tls13-pkcs1](https://datatracker.ietf.org/doc/html/draft-ietf-tls-tls13-pkcs1-07)),
  off by default in BoringSSL and not in Go. Don't count on it.

### 3.2 PIN

- **Every signature needs a fresh PIN check, with both keys.** OpenSC: "The two keys inside DNIe
  3.0 needs login before performing any signature. They are CKA_ALWAYS_AUTHENTICATE although
  they are not tagged like that." OpenSC works around it by caching the PIN and re-sending it
  ([`pkcs15-dnie.c`](https://github.com/OpenSC/OpenSC/blob/master/src/libopensc/pkcs15-dnie.c)).
  The government's own [jmulticard](https://github.com/ctt-gob-es/jmulticard) closes the secure
  channel after each signature `[src]`.
- **Three wrong PINs block the card** (FIA_AFL.1 in the security target) `[docs]`. Unblocking and
  PIN changes happen at a police station's update kiosk (PAD) with a fingerprint check
  ([La Moncloa](https://www.lamoncloa.gob.es/serviciosdeprensa/notasprensa/interior/paginas/2025/nuevo-dni-digital.aspx))
  `[docs]`; "no remote unblock" is from secondary sources (UNVERIFIED).
- **PIN policy (UX first; replaces the 2026-10-05 "sidecar memory, 60 minutes" plan):** the
  user types the PIN once on the desktop. It is saved in the vault and sent with each phone request,
  the way OpenSC caches and re-sends it. The PIN doesn't replace consent: the phone still shows
  what it signs and asks for approval.
- **Retries:** never retry a refused PIN automatically. The phone remembers refused PINs and CANs
  and asks the desktop for a new one (`packages/companion/README.md`), so a wrong saved PIN costs
  at most one try.
- **Fewer signatures:** each full upstream handshake costs one card operation (about a second,
  UNVERIFIED), and Chromium opens several connections per site. A resumed TLS 1.2 session reuses
  the earlier client authentication with no new signature, so the sidecar resumes sessions and
  reuses connections. UNVERIFIED that these servers allow resumption.

### 3.3 Certificates on the card

- **They expire before the card.** RD 1553/2005 art. 12.1 caps them at five years
  ([BOE](https://www.boe.es/buscar/act.php?id=BOE-A-2005-21163)) `[docs]`. Pages disagree on the
  actual period (60, 30 or 24 months). Read `notAfter` from the card; don't assume.
- **The FIRMA certificate is optional** at issuance (art. 9.2) `[docs]`. Some cards won't have one.
- Renewal is in person, at the PAD kiosk `[docs]`.

## 4. Talking to the card

Only the phone companion is supported. These desktop options were researched and rejected:

| Option | How | Why not |
|---|---|---|
| **A. Official PKCS#11 module, installed by the user** | Helper `dlopen`s `libpkcs11-dnie` (Policía) or FNMT's "MultiCard PKCS11 FNMT-DNIe" | Needs a contact reader most users don't have, and a closed-source driver install. macOS hardened runtime needs `disable-library-validation` (UNVERIFIED that the module is signed/notarized). How it prompts for the PIN is UNVERIFIED. |
| **B. Bundle OpenSC's PKCS#11 module** | Ship `opensc-pkcs11` (LGPL-2.1) as a separate library | DNIe driver barely maintained (#3593); DNIe 4.0 re-login bug (#3613, fix withdrawn); macOS build lacks the OpenSSL legacy provider the secure channel needs (#3612). Contact only. |
| **C. Our own APDU layer on the desktop** | Port jmulticard's DNIe code (CWA-14890 secure channel, PACE with CAN) to Go, over PC/SC | Real crypto work, still needs a reader; LGPL/EUPL care if ported rather than reimplemented (needs legal review). |

Drivers today `[docs]`:
- **macOS:** `libpkcs11-dnie` 1.6.8, Intel and ARM builds, macOS 13–26
  ([downloads](https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1113)), at
  `/Library/Libpkcs11-dnie/lib/libpkcs11-dnie.so`. FNMT MultiCard 2.0.1 (Nov 2025) also covers
  macOS x64/ARM ([FNMT](https://www.sede.fnmt.gob.es/stceres)). No evidence of a CryptoTokenKit
  token, so Safari/Chrome don't see the card through it (UNVERIFIED).
- **Windows:** installers for 10/11; a "DNIe Minidriver" arrives through Windows Update
  (secondary source). Whether a PKCS#11 DLL ships on Windows is UNVERIFIED.
- **Linux:** `libpkcs11-dnie` 1.7.1 `.deb` (Debian 13 / Ubuntu 25.04) and a 1.6.8 `.rpm`
  ([downloads](https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1112)).
  Flatpak needs `--socket=pcsc` (UNVERIFIED).

Card quirks `[src]` ([OpenSC wiki](https://github.com/OpenSC/OpenSC/wiki/DNIe-(OpenDNIe))): no
logical channels (one secure session at a time, so serialise all card access), no
APDU chaining, and "NEVER plug/unplug reader with DNIe inserted".

### 4.1 Signing documents through the sidecar

Built differently: `@sa/signer` takes a `KeySigner` (`packages/signer/src/key.ts`), and the DNIe
version is an `ExternalSigningKey` that asks the phone through `packages/companion`, not the
sidecar. Every format the signer supports uses PKCS#1 v1.5 with RSA.

## 5. NFC

DNIe 3.0 and 4.0 are dual-interface. Contactless access uses PACE, keyed with the 6-digit CAN
printed on the card, and then the same PIN for private-key operations `[src: jmulticard DnieNfc]`.

| Route | Status |
|---|---|
| **Android phone for the PC** (DNIe Smart Connect, "Lector de DNIe para PC, usando el móvil", `es.gob.fnmt.dniesmartconnect`, with DNIeRemote on the PC) | Updated 2026-07-15 (2.2.64) `[docs]`. Not a reader: the phone does the card work and the PC gets DNIeRemote's own PKCS#11 module. Windows and x86 Linux, same subnet or USB via adb; no macOS (§5.2) `[docs][bin]`. |
| **iPhone over Core NFC** | Works in third-party apps: [Firm@](https://apps.apple.com/es/app/firm@/id1564700621) signs PDFs with DNIe 3.0+ on iPhone 7+ `[docs]`. Needs the NFC entitlement and the card's AIDs in Info.plist (UNVERIFIED specifics). |
| **Android libraries** | jmulticard-android does PACE with CAN `[src]`. |
| **Government flows** | Cl@ve app registration "Con DNI electrónico" already uses NFC + CAN + PIN ([AEAT help](https://sede.agenciatributaria.gob.es/Sede/ayuda/consultas-informaticas/aplicaciones-moviles-aeat-ayuda-tecnica/app-clave-android/activacion-dispositivo.html)) `[docs]`. |
| **MiDNI app** | Phase 1 (since 2025-04-02) is in-person QR identification only. Online login and signing were promised for phase 2. They aren't live: the store text (v1.0.3, 2026-03) still rules them out `[docs]`. |
| **USB contactless reader on the PC** (ACR122U, ACR1252U) | OpenSC: no PACE for DNIe `[src]`. Official driver over contactless: UNVERIFIED. Our own APDU layer (option C) with PACE should work in principle (UNVERIFIED). |

For SpainAssist, a phone is something almost every user has; a contact reader isn't. NFC is the
route that removes the hardware barrier, hence the companion.

### 5.1 Companion app

Built as `apps/mobile`, `packages/companion` and `services/relay-server` (their READMEs). It
differs from the 2026-10-05 plan: a relay (end-to-end encrypted) instead of the local network,
because guest and corporate Wi-Fi often block device-to-device traffic; P-256 + HKDF + AES-GCM
instead of Noise; jmulticard on Android for the card. Facts that shaped it:

**Precedent.** Germany's [AusweisApp](https://github.com/Governikus/AusweisApp) (EUPL, open source)
has done "smartphone as card reader" for desktop eID logins for years: pair once with a code over
the local network, then the desktop sends card commands to the phone. Spain's own DNIeRemote +
DNIe Smart Connect does something similar for Windows/Linux, with the PIN on the PC (§5.2).

**Card access on each platform:**

- **Android:** `NfcAdapter.enableReaderMode` + `IsoDep`; jmulticard-android already does DNIe PACE
  `[src]`. The connection lasts while the card stays in the field, so the user can lay the phone on
  the card for a whole login. The OS presence check (`EXTRA_READER_PRESENCE_CHECK_DELAY`, 125 ms by
  default) can drop the tag during slow card operations; raise it (AusweisApp had to:
  [PR #52](https://github.com/Governikus/AusweisApp/pull/52)) `[src]`.
  Moving the card during a read breaks the connection. Autofirma for Android then fails with
  **AA300103** (jmulticard `ERROR_INITIALIZING_CARD`: "La conexión con la tarjeta no está
  inicializada"; the iOS app uses the same number) `[src: firma-android ThirdPartyErrors.java]`.
  Seen on a real phone on 2026-10-10. Our copy must tell users to put the card on a flat surface,
  lay the phone on top, and not move either until the read finishes.
- **iOS:** `NFCTagReaderSession` with ISO 7816. Each session shows a system sheet, lasts at most
  **60 seconds**, and the tag connection drops after about **20 seconds**, with no way to extend
  either ([Apple forums](https://developer.apple.com/forums/thread/131917),
  [thread 802895](https://developer.apple.com/forums/thread/802895)) `[docs]`. Every session needs
  a new tap and a new PACE handshake (UNVERIFIED cost: about 1–2 s). Fine for signing a document;
  painful for a login that needs several handshakes, unless TLS session resumption works (§3.2).
- **Order:** Android first. iOS only after resumption is confirmed, or for document signing only.
- PACE uses Brainpool P-256r1, so an iOS app couldn't use CryptoKit for it.
- The phone must show what it signs and for whom, and ask for consent on the phone too. Never
  sign a bare digest without that context: the desktop could be compromised.

### 5.2 DNIeRemote + DNIe Smart Connect (checked 2026-10-11)

The product has two halves, made by FNMT-RCM with the CNP:
- **DNIeRemote** on the PC;
- **DNIe Smart Connect** on Android ("Lector de DNIe para PC, usando el móvil",
  `es.gob.fnmt.dniesmartconnect`).

They're one product from launch in Feb 2019, not a successor and its predecessor. Checked against:
- the manual and the Play listing, with 1,085 reviews `[docs]`;
- the binaries: PC wizard 1.1.1, `.deb` 1.0-5, Linux PKCS#11 module 0.0.4, APK 2.2.64 `[bin]`.

**How it works:**
- **The phone is the signer, not a card reader.** The app does the card work in NFC reader
  mode, through FNMT's DNIeDroid library (jmulticard + androsmex):
  - PACE with the CAN, which is typed and stored on the phone;
  - the DNIe secure channel.

  The PC sends it high-level commands: `DO_LOGIN` (with the PIN), `DO_SIGNATURE` and
  `DO_CLOSE` `[bin]`. FNMT's privacy policy says the phone only forwards chip commands; the
  binaries say otherwise.
- **The PC sees a PKCS#11 module, not a reader.**
  - Linux: `/usr/local/lib/libdnieremotepkcs11.so`.
  - Windows: `DNIeRemotePKCS11.dll` in System32.

  The module has no card code. It only talks to the running wizard, over
  `/tmp/dnieWizard_service.socket` on Linux `[bin][docs]`. On Windows the certificates also go
  into the user's certificate store through a CNG provider, so Edge and Chrome see them. On
  Linux, officially only Firefox does `[docs]`.
- **The PIN and a per-signature confirmation are the wizard's own dialogs on the PC:**
  "Introduzca PIN:", "PIN incorrecto. Intentos restantes: %d.", and "¿Desea firmar el documento
  con el certificado digital?" `[bin]`. Whether `C_Login` accepts a PIN from the caller is
  UNVERIFIED.
- **Links:**
  - Wi-Fi on the same subnet: the PC shows a QR code. It fails on the phone's own hotspot, on
    NAT'd VMs, and when the firewall is closed.
  - USB through `adb forward` (port 9500), with USB debugging turned on.

  There's no internet route and no Bluetooth `[docs][bin]`.
- **The channel uses home-grown crypto:** ECDH P-256, KDF1-SHA256, then AES-256-CBC, with no MAC
  found `[bin]`. The PC side sets its ECDH private key from a constant in the binary
  (`ECDH_PRIVATEKEY_VALUE`), so the key looks the same in every install `[bin]`. If the QR
  carries no fresh secret, someone on the same Wi-Fi could decrypt a session, PIN included.
  UNVERIFIED: this needs a traffic capture with a real phone. If confirmed, report it to FNMT
  (consultas.cnp@fnmt.es) or INCIBE-CERT.
- **The card stays on the phone for the whole session,** and the session ends if it moves `[docs]`.
- **Platforms.**
  - PC: Windows 10/11 (x86/x64) and Debian/Ubuntu (i386/amd64). Linux needs OpenSSL 1.1, which
    Ubuntu dropped in 22.04. Installing needs admin rights.
  - Not available: macOS (promised 2019–2022, never shipped), ARM, and an iPhone app
    `[docs][bin]`.
- **Maintenance.**
  - Play rating: 1.4 stars (about 1,670 ratings, 100k+ installs).
  - No release from Sep 2021 to Apr 2026. 2.2.63 (Apr 2026) broke NFC reads on most phones until
    2.2.64 (Jul 2026).
  - On Android 15+, an edge-to-edge bug hides the confirm button.
  - Not open source; no SDK or terms for integrators. Users report that the Linux PKCS#11 module
    crashes on `C_Initialize(NULL)` `[docs]`.

**Using it instead of our companion:**
- **Still possible:** anything that only needs a signature from the key.
  - A PKCS#11 loader (rejected option A, §4) could load DNIeRemote's module like any other.
  - `@sa/signer`'s `KeySigner` would take it as is, for CAdES, XAdES and PAdES, and, with the
    proxy (§2), for TLS 1.2 logins.
  - We'd have no phone app, relay or jmulticard licence of our own.
- **Lost:**
  - macOS;
  - working across networks (it needs the same subnet);
  - a PC with nothing to install;
  - the document shown on the phone, and the binding checks: the phone shows nothing about what
    it signs;
  - our PIN policy and consent prompts: their dialogs come instead;
  - recovery when the card moves;
  - an iOS route;
  - an authenticated, freshly keyed channel;
  - fixing its bugs ourselves.
- **Decision:** keep the companion as the DNIe route, and don't point users to DNIeRemote while
  the channel question is open.

## 6. Open questions

These need a real DNIe:
- Real NFC timings: PACE and one signature on Android, and a full Cl@ve login over NFC; how
  often the card drops with the 2-second presence check.
- Whether these hosts allow TLS 1.2 session resumption after client authentication (§3.2).
- An end-to-end login to Cl@ve and AEAT with a real DNIe through the proxy, including HTTP-level
  bot checks on Go's fingerprint.
- Whether www10.agenciatributaria.gob.es accepts DNIe certificates.
- The Linux intermediate-certificate gaps for Go's verifier.
- DNIeRemote: whether its handshake adds a fresh secret (§5.2).

## Sources

- Lab code (proxy, emulated card, probes): throwaway, not kept.
- Go: [`GetClientCertificate`](https://lab.nexedi.com/kirr/go/-/commit/81038d2e2b588f9df45d20a2ca0be446b0e421b2),
  [renegotiation](https://lab.nexedi.cn/kirr/go/-/commit/af125a5193c75dd59307fcf1b26d885010ce8bfd?w=1),
  [pkcssigner (PKCS#11 `crypto.Signer`)](https://pkg.go.dev/github.com/salrashid123/pkcssigner).
- Chromium: [`ignore_errors_cert_verifier.h`](https://chromium.googlesource.com/chromium/src.git/+/20e8909e694cab857da21d8fe9d5f1da170eaae2/services/network/ignore_errors_cert_verifier.h).
- OpenSC: `card-dnie.c`, `pkcs15-dnie.c`, issues #3475, #3553, #3593, #3612, #3613, PR #3614,
  [DNIe wiki](https://github.com/OpenSC/OpenSC/wiki/DNIe-(OpenDNIe)).
- [jmulticard](https://github.com/ctt-gob-es/jmulticard) (`Dnie.java`, `DnieNfc.java`).
- DNIe: [CC security target](https://sec-certs.org/cc/3b78fd8644eead11/target.txt),
  [Policía downloads (macOS)](https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1113),
  [(Linux)](https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1112),
  [FNMT MultiCard](https://www.sede.fnmt.gob.es/stceres),
  [RD 1553/2005](https://www.boe.es/buscar/act.php?id=BOE-A-2005-21163),
  [MiDNI announcement](https://www.lamoncloa.gob.es/serviciosdeprensa/notasprensa/interior/paginas/2025/nuevo-dni-digital.aspx).
- DNIeRemote / DNIe Smart Connect:
  - [Play listing](https://play.google.com/store/apps/details?id=es.gob.fnmt.dniesmartconnect);
  - [PC downloads](https://www.dnielectronico.es/PortalDNIe/PRF1_Cons02.action?pag=REF_1015&id_menu=68);
  - [manual](https://www.dnielectronico.es/descargas/Apps/manual_DNIeRemote.html);
  - [privacy policy](https://www.fnmt.es/politicas-seguridad-apps/dniesmartconnect);
  - [autofirma-nix module](https://github.com/nix-community/autofirma-nix/blob/main/nix/dnieremote/module.nix).
- MiDNI phase 2 (online login and signing) still not live: the store text says so
  ([Play](https://play.google.com/store/apps/details?id=es.gob.interior.policia.midni), v1.0.3,
  2026-03).
- AEAT: [DNIe on Mac](https://sede.agenciatributaria.gob.es/Sede/en_gb/ayuda/consultas-informaticas/firma-digital-sistema-clave-pin-tecnica/errores-relacionados-uso-dnie/error-conexion-dni-electronico-mac-x.html),
  [TLS changes 2024-12](https://sede.agenciatributaria.gob.es/Sede/en_gb/aduanas/novedades/2024/noviembre/26/adecuacion-algoritmos-criptograficos-web-services.html),
  [Cl@ve app with DNIe](https://sede.agenciatributaria.gob.es/Sede/ayuda/consultas-informaticas/aplicaciones-moviles-aeat-ayuda-tecnica/app-clave-android/activacion-dispositivo.html).
- HSTS preload status: hstspreload.org API (2026-10-05).
