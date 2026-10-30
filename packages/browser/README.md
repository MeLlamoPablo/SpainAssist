# @sa/browser

Plain Node Playwright service: one lazy Chromium process and an isolated context per procedure.
Headed unless `headless` is set; headless uses Chromium's full browser and removes Headless from
the user agent. Pass the bundled or cached Chromium; this package never installs browsers.

```ts
const browser = createBrowserService({
  downloadsDir: '/temporary/downloads',
  onDownload: async (procedureId, file) => storeDocument(procedureId, file),
});
const observation = await browser.open('procedure-id', 'https://example.test');
await browser.click('procedure-id', 'e12'); // refs from the latest observation
await browser.closeAll();
```

See `src/types.ts` for the complete API and options.

## Observations and actions

- Observations include tabs, downloads, dialogs, page script errors, signatures, AutoFirma and
  certificate/CAPTCHA hints, and budgeted accessibility snapshots.
- Actions settle with a bounded network heuristic; stale refs require a fresh snapshot. Popups
  become the active page automatically.
- `onDownload` must copy the staged file before returning its document descriptor: the staging
  file is deleted afterwards. Inline PDF responses are captured too.
- `saveMedia` optionally persists throttled JPEGs; `startScreencast` follows the active tab.
- `exportState`/`importState` serialize browser storage; the caller must encrypt it. A browser
  that disconnects is relaunched on the next operation, unless two in a row closed by
  themselves within 10 s of launch, before any page loaded: the service then stops relaunching
  (code `unavailable`, an error that tells the agent not to retry) until `closeAll`. Each
  disconnection is logged with how long after launch it came.

## Secrets

Use `type(..., {secret: true})` for secrets. Values and variants are masked in later textual
observations, and marked fields and password inputs are masked in screenshots. Screenshots
cannot guarantee removal of secrets echoed elsewhere by arbitrary page scripts. Screencasts show
the real rendered page and must stay within the trusted local UI. `expect` rechecks input type
and frame origin right before typing, for credential safety.

## Client certificates and AutoFirma

Client certificates go through the TLS sidecar (`certificates`, `@sa/sidecar`). Every context
uses its own sidecar port; one browser-level DevTools handler answers the sidecar's password
(Playwright's proxy credentials would intercept every request and break inline PDFs).
`useClientCertificate` presents a `.p12` key or a remote key (the DNIe in the phone) to exact
origins only, without recreating the context; Chromium trusts the sidecar's per-launch key for
those origins and keeps checking every other site's certificate. Without the sidecar, contexts
connect directly and certificate logins fail clearly. `ignoreHTTPSErrors` is for local test
sedes only.

`afirma` injects the `@sa/signer` shim into every frame and binds calls to a trusted handler;
origin and URL come from the invoking frame rather than page arguments.

## Revoked certificates

Chrome blocks revoked certificates and compromised CA keys with a CRLSet, which its component
updater downloads in the background. Playwright turns the updater off, so its Chromium has no
CRLSet and trusts whatever its root store does: in October 2026 it accepted sites signed with
eMudhra's leaked intermediate keys, which Chrome had blocked within hours.

With `crlSet`, each launch copies the app's CRLSet (`dir`, unpacked from the component) into a
new temporary profile and launches Chromium persistently on it, because `launch` can't take a
profile. Chromium loads a seeded CRLSet only while its component updater runs, so the updater
is on, pointed at port 9, which Chromium never connects to: nothing is downloaded and nothing
is sent. Chromium enforces the CRLSet in its after-startup tasks, about 2 s after launch on a
Mac (it's listed in `chrome://components` sooner), so the launch waits 5 s before the first
page. Those tasks need a window, and the persistent launch opens a blank one: Playwright passes
`about:blank` (with `--no-startup-window`, a headed persistent launch waits for a first page
until it times out). That window stays open for the browser's whole life, minimized after the
wait with `startHidden` (macOS ignores `--start-minimized` for it). Closed at once, the CRLSet
is never enforced; closed after the wait, as v0.3.2 did, the browser quit on Windows and Linux,
where a browser started without `--no-startup-window` quits with its last window (macOS keeps
it running): no session had a window yet, so every tool call launched a browser that died. The
window belongs to the persistent context, which no session uses: sessions get their own
contexts of that browser, so tabs, snapshots and captures never see it. The profile is deleted
when the browser goes away, and again by `closeAll` once its process has exited: headed
Chromium still writes to it after `disconnected`. An expired CRLSet still blocks the keys it
lists.

`test/crlset.test.ts` checks the window outlives every session's, also headed where Chromium
would quit without it: on Windows, and on Linux with a display (CI runs the unit tests under
`xvfb-run`). `SA_TEST_BROWSER_WINDOWS=1` runs the headed case on macOS too, where it can't fail
that way.

A local server can't show the CRLSet being enforced (an untrusted test certificate fails
first, and a trusted one skips revocation), so the desktop app has a live test against a site
signed with eMudhra's leaked key (`apps/desktop/src/main/crlset/live.test.ts`,
`SA_TEST_LIVE_CRLSET=1`).

