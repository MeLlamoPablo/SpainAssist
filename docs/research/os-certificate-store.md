# Installing a certificate in the OS certificate store — research memo

*Date: 2026-11-02 · Scope: whether SpainAssist can put a certificate it holds (issued by FNMT
through the app, or imported from a `.p12`), with its private key and chain, straight into the
macOS, Windows or Linux certificate store, so that Safari, Chrome, Edge, Firefox and AutoFirma can
use it without the user importing a `.p12` by hand. Research only: nothing is built. The baseline
to compare with is the password-protected `.p12` export ([fnmt.md](fnmt.md) §6.6).*

**Update, 2026-11-14.** macOS is built, differently from §7–8: the app now finds FNMT
certificates already in the keychain and uses them in place ("external" certificates), and
"Mover al sistema operativo" moves a vault certificate there instead of copying it, so there is
no second copy to track. The key is imported extractable, since the keychain then holds the only
copy. koffi works with Security.framework from Electron's main process [verified in the
development build; the notarized build is still to check]. See `docs/ARCHITECTURE.md`,
"External certificates (macOS, Windows)". Windows followed the same day, without the move: the
app only reads `CurrentUser\My` and signs with its keys, because of the MSIX's registry
virtualization (§3.5), and the user imports the downloaded `.p12` themselves [written on a Mac;
CI's Windows job runs the crypt32/ncrypt test, a sideloaded MSIX is still to check].

Marks used below:

- **[verified]**: I ran it on this Mac (macOS 26.5.2, build 25F84, Apple silicon), against
  throwaway keychains in a scratch directory (§2.2).
- **[read]**: from the cited source, checked on 2026-11-02.
- **[inferred]**: my reasoning from what I verified or read, not checked.

## TL;DR

- **Yes, on every OS, with no admin rights.** The main process already holds the key and the chain
  (the vault keeps a normalized `.p12`, `packages/vault/src/certificate.ts`). Each OS can import a
  PKCS#12 blob into the user's own store.
- **macOS: cheap, and verified here.**
  - Call `SecItemImport` (or `SecPKCS12Import`) from the main process into the login keychain.
  - The hardened, notarized, non-sandboxed build needs no new entitlement, because it already uses
    the login keychain for `safeStorage`. Leave the data-protection keychain alone: it needs a
    provisioning profile, and other apps can't see its items.
  - Two catches:
    1. macOS 13–14 only read legacy `.p12` files (3DES, SHA-1 MAC). On macOS 26.5.2,
       `SecItemImport` still rejects AES-256 [verified], so import a 3DES copy made in memory.
    2. Every other app (Safari, Chrome, Edge, AutoFirma) asks for the login keychain password the
       first time it signs with the key. Apple: "there's no supported way for you to create
       keychain items which will be silently used by other apps". Users who import a `.p12` by
       hand report the same prompts.
- **Windows, NSIS build: cheap.**
  - `PFXImportCertStore` plus `CertAddCertificateContextToStore` into `CurrentUser\My`, and the
    intermediate into `CurrentUser\CA`. PowerShell's `Import-PfxCertificate` also works.
  - No prompt, and no prompt for any other app either.
- **Windows, Store MSIX build (the one we advertise): probably not as is.**
  - electron-builder makes it a full-trust Desktop Bridge app. Windows copies all of its HKCU
    writes to a private per-app hive, and the user's certificate store lives in HKCU. Microsoft
    documents no exception for certificates.
  - So Chrome and Edge would most likely never see the certificate, while the CNG key could
    still land in the real profile (§3.5, inferred).
  - Possible ways out: the WinRT `UserCertificateEnrollmentManager` with the restricted
    `sharedUserCertificates` capability, or a helper process started outside the package. Each
    needs a test on a real Store install, and the first needs Store approval.
- **Linux: possible, fiddly, low value.**
  - Electron's own `app.importCertificate` writes Chrome's NSS database. But it marks every
    certificate after the first as a trusted SSL CA, so it must not get the chain.
  - Chrome 146+ may use `~/.local/share/pki/nssdb` rather than `~/.pki/nssdb`. AutoFirma doesn't
    look there, and Firefox has its own database per profile.
- **Who sees it once it is in the OS store:**
  - Chrome, Edge and Safari (macOS);
  - Firefox on Windows and macOS (`security.osclientcerts.autoload` has been on by default since
    Firefox 90; not on Linux);
  - AutoFirma (Windows store / Apple keychain by default).
- **Chain:** install the intermediate (*AC FNMT Usuarios* or *AC USUARIOS G2*) with the leaf.
  Chrome on Windows and Linux matches the server's CA list only against certificates already on
  the machine. Never add the root: *AC RAIZ FNMT-RCM* is already in Apple's and Microsoft's root
  programs, and adding a root to the Windows Root store brings up a confirmation dialog.
- **What gets worse:**
  - a second copy of the key that the app no longer controls: deleting it in Mis datos doesn't
    delete it there;
  - on Windows, every process of the user can sign with it silently;
  - ARCHITECTURE §7's "Certificate use and signatures need explicit approval" stops holding for
    that copy.
- **Recommendation (§8):**
  1. Ship the `.p12` export first (*done*). It works on every OS and build, and on other
     computers and phones, and its 3DES encoding imports on macOS 13–14 too (§2.3).
  2. Then add an explicit, per-certificate "Añadir a este Mac / a Windows" action in Mis datos,
     never automatic: macOS first (about 3–4 days, shared parts included), then Windows NSIS
     (about 2–3 days).
  3. Spike the MSIX for 1–2 days before promising it on the Store build.
  4. Do Linux last, if at all.

---

## Sources

| Source | What |
| --- | --- |
| Apple TN3137 *On Mac keychain APIs and implementations* <https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains> (revised 2026-09-24) | File-based vs data-protection keychain, entitlements, SecItem defaults |
| macOS 26 SDK `Security.framework/Headers/SecImportExport.h` (Xcode on this Mac); <https://developer.apple.com/documentation/security/secpkcs12import(_:_:_:)>, `secitemimport(…)`, `ksecimporttomemoryonly` | `SecPKCS12Import` and `SecItemImport` options |
| `man security` on macOS 26.5.2 | `import` (`-x`, `-T`, `-A`), `set-key-partition-list` |
| Apple Developer Forums [810723](https://developer.apple.com/forums/thread/810723) (Jan 2026), [746931](https://developer.apple.com/forums/thread/746931) (Feb 2024), [98182](https://developer.apple.com/forums/thread/98182?page=2) (2018) | Quinn (Apple DTS) on modern PKCS#12 algorithms, keychain partitioning and silent use by other apps |
| Apple Community [256320130](https://communities.apple.com/es/thread/256320130) (Jul 2026, macOS 15.7) | What users see with an FNMT certificate in Safari and Chrome |
| Apple root list <https://support.apple.com/en-us/126047> (trust store 2025082000, macOS 26) | FNMT roots in Apple's store |
| Microsoft Learn: [PFXImportCertStore](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-pfximportcertstore), [CertAddCertificateContextToStore](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certaddcertificatecontexttostore), [CertFindChainInStore](https://learn.microsoft.com/en-us/windows/win32/api/wincrypt/nf-wincrypt-certfindchaininstore), [Key Storage and Retrieval](https://learn.microsoft.com/en-us/windows/win32/seccng/key-storage-and-retrieval), [NCRYPT_UI_POLICY](https://learn.microsoft.com/en-us/windows/win32/api/ncrypt/ns-ncrypt-ncrypt_ui_policy), [System Store Locations](https://learn.microsoft.com/en-us/windows/win32/seccrypto/system-store-locations), [Import-PfxCertificate](https://learn.microsoft.com/en-us/powershell/module/pki/import-pfxcertificate), [certutil](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil), [about_PowerShell_exe](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe) | Windows APIs and tools |
| Microsoft support article "Cannot import AES256-SHA256 encrypted PFX" (<https://github.com/MicrosoftDocs/SupportArticles-docs/blob/main/support/windows-server/certificates-and-public-key-infrastructure-pki/cannot-import-aes256-sha256-encrypted-pfx-certificate.md>) | Which Windows versions read AES-256 PFX files |
| Microsoft Learn: [How packaged desktop apps run](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes) (updated 2026-10-12), [flexible virtualization](https://learn.microsoft.com/en-us/windows/msix/desktop/flexible-virtualization), [app capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations) (2026-10-02), [UserCertificateEnrollmentManager.ImportPfxDataAsync](https://learn.microsoft.com/en-us/uwp/api/windows.security.cryptography.certificates.usercertificateenrollmentmanager.importpfxdataasync), [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [Store policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) | MSIX virtualization and the ways around it |
| Chromium `net/ssl/client_cert_store_{mac,win,nss}.cc`, `net/ssl/client_cert_matcher.cc`, `crypto/nss_util.cc`, `chrome/browser/net/profile_network_context_service.cc` (main, 2026-11-02) | Where Chrome reads client certificates and how it matches issuers |
| Electron v44.5.1 `shell/browser/api/electron_api_app.cc` (`ImportIntoCertStore`); <https://www.electronjs.org/docs/latest/api/app> | `app.importCertificate` (Linux only) |
| Firefox `modules/libpref/init/StaticPrefList.yaml` (main), bugs [1696997](https://bugzilla.mozilla.org/show_bug.cgi?id=1696997) and [1848815](https://bugzilla.mozilla.org/show_bug.cgi?id=1848815), `security/manager/ssl/osclientcerts/` | `security.osclientcerts.autoload`, `security.enterprise_roots.enabled` |
| `ctt-gob-es/clienteafirma` (master): `AOKeyStore`, `AOKeyStoreManagerFactory`/`getDefaultKeyStoreTypeByOs`, `SharedNssUtil`, `autoscript.js` `getDefaultKeystore` | AutoFirma's keystores per OS |
| CCADB reports (`IncludedCACertificateReportForMSFTCSV`, `IncludedCACertificateReportCSVFormat`), Chrome `net/data/ssl/chrome_root_store/root_store.textproto` | FNMT roots in Microsoft's, Mozilla's and Chrome's programs |
| npm registry, `koffi` 3.3.6 (2026-10-31) <https://www.npmjs.com/package/koffi> | How the app would call the native APIs |
| Repo: `apps/desktop/electron-builder.ts`, `apps/desktop/packaging/entitlements.mac*.plist`, app-builder-lib 26.18.0 `out/targets/AppxTarget.js`, `packages/sidecar/src/build.ts`, `packages/vault/src/pkcs12.ts`, [electron-packaging.md](electron-packaging.md) §6.6 and §6.11 | Our builds and what they already do |

---

## 1. What the app holds, and the baseline

- **The vault holds the key and the whole chain.** An imported or FNMT-issued certificate is
  stored as a normalized PKCS#12 with a random passphrase: PBES2, AES-256-CBC, PBKDF2-HMAC-SHA256,
  2048 iterations, SHA-256 MAC (`importCertificate`, `addCertificateFromKey`). For FNMT certificates
  the chain is rebuilt from the bundled CAs (`apps/desktop/src/main/fnmt/fnmt-ca/`).
- **`writePkcs12` already writes legacy encodings**: `keyEncryption`/`certEncryption:
  'pbe-sha1-3des'` and `mac: 'sha1'`. Those exist for test fixtures, but they are exactly what
  older OS importers need (§2.3, §3.1).
- **Baseline: the `.p12` export.** The user saves a file and picks a password, then imports it:
  - macOS: double-click opens Keychain Access;
  - Windows: double-click opens the Certificate Import Wizard;
  - Linux: each browser's settings.

  It works on every OS and build, and on other computers and phones. The cost is a file, a
  password and an OS dialog.
- **What FNMT's own Configurador does** ([fnmt.md](fnmt.md) §3.5 steps 5–6): it imports into the
  login keychain on macOS, `Windows-MY` on Windows (PowerShell/`certutil` as fallbacks) and
  `~/.pki/nssdb` on Linux, plus Firefox's profile. So users of FNMT's normal flow end up with the
  certificate in their OS store. The vault-only stand-in doesn't do that today.

## 2. macOS

### 2.1 The APIs

- **`SecPKCS12Import(data, options, &items)`** [read, SDK header]:
  - On macOS it imports "into the default keychain" (the login keychain).
  - Options:
    - `kSecImportExportKeychain` picks a file-based keychain;
    - `kSecImportExportAccess` sets the key's initial ACL;
    - from macOS 14, `kSecUseDataProtectionKeychain` targets the data-protection keychain;
    - from macOS 15, `kSecImportToMemoryOnly` skips the keychain.
  - There is no option for key attributes, so the key can't be made non-extractable this way.
- **`SecItemImport(data, …, &format, &type, flags, &keyParams, keychain, &items)`** [read]:
  - Since macOS 10.7, and not deprecated. A NULL `keychain` means the default keychain.
  - `keyParams.keyAttributes` controls the key's attributes. Leaving out `kSecAttrIsExtractable`
    makes the key non-extractable [verified].
- **`security import <file> -k <keychain> -f pkcs12 -P <pw> [-x] [-T app]… [-A]`** [read, man]:
  - `-T` lists the apps that may use the key without a prompt, and `-A` means any app ("insecure,
    not recommended!").
  - `-x` is documented as "private keys are non-extractable", but it did nothing on 26.5.2
    [verified].
  - The password is on the command line.
- **`security set-key-partition-list -S … -k <pw>`** [read, man]: "You must present the keychain's
  password to change a partition list." For the login keychain, that is the user's login password.
- **Deleting**: `SecItemDelete` with the identity, or `security delete-identity -Z <sha1>`. Both
  remove the certificate and its key [verified for `security`].

### 2.2 What I verified on macOS 26.5.2

Setup:

- A throwaway PKI made with OpenSSL 4.1.0: a root, an "Usuarios" intermediate, and RSA 2048 and
  EC P-256 leaves with clientAuth.
- `.p12` files from `openssl pkcs12` and from the vault's own `writePkcs12`.
- Throwaway keychains made with `security create-keychain` in the scratch directory. Every
  command named that keychain explicitly.
- A small Swift probe (ad-hoc signed) for the API path. It refused any keychain outside the
  scratch directory.
- Before and after every run, I checked that the login keychain had no `SA-E-TEST` certificate,
  and that the user search list (`security list-keychains -d user`) was byte-for-byte unchanged.
  On 26.5.2, `create-keychain` didn't add the new keychain to the search list. The default
  keychain was never changed.
- I triggered no GUI prompt.

**Which encodings import:**

| `.p12` encoding | `security import` | `SecPKCS12Import` | `SecItemImport` |
| --- | --- | --- | --- |
| Vault `writePkcs12` default: PBES2 AES-256-CBC, SHA-256 MAC (RSA, EC) | ✅ | ✅ (RSA) | ❌ −25264 "MAC verification failed during PKCS12 import (wrong password?)" |
| `openssl pkcs12 -export` default (same algorithms) | ✅ | not run | not run |
| 3DES key and certs, SHA-1 MAC (vault writer and openssl) | ✅ | not run | ✅ (RSA, EC) |
| `openssl -legacy` (3DES key, RC2-40 certs, SHA-1 MAC) | ✅ | not run | not run |
| PBMAC1 integrity (`-pbmac1_pbkdf2`) | ❌ "passphrase not correct" | ❌ −25293 | ❌ −25264 |

**Other results:**

- **The chain comes along.** All three paths put the identity and every CA certificate in the
  file into the keychain: 3 certificates.
  - Importing the root this way doesn't trust it: `find-identity` reports
    `CSSMERR_TP_NOT_TRUSTED` for the throwaway root.
  - No prompt appears.
- **Re-importing is a no-op.** The same identity imported twice with `security import`, twice
  with `SecItemImport`, then again from a different encoding with `SecPKCS12Import`, gave 1
  identity, 1 key and 3 certificates. Every call reported success.
- **The key's ACL trusts only the importer** (from `security dump-keychain -a`):
  - Without `-T`, `security import` puts `/usr/bin/security` on the decrypt/sign/export entry,
    with "don't-require-password". The probe got its own cdhash.
  - `-T /Applications/Safari.app` replaced the importer with Safari's designated requirement
    (`identifier "com.apple.Safari" and anchor apple`).
  - `-A` put "any application" there.
  - The importing program could sign and export the identity again without any prompt.
  - A Developer ID app would be recorded by its designated requirement (identifier plus team), so
    the entry survives updates [inferred].
- **Non-extractable works only through `SecItemImport`.**
  - `keyAttributes = [permanent, sensitive]` gave Extractable 0 and NeverExtractable 1.
  - Signing still worked.
  - `SecItemExport` of the identity failed with −25316 "The contents of this item cannot be
    retrieved".
  - `security import -x` left Extractable at 1.
- **`delete-identity`** removed the certificate and its key, and left the CA certificates.
- **No partition list showed up.** No `partition_id` ACL entry appeared in any dump: not after
  `security import`, not after the probe's imports, and not after `set-key-partition-list` (which
  also returned 0 with a wrong password). So I couldn't see partitioning in action here.
  Everything in §2.4 about partitions is from Apple, not observed.
- **Data-protection keychain.** A read-only query from the unentitled probe returned
  `errSecItemNotFound`. I wrote nothing there, because it is the user's real keychain.

### 2.3 Older macOS versions

- Apple DTS (Quinn, thread 810723, January 2026) [read]: "In macOS 15 we updated the system to
  work with modern PKCS#12 crypto algorithms. macOS 14 doesn't have that fix, so it can only import
  PKCS#12 items with legacy crypto."
- Electron 44 supports macOS 13+ ([electron-packaging.md](electron-packaging.md) §6.6), so two of
  our supported versions can't read the vault's AES-256 format.
- **For a direct install**, always hand the OS a 3DES/SHA-1 blob, built in memory with
  `writePkcs12` under a one-time random passphrase. It never touches disk, so the weak PBE
  protects nothing at rest. Unlike AES-256, `SecItemImport` accepts it, even on 26.5.2
  [verified], and it can be made non-extractable. So one code path covers 13 to 26 [inferred for
  13–14].
- **For the export**, the same fact is why "Descargar copia (.p12)" in Mis datos
  (`Vault.exportCertificate`) writes 3DES with a SHA-1 MAC rather than AES-256.

### 2.4 Prompts: what the user sees

- **The import itself:** no prompt when the login keychain is unlocked, which it normally is
  after login [verified only for unlocked throwaway keychains; inferred for login]. If it is
  locked, macOS asks to unlock it [inferred].
- **Other apps' first use** [read, user reports on macOS 15.7]: Safari, Chrome, Edge and AutoFirma
  are each asked, the first time they sign with the key, for the login keychain password.
  - The dialog reads roughly "Safari quiere firmar mediante la llave «…» de tu llavero", with
    *Permitir siempre / Denegar / Permitir*.
  - "Permitir" asks again next time.
  - Users of FNMT's own flow get the same prompts, and so do users who double-click a `.p12`:
    there, Keychain Access is the importer instead of our app [inferred].
- **Why it can't be avoided** [read]:
  - Quinn: "there's no supported way for you to create keychain items which will be silently used
    by other apps (or the system). User consent must be acquired."
  - Partitioning (macOS 10.12+) "prevents code from team A from accessing items created by code
    from team B".
  - Pre-authorizing apps doesn't help either. `-T`, or `kSecImportExportAccess` built with the
    deprecated `SecTrustedApplication`, only fills the ACL, and changing the partition list needs
    the login password.
  - Don't try to get around it.
- **Where it ends up:** file-based keychain items don't sync to iCloud (TN3137: iCloud Keychain
  needs the data-protection keychain). The certificate stays on this Mac [read].

### 2.5 Hardened runtime, notarization, entitlements

- **Nothing to add.** Our app is non-sandboxed, Developer-ID-signed with the hardened runtime, and
  notarized. Its entitlements (`apps/desktop/packaging/`) are JIT, unsigned executable memory,
  camera and microphone.
  - It already writes the login keychain: Electron's `safeStorage` key lives there, and the switch
    to signing showed that keychain item's ACL following the app's identity
    ([electron-packaging.md](electron-packaging.md) §6.11).
  - Importing an identity into the same keychain uses the same subsystem and needs no entitlement
    [inferred; not run in the signed app].
- **Not the data-protection keychain** [read, TN3137]:
  - Its access groups come from entitlements that "must be authorized by a provisioning profile",
    which our Developer ID build doesn't carry.
  - Its items are visible only to apps in those groups.
  - Chrome's and Firefox's macOS code query without `kSecUseDataProtectionKeychain`, and
    AutoFirma's Java `KeychainStore` uses `SecIdentitySearchCreate`, so none of them would see such
    an identity [read]. Safari isn't documented either way.
  - Leave `kSecUseDataProtectionKeychain` off.

### 2.6 How the app would call it

| Option | Cost | Notes |
| --- | --- | --- |
| **koffi** (FFI, MIT, 3.3.6 of 2026-10-31) from the main process: `SecItemImport`, `SecItemCopyMatching`, `SecItemDelete` | One dependency. Node-API prebuilds per platform (`@koromix/koffi-darwin-arm64` ≈ 1.2 MB), no rebuild [read] | In-process, so the ACL trusts the app itself. No temp file, no password on a command line, exact OSStatus codes, non-extractable possible. `koffi.node` would be unpacked by smartUnpack and signed with our team, so library validation should pass, and JIT is already entitled [inferred; check once in a notarized build]. No public example of koffi with Security.framework found [read]. |
| `child_process` → `/usr/bin/security import` | None | Password in argv (use a one-time passphrase and a 0600 temp file, deleted right after). Without `-T "<app bundle>"`, `/usr/bin/security` stays trusted, so any process of the user could later run `security export` on the key without a prompt [inferred from the verified ACL]. `-x` doesn't work. |
| A Swift helper in `extraResources` | Xcode in the macOS CI jobs, another signed binary | The ACL would trust the helper, not the app. |
| `sa-sidecar` (Go) | — | Built with `CGO_ENABLED=0` (`packages/sidecar/src/build.ts`), so it can't call Security.framework without cgo or a new dependency like purego. No. |
| An existing npm module | — | None writes identities into either store. The ones found only read roots: `mac-ca`, `win-ca`, `system-ca`, mongodb-js's `*-export-certificate-and-key` [read, npm 2026-11-02]. |

## 3. Windows

### 3.1 The APIs [read]

- **`PFXImportCertStore(blob, password, flags)`** returns a temporary in-memory store. You then
  copy the certificates into the real store yourself.
  - Flags to use: `CRYPT_USER_KEYSET` (the user's key set) and `PKCS12_PREFER_CNG_KSP`.
  - Without a CNG flag, an RSA key goes to the legacy CAPI `MS_ENHANCED_PROV`. ECDSA can't live in
    CAPI, so it lands in CNG's Microsoft Software KSP anyway [inferred]. Preferring CNG keeps both
    key types on one path.
  - Without `PKCS12_NO_PERSIST_KEY`, "keys are persisted on disk". With it, the key isn't
    marshalled to other processes, so Chrome couldn't use it.
  - Key files: CNG in `%APPDATA%\Microsoft\Crypto\Keys`, CAPI in `…\Crypto\RSA\<SID>`. CNG keys are
    written by the key isolation service in LSASS.
- **`CertOpenStore(CERT_STORE_PROV_SYSTEM, …, CERT_SYSTEM_STORE_CURRENT_USER, "MY")`**, then
  **`CertAddCertificateContextToStore`** for the leaf. The intermediate goes into the same
  location's `"CA"` store.
  - `CurrentUser` stores live under `HKCU\Software\Microsoft\SystemCertificates` ("System Store
    Locations").
  - Dispositions: `ADD_NEW` fails with `CRYPT_E_EXISTS`, `USE_EXISTING` keeps the old copy,
    `REPLACE_EXISTING` replaces it, and `ADD_ALWAYS` "can lead to duplicates".
  - Look the leaf up by thumbprint first. A re-import probably makes a new key container each
    time [inferred].
- **Formats:** Windows reads only "TripleDES-SHA1" and "AES256-SHA256" PFX files.
  - "Windows 11, Windows 2019, and later versions of Windows support AES256-SHA256". Older systems
    say the password is wrong.
  - Windows 10 1809 is build 17763, the same as Server 2019, which is our MSIX `minVersion`
    [inferred].
  - PBMAC1 isn't listed. As on macOS, hand Windows a 3DES/SHA-1 blob made in memory: it works on
    every version.
- **Removal:** `CertDeleteCertificateFromStore` removes only the certificate. Microsoft's guidance
  is to delete the key first: read `CERT_KEY_PROV_INFO_PROP_ID`, then call `NCryptDeleteKey` (CNG)
  or `CryptAcquireContext(…, CRYPT_DELETEKEYSET)` (CAPI). Otherwise the key file is orphaned
  [read + inferred].

### 3.2 Non-exportable and strong protection [read]

- **Non-exportable** is the default: leave out `CRYPT_EXPORTABLE`, or `-Exportable` for
  `Import-PfxCertificate`.
  - `Export-PfxCertificate` then fails, and certmgr's export wizard greys out the key: "The
    associated private key is marked as not exportable. Only the certificate can be exported."
  - It is a soft barrier. mimikatz's `crypto::capi` patches CAPI inside its own process with no
    admin rights, while `crypto::cng` must patch KeyIso in LSASS, which needs admin or debug
    rights. Another reason to prefer CNG.
  - The Windows import wizard also leaves "Mark this key as exportable" unchecked by default
    [inferred; not checked].
- **Strong protection** (`CRYPT_USER_PROTECTED`, CNG `NCRYPT_UI_POLICY`): a system dialog "when
  the key is completed and when the key is used", so at import and at every use. It fails in a
  silent context.
  - This is the only way on Windows to keep per-use consent, roughly like our vault's. It is
    optional, and noisy in the browser.

### 3.3 Command-line tools [read]

- **`certutil -user -p <pw> -importPFX [My] <file> [NoExport] [NoRoot]`**:
  - The password goes on the command line, and process auditing (event 4688) can log command
    lines.
  - Without `NoRoot` it imports the root too, which brings up the Root-store dialog (§6) [inferred].
- **`Import-PfxCertificate -FilePath … -CertStoreLocation Cert:\CurrentUser\My -Password
  <SecureString>`**:
  - It puts every certificate in the file, CA certificates included, into the target store. So
    give it the leaf alone, and add the intermediate to `CurrentUser\CA` separately.
  - To keep the password off the command line, run `powershell -NoProfile -NonInteractive -Command
    -` and write the script to stdin.
  - Even the `Restricted` execution policy allows commands this way. Whether loading the PKI
    module counts as a script is unconfirmed.

### 3.4 How the app would call it

- **koffi** again (`@koromix/koffi-win32-x64`), calling crypt32 and ncrypt in-process. It is the
  same dependency as on macOS.
- **`sa-sidecar`** is a zero-dependency alternative on Windows only. Go reaches crypt32 through
  `syscall.NewLazyDLL` without cgo, and the binary already ships and is signed. It would need a
  new command in its protocol [inferred].
- **PowerShell via stdin** costs nothing to package, but is slower, and in the MSIX it runs
  inside the package context like any other child (§3.5).

### 3.5 The Store MSIX build

This is the main Windows uncertainty. The Store MSIX is the build we advertise, and the NSIS build
is kept but unadvertised.

- **What our MSIX is.** electron-builder always adds `runFullTrust` (`AppxTarget.js`
  `getCapabilities`: "Ensure runFullTrust is always included"). Its manifest template declares
  `EntryPoint="Windows.FullTrustApplication"`, with no `uap10:RuntimeBehavior` (app-builder-lib
  26.18.0) [read]. That makes it a Desktop Bridge app, which Windows virtualizes [inferred from the
  doc's app types].
- **What Windows virtualizes** for such apps [read, "How packaged desktop apps run", updated
  2026-10-12]:
  - "All writes under *HKCU* are copied on write to a private per-user, per-app location."
  - On 1903+, new files under `AppData\Roaming` and `Roaming\Microsoft` "are redirected to a
    per-user, per-package private location"; existing files are modified in place.
  - Child processes stay in the same package context unless launched to break away
    (`PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY` exists to start them "outside of the desktop app
    runtime environment") [read + inferred].
  - No documented exception covers the certificate store or crypto.
- **So, most likely** [inferred, untested]:
  - The certificate written into `CurrentUser\My` lands in the app's private hive. The app sees
    it; Chrome, Edge, Firefox and AutoFirma don't.
  - A CNG key is written by LSASS, outside the package, so it probably lands in the real
    `%APPDATA%\Microsoft\Crypto\Keys`. The result would be a key nobody can use, and which
    uninstalling doesn't remove.
  - To check, look under `%LOCALAPPDATA%\Packages\<PFN>\` (`LocalCache\Roaming`,
    `SystemAppData\Helium`) after an import from a sideloaded build.
- **Ways out**, each needing a test:
  1. **`UserCertificateEnrollmentManager.ImportPfxDataAsync`** (WinRT), which "imports… into the
     user's 'My' store". It needs the `sharedUserCertificates` capability, which is on the
     *restricted* list, so the Store submission must justify it. Microsoft names smart-card
     banking as a valid case. Whether its writes escape virtualization is unverified, and calling
     WinRT from Electron needs a native module or a small helper [inferred]. Don't confuse it with
     `CertificateEnrollmentManager.ImportPfxDataAsync`, which writes "the app container MY store".
  2. **A helper launched outside the package**, with `PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY`
     (Windows 10 1703+). Node's `child_process` can't set that attribute, so this needs native
     code. Unverified.
  3. **`unvirtualizedResources`**, or Windows 11 flexible-virtualization exclusions for
     `SystemCertificates` and `Crypto`. Restricted, and "designed for certain types of desktop PC
     games… not intended to be used for other scenarios". Unlikely to be approved.
  4. **Fall back to the export.** Save the `.p12` and let the user open it with Windows' own
     import wizard. Whether a wizard started from a packaged app runs outside the package is
     unverified.
- **Store policy** has no rule about certificates. 10.2.8 asks for "supported methods" and "user
  consent" when changing Windows settings [read]. The user's own certificate store is arguably
  user data rather than a setting [inferred].
- **The NSIS build** is unpackaged and per-user, so nothing is virtualized, and `CurrentUser\My`
  needs no elevation [inferred, consistent with Microsoft's examples].

## 4. Linux (brief)

- **Chrome** reads `ClientCertStoreNSS` from one NSS database (`crypto/nss_util.cc`) [read; I
  checked the path rule in source]:
  - `~/.pki/nssdb` "if the directory already exists";
  - otherwise, since Chrome 146 (February 2026), `${XDG_DATA_HOME:-~/.local/share}/pki/nssdb`.

  Creating `~/.pki/nssdb` on a machine that doesn't have it would switch Chrome to a new, empty
  database. Write to whichever one exists.
- **Electron's `app.importCertificate({certificate, password})`** is Linux only. It imports a
  `.p12` file into NSS's private slot, which is the same database by the same rule, since Electron
  44 is Chromium 152 [read source; same DB inferred].
  - It imports the key as extractable.
  - **It marks every certificate after the first as `TRUSTED_SSL` CA**:
    `SetCertTrust(it->get(), net::CA_CERT, net::NSSCertDatabase::TRUSTED_SSL)` [read, v44.5.1
    source]. Giving it the chain would make *AC FNMT Usuarios* a local TLS anchor in Chrome on
    Linux.
  - Giving it the leaf alone leaves the intermediate missing, and Chrome on Linux matches issuers
    only against the local NSS database (`client_cert_matcher.cc`) [read].
  - So a clean Linux install needs NSS's own API (`libnss3` is on every desktop; koffi again), or
    `pk12util`. `libnss3-tools` isn't installed by default on Ubuntu 24.04 or 26.04 [read].
  - `pk12util -i <file> -d sql:<dir> -w <password file>` takes the password from a file.
    `certutil -N -d sql:<dir> --empty-password` creates a database.
- **Firefox** on Linux has no OS module. It uses only its profile's `cert9.db`/`key4.db`, found
  through `profiles.ini` [read]:
  - `~/.mozilla/firefox`;
  - from Firefox 147, `~/.config/mozilla/firefox` when `~/.mozilla` is absent;
  - snap: `~/snap/firefox/common/.mozilla/firefox`;
  - flatpak: `~/.var/app/org.mozilla.firefox/.mozilla/firefox`.

  A running Firefox holds its database open. Writing it from outside is what the Configurador
  does with a child JVM ([fnmt.md](fnmt.md) §3.5 step 6).
- **AutoFirma** on Linux reads `SHARED_NSS` [read]: `~/.pki/nssdb`, then
  `~/snap/chromium/current/.pki/nssdb`, then `/etc/pki/nssdb`. That is **not** Chrome 146's XDG
  path. From Firefox pages it reads Firefox's profile (`MOZ_UNI`).

## 5. Which apps see a certificate in the OS store

| App | macOS (login keychain) | Windows (`CurrentUser\My`) | Linux |
| --- | --- | --- | --- |
| Chrome | ✅ `ClientCertStoreMac`: `SecItemCopyMatching` for identities, file-based keychains only | ✅ `ClientCertStoreWin`: `CertOpenSystemStore(NULL, "MY")` | NSS DB (§4) |
| Edge | ✅ same Chromium code | ✅ same | same as Chrome [inferred] |
| Safari | ✅ keychain identities; an identity preference only preselects one | — | — |
| Firefox | ✅ since Firefox 90 (`security.osclientcerts.autoload: true`, "Currently only available for Windows and macOS") | ✅ same (the osclientcerts module isn't built for Windows ARM64) | ❌ own profile DB only |
| AutoFirma | ✅ `APPLE` (`KeychainStore`) by default | ✅ `WINDOWS` (`Windows-MY`) by default | `SHARED_NSS` (§4) |

[read: Chromium, Firefox and AutoFirma sources and docs listed above; "default" means AutoFirma's
`getDefaultKeyStoreTypeByOs`. In Firefox pages, `autoscript.js` asks for `MOZ_UNI` unless the user
set `useDefaultStoreInBrowserCalls`.]

- **Matching against the server's CA list:** for a certificate to be offered, the browser needs
  the private key, a valid date, clientAuth and digitalSignature usage, and a way to link the leaf
  to one of the CA names in the server's `CertificateRequest`, using certificates already on the
  machine.
  - **Windows Chrome** uses `CERT_CHAIN_FIND_BY_ISSUER_CACHE_ONLY_FLAG |
    CERT_CHAIN_FIND_BY_ISSUER_CACHE_ONLY_URL_FLAG` ("The Internet is not searched"). Windows does
    fetch missing intermediates over AIA in general, but not on this path.
  - **Linux Chrome** walks issuers only in the NSS database.
  - **macOS Chrome** builds the chain with `SecTrust`, which may fetch over AIA, and ignores the
    trust result: "the server is the only one that can decide that" [read].

  Which names Spanish sedes actually send wasn't checked. If they list the intermediate, the leaf
  matches directly; if they list only the root, the intermediate must be local.

## 6. Chain and trust

- **Install the intermediate** that the vault credential's chain holds (*AC FNMT Usuarios* for
  G1, *AC USUARIOS G2* for G2):
  - macOS: it comes along in the import [verified];
  - Windows: add it to `CurrentUser\CA`;
  - Linux: add it to the NSS DB without trust flags.

  This is what the Configurador does too ([fnmt.md](fnmt.md) §3.5 step 3).
- **Don't install the root.** Root-program membership on 2026-11-02 [read]:

  | Root | Apple (macOS 26, store 2025082000) | Microsoft | Mozilla | Chrome Root Store |
  | --- | --- | --- | --- | --- |
  | AC RAIZ FNMT-RCM (SHA-256 `EBC5570C…179B93FA`, expires 2030-01-01) | ✅ | ✅ Server Auth, Client Auth, Document Signing, Secure Email, Time Stamping | ✅ Websites | ✅ |
  | AC RAIZ FNMT-RCM SERVIDORES SEGUROS | ❌ | ✅ Server Auth | ✅ Websites | ✅ |
  | AC RAIZ FNMT-RCM G2 (2024–2049) | ❌ | ✅ Client Auth, Document Signing | ❌ | ❌ |

  - The fingerprint matches our bundled copy (`fnmt-ca/README.md`).
  - Client-side identity selection doesn't depend on root trust: the server validates. A
    G2-issued certificate still works on macOS without the G2 root being trusted [inferred from
    Chrome's comment].
  - Adding a root to the macOS keychain doesn't trust it [verified]. Trusting it would need trust
    settings and their own user-authentication dialog [inferred].
  - Adding a root to `CurrentUser\Root` on Windows brings up a confirmation dialog. Electron's
    `certificate_trust_win.cc` says it "requires prompting the user" [read].

## 7. UX and risks

- **One click, opt-in, per certificate.** "Añadir a este Mac" / "Añadir a Windows" on a
  certificate in Mis datos → Credenciales. It needs a consent card that says, in plain words:
  - other programs on this computer, such as your browser and AutoFirma, will be able to use the
    certificate;
  - on macOS, each one asks for your password the first time;
  - removing it here doesn't remove it there (unless the app offers to, below).

  It shouldn't run automatically after an FNMT download (the automatic step there saves to the
  vault, which is different).
- **Duplicates.** macOS re-imports are idempotent [verified]. On Windows, look up the thumbprint
  first and use `CERT_STORE_ADD_USE_EXISTING` [read]. Show "ya está en este Mac" when the
  thumbprint is already in the store (`SecItemCopyMatching` / `CertFindCertificateInStore`).
- **Deleting in Mis datos doesn't delete the OS copy.** Record on the credential that the app
  installed it, with the thumbprint and the OS store. When the user deletes the credential or uses
  "Borrar todo", ask "¿Quitarlo también de este Mac?":
  - macOS: `SecItemDelete` of the identity [verified for `security delete-identity`];
  - Windows: delete the key, then the certificate (§3.1).

  The user can still remove it themselves in Acceso a Llaveros or certmgr.
- **The key becomes usable by every app of the user.**
  - On Windows that is silent, and malware running as the user can sign with it (strong
    protection, §3.2, is the only per-use gate).
  - On macOS each app needs the user's consent once.
  - Today the vault asks before every certificate use (ARCHITECTURE §7), and the OS copy doesn't.
    The consent card must say so.
- **Exportability.** Recommended: **non-exportable** on both OSes. Backups come from Mis datos
  (the `.p12` export).
  - Windows: omit `CRYPT_EXPORTABLE`. This is also the import wizard's default [inferred].
  - macOS: `SecItemImport` without `kSecAttrIsExtractable`. Keychain Access's export then fails,
    as `SecItemExport` did [verified].
  - The catch: once the vault copy is deleted, nobody can make a backup from the OS copy, not even
    the user. So deleting a credential that has an OS copy and was never exported must say so.
- **Expiry and renewal.** When the user renews an FNMT certificate, the old OS copy stays until
  removed. Offer to replace it on the next "Añadir" [inferred].
- **No password, nothing on disk.** The OS import uses an in-memory 3DES blob with a one-time
  passphrase. No `.p12` file is written and no password reaches a command line (koffi path).
  Unlike the TEMPORARY FNMT debug log, nothing of this needs logging.

## 8. Recommendation

1. **Ship the `.p12` export first** (*done*: "Descargar copia (.p12)" in Mis datos, 3DES with a SHA-1
   MAC so it imports on macOS 13–14, §2.3). It works on every OS, every build (the MSIX included),
   other computers and FNMT's mobile app.
2. **Then, if users ask for it, add "Añadir a este ordenador"** as in §7. Order and rough effort:
   - **Shared parts** (consent card, Mis datos action, install record on the credential, removal
     offer, copy): about 1–2 days.
   - **macOS** (about 2 days): koffi → `SecItemImport` (3DES blob, non-extractable, default
     keychain) plus `SecItemCopyMatching` and `SecItemDelete`. Unit tests import into a throwaway
     keychain, as in §2.2; CI's macOS runners can create one. Check once in a notarized build
     that koffi loads under the hardened runtime and that Safari and Chrome then see the identity.
   - **Windows NSIS** (about 2–3 days): koffi → `PFXImportCertStore(CRYPT_USER_KEYSET |
     PKCS12_PREFER_CNG_KSP)`, the leaf into `My`, the intermediate into `CA`, deletion with the
     key. Test on CI's Windows runner, which is ephemeral.
   - **Windows MSIX** (a 1–2 day spike first): sideload a test MSIX and see where an import lands
     (§3.5). Then try `UserCertificateEnrollmentManager` with `sharedUserCertificates`. Until it is
     proven, hide the action in the Store build and point to the export.
   - **Linux** (about 2 days, lowest priority): NSS through koffi into whichever DB Chrome uses,
     leaf and intermediate with no trust. Not `app.importCertificate`, because of its trust
     marking. Firefox profiles and AutoFirma's XDG blind spot make it partial anyway.
3. **Don't** use the data-protection keychain, add roots, set Windows strong protection by
   default, or try to pre-authorize other macOS apps.

## Appendix A — Quick reference

```
macOS   SecItemImport(blob3des, NULL, &pkcs12, &aggregate, 0, {passphrase, keyAttributes=[permanent,sensitive]},
                      NULL /* default = login keychain */, &items)
        → identity + chain in login.keychain-db; other apps prompt once for the login password
        SecPKCS12Import(blob, {passphrase}) also works for AES-256 on macOS 15+ (no key attributes)
        Remove: SecItemDelete({class: identity, valueRef: identity})
Windows PFXImportCertStore(blob3des, pw, CRYPT_USER_KEYSET | PKCS12_PREFER_CNG_KSP)   // no CRYPT_EXPORTABLE
        CertOpenStore(SYSTEM, 0, 0, CERT_SYSTEM_STORE_CURRENT_USER, "MY") ← leaf (CERT_STORE_ADD_USE_EXISTING)
        CertOpenStore(…, "CA")                                           ← intermediate; never "Root"
        Remove: NCryptDeleteKey(from CERT_KEY_PROV_INFO_PROP_ID), then CertDeleteCertificateFromStore
        MSIX: HKCU is virtualized → likely invisible to other apps (untested)
Linux   NSS DB: ~/.pki/nssdb if it exists, else ${XDG_DATA_HOME:-~/.local/share}/pki/nssdb (Chrome 146+)
        pk12util -i f.p12 -d sql:<dir> -w <pwfile>   (libnss3-tools, not installed by default)
        app.importCertificate: marks every cert after the first as TRUSTED_SSL — leaf only, or don't use
Firefox macOS/Windows: OS store via osclientcerts (default on since Fx90); Linux: profile cert9.db/key4.db
```

## Appendix B — Unverified

| Item | How to settle it |
| --- | --- |
| Where a certificate and CNG key imported by the Store MSIX actually land, and whether Chrome/Edge see them | Sideloaded MSIX on a Windows VM (§3.5) |
| Whether `UserCertificateEnrollmentManager.ImportPfxDataAsync` with `sharedUserCertificates` escapes virtualization, and whether the Store approves it | Same VM, then a Store submission note |
| koffi under the hardened runtime and notarization | One signed build |
| The exact macOS prompt text and its partition behaviour for an identity our signed app imported | One manual run with Safari and Chrome on a test account |
| `SecItemImport` of a 3DES blob on macOS 13–14 | A macOS 13 or 14 VM |
| Which `certificate_authorities` names Spanish sedes send (root only, or intermediates too) | Read the CertificateRequest with the sidecar's capture, or `openssl s_client` against a sede |
| Whether Safari reads the data-protection keychain | Not needed if we use the login keychain |
| A re-import on Windows making a new key container each time | Windows VM |
