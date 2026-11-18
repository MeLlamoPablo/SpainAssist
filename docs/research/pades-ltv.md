# Long-term PDF signatures (PAdES-B-LT) — research and decisions

2026-11-19. What `@sa/signer` does is in `packages/signer/README.md`, "Long-term PDF signatures".
This memo is the why: which timestamp authorities, what was checked, and what is still open.

## TL;DR

- Every PAdES signature the app makes locally (AutoFirma requests and the user's own PDFs in Mis
  documentos) is upgraded after signing to **PAdES-B-LT**: an RFC 3161 signature timestamp in
  the CMS, plus a Document Security Store (`/DSS`) with every certificate of the signer's and the
  TSA's chains and an OCSP response (or CRL) for each one below the root.
- Default TSAs, in order: **DigiCert** (`http://timestamp.digicert.com`), **Sectigo qualified**
  (`http://timestamp.sectigo.com/qualified`), **Izenpe** (`http://tsa.izenpe.com`). All three are
  trusted by Acrobat out of the box (evidence below). A site's own `tsaURL` goes first.
- Nothing can make a signature fail except a signing certificate that its CA says is revoked.
  No TSA, no OCSP, no room in `/Contents`: the signature is returned as it was (B-B or B-T) and
  the reason is logged.
- Verified offline against an independent PKI (pkijs) and against real answers captured from the
  three TSAs; checked with pyHanko 0.38. **Not yet opened in Acrobat** with a real certificate:
  that is the first thing to do (see "Needs your review").

## Levels, briefly

| Level | What it adds | What it buys |
| --- | --- | --- |
| B-B | the signature (what we made before) | valid while the certificate is valid and checkable online |
| B-T | a TSA's timestamp over the signature value | proves the time; validators check the certificate *at that time* |
| B-LT | chains + OCSP/CRL stored in the PDF (`/DSS`) | validation needs no network: survives expired certificates and gone responders |
| B-LTA | a document timestamp over everything | protects the stored data against algorithm ageing; needs renewal every few years |

We do B-LT for every signature and B-LTA only when a site asks (`tsType` 2 or 3).

## Which TSAs Acrobat trusts (research 2026-11-19)

Method: Adobe's AATL (313 anchors, 108 with policy restrictions; `trustlist.adobe.com/tl12`) and
the EU trusted lists (Acrobat loads them), matched by certificate fingerprint against the chains
the TSAs actually return. Each TSA was queried for real (SHA-256, nonce, certReq) and every
certificate below the root was checked for fetchable OCSP/CRL. Nothing was opened in Acrobat.

| TSA | Why Acrobat trusts it | B-LT data | Terms |
| --- | --- | --- | --- |
| **DigiCert** `http://timestamp.digicert.com` | AATL: DigiCert Trusted Root G4 (`552F7BDC…9988`), no policy restriction | OCSP + CRL, small, CA-signed | DigiCert KB TL310 gives this URL for Acrobat, no account; no written licence or rate limit found |
| **Sectigo qualified** `http://timestamp.sectigo.com/qualified` | EU list: "Sectigo Qualified Time Stamping CA R35" is a granted QTST on Spain's list | OCSP + CRL | public; asks scripts for 15 s between requests and "may charge fees" |
| **Izenpe** `http://tsa.izenpe.com` | EU list: the TSA certificate is a granted QTST on Spain's list | CRLs only | policy v1.4 §5.2: free up to an unpublished monthly quota |

Rejected:

- `timestamp.sectigo.com` (also what `timestamp.comodoca.com` and `timestamp.entrust.net` now
  return): chains to USERTrust RSA, whose AATL entry only accepts certificates with policy OIDs
  `1.3.6.1.4.1.6449.1.2.1.6.6`/`.6.7`; the TSA certificate has `…3.8`. Inferred from Adobe's docs
  and a forum report of "Invalid policy constraint" with this OID. **Many guides recommend this
  URL for Acrobat; it is probably wrong now.**
