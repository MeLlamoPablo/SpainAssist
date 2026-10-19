# Browser automation research: Playwright 1.63 and Spanish government logins

Date: 2026-10-03 (updated 2026-10-18). Scope: the browser layer of SpainAssist, an Electron app
driving Chromium with `playwright-core`, logging in with Cl@ve or a certificate.

**What was built.** `packages/browser` (`service.ts`, `snapshot.ts`, `certificates.ts`,
`notes.ts`) runs Playwright in the Electron main process (`apps/desktop/src/main/app/libs.ts`,
`browser/holder.ts`), headed and started minimised. Every package bundles playwright-core's
Chrome for Testing in `<resources>/chromium/` (`apps/desktop/scripts/chromium.ts`,
`src/main/browser/bundled.ts`); the app never downloads a browser. Certificate logins (`.p12`
and the phone DNIe) go through the TLS helper in `packages/sidecar` (its README), not
Playwright's `clientCertificates`. The AutoFirma shim is injected with `addInitScript` and
`exposeBinding` (`packages/signer`, `service.ts`). This memo keeps the Playwright and site
behaviour behind those choices, and why `clientCertificates` was rejected (§1).

Still UNVERIFIED: real-card NFC timings, TLS resumption on real hosts, Linux intermediate-chain
behaviour, and whether the WAFs in §10 accept the sidecar's TLS fingerprint.

## How things were checked

| Tag | Meaning |
|---|---|
| `[lab]` | Ran a script in a local lab. Setup: `playwright-core@1.63.0`, Chromium r1243 (Chrome for Testing 153.0.8010.12), Node 24.9.0 (OpenSSL 3.6), Electron 44.5.1 (Node 24.21.0, BoringSSL, Chrome 152), macOS arm64. The test servers were local Node HTTPS servers with a test CA and test client certs. |
| `[live]` | Observed against the real government site on 2026-10-03. Done with headless/headed Playwright (navigation and snapshots only, no credentials entered) and `openssl s_client` handshake probes. |
| `[src]` | Read in the 1.63.0 source. Paths are relative to `github.com/microsoft/playwright/blob/v1.63.0/`. |
| `[docs]` | Read in the `.d.ts` / API docs shipped in the 1.63.0 tarball, or in the release notes. |
| UNVERIFIED | Not confirmed. |

---

## Key findings

1. **Never use the default `chromium-headless-shell`.** The Extranjería cita previa firewall
   returns 403 "Intrusion Prevention Violation" to it, even with a spoofed user agent `[live]`.
   Headed works; new headless (`channel: 'chromium'`) works only with "Headless" removed from the
   user agent (§5.1).
2. **Playwright's `clientCertificates` was rejected** (§1). It turns on `ignoreHTTPSErrors` for
   every origin in the context, checks server certificates with Node's store (no AIA fetching),
   uses Node's TLS fingerprint, fixes certificates at context creation, and can't use a key it
   doesn't hold (DNIe; PKCS#11 is out of scope, issue #32003).
3. **Hosts that ask for a TLS client certificate** at the handshake are listed in §9.1. Missing
   certificates rarely fail at the network level: each site shows its own error page (§9.2).
4. **Snapshot refs** (`ariaSnapshot({ mode: 'ai' })`, `aria-ref=`) include cross-site iframes and
   resolve only against the latest snapshot of their frame (§2.3).
5. **Biggest product risk is legal or policy, not technical.** On 29/04/2026 AEAT listed
   "automatización de autenticaciones, robotización, scripting", showing Cl@ve QR codes through
   "sistemas interpuestos", and storing passwords or one-time codes as improper uses of Cl@ve
   `[live]` (§10). Keep a human in the loop for Cl@ve, and prefer certificates.

---

## 1. Rejected: Playwright `clientCertificates`

These probes are why certificate logins go through `packages/sidecar` instead. Kept because
the TLS facts (renegotiation, error signals) also apply to the sidecar.

### 1.1 Exact shape (1.63 `types.d.ts`) `[docs]`

It is accepted by these four, and by nothing else:
- `browser.newContext(options?: BrowserContextOptions)`
- `browser.newPage(...)`
- `browserType.launchPersistentContext(userDataDir, options)`
- `request.newContext(...)` (APIRequestContext)

There is no setter on an existing context.

```ts
clientCertificates?: Array<{
  origin: string;      // "Exact origin that the certificate is valid for. Origin includes https protocol, a hostname and optionally a port."
  certPath?: string;   // PEM
  cert?: Buffer;       // PEM
  keyPath?: string;    // PEM
  key?: Buffer;        // PEM
  pfxPath?: string;    // PFX/PKCS#12 (key + chain)
  pfx?: Buffer;
  passphrase?: string; // for PEM key or PFX
}>;
```

Validation (`server/browserContext.ts → verifyClientCertificates`) `[src]`:
- `origin` is required.
- `cert` requires `key`, and `key` requires `cert`.
- `pfx` cannot be combined with `cert` or `key`.
- An unreadable or unsupported certificate makes `newContext` throw `Failed to load client certificate: …`.

### 1.2 How it works `[src]` (`server/socksClientCertificatesInterceptor.ts`)

- **A SOCKS proxy for the whole context.** When the list is non-empty, Playwright starts a SOCKS5 server on `127.0.0.1:<random>` in the Playwright (Node) process. Every connection of the context goes through it, using `proxyOverride`.
- **Listed origins.** If the first bytes are a TLS ClientHello and `https://host:port` (normalized) is in the list, Playwright terminates TLS:
  - Toward the browser, it presents a runtime-generated self-signed cert.
  - Toward the server, it opens its own `tls.connect({ secureContext /* your cert */, ALPNProtocols: <copied from browser>, rejectUnauthorized: !ignoreHTTPSErrors })`.
