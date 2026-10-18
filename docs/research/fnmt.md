# Getting an FNMT certificate inside SpainAssist — research memo

*Date: 2026-10-12 · Scope: how FNMT's "Configurador FNMT-RCM" and the FNMT sede work together to issue a
software certificate (`Certificado de Persona Física`), and what SpainAssist needs to do the same with
the key kept in our vault.*

## TL;DR

- **Today SpainAssist can't get an FNMT certificate issued.** The agent could fill in FNMT's form,
  but FNMT's page hands key generation to a local app, the *Configurador FNMT-RCM*, which we can't
  drive. The user would have to finish the request in their normal browser, then import the `.p12`
  in Mis datos → Credenciales.
- **The Configurador is a small Java app with a narrow job** (§3). It:
  - makes an RSA 2048 key, or EC P-256 when the page asks for EC;
  - builds a PKCS#10 request whose subject is always the placeholder `CN=foo.bar.com`;
  - keeps the private key, encrypted with a password the user picks, in a local Derby database until
    the certificate is ready;
  - at download time, pairs the certificate with that key, makes the user save a `.p12` backup, and
    imports it into the OS store and Firefox.
- **The page does all the talking to FNMT** (§2). The app never sends the request to the
  certification authority (CA):
  - the app returns the request to the page through @firma's StorageService/RetrieveService relay,
    and the page submits it as a normal form field (`PKCS10`);
  - at download, the page receives the certificate itself and passes it to the app.
- **So a stand-in is feasible without running or copying FNMT's software** (§7). It is an in-page
  shim that traps `window.FnmtCertRequest`, the same technique as our AutoFirma shim
  ([autofirma.md](autofirma.md) §2.2). The main process makes the key and the request, keeps the
  pending key in the vault, and turns the certificate into a vault credential. No `fnmtcr://`, no
  relay, no Java.
- **Things a stand-in must handle that aren't obvious** (§6):
  1. The pending key has to outlive the procedure, the browser context and app restarts. The
     identity check can take days.
  2. Build the request exactly as the Configurador does: placeholder subject, no attributes,
     SHA-256.
  3. The certificate arrives as a PKCS#7 bundle, sometimes gzipped, in base64url. Rebuild the chain
     from FNMT's intermediates rather than trusting the bundle.
  4. Offer a `.p12` backup. FNMT makes one mandatory, because the key exists only on that computer.
  5. "Borrar todo", deleting the procedure, or uninstalling must not silently destroy a pending key.
- **Weaknesses we must not copy** (§5):
  - pending keys encrypted with PBE-SHA1-3DES at only 20 iterations;
  - a database encryption password fixed in the app;
  - user passwords concatenated into shell commands;
  - relay payloads under single DES with an 8-digit key.
- **Legal** (§8): the Configurador is proprietary and its licence bans reverse engineering. EU and
  Spanish law allow decompiling for interoperability whatever the licence says, within limits. This
  memo describes behaviour only, and no FNMT code is in the repo. Get legal review before shipping,
  including FNMT's *Declaración de Prácticas de Certificación* (DPC).
- **Unverified until one real request runs** (Appendix B): whether FNMT's server accepts a request
  not made by the Configurador (it should, since the subject is a placeholder), and what exactly the
  download page puts in `installCert`.

---

## Sources

| Source | What |
| --- | --- |
| `configuradorfnmt_5.1.2.amd64.deb` from <https://descargas.cert.fnmt.es/Linux/configuradorfnmt_5.1.2.amd64.deb> (SHA-256 `90057343784d6df8bbad9dce7b13b53bc5b58b6c1b6fa597bb08b16d7f02b606`, fetched 2026-10-12) | The app. We decompiled only FNMT's own package (`es.gob.fnmt.cert.certrequest`, 81 classes) with Vineflower 1.11.1, plus the bundled `preferences.properties`, `updater.properties` and `certrequestmessages.properties`. |
| Download index <https://www.sede.fnmt.gob.es/descargas/descarga-software> | Versions per OS (§3.1) |
| `https://apus20.sede.fnmt.gob.es/SolicitudWebCert/js/fnmtcertrq.js` (v1.6.4) and `gestionPeticiones.js` | Page side of the request and install hand-off |
| Request form `https://apus20.sede.fnmt.gob.es/SolicitudWebCert/presolicitar.do?ID_CASO=68&APPID=PRESOLICITUD` | Citizen certificate request (case 68). Fetched with GET only; nothing submitted. |
| Download form `https://apus20.sede.fnmt.gob.es/DescargaCertificados/preDescarga.do?IDCA=PF1&TIPOCERT=F&APPID=DESCARGA_CERT` | Download step. GET only. |
| Before-you-start page <https://www.sede.fnmt.gob.es/certificados/persona-fisica/obtener-certificado-software/configuracion-previa> | FNMT's own rules: same computer, same user, don't uninstall or format |
| Mobile route <https://www.sede.fnmt.gob.es/certificados/persona-fisica/certificado-con-dispositivo-movil>, iOS app <https://apps.apple.com/es/app/id6449721772> | §9 |
| Request terms <https://www.sede.fnmt.gob.es/normativa/terminos-y-condiciones-persona-fisica-solicitud> | §8 |
| Licence text in the package (`/usr/share/doc/configuradorfnmt/copyright`) | §8 |
| Directive 2009/24/EC arts. 5–6 and 8 <https://eur-lex.europa.eu/eli/dir/2009/24/oj>; Spanish LPI (RDL 1/1996) art. 100 <https://www.boe.es/buscar/act.php?id=BOE-A-1996-8930>; Ley 40/2015 arts. 157–158 <https://www.boe.es/buscar/act.php?id=BOE-A-2015-10566> | §8 |