- SSL.com (same kind of policy mismatch), GlobalSign's public TSAs (now "R45 TSA for CodeSign",
  root not in the AATL), Apple (SHA-1), Microsoft (no OCSP), Certum (OCSP "unknown"), FreeTSA,
  DFN, CESNET.
- IdenTrust: technically fine, but its terms require signed requests and internal use only.
- QuoVadis EU: trusted, but needs IP registration. Belgium's TSA: qualified, but "usage non
  commercial". ACCV (`tss.accv.es:8318/tsa`): Spanish QTST, no usage terms found.
- FNMT and @firma's TS@: administrations only.

Inferred, not verified: that Acrobat applies AATL policy restrictions to timestamp chains; that
Acrobat's copy of the EU lists has these services today (it can lag ~30 days); that DigiCert is
free for this use.

## How it works (`packages/signer/src/ltv.ts`, `tsp.ts`, `revocation.ts`, `timestamping.ts`)

1. **After the key is released** (the phone, Touch ID and the approval never wait for the
   network), the last signature's CMS is read from `/Contents`.
2. **Timestamp.** The SHA-256 of the SignerInfo's signature value goes to the TSAs in order. An
   answer is used only if: status granted, imprint and nonce match, the TSA's signature over the
   TSTInfo verifies with the certificate it carries, and that certificate has the timeStamping
   EKU. The token is spliced into the CMS as the unsigned `signatureTimeStampToken` attribute by
   editing the raw DER (only the lengths around it change, so every signed byte is identical) and
   written back into `/Contents`, which the byte range excludes. If it doesn't fit the reserved
   27000 bytes, the signature stays B-B.
3. **Validation data.** For the signer's certificate and the TSA's: the chain up to a root (from
   the CMS, the token, the app's DNIe CA certificates, or the certificates' CA-issuers URLs,
   preferring a self-signed root over a cross-signed copy), then for each certificate below the
   root an OCSP response (SHA-1 CertID, no nonce: CDN-cached responders reject nonces) or else the
   CA's CRL. Each answer's signature is verified (by the CA, or a delegated responder with the
   OCSPSigning EKU; a responder without `id-pkix-ocsp-nocheck` gets its own revocation check).
4. **`/DSS`.** A new incremental update with the certificates, OCSP responses and CRLs as
   streams, merged with any existing `/DSS`, a `/VRI` entry keyed by the uppercase SHA-1 of the
   signature's `/Contents` (as iText and Acrobat key it), and Adobe's extension level 8.
5. **Document timestamp** (only for `tsType` 2/3): a `/DocTimeStamp` field (`ETSI.RFC3161`) over
   the whole file.

Network: per request 10 s; CRLs up to 10 MB; downloads shared between the two chains.

### AutoFirma's TSA parameters

Read from clienteafirma `TsaParams` (`afirma-crypto-core-pkcs7-tsp`): `tsaURL`; `tsaPolicy`
(AutoFirma sends `0.4.0.2023.1.1` when absent); `tsaHashAlgorithm` (default SHA-512);
`tsaRequireCert`; `tsaUsr`/`tsaPwd` (basic auth); `tsaExtensionOid`/`…ValueBase64`/`…Critical`;
`tsaSslKeyStore*`/`tsaSslTrustStore*` (TLS client certificates); `tsType` 1 signature, 2 document,
3 both. We honour the URL, policy, hash and basic auth exactly as AutoFirma sends them, always ask
for the certificate (B-LT needs it), and add our TSAs as fallbacks. `socket://` URLs, request
extensions and TLS client certificates aren't supported: those requests fall back to our TSAs.

## Verification

- `packages/signer/test/ltv.test.ts`: a fake PKI (root, user CA, TSA CA, TSA, delegated OCSP
  responder with nocheck) served by a stub `fetch` and built with pkijs. Covers the happy path,
  TSA fallback, no TSA, a replayed token (wrong imprint/nonce) refused, OCSP down → CRL, nothing
  reachable → B-T, revoked signer → error, B-LTA, and a second signature keeping the first one's
  data.