- **Other origins** are piped through untouched, and the browser does TLS itself. This has been true since 1.61 (PR #41113); before that, every TLS connection was intercepted.
- **All certificate errors are ignored.** Because the browser sees the fake cert, the context is created with `internalIgnoreHTTPSErrors = true`, which sends `Security.setIgnoreCertificateErrors` to every frame. Verified `[lab]`:
  - With certificates configured for origin A, a page on origin B with an untrusted self-signed cert loads with 200 ("ROGUE SERVER REACHED").
  - Without `clientCertificates`, the same page fails with `net::ERR_CERT_AUTHORITY_INVALID`.
- **Consequences:**
  - Server cert checking for listed origins is done by Node's CA store, not Chrome's. Node does no AIA fetching of missing intermediates.
    - Example: `icp.administracionelectronica.gob.es` fails in Node and Electron with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, but works in Chrome `[live]`.
    - All the certificate-requesting hosts in section 9 do validate in Node 24 and Electron 44 `[live]`.
    - If upstream validation fails, the page gets a synthetic **HTTP 503**, body `Playwright client-certificate error: <reason>` `[lab]`.
  - The TLS fingerprint toward listed origins is Node's (OpenSSL or BoringSSL), not Chrome's. That could matter to F5/Akamai bot defenses (UNVERIFIED on gov sites).
  - Bug in 1.63.0 (#42806): a **launch-level** `proxy` and `proxy.bypass` are ignored when `clientCertificates` is set. Fixed after 1.63.0 by PR #42873.

### 1.3 Origin matching `[lab]`, Node 24 and Electron 44

| Configured `origin` | Navigated URL | Cert sent? |
|---|---|---|
| `https://localhost:9443` | `https://localhost:9443/` | yes |
| `https://localhost:9443/foo/bar?x=1` (path is ignored, `new URL().origin`) | `https://localhost:9443/` | yes |
| `https://*.localhost:9443` | `https://localhost:9443/` | **no**: no wildcards |
| `https://127.0.0.1:9443` | `https://localhost:9443/` | **no**: the host is compared as a string |
| `https://localhost` | `https://localhost:9443/` | **no**: the port must match |
| `https://host:443` vs `https://host` | | the same, because the default port is normalized `[src]` |

Each subdomain needs its own entry: `www1`, `www8` and `www10.agenciatributaria.gob.es` are three origins.

### 1.4 Headed, persistent, and channels `[lab]`

These all worked against a lab server that required a client cert:
- Headed `chromium.launch({ headless:false })` + `newContext`
- Headed `launchPersistentContext`
- `channel: 'chrome'` (Chrome 154 stable)
- Electron main process
- Electron `utilityProcess`

### 1.5 PKCS#12 parsing `[lab]`

Plain Node 24 with OpenSSL 3 rejects legacy RC2-40 PKCS#12 files; Electron's BoringSSL accepts
them. The app parses `.p12` files itself (`@sa/signer` `openP12`, modern and legacy) and hands
the sidecar the key, so neither TLS stack has to.

### 1.6 Performance `[lab]`

Fetching 50 MB on localhost from inside a page, in Node 24 and Electron 44 respectively:

| Path | Node 24 | Electron 44 |
|---|---|---|
| Direct | ~840 MB/s | ~1 GB/s |
| SOCKS pass-through (origin not listed) | ~920 MB/s | ~1 GB/s |
| Node TLS interception (origin listed) | ~340 MB/s | ~280 MB/s |

Throughput is irrelevant for government sites. The cost is that every byte crosses the
Playwright process's event loop.

### 1.7 Certificates are fixed per context

With `clientCertificates`, adding a certificate means recreating the context and carrying over
`storageState` (which loses sessionStorage and in-page state). The sidecar avoids this:
`useClientCertificate` changes the session's configuration and the context stays.

### 1.8 TLS renegotiation and mid-connection certificate requests

- **Server-initiated renegotiation (TLS 1.2, Apache/IIS-style "ask for a cert only on /login") works through the proxy**, in both Node 24 (OpenSSL) and Electron 44 (BoringSSL) `[lab]`.
  - Lab server: `socket.renegotiate({requestCert:true})` with `SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION`, so it is a full handshake.
  - Playwright's own test suite covers it too: PR #42878, `tests/library/client-certificates.spec.ts`.
- **Edge case `[lab]`:** if the server lets the renegotiation *resume* the session (abbreviated handshake), OpenSSL-based clients send **no** certificate.
  - That includes the proxy and `openssl s_client`. macOS curl/SecureTransport did send one.
  - Real Apache forces a full handshake, so this is unlikely to matter.
- **HTTP/2 forbids renegotiation.** The proxy copies the browser's ALPN offer, so an h2 server can't renegotiate.
  - IIS handles this with `HTTP_1_1_REQUIRED` and a retry over HTTP/1.1. That this works through the proxy is UNVERIFIED.
  - None of the government certificate hosts found below needs it: they all ask during the initial handshake `[live]`.
- **TLS 1.3 post-handshake auth** is not supported by Chrome, so sites can't depend on it. Node's client doesn't enable it either.
- **Origins not listed** are handled by Chromium itself. Headless sends no certificate.
  - In **headed** Chrome, a native "Select a certificate" dialog appears when the OS store has identities, and Playwright cannot click it (issues #33230, #31906). Seen in the field on Windows on 2026-10-19 (an FNMT certificate and a work account's MS-Organization-Access certificate in the store, ClicSalud+'s `ws235.juntadeandalucia.es`): the dialog stayed open, and the tab ignored the agent's clicks until it was closed.
  - So the sidecar never lets Chromium see a certificate request: before tunnelling to a host for the first time it probes the handshake, and hosts that ask are intercepted with no certificate until one is enabled (`packages/sidecar/go/probe.go`). The probe can't see renegotiation-based requests (§9.1 caveats).
  - The documented trick of "list a dummy origin to force 'no certificate'" **broke in 1.61** (issue #42546). Its fix (#42547) was **reverted on 2026-10-02** (#43074). So don't rely on it, and list every certificate host explicitly.

### 1.9 Error signals `[lab]`

| Situation | What Playwright reports |
|---|---|
| Server *requires* a cert, origin not listed (browser does TLS) | `page.goto` throws `net::ERR_BAD_SSL_CLIENT_AUTH_CERT`; `requestfailed` has the same `errorText` |
| Server rejects the cert we sent (TLS 1.3) | `net::ERR_EMPTY_RESPONSE` |
| Upstream TLS error in the proxy (untrusted server chain, etc.) | HTTP **503**, body starts with `Playwright client-certificate error:` |
| Unsupported `.p12` | `newContext` throws `Failed to load client certificate: Unsupported TLS certificate…` |
| Server *optionally* asks and none is sent (the common case on government sites) | No network error; an app-level error page instead (section 9) |

Debug with `DEBUG=pw:client-certificates`.

---

## 2. Snapshots and element refs for the LLM

### 2.1 What `mode: 'ai'` changes `[src]` (`injected/src/ariaSnapshot.ts`)

Compared with the default mode:
- visibility is "aria **or** visible"
- `generic` nodes are included
- `[active]` and `[cursor=pointer]` are shown
- refs go only to *interactable* nodes (visible and receiving pointer events)
- `<iframe>` contents are inlined
- on a locator it doesn't wait, and throws when nothing matches

### 2.2 What it looks like

Excerpt of the Cl@ve gateway page `[live]`, trimmed:

```yaml
- main [ref=f3e26]:
  - heading "Plataforma de identificación para las Administraciones" [level=1] [ref=f3e30]
  - article [ref=f3e37]:
    - heading "Clave Móvil" [level=2] [ref=f3e43]: Cl@ve Móvil
    - button "Acceso Clave Móvil" [ref=f3e58] [cursor=pointer]
  - article [ref=f3e61]:
    - heading "DNIe / Certificado electrónico" [level=2] [ref=f3e65]
    - button "Acceso DNIe / Certificado electrónico" [ref=f3e70] [cursor=pointer]
```

Iframe case `[lab]` (cross-site OOPIF):

```yaml
  - button "Abrir ventana" [ref=e6]
  - iframe [ref=e8]:
    - generic [ref=f1e1]:
      - textbox "Nombre" [ref=f1e3]
      - button "Enviar" [ref=f1e4]
```

### 2.3 How refs behave (all `[lab]`, mechanism from `[src]`)

- A ref is cached on the DOM node (`element._ariaRef`). The same element keeps the same ref across snapshots while its **role and name** stay the same.
  - New elements get new numbers (`e9`); a renamed element gets a new ref (`e10`).
- `aria-ref=` resolves **only against the latest snapshot taken in that frame** (`injectedScript._lastAriaSnapshotForQuery`). After any of these, an older ref fails:
  - a default-mode `ariaSnapshot()`
  - a sub-tree `locator.ariaSnapshot()`
  - a navigation
  - replacing the element with an identical clone (`isConnected` is false), which is common with JSF/React re-renders

  A fresh full `mode:'ai'` snapshot makes refs resolvable again: a still-attached element gets its old ref back (`e3` stayed `e3`), while a replaced element gets a new one.
- An unresolvable ref doesn't throw immediately. The locator auto-waits until its timeout. Check first with `await page.locator('aria-ref=e3').count()`, which returns 0 for a stale ref.
  - A bad frame prefix throws `Invalid frame in aria-ref selector`.
- **The prefix is the frame's sequence number, not "iframe".**
  - The main frame of a fresh page has no prefix (`e3`).
  - Each new main-frame document gets a new sequence number, so it is `f1e…`, then `f2e…`, and so on (`server/frames.ts`: `frame.seq = this._allocateFrameSeq()` on cross-document navigation).
  - So refs from the old document can never hit an element in the new one. After a reload, `e3` became `f2e3`.
  - The server routes `aria-ref=f<seq>e<n>` to the frame with that seq (`frameSelectors.ts → _jumpToAriaRefFrameIfNeeded`).
- Iframes: `page.ts → ariaSnapshotJSONForFrame` recursively snapshots every rendered iframe ref through `aria-ref=<iframe ref> >> internal:control=enter-frame`, with depth budgeting.
  - It works for cross-site out-of-process iframes. Filling a textbox inside one via `aria-ref=f3e3` worked `[lab]`.
  - Default (non-ai) mode does **not** include iframe content.

### 2.4 How `@playwright/mcp` does it `[src]`

`@playwright/mcp@0.0.83` is now a thin wrapper: `require('playwright-core/lib/coreBundle').tools.createConnection`. The tools ship inside playwright-core (`npx playwright mcp`, 1.62+). Files are under `packages/playwright-core/src/tools/backend/`.

- **`browser_snapshot`** (`snapshot.ts`) takes `{ target?, filename?, depth?, boxes? }` and calls `page.ariaSnapshot({ mode:'ai', depth, boxes })`, or `locator.ariaSnapshot(...)` for a target, and returns the YAML inline.
  - After *actions*, 1.63 writes the snapshot to a `.yml` file and returns only a link (`response.ts`, `snapshotToFile`).
- **`browser_click`** takes `{ element?, target, doubleClick?, button?, modifiers? }`. In `tab.ts → targetLocators`:
  - If `target` matches `/^(f\d+)?e\d+$/`, it builds `page.locator('aria-ref='+target).describe(element)` and calls `.normalize()` for code generation.
  - On failure it says `Ref X not found in the current page snapshot. Try capturing new snapshot.`
  - Anything else is treated as a selector or locator string.
- **Settling** (`utils.ts → waitForCompletion`) runs after the action:
  - waits `settle` ms (500 by default)
  - if a navigation started, waits for `load` (up to 10 s)
  - otherwise waits for document/script/xhr/fetch responses (up to 5 s)
- **Modal states**: dialogs and file choosers are tracked from `page.on('dialog' | 'filechooser')`. A snapshot is raced against them, so a pending dialog doesn't hang the snapshot.
- **Embedding.** `tools.createConnection(config, () => Promise<BrowserContext>)` lets you hand it your own context, with certificates and hooks. That is an internal, non-semver export.
  - Version trap: `@playwright/mcp@0.0.83` depends on `playwright-core@1.64.0-alpha`. Don't mix its objects with a 1.63 context; import `tools` from the same `playwright-core` instead.
  - We wrote our own small tool set with the same pattern (`packages/browser`).
  - That keeps control over PII scrubbing. MCP's `secrets` redaction is "a convenience and not a security feature" (`config.d.ts`).

---

## 3. `exposeBinding` and `addInitScript` (for injecting an AutoFirma replacement)

Signatures `[docs]`:

```ts
// Page and BrowserContext
exposeBinding(name: string, playwrightBinding: (source: BindingSource, ...args: any[]) => any): Promise<Disposable>;
exposeFunction(name: string, callback: Function): Promise<Disposable>;
addInitScript<Arg>(script: PageFunction<Arg, any> | { path?: string; content?: string }, arg?: Arg,
                   options?: { exposeFunctions?: boolean }): Promise<Disposable>;
type BindingSource = { context: BrowserContext; page: Page; frame: Frame };
```

- The `handle` option of `exposeBinding` was removed in 1.60.
- `exposeFunctions` was added in 1.62. Functions nested in `arg` become hidden bindings that are passed to the script and **not** put on `window`.
- `Disposable` and `await using` exist since 1.59.

Semantics, all `[lab]` (Chromium wiring: `crPage.ts` uses `Page.addScriptToEvaluateOnNewDocument` with `runImmediately`, `Runtime.addBinding`, and auto-attach with `waitForDebuggerOnStart`):

- **Init scripts run before any page script** in the main frame, in a **cross-site OOPIF**, and in **popups** (`window.open`).
  - In all three, `typeof window.myBinding` was already `'function'` when the page's first inline script ran.
- **They run again on every navigation and every new frame**, and stay installed until disposed. Context-level ones apply to every page.
  - The order between several init scripts is undefined.
- **Bindings exist in every frame.** `source.frame` tells you which iframe called.
  - A binding call is asynchronous; the page gets a Promise.
- **Bindings leave detectable globals:** `window.__playwright__binding__` and `__playwright__binding__controller__`, even with `exposeFunctions`. Bot-defense scripts could look for them (UNVERIFIED that any government site does).
- **Not covered:** service and web workers.

The app uses a context-level `exposeBinding` (it needs `source.frame` to know which origin is
asking) plus an `addInitScript` with the shim's source (`installAfirma` in `service.ts`).

Pattern that was tested: a locked global that page scripts can't overwrite.

```ts
await context.addInitScript((api) => {
  const shim = { sign: (dataB64: string /* … */) => api.sign(dataB64), /* cargarAppAfirma, setServlets, … */ };
  // Accessor + no-op setter: page assignments are ignored without throwing, even in strict mode.
  Object.defineProperty(window, 'AutoScript', { get: () => shim, set: () => {}, configurable: false });
}, { sign: async (dataB64: string) => signWithUserCert(dataB64) }, { exposeFunctions: true });
```

- Verified `[lab]`: the shim survives a sloppy-mode `var AutoScript = {…}` (the way `autoscript.js` declares it), a strict-mode `AutoScript = {…}`, and a strict-mode `window.AutoScript = {…}`. No page errors, and later scripts still run.
- Don't use `{ value, writable: false }` instead: a strict-mode assignment would then throw and could break the sede's own script.
- A global `function AutoScript(){}` declaration would still throw against a non-configurable property (UNVERIFIED that any sede does this).
- Implement the full API surface, or wrap the shim in a `Proxy` that logs unknown calls.
- Alternative: replace the library at the network level with `context.route('**/autoscript*.js', r => r.fulfill({ contentType: 'application/javascript', body: SHIM }))`. Script names differ per sede, so this needs a pattern list (UNVERIFIED coverage).

---

## 4. Popups, downloads, uploads, dialogs, storageState

**Popups** `[lab]`:
- Use `page.waitForEvent('popup')`, or `context.on('page')` for every new page.
- Popups inherit the context's init scripts and bindings, and the popup's `__initRan` was true.

```ts
const popupP = page.waitForEvent('popup'); await page.getByRole('button', { name: 'Abrir ventana' }).click();
const popup = await popupP; await popup.waitForLoadState();
```

**Downloads** `[lab]`:
- `acceptDownloads` defaults to `true`, and files go to a temp `downloadsPath`.
- They are **deleted when the context closes**, so always `saveAs`.
- Signatures:
  - `Download.saveAs(path: string): Promise<void>`
  - `suggestedFilename(): string`
  - `path(): Promise<string>`
  - `failure(): Promise<null|string>`
  - `createReadStream(): Promise<Readable>`

```ts
const dl = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: /justificante/i }).click()]).then(([d]) => d);
await dl.saveAs(path.join(userDocsDir, dl.suggestedFilename()));
```

**PDF gotcha** `[lab]` (how the "justificante" is usually served):

| Mode | Opening a PDF |
|---|---|
| Default headless (`chromium-headless-shell`) | `page.goto(pdfUrl)` throws `Download is starting` and fires a `download` event |
| **Headed** and `channel:'chromium'` | The PDF opens in Chrome's built-in viewer with **no download event** |

To get the bytes, use one of:
- `await context.request.get(url)`, which shares cookies (but uses Node's TLS, see section 1.2)
- `page.waitForResponse(r => r.headers()['content-type']?.includes('pdf'))` then `.body()`

**Uploads** `[lab]`. Bytes can come from memory, so there's no temp file with personal data.
- Signature: `Locator.setInputFiles(files: string | ReadonlyArray<string> | { name: string; mimeType: string; buffer: Buffer } | ReadonlyArray<…>, options?)`.
- Native pickers: use `page.on('filechooser')` and then `fileChooser.setFiles(...)`.

```ts
await page.getByLabel('Adjuntar documento').setInputFiles({ name: 'dni.pdf', mimeType: 'application/pdf', buffer });
```

**Dialogs** `[lab][docs]`:
- `page.on('dialog', d => …)` gives `d.type()` (`alert | confirm | prompt | beforeunload`), `d.message()`, `d.accept(promptText?)` and `d.dismiss()`.
- **With no listener, every dialog is auto-dismissed**, which is risky for "¿Desea continuar?" confirms. Always register a handler that routes the dialog to the agent or the user.
- New in 1.63: the `dialogclosed` event.

**storageState** `[lab][docs]`:
- `context.storageState(options?: { path?: string; indexedDB?: boolean; opfs?: boolean; credentials?: boolean })` returns `{ cookies, origins:[{origin, localStorage}] }`.
- It includes session cookies (`expires: -1`). It **excludes sessionStorage**.
- Restore it with `browser.newContext({ storageState })` or `context.setStorageState(state)` (1.59+; it clears existing state).
- The Cl@ve gateway SSO cookie (`clave2Sso`, `Max-Age=3600`) means a saved state can skip re-login for 60 minutes (live check, 2026-10-03).
- Encrypt saved state at rest: it is a bearer credential.

---

## 5. Launching Chromium from an Electron app

### 5.1 Which browser

| Option | Pros | Cons |
|---|---|---|
| **Playwright's Chrome for Testing** (`chromium`, r1243 = 153.0.8010.12): **chosen** | The exact build 1.63 is tested against; same on every OS. Headed works on F5-protected sites `[live]`. | About 360 MB on disk (measured, macOS arm64). The app bundles it; Google publishes no redistribution licence, a risk we accept. Shows as a separate "Google Chrome for Testing" app/window. |
| `channel: 'chrome' \| 'msedge'` | No download; real branded Chrome. Worked, with certificates, on this Mac with Chrome 154 `[lab]`. | Not installed everywhere. Version drift (1.63 tested with Chrome 153). Enterprise policies can interfere (Playwright docs). |
| Electron's own Chromium (e.g. a `WebContentsView` + `webContents.debugger` CDP, or `connectOverCDP` to the app's own `--remote-debugging-port`) | Nothing to download; true in-app view. | Loses the Playwright API or `clientCertificates`. A debugging port lets any local process take over the app. Rejected. |

Headless variants against `icp.administracionelectronica.gob.es` `[live]`:

| Mode | Result |
|---|---|
| `headless:true` (default headless shell) | **403 "Intrusion Prevention Violation"**, even with the UA fixed |
| `channel:'chromium'` (new headless) | 403 with the default UA, **200** with `userAgent` = UA with "HeadlessChrome" replaced by "Chrome" |
| Headed | 200, with an F5 TSPD JS challenge and an `eu-captcha` stylesheet loaded |

So install only `chromium` (`--no-shell`).

### 5.2 Playwright's browser registry

The app bundles Chromium (`apps/desktop/scripts/chromium.ts` stages it at packaging time, main
passes it as `executablePath`). It never downloads one at runtime: the Microsoft Store forbids
downloading code (policy 10.2.2). What the packaging script relies on `[src]`:

- `require('playwright-core/lib/coreBundle').registry.registry` is internal, not semver. Its
  `findExecutable('chromium')` gives `directory` (`<cache>/chromium-<revision>`),
  `executablePath()` and `browserVersion`. Check it whenever playwright-core is updated.
- `PLAYWRIGHT_BROWSERS_PATH` is read **once, when `playwright-core` is first required**
  (`registry/index.ts → registryDirectory`). `"0"` means `node_modules/playwright-core/.local-browsers`;
  unset means `~/Library/Caches/ms-playwright`, `%LOCALAPPDATA%\ms-playwright` or
  `~/.cache/ms-playwright`.
- The shared cache is garbage-collected: `registry.install` deletes browser revisions not
  referenced by any `.links/<sha1>` entry. Guard against that with `PLAYWRIGHT_SKIP_BROWSER_GC=1`,
  `install(..., { gc: false })`, or CLI `--no-remove` (1.63).
- Downloads come from `cdn.playwright.dev/builds/cft/<ver>/<platform>/...`
  (`PLAYWRIGHT_DOWNLOAD_HOST` / `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` for mirrors). Electron's
  `child_process.fork` runs the out-of-process downloader fine `[lab]`.

### 5.3 Running Playwright inside Electron

- **It works** in Electron 44 main and in a `utilityProcess` `[lab]`, including certificates and
  screencast. The app runs it in main.
- **The TLS stack differs.** Electron's Node is BoringSSL (`process.versions.openssl === '0.0.0'`).
  Its bundled root store is smaller than Node 24's (121 vs 146 certificates from
  `tls.getCACertificates('bundled')`). `NODE_EXTRA_CA_CERTS` is honored.
- **Packaging.** Keep `playwright-core` **external** to the Vite bundle. It loads files relative
  to its package root: `browsers.json`, `lib/entry/oopBrowserDownload.js` (forked),
  `lib/server/electron/loader.js`, `webp_codec.wasm` `[src]`. No `asarUnpack` is needed
  (`electron-packaging.md` §6.11).
- **Code signing.** The bundled Chrome for Testing .app is signed with the rest of the macOS app:
  ad-hoc, it passes `codesign --verify --deep --strict` and launches `[lab]`. Developer ID signing
  and notarization of it are UNVERIFIED.
- **Shutdown.** Playwright installs SIGINT/SIGTERM handlers by default, so close the browser on
  `app.on('before-quit')` (or pass `handleSIGINT: false` and friends).

---

## 6. Electron end-to-end tests with `_electron`

Still marked **experimental** in the 1.63 docs `[docs]`; worked with Electron 44.5.1 `[lab]`
(launch in about 340 ms). Used by `e2e/fixtures.ts` and `apps/desktop/scripts/smoke.mjs`.

Gotchas `[src][docs]`:
1. Playwright starts Electron with `--inspect=0 --remote-debugging-port=0`. Without `executablePath`, it also adds `-r lib/server/electron/loader.js`, which patches `app.whenReady` and adds Chromium switches.
   - Packaged builds need the `EnableNodeCliInspectArguments` fuse **on**. Test an unpackaged `electron-vite build` output, or a test-flavored package.
   - `NODE_OPTIONS` is deleted from the environment.
2. electron-vite: run `electron-vite build` first. The template loads `process.env.ELECTRON_RENDERER_URL` when `is.dev`, otherwise `out/renderer/index.html`.
   - `is.dev` (`!app.isPackaged`) is true under `_electron.launch`, so make sure `ELECTRON_RENDERER_URL` isn't inherited.
   - Use `waitForEvent('window', p => p.url().endsWith('index.html'))` if a splash or DevTools window may come first.
3. Native dialogs are not intercepted; stub them in main through `app.evaluate(({ dialog }) => …)`.
4. The agent's Chromium is a separate browser, so it is invisible to `app.windows()`. Assert on the renderer's live view, or expose a test hook.
   - For CI, point the agent at local mock sedes (like the lab servers used here) instead of real government sites.

---

## 7. Live view of the agent's page in the renderer

1. **`page.screencast.start({ onFrame })`** (1.59+, recommended) `[lab]`.
   - About 30–40 JPEG frames per second while the page changes; frames are only sent on repaint.
   - Back-pressure: the next frame waits for the `onFrame` promise to resolve.
   - Default size fits the viewport into 800 px; default quality is 90.
   - Bonus: `showActions()` draws an animated cursor and action titles in the page, and `showOverlay(html)` / `showChapter()` add banners. Good for "what is the agent doing".

   ```ts
   start(options?: { onFrame?: (f: { data: Buffer; timestamp: number; viewportWidth: number; viewportHeight: number }) => any;
                     path?: string; size?: { width: number; height: number }; quality?: number }): Promise<Disposable>;
   ```

   ```ts
   await page.screencast.start({ size: { width: 960, height: 600 }, quality: 70,
     onFrame: async ({ data }) => port.postMessage({ type: 'frame', jpeg: data }) });  // renderer: createImageBitmap(new Blob([jpeg])) -> <canvas>
   await page.screencast.showActions({ position: 'top-right' });
   ```

   The doc comment on `page.screencast` mentions `.on('screencastFrame')`, but the 1.63 `Screencast` interface has no `on`. Use `onFrame`.
2. **Raw CDP**: `const cdp = await context.newCDPSession(page)`, then `cdp.send('Page.startScreencast', { format:'jpeg', quality, maxWidth, maxHeight })`.
   - Handle `Page.screencastFrame` and `Page.screencastFrameAck` yourself. About 29 frames per second `[lab]`.
   - Chromium only; `newCDPSession(page: Page | Frame): Promise<CDPSession>`.
3. **Polling** `page.screenshot({ type:'jpeg', quality:60 })` every 200–500 ms: simplest, and works in any mode.
4. **Show the real headed window** for steps that need the user: Cl@ve Móvil QR, CAPTCHAs, SMS codes.
   - For a streamed view with takeover, forward clicks and keys from the canvas through `page.mouse` / `page.keyboard`.

Remember to switch streaming to the new page when a popup opens.

---

## 8. Cl@ve gateway flows (late 2025 and 2026)

All hostnames and paths below were observed `[live]` on 2026-10-03 by following Mi Carpeta Ciudadana to Cl@ve (no credentials entered). A parallel check from a council sede saw the same endpoints.

**Sede (service provider) to gateway:**
- The Carpeta case goes `carpetaciudadana.gob.es/clave`, then the Keycloak OIDC broker `auth-api.redsara.es/auth/realms/sgad-appfactory/...`, then a self-submitting SAML2 POST to **`https://pasarela.clave.gob.es/Proxy2/ServiceProvider`**.
- That shows "Plataforma de identificación para las Administraciones", footer "Cl@ve v2.8.4".
- Protocol: Cl@ve 2.0 uses the eIDAS SAML2 profile. The level of assurance (LoA) is requested as `http://eidas.europa.eu/LoA/{low|substantial|high}` ([RedIRIS wiki](https://wiki.rediris.es/pages/viewpage.action?pageId=25428332)).
- The selection form posts `SelectedIdP` ∈ {`IDP_MOVIL`, `AFIRMA`, `EIDAS`, `SEGSOC`} to `/Proxy2/ServiceRedirect`.
- The identity provider's SAMLResponse returns through `/Proxy2/ResponseRedirect` to the sede's return URL (for Carpeta, `auth-api.redsara.es/.../broker/clave/endpoint`).
- Posting without the sede's Referer/Origin gave `invalid.sp.domain` (live check), so the agent must start from the sede, not deep-link the gateway.
- Single sign-on: "La identificación se realizará automáticamente si no han transcurrido más de 60 minutos desde su última identificación" (cookie `clave2Sso`, `Max-Age=3600`).

**Methods shown in 2026** (Cl@ve PIN no longer has its own button):

| Button | Next hop (live) | What the user does |
|---|---|---|
| **Cl@ve Móvil** ("Novedad · Incluye Cl@ve PIN") | POST `www2.agenciatributaria.gob.es/wlpl/SEII-SAML/AuthenticateCitizenMovil`, then 302 to `www2.agenciatributaria.gob.es/wlpl/MOVI-P24H/ObtenerClaveMovilQR?…&qaa=2` | The page shows a **QR**, a **5:00 countdown**, a **3-character verification code** (e.g. "SM6") to compare in the app, and "Confirma el acceso en la APP". It continues by itself. It warns: scan only if the URL starts with `https://www2.agenciatributaria.gob.es`. The link "¿No puedes acceder escaneando el código QR?" goes to `www12.agenciatributaria.gob.es/wlpl/MOVI-P24H/ObtenerClaveMovil` and then `www2…/wlpl/BUCV-JDIT/AutenticaDniNieContrasteh`: a form "Introduce tu DNI/NIE" plus a check value (DNI expiry date, issue date for permanent DNIs, or NIE support number), then a push to approve in the app. An SMS PIN fallback is offered after about 59 s ([AEAT help, 24/06/2026](https://sede.agenciatributaria.gob.es/Sede/ayuda/consultas-informaticas/firma-digital-sistema-clave-pin-tecnica/obtencion-clave-pin.html)). |
| **DNIe / Certificado electrónico** ("Cualquier certificado electrónico cualificado") | POST **`https://pasarela-ident.clave.gob.es/IdP2/AuthenticateCitizen`**: TLS 1.2, **CertificateRequest during the handshake** (no CA hints) | The browser presents the TLS client cert. With none, the sede shows `003002 - Authentication Failed (no certificate has been submitted)`. |
| **Ciudadanos UE** | POST `https://eidas.redsara.es/SpecificConnector/CountrySelector` | Country picker, then the foreign eID. |
| **Cl@ve permanente** ("Usuario y contraseña") | POST `clave-dninbrt.seg-social.gob.es/IPUC2/Login`, then `/AutenticacionSMSWeb/Identificacion?PAUC.TIPO_VALIDACION=1…`, then `/rss-gateway/AuthByLevelFormGateWayServlet` | Form "DNI o NIE" + "Contraseña" + "Entrar". An **SMS one-time code is needed only for services that require "modo reforzado"**, and that requires an "avanzado" registration level ([clave.gob.es/clave/funcionalidad](https://clave.gob.es/clave/funcionalidad)). That corresponds to LoA "substantial" ([Canarias Cl@ve2 doc](https://www.gobiernodecanarias.org/transformaciondigital/platino/ext/doc/servicio-clave2/6.0/5_1_idPs_qaa.html)). No app or push alternative was found for Permanente (UNVERIFIED negative). The page has a dormant image-CAPTCHA hook (UNVERIFIED trigger). |

Other notes:
- With LoA **high**, only DNIe/Certificado and Ciudadanos UE are offered (live check, 2026-10-03).
- Cl@ve PIN's identity provider was announced for removal from the gateway in Q2 2025 ([REGTSA communiqué](https://regtsa.es/comunicado-sobre-el-cierre-del-idp-clve-pin/)). The exact date is UNVERIFIED; the button is gone as of 2026-10-03.
- Other gateway environments: `se-pasarela.clave.gob.es` (integrator test environment) and `pre-`/`des-pasarela.clave.gob.es` (UNVERIFIED that these are reachable).
- **AEAT does not use the gateway for its own services.** It has its own selector at `sede.agenciatributaria.gob.es/static_files/common/html/selector_acceso/SelectorAccesos.html?ref=…&aut=…`.
  - "Identifícate con" offers Cl@ve Móvil, "Certificado o DNI electrónico", "Número de referencia" / "DNI/NIE y dato de contraste" (the set depends on `aut`), and eIDAS. There is no Cl@ve Permanente.
  - Certificate goes to `https://www1.agenciatributaria.gob.es/wlpl/OVCT-CXEW/DialogoRepresentacion?ref=…`, which asks for a certificate during the handshake. Without one it redirects to `https://sede.agenciatributaria.gob.es/Sede/errores/erro4033.html` (title "Agencia Tributaria: 403").

---

## 9. Certificate login: origins for the sidecar, and runtime detection

### 9.1 Origins

Handshake probe `[live]`: `openssl s_client -connect H:443 -servername H`. A `Requested Signature
Algorithms` line means the server sent a CertificateRequest; the probe was calibrated on the lab
servers. Every host probed on 2026-10-03 also passes Node 24 and Electron 44 certificate
validation.

**Ask during the handshake** (`CERTIFICATE_ORIGINS` in `packages/browser/src/certificates.ts`):
- `pasarela-ident.clave.gob.es`: Cl@ve "DNIe / Certificado electrónico", used by any sede on Cl@ve.
- `www1.agenciatributaria.gob.es`: AEAT certificate access (selector → `/wlpl/OVCT-CXEW/…`).
- `www8.agenciatributaria.gob.es` (asks during a TLS 1.3 handshake) and
  `www10.agenciatributaria.gob.es`: AEAT, purpose UNVERIFIED.
- `w2.seg-social.es`: Seguridad Social certificate services, purpose UNVERIFIED.
- `ipce.seg-social.es`: Seguridad Social's own certificate login (`/IPCE/Login` per third-party
  code, UNVERIFIED).
- `idp.seg-social.es`: Seguridad Social login (Importass goes idp → ipce → idp), seen live on
  2026-10-12.
- `ws235.juntadeandalucia.es`: Junta de Andalucía's certificate login (ClicSalud+'s "Certificado
  digital o DNIe" goes to `/authenticationFacade?action=validateCert`), TLS 1.2, seen live on
  2026-10-20. The request is optional: the handshake completes without a certificate.

**No certificate request during the handshake** on: `pasarela.clave.gob.es`, `se-pasarela.clave.gob.es`, `clave-dninbrt.seg-social.gob.es`, `sede.agenciatributaria.gob.es`, AEAT `www2/www3/www6/www9/www11/www12`, `sede.seg-social.gob.es`, `portal.seg-social.gob.es`, `sede-tu.seg-social.gob.es`, `w6/w7.seg-social.es`, `sede.dgt.gob.es`, `sedeapl.dgt.gob.es`, `sedeclave.dgt.gob.es`, `sede.sepe.gob.es`, `citaprevia-sede.sepe.gob.es`, `www1.sedecatastro.gob.es`, `www.sedecatastro.gob.es`, `carpetaciudadana.gob.es`, `rec.redsara.es`, `dehu.redsara.es`, `valide.redsara.es`, `sede.administracion.gob.es`, `sede.administracionespublicas.gob.es`, `sede.mjusticia.gob.es`, `sede.policia.gob.es`, `www.sede.fnmt.gob.es`, `www.cert.fnmt.es`, `sede.madrid.es`, `servpub.madrid.es`, `valid.aoc.cat`, `sede.registradores.org`.

Caveats:
- A handshake probe **cannot see renegotiation-based requests**. TLS-1.2-only hosts such as `www1.sedecatastro.gob.es` or `sede.registradores.org` may ask on specific paths (UNVERIFIED).
- Regional and municipal sedes often use their own gateways (e.g. Catalonia's VÀLid at `valid.aoc.cat`), so the list must grow over time. That is a good fit for the shared "learnings" database.

### 9.2 Runtime detection

There is no single network-level signal, because government servers mostly use *optional* client auth. Combine these:

1. **Known hosts.** When the user has approved certificate use for a procedure, turn it on for
   the known origins.
   - The certificate is only sent to a listed origin that asks for one.
   - Sending it reveals name and DNI, so keep the list tight.
2. **Network errors** on `page.goto` or `context.on('requestfailed')`:
   - `/ERR_BAD_SSL_CLIENT_AUTH_CERT|ERR_SSL_CLIENT_AUTH_/` (strict servers)
   - `ERR_EMPTY_RESPONSE` / `ERR_CONNECTION_CLOSED` right after a certificate step
   - a sidecar error response carrying `X-Sa-Certificate-Error`
3. **App-level error pages** `[live]`:
   - Cl@ve: text `003002 - Authentication Failed (no certificate has been submitted)`
   - AEAT: URL `/Sede/errores/erro4033.html`
   - Keep a regex list per site in the learnings database.
4. **On detection:**
   - (a) ask the user, since the certificate is "ask before use" by default
   - (b) turn the certificate on for that origin (no new context with the sidecar, §1.7)
   - (c) restart from the sede's login button
   - (d) record the origin.

---

## 10. Bot detection, CAPTCHAs and terms of use

**Bot defenses seen** (live checks, 2026-10-03, landing pages only):

| Site | Defense |
|---|---|
| **Extranjería cita previa** `icp.administracionelectronica.gob.es/icpplus/` | F5 BIG-IP ASM (`TS…`, `TSPD_101`, `f5_cspm` cookies, TSPD JS challenge); the page also loads an `eu-captcha` stylesheet (a CAPTCHA component; where it appears in the flow is UNVERIFIED). Headless shell gets **403 "Intrusion Prevention Violation"**; headed and UA-fixed new-headless get 200 (section 5.1). Paths vary by province: `/icpplus/`, `/icpco/`, `/icpplustie*/` (third-party, UNVERIFIED). Bots have historically met reCAPTCHA v3 and an image CAPTCHA here (third-party code, UNVERIFIED). |
| DNI/passport cita (`www.citapreviadnie.es`, `sede.policia.gob.es`) | FortiWeb (`cookiesession1`); no CAPTCHA on the landing or identification pages. Later steps UNVERIFIED. |
| DGT cita (`sedeclave.dgt.gob.es/WEB_CITE_CONSULTA/...`) | Google **reCAPTCHA v3** (action `inicio`) |
| SEPE (`sede.sepe.gob.es`, `citaprevia-sede.sepe.gob.es`) | F5 ASM cookies; the appointment app has its own image CAPTCHA (`simpleCaptcha.png`, with audio) |
| Seguridad Social (`sede.seg-social.gob.es`, `portal.seg-social.gob.es`) | Behind Akamai, with no Bot Manager cookies on the landing page. The SMS login limits resends. |
| Others | `sede.madrid.es`: Akamai 403 to curl. `www.interior.gob.es`: Cloudflare challenge. `administracionelectronica.gob.es`: F5 "Request Rejected" to automated fetches. AEAT and `pasarela.clave.gob.es`: no CAPTCHA or WAF markers. |

Engineering consequences:
- Run headed (or new-headless with the UA fixed) with a realistic `locale: 'es-ES'` and timezone.
- Keep request rates human-like, and never loop on cita pages.
- Hand CAPTCHAs to the user in the live view rather than solving them.
- `navigator.webdriver` is `true` in every mode tested (headless shell, new headless, headed, Chrome channel) `[lab]`, and the binding globals in section 3 are visible.

**Terms of use and legal:**
- **AEAT notice "Uso personal de Cl@ve y prevención de prácticas de intermediación no autorizadas"** (page updated **29/04/2026**, [link](https://sede.agenciatributaria.gob.es/Sede/identificacion-electronica/clave-movil/uso-personal-clave-prevencion-practicas-autorizadas.html), quoted `[live]`):
  - Cl@ve is "de uso personal, directo e intransferible".
  - Improper: "captura o reutilización de credenciales, proxying, automatización de autenticaciones, robotización, scripting o cualquier mecanismo de intermediación técnica".
  - Improper: "reproducir o presentar al ciudadano códigos QR, notificaciones o peticiones de autenticación generadas por sistemas interpuestos".
  - Improper: "almacenar, tratar o reutilizar códigos de un solo uso, contraseñas".
  - "La Agencia Tributaria podrá adoptar las medidas técnicas y organizativas necesarias…".
  - A law-firm note (ECIJA, 30/06/2026) calls it an administrative criterion, not a statutory ban ([pdf](https://files.griddo.ecija.com/ecija-nota-informativa-aeat.pdf)).
- **What this means for SpainAssist** (needs legal review before building "Cl@ve used automatically"):
  - Don't store Cl@ve Permanente passwords or OTPs. Let the user type them into the real page.
  - Don't re-render the Cl@ve Móvil QR in our UI. Show the real browser window, whose URL the user can check.
  - Lean on certificates (stored locally, used with consent), which is how the "Certificado o DNIe" path is meant to work in software.
- **Appointment bots are prosecuted.** Police dismantled Extranjería cita-reselling rings: May 2023 (69 arrests) and Nov 2024 (21 arrests) ([Interior 2023](https://www.interior.gob.es/opencms/es/detalle/articulo/La-Policia-Nacional-desmantela-un-entramado-que-bloqueaba-el-sistema-de-citas-online-de-extranjeria-mediante-un-bot-informatico/), [Interior 2024](https://www.interior.gob.es/opencms/es/detalle/articulo/La-Policia-Nacional-desarticula-un-grupo-criminal-dedicado-a-la-venta-fraudulenta-de-citas-de-extranjeria-mediante-bots/)).
  - Polling cita availability at scale is exactly the pattern that got targeted.
- **The lawful way to act for someone else** is the Registro Electrónico de Apoderamientos (Ley 39/2015 arts. 5–6; [Orden PCM/1384/2021](https://www.boe.es/eli/es/o/2021/12/09/pcm1384)), plus AEAT's own register and "colaboración social". SpainAssist should stay the user's *own* tool acting in the user's own session.

---

## Sources

**Playwright 1.63 source** (`https://github.com/microsoft/playwright/blob/v1.63.0/…`):
- `packages/playwright-core/src/server/socksClientCertificatesInterceptor.ts`
- `.../server/browser.ts`, `.../server/browserType.ts`, `.../server/browserContext.ts`
- `.../server/chromium/crPage.ts`
- `packages/injected/src/ariaSnapshot.ts`, `packages/injected/src/injectedScript.ts`
- `.../server/page.ts`, `.../server/frames.ts`, `.../server/frameSelectors.ts`
- `.../tools/backend/{snapshot,tab,response,utils}.ts`, `.../tools/mcp/index.ts`
- `.../server/electron/{electron,loader}.ts`
- `.../server/registry/{index,browserFetcher}.ts`
- `.../server/screencast.ts`, `.../client/clientHelper.ts`

**Docs:**
- https://playwright.dev/docs/api/class-browser#browser-new-context-option-client-certificates
- https://playwright.dev/docs/aria-snapshots
- https://playwright.dev/docs/api/class-page#page-aria-snapshot
- https://playwright.dev/docs/api/class-screencast
- https://playwright.dev/docs/api/class-electron
- https://playwright.dev/docs/browsers
- https://playwright.dev/docs/api/class-browsercontext#browser-context-add-init-script

**Release notes** (https://github.com/microsoft/playwright/releases):
- v1.59.0: page.ariaSnapshot, `mode`, screencast, setStorageState, Disposable, browser.bind
- v1.60.0: `boxes`; removed `ariaRef` and the `handle` option
- v1.61.0: WebStorage
- v1.62.0: functions as init-script args; bundled MCP
- v1.63.0: ariaSnapshotJSON, dialogclosed, `install --no-remove`

**Issues and PRs** (microsoft/playwright):
- #41106 / PR #41113: no interception for unlisted origins (1.61)
- #42546 / PR #42547: "send no cert" fix, reverted by PR #43074 on 2026-10-02
- #42806 / PR #42873: launch proxy ignored
- PR #42878: renegotiation test
- #41105: HTTP/2 crash
- #33230, #31906, #32004: native certificate popups in headed Chrome
- #32003: PKCS#11 out of scope, so a DNIe key can't be used through Playwright (see `dnie.md`)

**`@playwright/mcp@0.0.83`** (npm tarball: `index.js`, `cli.js`, `config.d.ts`, README tool list): https://github.com/microsoft/playwright-mcp

**Government:**
- Live checks, 2026-10-03: `carpetaciudadana.gob.es` to `pasarela.clave.gob.es` and its identity providers; AEAT selector; `icp.administracionelectronica.gob.es`
- https://clave.gob.es/clave/funcionalidad
- https://clave.gob.es/clave-movil/que-es/aviso-clave-movil
- AEAT Cl@ve Móvil help (obtencion-clave-pin, caducidad-clave-pin)
- https://regtsa.es/comunicado-sobre-el-cierre-del-idp-clve-pin/
- AEAT notice of 29/04/2026 (linked above)
- BOE Orden PCM/1384/2021
- Interior press releases (linked above)