Class names below are FNMT's, given so a reader can find the same behaviour in their own copy. The
decompiled sources are not in this repo and must not be added (§8).

---

## 1. The user's journey (FNMT's documented flow)

1. **Install the Configurador** for your OS. FNMT says you must request and download on the same
   computer and the same OS user, and must not uninstall the app or format the disk in between.
2. **Request** at the sede (case 68, "Certificado de Persona Física"): NIF, first surname and an
   email address, then accept the terms. The page launches the Configurador. It asks for a new
   password, makes the key, and returns the request. FNMT emails a request code.
3. **Prove your identity**, by one of:
   - in person at a registration office (AEAT, Seguridad Social, ayuntamientos…);
   - by video identification, a paid service (€2.99 + tax at the time of writing);
   - with a DNIe.

   All three still need the Configurador on a desktop.
4. **Download** at the sede: NIF, first surname and request code. The page launches the
   Configurador. It asks for the password from step 2, makes the user save a `.p12` backup, and
   installs the certificate.

Between steps 2 and 4 the only copy of the private key is the Configurador's database on that
computer (§3.4). Losing it means starting over.

## 2. How the sede talks to the Configurador

### 2.1 Page API (`fnmtcertrq.js` v1.6.4)

The script defines a global `FnmtCertRequest` (with `var`, in a classic `<script>`). Its public
members:

| Member | Use |
| --- | --- |
| `VERSION` | `"1.6.4"` |
| `cargarAppFnmt(servletBase)` | Builds the servlet URLs: `<origin>/afirma-signature-retriever/RetrieveService` and `<origin>/afirma-signature-storage/StorageService` |
| `setServlets(storage, retrieve)` | Overrides them |
| `requestCert(ok, ko, keyType, keyLength, csrType, forceCard)` | Starts a request. `ok(base64Pkcs10)` / `ko(errorType, message)` |
| `installCert(ok, ko, cert)` | Starts an install. `cert` is the base64 certificate data from the server (§4.3) |
| `getBase64FromText`, `getTextFromBase64`, `downloadRemoteData`, `getErrorMessage`, `getErrorType`, `isAndroid`, `isIOS` | Helpers |

How `gestionPeticiones.js` uses it on the request page:

- `FnmtCertRequest.requestCert(successCallback, errorCallback, getKeyAlgorithm(caso), null, null,
  forceCard(caso))`.
- `getKeyAlgorithm` returns `"EC"` for cases 170, 174, 177, 179, 181, 146, 148 and 150. For case 68
  it returns nothing, so the app falls back to RSA.
- `forceCard` returns `false` for case 68 and most others (170, 10, 89, 72, 75, 77, 114, 174),
  which means software keys and no question about a card. Cases 20, 87 and 121 force a smart card.
  Case 119 returns `null`, which makes the app ask.
- `successCallback(b64)` sets `document.forms[0].PKCS10.value = b64`, shows a spinner and submits
  the form to `guardarpresolicitud.do`. **This is the only place the request reaches FNMT.**
- `errorCallback(type, msg)` renames the `PKCS10` field and shows `alert()` for `ERR-` messages.
  A shim must report errors through `ko` and keep `alert()` out of the agent's way; see
  [browser.md](browser.md) on dialogs.
