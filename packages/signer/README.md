# @sa/signer

AutoFirma replacement for a Playwright browser and a Node signing broker. No Electron imports.
RSA and ECDSA certificates work throughout PKCS#12 import and all local signing formats.

| Format/method | Support |
| --- | --- |
| CAdEStri/XAdEStri/PAdEStri; formats with serverUrl | Pre/post triphase, server assembly, local PRE signing |
| CAdES BES/EPES | Attached/detached, signing-certificate-v2, FirmaAGE policy |
| CAdES coSign/counterSign | Multiple signers; leaf/tree countersignatures |
| NONE/PKCS#1 | Raw RSA PKCS#1 or DER ECDSA signature |
| XAdES | Enveloping, Enveloped, internally Detached; BES/EPES, FirmaAGE |
| PAdES | Invisible incremental signature; classic or stream xref, co-sign by appending |
| selectCertificate | Explicit approval then DER certificate in Base64 |
| signBatchProcess | JSON local batches and remote JSON pre/post batches |
| signBatch | Legacy XML `<signbatch>` against the site's BatchPresigner/BatchPostsigner; the page gets the Base64 result log |
| signAndSaveToFile, file helpers | Inject native pickFiles/saveFile in createAfirmaHandler |
| AutoScript/MiniApplet utilities | Full 1.10.1 surface plus 1.8.x copies' setters, configuration no-ops, Base64 utilities; unknown methods of the page's own copy become no-ops reported as `AFIRMA_NOTICE` |

Install `AUTOSCRIPT_SHIM_SOURCE` with `context.addInitScript({content})` before navigating.
Expose `AFIRMA_BINDING` (`__saAfirma`) and pass calls to `afirmaHandler(call, ctx)`.
Set origin/url from Playwright's binding source frame; page-provided values are untrusted.
Always install in every frame. The site's actual AutoScript can load repeatedly so its Base64,
Cipher and SupportDialog globals remain available. Strict page CSP does not prevent init scripts.
For pages with no AutoScript, assign `window.AutoScript = {}` after injection to expose the shim.

`ctx.approveSignature(summary)` must show a native approval and choose the certificate. Returning
null produces AutoFirma's cancellation error; the handler reports signed/rejected/failed.
The shared summary contains origin, method, format, size and SHA-256; the approval UI uses its
own credential metadata to display the signer. Inject `ctx.fetch` to enforce the application's
remote URL policy. Triphase summaries explicitly warn that the server prepares the signed bytes.
File callbacks must show native dialogs; site-proposed paths are suggestions, never trusted paths.

The original stub exports remain. Additional low-level builders, readP12/openP12,
buildAutoscriptShimSource and createAfirmaHandler expose typed integration points.
`readP12` returns PEM material and metadata; `openP12` also exposes Node KeyObjects and DER chain.
Modern AES and legacy RC2/3DES containers are read; normalization emits AES-256 PBES2 usable by
Node TLS and Playwright. node-forge handles legacy primitives while Node crypto supports EC keys.
`parseExtraParams` follows Java Properties comments, continuation lines and character escapes.

Known gaps: no smart cards, revocation checking, timestamp/LTV, local XML batch, FacturaE/ASiC local
assembly, visible PDF signing, encrypted PDFs or PDF certification. XAdES Detached without an
explicit `format` parameter deliberately maps to Enveloping, matching AutoFirma's REG quirk.
External detached XML reference resolution and local XAdES co/countersigning are unsupported.
Use the site's triphase service for these formats where available. Implementations are verified
cryptographically offline; acceptance by particular production sedes remains unverified.

Each signature requires explicit human consent, including clear consent to all documents in a
batch. Legal acceptance depends on the certificate, signature format/policy and applicable
requirements; cryptographic verification alone does not establish acceptance or qualification.
Never expose private keys/passphrases to pages, the model, logs or remote triphase servers.

Tests generate disposable RSA/EC PKI, verify CMS with pkijs/OpenSSL and XML with independent
XMLDSig verifiers, verify PDF ByteRanges, run local HTTP triphase pre/post, and load real-shaped
AutoScript in cached Chromium with CSP, double loads, iframe and cancellation. No government
sites or paid APIs are contacted; Chromium test skips when the documented cache is unavailable.