- `test/real-tsa.test.ts`: real tokens, chains, OCSP responses and CRLs captured from DigiCert,
  Sectigo qualified and Izenpe on 2026-11-18: our checks accept the tokens and find revocation
  data for each whole chain.
- `test/long-term.test.ts`: the AutoFirma handler (site TSA first, `tsType=3`, nothing fetched
  without the option, revoked certificate fails) and `signPdf`.
- **Live, once, by hand** (not a test: tests never reach real services): a test signer with the
  fake PKI's revocation, timestamped by the real DigiCert TSA, reached B-LT in 2.2–2.7 s with
  DigiCert's real OCSP and CRL data. pyHanko validated DigiCert's whole TSA chain from the stored
  data alone, anchored at the self-signed Trusted Root G4. That run found a real-world detail:
  DigiCert's token carries only a cross-signed copy of G4, so the chain builder now prefers the
  self-signed root from the certificate's CA-issuers URL (regression test with a cross-signed
  root in the fake PKI).
- **pyHanko 0.38** on exported samples (classic and stream xref; B-LT and B-LTA):
  - the signature and both timestamps are "cryptographically sound"; every later revision is
    "signature maintenance compatible with the document modification policy";
  - with only the `/DSS` contents (no network, hard-fail revocation), its certificate validator
    accepts every certificate of both chains;
  - its strict AdES (ETSI EN 319 102-1) validator does **not** accept a plain B-LT: it gives
    stored revocation data a proof of existence only through a later document timestamp, so
    without one it dates them "now" and discards them. That's the AdES archival model, not an
    Acrobat requirement; Acrobat's "LTV enabled" is about the stored data being there.

## Needs your review (morning of 2026-11-19)

1. **Open a real signature in Acrobat Reader.** Sign any PDF in Mis documentos with your FNMT
   certificate (or the DNIe), open it in Acrobat Reader, and check the signature panel: expected
   "Signature is LTV enabled" and "Signature is timestamped" with DigiCert's time. If Acrobat says
   the timestamp isn't trusted, the AATL/EUTL matching above is wrong for that TSA; if it isn't
   "LTV enabled", look at the freshness point below. Also worth one look: a signature made with
   `timestamp.sectigo.com` (not ours) to confirm it is untrusted, as inferred.
2. **Freshness.** DigiCert's OCSP answers for its TSA chain are pre-generated (the captured one
   was issued 2026-08-05, valid until 2027-02-01), so they predate our timestamp. Acrobat accepts
   answers whose validity window covers the signing time, as far as I know; strict AdES
   validators want answers issued after it. If Acrobat disagrees, the fix is to prefer CRLs for
   the TSA chain or add the data again later (a second `/DSS` pass).
3. **Privacy policy.** Each signature now contacts, from the user's computer: the TSA (DigiCert,
   else Sectigo, else Izenpe; it receives only a hash), and the OCSP/CRL servers of the
   certificate authorities in both chains (for an FNMT certificate, FNMT learns that its serial
   number is being checked now; for the DNIe, the Policía's responder). The policy should mention
   these third parties.
4. **Terms of use.** DigiCert has no written terms for its free TSA; Sectigo "may charge fees";
   Izenpe is free up to an unpublished monthly quota. At our volume this is fine; with many users
   a paid, contracted TSA (ideally qualified) would be the safe choice.
5. **On by default** in the desktop app, off in e2e runs. There is no setting to turn it off.

## Not done

- CAdES-T / XAdES-T when a site asks (`tsaURL` with those formats): ignored, as before.
- Triphase and batch PAdES: the site's server builds the signature; we don't touch it.
- B-LTA renewal (re-timestamping archived documents before the last timestamp expires).
- Showing the level in the UI (Mis documentos' signature list could say "con sello de tiempo").