- Older paths are still in the page: a hidden `<keygen name="tryKeygen">` (SPKAC), the IE
  `X509Enrollment` ActiveX path (RSA 2048 PKCS#10), and Safari-specific branches. None of them
  matters in Chromium.

The download form (`preDescarga.do`) posts `NIF_SG`, `COD_SOLICITUD` (request code), `FechaOp` and
`CodigoHmac` to `validarDescarga.do`. In some cases the page computes `CodigoHmac` with CryptoJS
HMAC-SHA256 keyed with the request code. We haven't seen the page that follows, because reaching it
needs a real request (Appendix B). From `installCert`'s signature, it calls
`FnmtCertRequest.installCert(ok, ko, certB64)`.

### 2.2 Launching the app

- `requestCert` builds
  `fnmtcr://request?fileid=<20 chars>&key=<8 digits>&stservlet=<StorageService>&keytype=…&keylength=…&csrtype=…&forcecard=…`.
  Null values are left out, and every value is URL-encoded.
  - `fileid`: 20 characters from `[0-9a-zA-Z]` minus `v`, from `crypto.getRandomValues`.
  - `key`: 8 decimal digits.
- On Android Chrome it uses `intent://request?…#Intent;scheme=fnmtcr;package=es.gob.fnmt.cert.certrequest;end`.
- In Chrome, and on iOS, it sets `document.location = url`. Other browsers get a hidden 1×1 iframe,
  or `navigator.msLaunchUri` on old IE/Edge.
- `installCert` builds `fnmtcr://install?fileid&stservlet&rtservlet&cert&key`. If the URL is over
  the browser limit (2,000 characters on desktop), the page first POSTs the parameters to
  StorageService and launches `fnmtcr://install?fileid=<new id>&rtservlet=…&key=…` instead.
  - The upload body is `op=put&v=1_0&id&dat`, where `dat` is
    `<install><e k="…" v="…"/>…</install>`, encrypted as in §2.3.
  - The app downloads it with `op=get&v=1&id` and parses the `<e k v>` elements. Any other element
    name is an error.

The OS maps `fnmtcr:` to the app. The Linux postinst registers `x-scheme-handler/fnmtcr`, a KDE
handler and the Firefox prefs `network.protocol-handler.app.fnmtcr`. The macOS `.pkg` and Windows
installer do the same in their own way (not inspected).

### 2.3 The relay (same design as AutoFirma)

The app posts its result to StorageService, and the page polls RetrieveService:

- **App → storage:** `POST <StorageService>` with body `op=put&v=1_0&id=<fileid>&dat=<payload>`.
  The service answers `OK`.
- **Page → retrieve:** `POST <RetrieveService>`, body `op=get&v=1_0&id=<fileid>&it=<n>`. The first
  poll is 8 s after launch, then every 8 s, up to 50 tries (about 6.7 minutes). After that the page
  reports `java.util.concurrent.TimeoutException`.
- **Responses the page understands:**
  - `err-06…`: not there yet, keep polling;
  - `ERR-nn:=message`, or base64 of `ERR-`/`err-` (prefix `RVJSL`/`ZXJyL`): error, reported
    through `ko`;
  - `OK`: success with no data (install);
  - anything else: the encrypted result (request).
- **Payload encryption:**
  - `DES/ECB/NoPadding`, keyed with the 8 ASCII digits of `key`.
  - Data is zero-padded to 8 bytes, and the result is written `"<pad count>.<base64url ciphertext>"`.
  - The page's DES code always adds one extra zero block and strips it after decrypting.
  - The page decrypts and calls `ok(base64)` with the result.
- **Errors from the app** are sent as `ERR-2xx: <message>` through the same channel (§3.6).

The relay protects nothing secret: the request and the certificate are public data, and DES with an
8-digit key gives about 26 bits of security. A shim makes it unnecessary.

## 3. What the Configurador does

### 3.1 Package and runtime

- **Versions:** 5.1.2 (internal version `18`) for Windows x64, macOS (`.pkg`) and Linux `.deb`. The
  Linux `.rpm` is still 5.0.3.
- **Package contents:** a Java app (main class `es.gob.fnmt.cert.certrequest.CertRequest`) with its
  own Temurin 21 runtime. It bundles:
  - Bouncy Castle FIPS (`bc-fips`, `bcpkix-fips`, `bcutil-fips`);
  - Apache Derby (embedded database), Rhino (JavaScript, for proxy auto-config scripts) and a proxy
    discovery library (`markusbernhardt/proxy-vole`);
  - JNA and SLF4J.
- **Single instance:** a file lock at `~/.fnmt/ConfiguradorFnmt/.lock`. A second launch shows an
  error. On Windows the folder is made hidden.
- **Proxy:** uses the user's saved proxy settings, including a username and password stored in Java
  preferences, or the system/PAC proxy.
- **Updates:** fetches a version number from `https://www.sede.fnmt.gob.es/documents/10445900/10528994/certrequest.version[.mac|.linux]`.
  If it is newer, the app offers to open the download page and quit. **It skips this check while a
  request is pending**, presumably so an upgrade doesn't strand a key.
- **Logs:** `~/.fnmt/logs/ConfiguradorFnmt.fnmt.log.xml`, rotated over 20 files of 2 MB, plus a Derby
  log. They contain the full call URL including the relay key, the request in base64, the
  certificate, and the hostname output on Linux.

### 3.2 Call parameters (`UrlParametersFnmt*`)

| Parameter | Op | Meaning |
| --- | --- | --- |
| `fileid` | both | Relay id. Required. If any required parameter is missing, the app fetches all parameters from `rtservlet`, or the default RetrieveService. |
| `key` | both | 8-character DES key. Any other length is an error. If absent, data goes in clear (base64). |
| `stservlet` | both | StorageService URL. Must be `https` with no query string. Default `https://apus20.sede.fnmt.gob.es/afirma-signature-storage/StorageService`. |
| `rtservlet` | install | RetrieveService URL, same rules. Default `…/afirma-signature-retriever/RetrieveService`. |
| `keytype` | both | `rsa`, or `ec`/`ecdsa`. Anything else, or missing, means RSA. |
| `keylength` | request | Integer. Default 2048 for RSA, 256 for EC (curve fixed to `secp256r1`). |
| `forcecard` | request | `true` = smart card, `false` = software, absent = ask the user. **Quirk:** it is only read when `keylength` is absent or invalid, so a page that sends `keylength` always gets the question. |
| `csrtype` | request | Sent by the page; **ignored** by 5.1.2. |
| `cert` | install | Certificate data (§4.3) |
| `ping=1` | any | Health check (§3.7) |

The app turns `%3F` and `&amp;` back into `?` and `&` before parsing, which deals with browsers that
over-encode the URL.

### 3.3 Request (`OperationSoft.doRequest`)

1. Beeps, then asks for a password twice ("Debe crear una contraseña para proteger las claves de su
   certificado durante el proceso de solicitud y descarga…"). If the user cancels and confirms, the
   app sends `ERR-230`.
2. Generates the key pair:
   - `KeyPairGenerator` RSA with the given length;
   - or EC on `secp256r1`.
3. Builds the PKCS#10 request:
   - **Subject `CN=foo.bar.com`**, a fixed placeholder.
   - SubjectPublicKeyInfo of the new key.
   - **No attributes and no extension request.**
   - Signed `SHA256withRSA` (OID 1.2.840.113549.1.1.11) or `SHA256withECDSA` (1.2.840.10045.4.3.2).
   - FNMT clearly takes the subject from the form data (NIF, surname) and uses the request only for
     the public key and proof of possession.
4. Encrypts the private key as PKCS#8 `EncryptedPrivateKeyInfo` with `PBEWithSHA1AndDESede`, an
   8-byte random salt and **20 iterations**, under the user's password.
5. Stores it in the database (§3.4) under the public-key hash.
6. Sends the DER request to the relay (§2.3), then exits.

Errors along the way go to the relay as `ERR-201` (key generation), `ERR-202` (PKCS#10), `ERR-204`
(PKCS#8) or `ERR-205` (database).

### 3.4 Where the pending key lives

- **Database:** embedded Derby at `~/.fnmt/ConfiguradorFnmt/FnmtKeysV2`, user `fnmt`, encrypted
  with AES-256/CBC. **The database's boot password is fixed in the app's configuration**, the same
  for every install, so the database encryption adds nothing against someone who has the file. The
  only real protection is the user's PKCS#8 password from §3.3.
- **Tables:**
  - `APP.KEYS(PKCS8 VARCHAR(4069), PUBLIC_KEY_HASH VARCHAR(64), DATE VARCHAR(255))` holds software
    keys.
  - `APP.CARDS(PUBLIC_KEY VARCHAR(2048), CKA_ID VARCHAR(255), DATE VARCHAR(255))` holds smart-card
    requests (§3.8).
- **Lookup key:** `PUBLIC_KEY_HASH` is base64url of SHA-256 over the DER SubjectPublicKeyInfo.
  Several requests can be pending at once.
- **Older versions:** an older database (`FnmtKeys`, Blowfish, same fixed password) is still read
  as a fallback during install.
- **Why "same computer, same user":** the key is only in this per-user folder. Nothing goes to FNMT
  or the cloud.

### 3.5 Download and install (`AbstractOperation.doInstall`, `OperationSoft.doInstallSoft`)

1. **Decode the certificate data:** base64 (`-_` turned back into `+/`, spaces removed), then gunzip
   if it is gzipped.
   - It is parsed as a CMS SignedData and every certificate in it is taken.
   - If that fails, it is parsed as a single X.509 certificate.
   - On failure the app sends `ERR-207`.
2. **Find the key:**
   - A card key, if the public key matches a `CARDS` row (§3.8).
   - Otherwise, ask for the password ("Esta contraseña es la que estableció durante el proceso de
     solicitud") and decrypt the matching `KEYS` row, then the legacy database.
   - Wrong password: offer to retry, otherwise `ERR-232`. Cancel: `ERR-233`.
   - No row: `ERR-209`, with the message "asegúrese de que la contraseña es correcta y de que está
     haciendo la descarga desde el mismo equipo desde donde solicitó el certificado".
3. **Build the chain** (`CertPathUtil.buildCertPath`):
   - It picks the end-entity certificate: the only one, or the first that isn't a CA (basicConstraints
     plus keyCertSign).
   - It then **replaces whatever chain came in the bundle with a fixed one from CA certificates
     bundled in the app**, chosen by the leaf's issuer:
     - G1: *AC FNMT Usuarios*, *AC Representación*, *AC Sector Público* and *AC Componentes
       Informáticos*, under *AC Raíz FNMT-RCM*;
     - G2: *AC Usuarios G2*, *AC Representación G2*, *AC Sector Público G2* and *AC Consulares G2*,
       under *AC Raíz FNMT-RCM G2*;
     - each also has a `_PRE` (pre-production) twin.
   - Unknown issuer: it reorders what the bundle contains.
4. **Backup, mandatory in practice:**
   - It builds a PKCS#12 with Bouncy Castle FIPS, protected by the same password, with alias = the
     certificate's CN with accents and punctuation folded to ASCII/`_`.
   - It opens a "save as" dialog with default name `<alias>.p12`.
   - Cancelling asks "¿Está seguro…? Si no la realiza en este momento es posible que no pueda
     hacerlo con posterioridad".
   - Then it tells the user the backup's password is the request password.
5. **Install into the OS store:**
   - **macOS:** sets the key entry in `~/Library/Keychains/login.keychain-db` (or `login.keychain`)
     through Java's Apple provider. If the chain doesn't validate, it retries with the leaf only.
     Fallback: `security import <p12> -P <password>` run through AppleScript.
   - **Windows:** CAPI `Windows-MY` for RSA. EC keys, and any failure, fall back to PowerShell
     `Import-PfxCertificate` into `Cert:\CurrentUser\My`, then `certutil -user -importPFX`.
   - **Linux:** the shared NSS database (`~/.pki/nssdb`, else `/etc/pki/nssdb`). Failure is logged
     and ignored.
6. **Firefox:** if Firefox is installed, the app also imports into its NSS profile. On Linux it does
   this in a child JVM (`-linuxmozadd <gz-b64 cert> <b64 PKCS#8>`), with the key re-encrypted under
   another fixed password. On macOS it skips this step. A failure only shows a warning.
7. Deletes the `KEYS` row, sends `OK` to the relay and exits. If the OS install fails, it sends
   `ERR-211`. The `.p12` backup already exists by then.

### 3.6 Error codes the app sends

| Code | When |
| --- | --- |
| `ERR-201` | Key generation failed |
| `ERR-202` | PKCS#10 failed |
| `ERR-204` | PKCS#8 encryption failed |
| `ERR-205` | Database write failed |
| `ERR-207` | Certificate data unreadable |
| `ERR-209` | No matching key on this computer |
| `ERR-211` | OS install failed |
| `ERR-215` / `ERR-226` | Card driver missing / card inaccessible |
| `ERR-216` / `ERR-217` / `ERR-218` | Card key unreadable / key not on this card / writing the certificate to the card failed |
| `ERR-221` | No card or reader |
| `ERR-230` | User cancelled the password at request time |
| `ERR-231` | User cancelled the card PIN |
| `ERR-232` / `ERR-233` | Wrong password, gave up / cancelled at download |

The format on the wire is `ERR-nnn: <Spanish message, HTML entities>`, and `errorCallback` shows
`msg.substr(9)` in an `alert()`.

### 3.7 `ping=1`

If the URL contains `ping=1`, the app answers `"<internal version> <version text> "`, e.g.
`"18 5.1.2 "`, through the relay and exits without opening a window. Page script 1.6.4 never sends
it; other FNMT pages may. A shim that wants to support it should answer with its own version
string, not FNMT's.

### 3.8 Smart cards (out of scope)

- With `forcecard=true`, or if the user says yes to "¿Desea usar una tarjeta inteligente de
  FNMT-RCM…?", the key is generated on an FNMT smart card through PKCS#11.
  - Supported families: CERES, Gemalto Optelio R7 (contact and contactless), G&D, Bit4Id and
    Oberthur, detected by ATR.
  - The key is marked `CKA_SENSITIVE`, and its `CKA_ID` goes in the `CARDS` table.
- At download, the certificate is written next to the key on the card.
- FNMT warns that a card key can't be backed up or used on phones.
- This is not the DNIe, and SpainAssist has no PKCS#11 path. A stand-in should report it as
  unsupported (§7.3).

## 4. Data formats in detail

### 4.1 Request returned to the page

- DER PKCS#10, base64 (standard alphabet).
- Built with Bouncy Castle FIPS's `JcaPKCS10CertificationRequestBuilder` and a custom signer.
- The signature algorithm identifier carries **no parameters** for RSA: no `NULL`. This is what the
  custom signer writes. For SHA256withRSA, RFC 4055 recommends `NULL`, but most parsers accept both.
  A stand-in should match the Configurador (absent) unless testing shows the server minds.

### 4.2 Pending key at rest

`EncryptedPrivateKeyInfo` with `pbeWithSHAAnd3-KeyTripleDES-CBC` (PKCS#12 PBE, OID
1.2.840.113549.1.12.1.3), 8-byte salt, 20 iterations. We will **not** reproduce this (§5); our vault
already encrypts secrets.

### 4.3 Certificate data at install

- A CMS SignedData with certificates only ("degenerate PKCS#7"), possibly gzipped, in base64 or
  base64url.
- The fallback is a single DER X.509 certificate.
- The leaf may come with or without intermediates.
- The issuer for a 2026 citizen certificate is expected to be *AC FNMT Usuarios* (G1) or *AC
  Usuarios G2*. Which one is current is unverified (Appendix B).

### 4.4 Backup `.p12`

PKCS#12 written by Bouncy Castle FIPS, protected with the request password. It holds the key and
the chain from §3.5 step 3. Our vault's importer (`packages/vault/src/pkcs12.ts`) already reads Bouncy
Castle `.p12` files, including 3DES ones, and keeps the chain.

## 5. Weak points in FNMT's implementation (don't copy them)

These are observations, not attacks. Every item needs local access to the user's files or to the
traffic.

1. **Weak key protection:** PBE-SHA1-3DES with 20 iterations makes offline password guessing cheap
   for anyone who copies `~/.fnmt`.
2. **Fixed database password:** the same for every install, so the Derby AES encryption is
   effectively obfuscation.
3. **Unquoted passwords in commands:** the macOS fallback (`security import … -P <password>` via
   AppleScript) and the Windows PowerShell fallback build the command text from the user's
   password. A password with quotes or shell characters breaks the install or changes the command.
4. **Relay encryption:** single DES/ECB with an 8-digit key. The data is public, so this is weak
   rather than harmful.
5. **Logs** keep the relay key and full URLs for up to 40 MB of history. They are not secret, but
   they are noise.
6. **TLS to the relay** trusts only FNMT's own SSL CAs (pinning, which is good). It checks the
   leaf's signature against them by hand rather than through a full PKIX validation.

## 6. What a SpainAssist stand-in must handle

1. **Lifetime of the pending key.** Days can pass between request and download, so the key must
   live in the vault, not in the browser context: contexts are ephemeral and per procedure
   ([browser.md](browser.md), `packages/browser/src/service.ts`).
   - Store it under SHA-256(SPKI) so the download can find it.
   - Allow several pending requests at once, and record the request date and the procedure.
   - "Borrar todo" (IPC `vault.wipeAll`) and deleting the procedure must warn when a pending FNMT key exists.
   - Never expire the key silently. Let the user discard it.
2. **The request must match the Configurador's:**
   - RSA 2048 with SHA256withRSA by default;
   - EC P-256 with SHA256withECDSA when `keyType` is `EC`;
   - subject `CN=foo.bar.com`, no attributes, algorithm parameters as in §4.1.

   Honour `keyLength` when the page sends one.
3. **Certificate parsing** has to cope with: base64 or base64url, embedded spaces, optional gzip,
   CMS SignedData or a bare X.509, any number of certificates, any order.
4. **The chain.** Ship FNMT's public intermediates and roots (G1 and G2; production only, except in
   tests) and build the chain the same way, by issuer.
   - Our sidecar sends the vault credential's whole chain during TLS client login
     (`packages/sidecar/go/identity.go`, `tls.Certificate{Certificate: id.chain}`), so a correct
     chain in the credential is what makes the new certificate work at sedes that don't already
     hold the intermediate.
   - Get the CA files from FNMT's public CA page, not from the Configurador package.
5. **Turning it into a credential.** The vault adds certificates today only through renderer IPC,
   from a `.p12` file plus passphrase (`vault.addCertificate`). The stand-in needs a main-process
   path that takes key + chain and creates the same normalized PKCS#12 credential, with the user's
   consent. It must keep the existing rules: reject expired certificates, deduplicate.
6. **Backup.** FNMT's flow nudges hard for a `.p12` backup, and users will expect one; without it,
   losing the vault or the computer means a new request and a new identity check. Offer "Guardar
   copia de seguridad" (export as a passphrase-protected `.p12`) right after the download, and from
   Mis datos → Credenciales. This is a new vault feature: credentials can't be exported today.
7. **Installing in the OS or Firefox.** The Configurador does it, and some users may want the
   certificate in their own browser too. That is a product choice, not an interoperability need.
   Default to vault-only, plus the backup from item 6. The user can import that file anywhere.
8. **Errors.** Answer `ko(type, message)` with our own Spanish text. Don't send `ERR-` strings that
   make the page call `alert()`. If we must use an `ERR-` string, keep the format
   `ERR-nnn: message`, because the page shows `substr(9)`.
9. **Polling and timing.** With a shim the page doesn't poll, but the callbacks must arrive before
   the user or agent navigates away. The key generation and user-consent prompt must take minutes
   at most.
10. **Cards** (`forceCard === true`): answer `ko` with "no compatible". Never prompt for a card.
11. **Single instance.** Two concurrent requests from two procedures are fine for us, because keys
    are indexed by SPKI hash. No lock is needed.
12. **Consent and wording.**
    - The user must approve generating the key, as with signatures and certificate logins.
    - Downloading a certificate into the vault is also a consent moment.
    - The password FNMT asks for has no equivalent in our flow, because the vault replaces it. Say
      so in the guide, because FNMT's help pages talk about it.
13. **Tests.** Automated tests must never contact FNMT. `apps/mock-sede` needs a fake FNMT flow:
    - a request page that loads a faithful copy of `FnmtCertRequest`'s public API and submits
      `PKCS10`;
    - an issuing CA (the mock already has PKI helpers in `pki.ts`) that signs a certificate for the
      request's public key with a subject built from the form;
    - a download page that calls `installCert` with a gzipped, base64url SignedData;
    - a "_PRE-like" test chain so the chain-building code is exercised.

## 7. Recommended design

### 7.1 Components

1. **In-page shim** (`@sa/signer`, next to the AutoFirma shim, or a sibling package if it grows):
   - Trap the global `FnmtCertRequest` with the same `Object.defineProperty` setter technique as
     `AutoScript` ([autofirma.md](autofirma.md) §2.2).
   - The page's own object is built by an IIFE and then assigned, so the trap wraps or replaces
     `requestCert`, `installCert` and `cargarAppFnmt`/`setServlets` (to no-ops).
   - It calls the host through the existing `exposeBinding` mechanism
     (`packages/browser/src/service.ts`, `AFIRMA_BINDING`), or a sibling binding.
   - Only on FNMT origins (`*.sede.fnmt.gob.es`, already official under `gob.es` in
     `packages/shared/src/official.ts`) and the mock-sede.
2. **Certificate-request broker** (main process, `apps/desktop/src/main`):
   - `request({origin, keyType, keyLength, procedureId})`: get consent → generate the key
     (`node:crypto`) → build the PKCS#10 (`pkijs`/`asn1js`, already dependencies of `@sa/signer`) → store the
     pending key in the vault → return base64 DER.
   - `install({origin, certData, procedureId})`: parse (§6.3) → find the pending key by SPKI hash →
     build the chain (§6.4) → get consent → create the vault credential → delete the pending key →
     offer the backup → return.
   - The private key never leaves the main process. The renderer and the model see only "pending
     request for <NIF masked>, created <date>" and the resulting `CredentialSummary`.
3. **Vault** (`@sa/vault`):
   - a new pending-key record type, or a typed secret (`setSecret` with a well-known prefix is a
     workaround; prefer a proper type, per AGENTS.md's no-workarounds rule);
   - `addCertificateFromKey(key, chain)`;
   - `exportCertificate(id, passphrase)`.
4. **Agent guide** (`packages/agent`): the FNMT steps.
   - Fill the form from the vault's personal data.
   - Explain the identity check (in person, video identification, DNIe) and help book an
     appointment.
   - Later, resume the procedure to download.
   - Tell the user the request code arrives by email. The agent may read it with the user's
     consent ([email.md](email.md)).
5. **Contracts** (`@sa/shared`): bridge requests for the two operations, a pending-request summary
   type, and IPC for listing and discarding pending requests and for the backup export.

### 7.2 Why not the alternatives

| Option | Verdict |
| --- | --- |
| Drive FNMT's own Configurador | Needs Java and FNMT's installer on the user's machine, puts an unattended native window in the middle of the flow, and keeps the key outside the vault. It also runs into the licence's "no use as part of a competing service" clause. No. |
| Register our own `fnmtcr://` handler and speak the relay | Clashes with an installed Configurador. Needs the DES relay, a second app entry point and OS registration. No benefit over the shim, since Chromium is ours. No. |
| Let the browser context hold the key (WebCrypto in the page) | Contexts are ephemeral, and the key would live in renderer memory. No. |
| Read the certificate from the download page's DOM after the fact | Brittle and unnecessary: `installCert` hands it to us. Keep only as a fallback if the shim fails. |
| Tell users to use FNMT's mobile app and import the `.p12` | Works today with no code. Keep it as the documented fallback (§9). |

### 7.3 Shim behaviour, summarised

| Page call | Shim does |
| --- | --- |
| `cargarAppFnmt`, `setServlets` | Record, no-op |
| `requestCert(ok, ko, keyType, keyLength, csrType, forceCard)` | If `forceCard === true`: `ko('es.gob.fnmt.cert.certrequest.CardNotSupported', '…')`. Otherwise call the broker; on success `ok(b64Der)`, on refusal or error `ko(type, message)`. |
| `installCert(ok, ko, cert)` | Call the broker with `cert`; on success `ok()`, otherwise `ko(type, message)` |
| `getErrorMessage`, `getErrorType` | Last error |
| Helpers (`getBase64FromText`, …) | Pass through to the page's own implementation |
| `VERSION` | Keep the page's value; pages may check it |

## 8. Legal notes (not legal advice)

- **Licence.** The Configurador is proprietary: "© 2026 FNMT-RCM. Todos los derechos reservados".
  The licence forbids modifying it, reverse engineering or decompiling it, and marketing it "formando
  parte de un paquete de oferta de servicios para terceros que pudiera competir con la Aplicación".
  It says FNMT reuses code from Cliente @firma (dual GPLv2/EUPL 1.1), which doesn't make the
  Configurador open source. No source is published anywhere we could find.
- **No duty to publish.** No EU rule requires publicly funded software to be open source. Ley
  40/2015 arts. 157–158 oblige administrations to share applications with other administrations,
  and open-source licensing is optional.
- **Interoperability exception.**
  - Directive 2009/24/EC art. 6, applied in Spain by LPI art. 100, lets a lawful user decompile a
    program, without the rightholder's permission, when that is indispensable to get the
    information needed for an independently created program to interoperate with it.
  - Conditions: the information isn't readily available; only the necessary parts are decompiled;
    the information isn't given to others except as needed for interoperability; and it isn't used
    to create a program substantially similar in its expression.
  - Art. 8 makes contract terms to the contrary void.
  - Art. 5(3) separately allows observing and testing the program while running it.
- **How this memo stays inside that:**
  - We decompiled only FNMT's own package and read only the parts on the hand-off, key handling and
    install. We skipped the third-party libraries and most of the smart-card code.
  - The decompiled sources live outside the repo and will be deleted with the job.
  - This memo records behaviour and formats, not code.
  - Our implementation will be written from this description in TypeScript with different
    architecture. It doesn't use or redistribute FNMT's binaries, and it talks only to FNMT's public
    web pages.
- **Still to check before shipping:**
  1. FNMT's *Declaración de Prácticas de Certificación* (DPC) and the policies for the citizen
     certificate: does any clause require keys to be generated with FNMT's software, or on a
     specific kind of device? If it requires "software proporcionado por la FNMT-RCM", a
     third-party generator could breach the subscriber's obligations even if it works.
  2. The request terms page has no clause on clients or automation. Re-read it at implementation
     time.
  3. Whether answering `ping` or keeping `VERSION` could look like impersonating FNMT's app. We
     plan to identify ourselves, never as FNMT.

## 9. Options available today without code

- **FNMT's mobile app "Certificado digital FNMT"** (Android, iOS) handles request, identity check
  and download without the Configurador. FNMT says its backup can be installed on a computer. The
  user can then import that `.p12` in Mis datos → Credenciales. The export format is unverified
  (Appendix B).
- **Configurador in the user's own browser,** then import the backup `.p12`.
- In both cases the agent can guide, fill FNMT's forms where it can, and book the identity
  appointment.

## 10. Plan

1. Decision record: page shim plus main-process broker; pending keys in the vault; chain from
   bundled FNMT CAs; vault export.
2. Mock-sede FNMT flow and e2e test (§6.13).
3. Vault: pending-key record, `addCertificateFromKey`, `exportCertificate`, and wipe and delete
   warnings.
4. Broker and shim, with consent prompts.
5. Agent guide.
6. One real end-to-end run by a person, with their own NIF, to close Appendix B. This must never be
   automated.

---

## Appendix A — Quick reference

```
Request launch : fnmtcr://request?fileid=<20>&key=<8 digits>&stservlet=<https…/StorageService>
                 [&keytype=RSA|EC][&keylength=n][&csrtype=x][&forcecard=true|false]
Install launch : fnmtcr://install?fileid&stservlet&rtservlet&cert=<b64(gz?)(SignedData|X.509)>[&key]
                 (or, when too long: fnmtcr://install?fileid=<id2>&rtservlet&key, params on relay as
                  <install><e k="…" v="…"/></install>)
Ping           : any of the above + ping=1  → relay gets "18 5.1.2 "
Relay put      : POST StorageService   op=put&v=1_0&id=<fileid>&dat=<pad>.<b64url(DES-ECB(zero-pad(data)))>
Relay get      : POST RetrieveService  op=get&v=1_0&id=<fileid>&it=<n>  (app uses GET …?op=get&v=1&id=)
                 → err-06… (wait) | ERR-nnn: msg | OK | <pad>.<b64url ciphertext>
PKCS#10        : subject CN=foo.bar.com, SPKI, no attributes, SHA256withRSA | SHA256withECDSA
Keys           : RSA 2048 (default) | EC secp256r1
Pending key    : ~/.fnmt/ConfiguradorFnmt/FnmtKeysV2 (Derby), row keyed by b64url(SHA-256(SPKI))
Page callback  : ok(b64) → forms[0].PKCS10 = b64 → submit guardarpresolicitud.do
```

## Appendix B — Unverified

| Item | How to settle it |
| --- | --- |
| The server accepts a PKCS#10 not made by the Configurador (expected, since it's a plain PKCS#10 with a placeholder subject) | One real request |
| Exact `installCert` argument on the post-download page (gzip? whole chain?) | One real download, or read the page with the user's consent |
| Which CA issues 2026 citizen certificates (G1 *AC FNMT Usuarios* or *AC Usuarios G2*) | Real certificate, or FNMT's CA page |
| Whether the server checks the PKCS#10 signature algorithm parameters (§4.1) | Real request |
| Whether the DPC requires FNMT's own key-generation software | Read the DPC (§8) |
| Format of the mobile app's backup | Try the app |
| macOS `.pkg` and Windows installer behaviour (protocol registration, extra steps) | Inspect the installers; not needed for the shim |
