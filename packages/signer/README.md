# @sa/signer

AutoFirma replacement for a Playwright browser and a Node signing broker. No Electron imports.
RSA and ECDSA certificates work throughout PKCS#12 import and all local signing formats.

## Formats

| Format/method | Support |
| --- | --- |
| CAdEStri/XAdEStri/PAdEStri; formats with serverUrl | Pre/post triphase, server assembly, local PRE signing |
| CAdES BES/EPES | Attached/detached, signing-certificate-v2, FirmaAGE policy |
| CAdES coSign/counterSign | Multiple signers; leaf/tree countersignatures |
| NONE/PKCS#1 | Raw RSA PKCS#1 or DER ECDSA signature |
| XAdES | Enveloping, Enveloped, internally Detached; BES/EPES, FirmaAGE |
| PAdES | Invisible incremental signature; classic or stream xref, co-sign by appending |
| selectCertificate | Explicit approval then DER certificate in Base64, chosen by the certificate filters |
| signBatchProcess | JSON local batches and remote JSON pre/post batches |
| signBatch | Legacy XML `<signbatch>` against the site's BatchPresigner/BatchPostsigner; the page gets the Base64 result log |
| signAndSaveToFile, file helpers | Inject native pickFiles/saveFile in createAfirmaHandler |
| AutoScript/MiniApplet utilities | Full 1.10.1 surface plus 1.8.x copies' setters, configuration no-ops, Base64 utilities; unknown methods of the page's own copy become no-ops reported as `AFIRMA_NOTICE` |

Known gaps: no local smart-card readers (the DNIe signs on the phone through an
`ExternalSigningKey`), no revocation checking, timestamp/LTV, local XML batch, FacturaE/ASiC local
assembly, visible PDF signing, encrypted PDFs or PDF certification. XAdES Detached without an
explicit `format` parameter deliberately maps to Enveloping, matching AutoFirma's REG quirk.
External detached XML reference resolution and local XAdES co/countersigning are unsupported.
Use the site's triphase service for these formats where available. Implementations are verified
cryptographically offline; acceptance by particular production sedes remains unverified.

## Installing the shim

- Install `AUTOSCRIPT_SHIM_SOURCE` with `context.addInitScript({content})` before navigating, in
  every frame.
- Expose `AFIRMA_BINDING` (`__saAfirma`, from `@sa/shared`) and pass calls to
  `afirmaHandler(call, ctx)`. Set origin and URL from Playwright's binding source frame;
  page-provided values are untrusted.
- The site's actual AutoScript can load repeatedly, so its Base64, Cipher and SupportDialog
  globals remain available. A strict page CSP does not prevent init scripts.
- For pages with no AutoScript, assign `window.AutoScript = {}` after injection to expose the
  shim.

`@sa/browser` does all of this when its `afirma` option is set.

## The handler

- `ctx.approveSignature(summary)` must show a native approval and choose the certificate.
  Returning null produces AutoFirma's cancellation error; the handler reports
  signed/rejected/failed.
- The summary contains origin, method, format, size and SHA-256; the approval UI uses its own
  credential metadata to display the signer. Triphase summaries warn that the server prepares
  the signed bytes.
- Inject `ctx.fetch` to enforce the application's remote URL policy.
- File callbacks must show native dialogs; site-proposed paths are suggestions, never trusted
  paths.

## Certificate filters

AutoFirma's `filters=` (`;` = AND), `filters.1=`, `filters.2=`… (OR between groups) and
`filter=` in the params of `selectCertificate`, the signatures, `signBatchProcess`'s
`certFilters` and `signBatch` (`filters.ts`). They narrow the approved credential's certificates:
its signing certificate, then the others it brings (`ExternalSigningKey.otherCertificates`: the
DNIe's AUTENTICACIÓN, from phones that send it), when still valid. The user is never asked to
choose:

- `selectCertificate` returns the first that passes: FIRMA whenever it passes (as without
  filters), AUTENTICACIÓN for `authcert:` or a key usage of digitalSignature without
  nonRepudiation.
- Signatures use only the signing certificate. When only another certificate passes, the
  call fails with a "no certificate" error that names the authentication certificate, and the
  key is released with `authentication_only` (the app tells the user). Signing with the DNIe's
  authentication key is not supported.
- Nothing passes (a `.p12` included): AutoFirma's "No se encontraron certificados con los que
  firmar" (`AF501001`), released with `no_match`.

Supported: `nonexpired:`, `authcert:`, `signingcert:`, `dnie:`, `sscd:`, `ssl:<serial>` and
`qualified:<serial>` (the signing certificate with that hexadecimal serial, or the one paired
with the certificate that has it), `thumbprint:<alg>:<hex>`, `encodedcert:<b64>`,
`subject.contains:`, `issuer.contains:`, `subject.rfc2254:`, `issuer.rfc2254:` (and
`.recurse`, on the leaf's issuer only), `keyusage.<usage>:true|false`, `policyid:<oids>` and
`pseudonym:only|andothers`. Unknown filters (and `disableopeningexternalstores:`) are ignored,
unknown ones with a warning in the log; a group made only of unknown filters lets everything
through.

Low-level builders, `readP12`/`openP12`, `buildAutoscriptShimSource` and `createAfirmaHandler`
are the typed integration points. `readP12` returns PEM material and metadata; `openP12` also
gives Node KeyObjects and the DER chain. Modern AES and legacy RC2/3DES containers are read;
normalization emits AES-256 PBES2 usable by Node TLS and Playwright. node-forge handles legacy
primitives while Node crypto handles EC keys. `parseExtraParams` follows Java Properties
comments, continuation lines and character escapes.

## Consent and secrets

Each signature requires explicit human consent, including clear consent to all documents in a
batch. Legal acceptance depends on the certificate, signature format/policy and applicable
requirements; cryptographic verification alone does not establish acceptance or qualification.
Never expose private keys or passphrases to pages, the model, logs or remote triphase servers.

## Tests

`corepack pnpm --filter @sa/signer test`. Tests generate disposable RSA/EC PKI, verify CMS with
pkijs/OpenSSL and XML with independent XMLDSig verifiers, verify PDF ByteRanges, run local HTTP
triphase pre/post, and load real-shaped AutoScript in cached Chromium with CSP, double loads,
iframes and cancellation. No government sites or paid APIs are contacted; the Chromium test
skips when the cached browser is missing.
