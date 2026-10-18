# @sa/sidecar

`sa-sidecar` is the native TLS helper of the agent's browser (Go 1.19+, standard library only, in
`go/`), plus its Node client (`src/`). It lets government sites ask for a client certificate and
get one, from a `.p12` key in memory or the DNIe in the paired phone, without the browser ever
holding the key (`docs/research/dnie.md` §2).

## How it works

- It is an HTTP proxy on loopback. Every browser context gets its own port (`openSession`), and
  every request needs the per-launch password (`credentials`, answered by `@sa/browser` from one
  browser-level DevTools handler). Connections are plain TCP tunnels, so Chromium checks every
  site's certificate itself. A site that can't be reached fails the tunnel, and
  `networkError(session, host)` says why the way Chromium would (`ERR_CONNECTION_REFUSED`...).
- `configure(session, hosts, identity)` turns on a client certificate for some hosts of one
  session. Those connections are intercepted: the sidecar finishes TLS with the browser using a
  per-launch key Chromium trusts (`launchArgs`, an SPKI pin), and talks to the real host itself
  with the platform's verifier and the client certificate. Requests are forwarded over
  HTTP/1.1 (TLS 1.2 renegotiation works).
- Remote keys (the DNIe) only do RSA PKCS#1 v1.5, so they stay on TLS 1.2. Before each new
  upstream connection the sidecar calls `prepare` (the user may approve on the phone), then
  `sign` during the handshake. Each signature is checked against the certificate.
- Few signatures: upstream connections are kept and reused, handshakes to a host are serialized,
  and TLS sessions are resumed when the server allows it. Each full handshake is one card
  operation.
- Failures become a 502 page that says why, with an `X-Sa-Certificate-Error` header the browser
  service turns into a note for the agent.

## Secrets and lifetime

Secrets (the proxy password, `.p12` keys) only travel on the sidecar's stdin. It exits when stdin
closes, so it never outlives the app. The client restarts it on the same port after a crash.

## Build and test

```sh
corepack pnpm --filter @sa/sidecar build         # → apps/desktop/vendor/<platform>-<arch>/sa-sidecar
corepack pnpm --filter @sa/sidecar build --all   # every shipped target (cross-compiled, no cgo)
corepack pnpm --filter @sa/sidecar test          # go test + vitest (real binary, local TLS servers)
```

- Without Go the build says so and exits 0; the app then runs with certificate logins off.
- Packaging (`apps/desktop/electron-builder.ts`) builds the target's binary itself and fails
  without Go. It ships the binary in `<resources>/vendor/`, outside the ASAR.
- `sidecarBinaryPath` (`src/layout.ts`) is where the app looks for it, in development and when
  packaged.
