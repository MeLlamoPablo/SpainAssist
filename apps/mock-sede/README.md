# Mock sede

A fictional Spanish government site for offline development, tests and demos. It never submits
anything to a real administration. Node HTTPS serves the sede and a Cl@ve-like gateway on port
8790, and a TLS client-certificate identity provider on 8791.

## Run it

```sh
corepack pnpm --filter @sa/mock-sede start   # or `corepack pnpm services -- --mocks`
```

The CLI caches a self-signed server CA under `.data/mock-sede` at the repository root; trust it
only in a test browser. Environment: `MOCK_SEDE_PORT`, `MOCK_SEDE_CERT_PORT`,
`MOCK_SEDE_DATA_DIR`, `MOCK_SEDE_TEST_API=0` (no test controls) and
`MOCK_SEDE_AUTOFIRMA_RETRIES` (default 15).

Demo logins:

- Cl@ve Permanente: DNI `99999999R`, password `clave-demo-1234`. The SMS code is printed and
  served at `GET /__test/sms`.
- Certificate: `fixtures/demo-identity.p12`, password `1234`.

All committed certificates and CA private keys are disposable test material.

## What it simulates

- **Home** with residence certificate and appointment procedures.
- **Residence certificate**: a multi-step form, PDF/JPG upload, review, AutoScript signing and
  server verification of real implicit CAdES signatures against the mock client CA. Receipts
  come as a PDF attachment and inline links.
- **Cita previa**: office and service selection, a slot calendar, a CAPTCHA and the booking
  confirmation.
- **Municipal gsede login** (`/gsede/acceso`): "Acceder" signs a challenge with AutoFirma's
  legacy XML batch (`clientSigner.js` → `AutoScript.signBatch`, multinode
  `/service/<JSESSIONID>` servlets). Its BatchPresigner/BatchPostsigner build a real CAdES; the
  login verifies it against the mock client CA and opens a certificate session
  (`/gsede/carpeta`).
- **The gateway**: Cl@ve Permanente with a substantial-level SMS, Cl@ve Móvil QR approval and
  certificate login, including a realistic missing-certificate error. No physical phone or
  AutoFirma is needed.

The QR is decorative: approve with the test API. The page's own AutoScript tries the afirma
protocol and eventually reports that AutoFirma could not be reached; inject the signer shim
before navigation for a successful signature. Sessions and submissions live in memory.

## Use it from tests

`startMockSede({port: 0, certPort: 0})` starts hermetic servers on random ports and returns
`url`, `certUrl`, `caCertPem`, `serverCertSpkiSha256`, `demo`, `test` and async `close()`.

- Use `publicHost: '127.0.0.1'` for browser client-certificate tests on macOS (Chromium treats
  localhost client authentication specially).
- Configure the sidecar for exactly `certUrl` with `roots: [caCertPem]`. Pin the mock server's
  SPKI for tunnelled requests in the test browser; do not disable upstream HTTPS verification.
- `createTestIdentity` creates FNMT-style identities, including legacy PKCS#12 variants.
- Test controls: `GET /__test/state`, `/sms`, `/submissions`; `POST /__test/approve-movil`,
  `/solve-captcha`, `/reset`, `/advance-time`, `/users`, `/expire-sessions`. The same methods
  are on `sede.test`. Turn the HTTP controls off with `MOCK_SEDE_TEST_API=0` or
  `testApi: false`.

Close the servers when a test ends.

## Checks

```sh
corepack pnpm --filter @sa/mock-sede typecheck
corepack pnpm --filter @sa/mock-sede test
```

Tests use the cached Chromium and local servers, including a real test CAdES signer and the
rejection of tampered signatures.
