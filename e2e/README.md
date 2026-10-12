# Electron integration tests

From the repository root, using Node 24:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
corepack pnpm --filter @sa/desktop build
corepack pnpm --filter @sa/desktop exec install-electron
corepack pnpm e2e
```

The suite launches the built Electron app with Playwright. Each test starts the real voucher
and feedback HTTP servers backed by fresh in-memory PGlite databases, a scripted mock model,
and a mock HTTPS government site on random ports. Each app uses a temporary local profile and
a test encryption key provider. Closing a test shuts down its app and services and deletes
the profile. No real credentials, administration sites or paid APIs are used.

Coverage: voucher onboarding and a streamed conversation through the interface; a researched
plan with a native form and opt-in saved data; encrypted credentials and restart persistence;
secret-answer redaction across model requests/transcripts; cancellation of pending prompts;
and the real agent opening the mock government site through the browser bridge.

Package integration tests additionally cover the mock site's certificate login and verified
signature/receipt flows. These tests require Playwright's cached Chromium but never download
it automatically. Use `corepack pnpm --filter @sa/e2e exec playwright install chromium` once
on a new development machine if needed.

In an interactive terminal, `corepack pnpm e2e` opens Playwright's UI mode, where you can step
through each test with DOM snapshots of the Electron window. With `CI` set, without a terminal
(agents, pipes) or with `--no-ui`, it runs the suite headlessly instead. Other arguments go to
`playwright test`. For a headless trace, use `corepack pnpm e2e --no-ui --trace on`, then
`corepack pnpm --filter @sa/e2e exec playwright show-trace <trace.zip>`. The harness hooks the
app's context into Playwright's per-test tracing, because Playwright only traces browser
contexts it creates itself.

Tests run in parallel on half the CPU cores; each has its own app profile and backends.

The app window and Dock icon stay hidden by default (`SA_HIDE_WINDOW=1`), like headless browser
tests. Add `--headed` to watch the real window.
