# @sa/vault

Encrypted local store for the user's personal data, documents, credentials (Cl@ve, digital
certificates) and app secrets (AI provider keys, OAuth tokens, browser session state).
Plain Node library: no Electron imports. OS-backed key protection is injected via `KeyProvider`.

## Usage (desktop main process)

```ts
import { app, safeStorage } from 'electron';
import { createSafeStorageKeyProvider, Vault, VaultError } from '@sa/vault';

await app.whenReady(); // safeStorage needs the app to be ready (Linux keyring selection)
const keys = createSafeStorageKeyProvider(safeStorage); // Keychain / DPAPI / libsecret / KWallet
let vault: Vault;
try {
  vault = await Vault.open(path.join(app.getPath('userData'), 'vault'), keys);
} catch (e) {
  if (e instanceof VaultError && e.code === 'corrupted') {
    // Wrong key (keychain entry reset) or damaged files: tell the user, offer to start over
    // with Vault.destroy(dir). Never delete automatically.
  }
  throw e;
}
vault.overview({ biometricAvailable: systemPreferences.canPromptTouchID() }); // → renderer
```

- `keys.secure === false` on Linux without a keyring (`basic_text`): show a warning.
- Touch ID / "ask before use" are enforced by the caller before `getCredentialSecret()`.
- Use one `Vault` instance per directory per process (the app should hold
  `app.requestSingleInstanceLock()`); concurrent calls on one instance are serialized.
- Tests and e2e: `createTestKeyProvider(seed)` (insecure; stable for a given seed).

## API

| Area | Methods |
| --- | --- |
| Open/inspect | `Vault.open(dir, keys, { now? })`, `Vault.destroy(dir)`, `overview({ biometricAvailable })`, `storageInfo()` |
| Personal data | `listPersonal()`, `getPersonal(key)`, `setPersonal(items, source)`, `deletePersonal(keys)` |
| Documents | `listDocuments({ procedureId? })`, `getDocument(id)`, `addDocument(opts)`, `readDocument(id)`, `deleteDocument(id)` |
| Credentials | `listCredentials()`, `getCredential(id)`, `addClave()`, `addClaveMovil()`, `addCertificate()`, `setCredentialPolicy()`, `getCredentialSecret()`, `markCredentialUsed()`, `deleteCredential()` |
| App secrets | `listSecrets()` (labels only), `setSecret(id, label, value)`, `getSecret(id)`, `deleteSecret(id)` |
| PII | `knownSensitiveValues()` (for `@sa/pii` `knownValues`) |
| Reset | `wipe()` |
| Helpers | `readPkcs12()`, `pkcs12ToPem()`, `certificateInfo()`, `parseHolder()`, `isDni()`, `isNie()` |

Behaviour worth knowing:

- **Personal data**: keys are the well-known `PERSONAL_FIELDS` or `custom.<slug>` (a label is
  required the first time). Values are trimmed and validated by field type (dates
  `YYYY-MM-DD`, select options, email, phone, IBAN mod-97); an empty value deletes the field.
  document-specific number keys (`dniNumber`, `dniSupportNumber`, `tieNumber`, `tieSupportNumber`, `passportNumber`) are stored compact and uppercase, IBAN without
  spaces. A batch is all-or-nothing. Error messages never echo values.
- **Documents**: each file is encrypted separately in `documents/<id>.bin`; max 50 MB;
  newest first.
- **Cl@ve Permanente**: the username must be a valid DNI/NIE (normalized); the summary only
  has `usernameHint` (`maskValue`). **Cl@ve Móvil** stores no secret.
- **Certificates** (`addCertificate`): the passphrase is checked (PKCS#12 MAC or decryption),
  the file is parsed with Node crypto, so **RSA and ECDSA keys** (FNMT's new P-256/P-384
  hierarchy) both work, with modern (PBES2/AES), 3DES and RC2-40 files (`node-forge` is only
  used for RC2), PBMAC1, BER and non-ASCII passphrases. Expired or not-yet-valid certificates
  are rejected. The vault stores a **normalized copy** (PBES2/AES-256-CBC + SHA-256 MAC,
  key + chain) protected by a **random passphrase**; the user's passphrase is not kept.
  `getCredentialSecret()` returns `{ p12, passphrase }` for that copy, which loads in
  `tls.createSecureContext({ pfx, passphrase })`, Playwright `clientCertificates` and
  Electron. `pkcs12ToPem()` gives `{ key, cert, ca }` PEM if a consumer prefers that.
  Importing the same certificate again returns the existing credential.
- **Policies** default to `DEFAULT_CREDENTIAL_POLICY` (Cl@ve `auto`, certificate `ask`).
- **Secrets**: ids like `provider.openrouter`, `oauth.chatgpt`, `browser.state:<procedureId>`;
  values up to 8 MB (kept in `vault.bin`, rewritten on every change: keep them small).
- **`knownSensitiveValues()`**: every personal value except low-identifying categories
  (document type, sex, nationality, marital status, province, country), plus variants: name
  combinations and each surname, DNI/NIE with/without letter and separators, dates as
  `dd/mm/yyyy`, phone with/without `+34`, IBAN with/without spaces and the 20-digit account,
  NUSS with separators, address parts; Cl@ve usernames; certificate holder names/IDs. Values
  under 3 characters are skipped. Sorted longest first. Passwords and API keys are not included.

## Errors

`VaultError.code`: `invalid_input`, `not_found`, `invalid_passphrase`, `invalid_certificate`,
`expired_certificate`, `corrupted` (wrong key, tampering, truncation), `key_unavailable` (the
OS cannot protect keys, e.g. `safeStorage` unavailable) and `io` (file system; `cause` holds the
original error). `key_unavailable` and `io` are additions to the original stub.

## Storage format and security

```
<dir>/                    0700
  key.bin                 0600  "SAVK" | v1 | KeyProvider.encrypt(random 256-bit data key)
  vault.bin               0600  AES-256-GCM(JSON state)
  documents/<uuid>.bin    0600  AES-256-GCM(file bytes)
```

- Encrypted files: `"SAVF" | version | purpose | 8-byte key check | 96-bit random IV |
  ciphertext | 128-bit tag`. The AAD binds the header and the file identity (`vault.bin` or
  `document:<id>`), so files cannot be swapped or relabelled. Separate subkeys (HKDF-SHA256)
  for state and documents. The key check distinguishes "different key" from "modified file"
  in error messages; both are `corrupted`.
- Writes: temp file (`O_EXCL`, 0600) → fsync → rename → fsync directory. State changes are
  copy-on-write: memory only changes after the new file is on disk. A write mutex serializes
  all changes. On open, temp files from crashes and unreferenced document files are removed.
- `wipe()` destroys `key.bin` first (crypto-shredding), overwrites every file with random
  bytes before unlinking, then creates a new key and an empty state. On SSD/APFS overwriting
  cannot guarantee physical erasure; the guarantee comes from destroying the key.
- Known gaps: no rollback protection (an old `vault.bin` + `key.bin` pair can be restored);
  secrets live in process memory while the vault is open.

## Tests

`corepack pnpm --filter @sa/vault test` (~3 s). PKCS#12 fixtures in `test/fixtures/` were made
with OpenSSL 3.6 by `test/fixtures/generate.sh` (synthetic keys; passphrase `Fixture-1234`).
Other test certificates (RSA and EC) are generated at test time by `test/helpers/certs.ts`.
