# Mock sede

A fictional Spanish government site for offline development and demos. It never submits anything
 to a real administration. Node HTTPS serves the sede on port 8790 and a TLS client-certificate
identity provider on 8791. Run `corepack pnpm --filter @sa/mock-sede start` with Node 24.
The CLI caches a self-signed server CA under `.data/mock-sede`; trust only in a test browser.

Demo Cl@ve Permanente: DNI `99999999R`, password `clave-demo-1234`. Its SMS code is available
at `GET /__test/sms`. Demo certificate: `fixtures/demo-identity.p12`, password `1234`.
All committed certificates and CA private keys are disposable test material.

`startMockSede({port: 0, certPort: 0})` starts hermetic servers on random ports and returns
`url`, `certUrl`, `caCertPem`, `serverCertSpkiSha256`, `demo`, `test`, and async `close()`.
Use `publicHost: '127.0.0.1'` for browser client-certificate tests on macOS (Chromium treats
localhost client authentication specially). Configure the sidecar for exactly `certUrl` with `roots: [caCertPem]`. Pin the mock server's
SPKI for tunnelled requests in the test browser; do not disable upstream HTTPS verification.
`createTestIdentity` creates FNMT-style identities, including legacy PKCS#12 variants.

The home lists residence certificate and appointment procedures. Residence uses a multi-step
form, PDF/JPG upload, review, AutoScript signing and server verification of real implicit CAdES
signatures against the mock client CA. Receipts provide PDF attachment and inline links. Cita
includes office/service selection, a slot calendar, CAPTCHA and booking confirmation.
`/gsede/acceso` imitates a municipal gsede login: "Acceder" signs a challenge with AutoFirma's
legacy XML batch (`clientSigner.js` → `AutoScript.signBatch`, multinode `/service/<JSESSIONID>`
servlets). Its BatchPresigner/BatchPostsigner build a real CAdES; the login verifies it against
the mock client CA and opens a certificate session (`/gsede/carpeta`).
The gateway simulates Permanente + substantial-level SMS, Movil QR approval and certificate
login, including a realistic missing-certificate error. No physical phone or AutoFirma is needed.

Test controls: `GET /__test/state`, `/sms`, `/submissions`; `POST /__test/approve-movil`,
`/solve-captcha`, `/reset`, `/advance-time`, `/users`, `/expire-sessions`. Equivalent methods are
available on `sede.test`. Disable HTTP controls with `MOCK_SEDE_TEST_API=0` or `testApi: false`.
The QR is decorative; approve with the test API. The default AutoScript attempts the afirma
protocol and eventually reports that AutoFirma could not be reached; inject the signer shim
before navigation for a successful demo. Sessions and submissions live in memory.

Run `corepack pnpm --filter @sa/mock-sede typecheck` and `corepack pnpm --filter @sa/mock-sede test`.
Tests use cached Chromium and local servers, including a real test CAdES signer and rejection
of tampered signatures. Use the exported API and random ports in e2e; close servers afterwards.
