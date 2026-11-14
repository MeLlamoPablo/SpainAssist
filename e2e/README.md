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

Three Playwright projects; `--project <name>` runs one.

- **Electron tests** (`electron`, `tests/desktop.spec.ts`, and on macOS
  `tests/os-certificates.spec.ts`: external certificates, against a throwaway keychain file) launch the built app with Playwright. Each test
  starts the real key and feedback servers on fresh in-memory PGlite databases, a scripted mock
  model and a mock HTTPS government site, all on random ports. Each app gets a temporary
  profile and a test encryption key provider; closing the test shuts everything down and
  deletes the profile. They cover the codemode harness (`docs/codemode.md`): voucher onboarding
  and the coordinator's streamed answer; the coordinator delegating to an agent (the mock
  model's built-in `demo`), whose workflow creates a card and asks in "Para ti", the question
  coming back after a restart and resuming the workflow when answered, and the agent's report
  relayed in the chat; a code typed by the app (`page.fillFromUser`) kept out of model requests
  and every saved file, and stopping an agent cancelling its approval; and an agent's workflow
  opening the mock government site through the browser bridge.
- **Web preview tests** (`web`, `map-options.spec.ts`, `shell-scroll.spec.ts`) run the renderer's
  web build with its mock API (`build:web`, served on port 5186): map selection with mouse and
  keyboard, typed addresses, and settings navigation and scrolling.
- **Parity tests** (`parity`, `tests/parity.spec.ts`) run the agent's browser as users get it:
  headed with its windows minimized, and with a CRLSet (the app's bundled fixture,
  `SA_CRLSET_FIXTURE`), where the Electron tests run it headless without one. An agent's workflow
  opens the mock site and closes its browser; its next workflow, a few seconds later, opens it
  again in two tabs: the app's log must
  show one launch and no disconnection. They also run the built app's `--self-test`
  (`apps/desktop/src/main/app/self-test.ts`). On Windows and Linux headed Chromium quits with its
  last window, which only these runs show (v0.3.2's browser died after every launch on Windows):
  CI runs this project on Linux under `xvfb-run` and on Windows. Locally it puts minimized Chrome
  for Testing windows in the Dock while it runs.

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
