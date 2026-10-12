# SpainAssist

A local desktop assistant for researching and completing Spanish government procedures.
Each procedure has its own conversation and plan. Personal data and credentials live in an
encrypted vault. Information needed for inference can go directly to the selected provider,
including document images for model vision; passwords and signing keys stay outside the model. The interface supports
Spanish and English.

The MVP uses Electron, React and TypeScript, with pi agents, Playwright browser automation,
model vision document scanning and an integrated AutoFirma replacement. The stack decisions are
in [docs/DECISIONS.md](docs/DECISIONS.md); the product brief is [SPEC.md](SPEC.md).

## Run locally

Use Node 24 and Corepack ≥ 0.36 (`npm i -g corepack@0.36.0`; the Corepack bundled with Node 24
can't run pnpm 12). Always invoke pnpm through Corepack; an older global pnpm can damage the
workspace lockfile.

```sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install
corepack pnpm dev          # the app, against the production backends
```

`dev` uses the production key server and feedback server (`PRODUCTION_SERVICES` in
`@sa/shared`): real vouchers, LiteLLM keys and research. For the offline demo with local
services and mocks instead, start them and use `dev:local`:

```sh
corepack pnpm services -- --mocks
corepack pnpm dev:local    # in another terminal
```

`dev:local` also turns on every feature flag (`SA_FEATURE_FLAGS`) instead of asking Unleash,
including `dnie-phone` for the DNIe with the phone; `dev` follows Unleash's production flags.

On macOS, `dev` and `preview` launch Electron through Launch Services. This lets camera
permission belong to Electron even when a terminal such as Otty lacks the camera entitlement.
Development runs without file watching, hot reload or automatic Electron restarts. To pick up
changes, stop the command with Ctrl+C and run `corepack pnpm dev` again. The standalone
`preview:web` command also requires a manual restart. Terminal logs still work.


To repeat onboarding, close the dev app and stop its dev command, then run:

```sh
corepack pnpm reset:dev
corepack pnpm dev
```

This deletes the dev profile's personal data, documents, conversations, procedures, browser
storage, logs and settings. If a valid Codex session is saved, it keeps only that session,
with Codex still connected (default model) and onboarding reset. Otherwise (voucher, API key or
no provider) it resets everything, provider included. It refuses to run while the app is
running. `SA_USER_DATA_DIR` selects a custom dev profile; the default is the
app's usual `SpainAssistant` profile. Global Codex and pi configuration are untouched.

To repeat only onboarding and keep everything else (data, procedures, settings, Codex), run
`corepack pnpm reset:dev:onboarding` instead. It also refuses to run while the app is open.

The desktop scripts build the agent host and install the Electron binary. Browser automation
uses Playwright's Chromium. If it is absent on a new machine:

```sh
corepack pnpm --filter @sa/e2e exec playwright install chromium
```

For an offline demonstration (`dev:local`), choose **Tengo un código** during onboarding and enter
`SA-DEMO42`, then ask **Quiero renovar el DNI**. The scripted model simulates research,
creates a plan and asks for your province and document expiry. Its responses are demo fixtures. With no provider keys configured, the local key server issues mock credentials.
Embedded Postgres (PGlite) needs no Docker. For real web search in the agent, put an Exa API key
in `apps/desktop/.env` (copy `apps/desktop/.env.example`); without it real procedure agents report
a research blocker.

| Service | Local URL |
| --- | --- |
| Voucher server (LiteLLM keys; mock keys locally) | http://127.0.0.1:8787 |
| Anonymous feedback | http://127.0.0.1:8788 |
| Scripted model | http://127.0.0.1:8789/v1 |
| Mock government site | https://localhost:8790 |
| Mock certificate login | https://localhost:8791 |

The mock site has a self-signed development certificate. Its fake Cl@ve login is
`99999999R` / `clave-demo-1234`; its SMS code is available through its test API. See
[the mock site README](apps/mock-sede/README.md) for the synthetic certificate and signing
demo. Automated tests trust this certificate only inside isolated test profiles.

## Checks

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm lint
corepack pnpm build
corepack pnpm e2e
```

Build before running e2e. The [Electron tests](e2e/README.md) start real local backend services
with in-memory databases, a scripted model and the mock government site. They use temporary
app profiles, fake credentials and no paid providers or real administration websites.

## Project layout

| Directory | Purpose |
| --- | --- |
| `apps/desktop` | Electron main process, isolated preload bridge and React interface |
| `packages/agent` | Agent host, tools, provider adapters and Exa research |
| `packages/browser` | Browser contexts, element references, certificate login and downloads |
| `packages/signer` | AutoScript shim and CAdES, XAdES, PAdES and triphase signing |
| `packages/vault` | Encrypted data, documents and credentials with OS-backed key wrapping |
| `packages/pii` | Spanish personal data detection and feedback scrubbing |
| `packages/shared` | Validated contracts between app, agent and services |
| `services` | Voucher (LiteLLM keys) and anonymous feedback backends |
| `apps/mock-sede`, `tools/mock-llm`, `e2e` | Local simulation and integration tests |
| `infra` | Docker Compose and infrastructure definitions |

See [architecture](docs/ARCHITECTURE.md) and each package's
README for APIs and configuration. Backend production configuration is documented in
[infra/README.md](infra/README.md). No infrastructure is deployed by local setup.

## MVP limits

The vault is encrypted at rest; procedure transcripts, screenshots and pi session files
currently remain private local files without encryption. Linux key protection depends on
the available keyring and the interface reports its storage security level. Signing supports
the documented MVP formats; it does not replace every AutoFirma operation or smart-card DNIe.
Real government integrations and real ChatGPT OAuth have not been validated by offline tests.
The existing research records unresolved Cl@ve automation and ChatGPT distribution concerns.

`corepack pnpm --filter @sa/desktop package` builds installers for the machine's OS and CPU
(D17); Chromium downloads on first use. Releases still need code signing and macOS
notarization, the hardened agent-process transport, and tests of each installer on its OS
(`PRODUCTION_CHECKLIST.md`).

Service endpoints are configured with `SA_KEY_SERVER_URL` and `SA_FEEDBACK_SERVER_URL`,
not in the app settings. Development defaults to local ports 8787 and 8788. For releases,
set deployed URLs in `apps/desktop/.env.production` or the build environment. Runtime
environment variables override build defaults. Packaged builds with no endpoints configured
report those services as unavailable without contacting localhost. Saved service URLs from
older versions are ignored.

## Licence

MIT ([LICENSE](LICENSE)): the desktop app, the packages, the services, the tools and the phone
app's own code. The Android build of the phone app is EUPL-1.2 as a whole, because it bundles
jmulticard ([apps/mobile/NOTICE](apps/mobile/NOTICE), DECISIONS D16). The desktop's
third-party notices are generated at build time (`apps/desktop/scripts/notices.ts`). Not
covered: the files encrypted with git-crypt (private), the Instrument Serif fonts (OFL-1.1,
`OFL.txt` next to them), `packages/signer/test/fixtures/autoscript.min.js` (clienteafirma,
GPL-2.0 / EUPL-1.1, a test fixture that is never shipped) and the Gradle wrapper (Apache-2.0).
