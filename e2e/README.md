# End-to-end tests

From the repository root, using Node 24:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
corepack pnpm --filter @sa/desktop build
corepack pnpm --filter @sa/desktop exec install-electron
corepack pnpm e2e
```

`corepack pnpm e2e` builds sa-sidecar first (it needs Go; without it, certificate logins are off).

## What runs

- **Electron tests** (`tests/desktop.spec.ts`) launch the built app with Playwright. Each test
  starts the real key and feedback servers on fresh in-memory PGlite databases, a scripted mock
  model and a mock HTTPS government site, all on random ports. Each app gets a temporary
  profile and a test encryption key provider; closing the test shuts everything down and
  deletes the profile. They cover voucher onboarding and a streamed answer; delegation to a
  procedure, its question on the card, its report and a restart; secret answers kept out of
  model requests and transcripts, and stopping a procedure; and a procedure agent opening the
  mock government site through the browser bridge.
- **Web preview tests** (`map-options.spec.ts`, `shell-scroll.spec.ts`) run the renderer's web
  build with its mock API (`build:web`, served on port 5186): map selection with mouse and
  keyboard, typed addresses, and settings navigation and scrolling.

No real credentials, government sites or paid APIs are used. Tests run in parallel on half the
CPU cores. They need Playwright's cached Chromium and never download it; on a new machine run
`corepack pnpm --filter @sa/e2e exec playwright install chromium` once.

The mock sede's certificate login and signature flows are tested in `apps/mock-sede`,
`packages/browser` and `packages/signer` instead.

## Debugging

In an interactive terminal, `corepack pnpm e2e` opens Playwright's UI mode, where you can step
through each test with DOM snapshots of the Electron window. With `CI` set, without a terminal
(agents, pipes) or with `--no-ui`, it runs headlessly. Other arguments go to `playwright test`.
For a headless trace, use `corepack pnpm e2e --no-ui --trace on`, then
`corepack pnpm --filter @sa/e2e exec playwright show-trace <trace.zip>`. The harness hooks the
app's context into Playwright's per-test tracing, because Playwright only traces browser
contexts it creates itself.

The app window and Dock icon stay hidden by default (`SA_HIDE_WINDOW=1`). Add `--headed` to
watch the real window.