## Tests

`corepack pnpm --filter @sa/browser typecheck` and `corepack pnpm --filter @sa/browser test`,
with Node 24 and Go. Tests use local fixture HTTP(S) servers, the cached Chromium and the
sidecar (built once per run), through which every test browser connects, like the app.

### Headed, as the app runs it

The suite is headless by default. `SA_TEST_HEADED=1` runs every test browser headed with its
windows minimized (`startHidden`), as the app does, which is where Windows and Linux differ from
macOS and from headless: there Chromium quits with its last window, and the window sets the
viewport. CI runs the suite headed on Linux (under `xvfb-run`) and on Windows (`ci.yml`). Run it
after changing how the browser launches or handles its windows:

```sh
SA_TEST_HEADED=1 corepack pnpm --filter @sa/browser test
```

On macOS this puts minimized Chrome for Testing windows in the Dock while it runs.

### Native window visibility test

The normal suite skips it. Run the window minimize/restore integration test separately on an
interactive desktop, because concurrent Chromium launches can change native macOS focus (CI
runs it on Windows, with the headed suite):

```sh
SA_TEST_BROWSER_WINDOWS=1 corepack pnpm --filter @sa/browser exec vitest run test/visibility.test.ts
```

The test uses only a local mock page and the cached Chromium. It checks that automation and
popups stay minimized and that helping the agent preserves the live page and filled fields.

## Browser capture (development only)

`capture: { dir, scratchDir }` records every context for offline mock sites (`capture.ts`):
a HAR with bodies, a trace (screenshots, DOM snapshots), the HTML of every page and frame after
each action, and `actions.jsonl` (each action with the agent's tool call, set by the caller with
`withCaptureTool`, and the ref's role and accessible name). Everything is written to `scratchDir`
while the context is open; when it closes (`close`, `closeAll`, `finishCapture`, a browser
crash), each file is scrubbed and written to `dir(procedureId)/<start time>/`, and the scratch
copy is deleted. A new service deletes scratch files left by a crash.

Scrubbed: values typed with `secret: true` (as `«secret:<n>»`, raw and URL/form/JSON/HTML
encoded, in HAR URLs, headers, cookies and bodies, HTML, `actions.jsonl` and trace entries) and
the sidecar's proxy password. Not scrubbed: personal data, values typed without `secret`, session
tokens, secrets a page hashes or encrypts. Use it only with synthetic or throwaway accounts; the
app enables it only in development (`SA_BROWSER_CAPTURE=1`, docs/ARCHITECTURE.md).

`capture.scrub: false` keeps the typed values too (only the sidecar's proxy password is still
redacted; `capture.json` says so). It is for runs with made-up accounts, like the eval suite's.
A captured context is closed page by page first, with a timeout: `context.close()` alone never
finishes for a context that records a HAR and ever showed a PDF in Chromium's viewer.
