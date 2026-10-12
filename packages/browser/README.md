# Browser service

Plain Node Playwright service; one lazy Chromium process and an isolated context per procedure.
Headed by default. Headless uses Chromium's full browser and removes Headless from the user agent.
Use the cached Playwright Chromium; this package never installs browsers.

```ts
const browser = createBrowserService({
  downloadsDir: '/temporary/downloads',
  onDownload: async (procedureId, file) => storeDocument(procedureId, file),
});
const observation = await browser.open('procedure-id', 'https://example.test');
await browser.click('procedure-id', 'e12'); // refs from the latest observation
await browser.closeAll();
```

`onDownload` must copy the staged file before returning its document descriptor: the staging
file is deleted afterwards. Inline PDF responses are captured too. Observations include tabs,
downloads, dialogs, page script errors, signatures, AutoFirma and certificate/CAPTCHA hints and budgeted accessibility snapshots.
`saveMedia` optionally persists throttled JPEGs. Actions settle with a bounded network heuristic;
stale refs require a fresh snapshot. Popups become the active page automatically.

Use `type(..., {secret: true})` for secrets. Values and variants are masked in subsequent textual
observations, and marked fields/password inputs are masked in screenshots. Screenshots cannot
guarantee removal of secrets echoed elsewhere by arbitrary page scripts. Screencasts expose the
actual rendered page and must stay within the trusted local UI. `expect` rechecks input type and
frame origin immediately before typing, for credential safety.

Client certificates go through the TLS sidecar (`certificates`, `@sa/sidecar`). Every context
uses its own sidecar port; one browser-level DevTools handler answers the sidecar's password
(Playwright's proxy credentials would intercept every request and break inline PDFs).
`useClientCertificate` presents a `.p12` key or a remote key (the DNIe in the phone) to exact
origins only, without recreating the context; Chromium trusts the sidecar's per-launch key for
those origins and keeps checking every other site's certificate. Without the sidecar, contexts
connect directly and certificate logins fail clearly. `ignoreHTTPSErrors` is for local test
sedes only.

`afirma` injects a shim into every frame and binds calls to a trusted handler; origin and URL come
from the invoking frame rather than page arguments. `exportState`/`importState` serialize browser
storage; the caller must encrypt it. Browser disconnects relaunch on the next operation.

Optional additions to the original stub: viewport/launch arguments, local TLS test support,
timeout and media controls, typing expectations, and active-tab-following `startScreencast`.
No RPC transport is implemented. See `src/types.ts` for the complete API.

Run `corepack pnpm --filter @sa/browser typecheck` and `corepack pnpm --filter @sa/browser test`
with Node 24 and Go. Tests use local fixture HTTP(S) servers, cached Chromium and the sidecar,
built once per run, through which every test browser connects (like the app).

### Native window visibility test

The normal suite is headless. Run the window minimize/restore integration test separately on
an interactive desktop, because concurrent Chromium launches can change native macOS focus:

```sh
SA_TEST_BROWSER_WINDOWS=1 corepack pnpm --filter @sa/browser exec vitest run test/visibility.test.ts
```

The test uses only a local mock page and the cached Chromium. It checks that automation and
popups stay minimized and that helping the agent preserves the live page and filled fields.
