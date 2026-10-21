# Spain _Assist_

<p align="center"><img width="600" alt="Stack" src="https://github.com/user-attachments/assets/885a3957-5dec-4e2a-bf37-e27312d01f7f" /></p>

Spain _Assist_ is a local AI agent that deals with any bureaucracy with the Spanish public administrations.

It knows how to use Cl@ve, the DNI electrónico and the FNMT's _Certificado Digital_. It remembers the data you give it, stores it securely, and reuses it for future procedures.

## Download

Get the latest version from [spainassist.es](https://spainassist.es) or the
[latest release](https://github.com/MeLlamoPablo/SpainAssist/releases/latest): macOS (Apple
silicon and Intel), Windows x64 and Linux x64 (`.deb`). On Windows and Linux the app updates
itself.

What changed in each version: [CHANGELOG.md](CHANGELOG.md).

## AI provider

Pick one in the app:

* **A Spain Assist code**, with credit included.
* **ChatGPT** Go or higher.
* **Your own API key** (Anthropic, OpenAI, OpenRouter…) or **any OpenAI-compatible endpoint**.
  Web research uses Exa's free tier, no key needed; an Exa key of your own raises the limits.

## Run locally

Dev build, production backend:

```sh
corepack pnpm install
corepack pnpm dev
```

Dev build, local backends (no Docker, no accounts):

```sh
corepack pnpm services -- --mocks
corepack pnpm dev:local
```

What each one starts and the other ways to run the backends: [infra/README.md](infra/README.md).

## Project layout

| Directory | Purpose |
| --- | --- |
| `apps/desktop` | Electron main process, isolated preload bridge and React interface |
| `apps/mobile` | Phone app for DNIe signatures and certificate logins |
| `packages/agent` | Agent host, tools, provider adapters and web research |
| `packages/browser` | Browser contexts, element references, certificate login and downloads |
| `packages/sidecar` | Go TLS helper for certificate and DNIe logins |
| `packages/signer` | AutoScript shim and CAdES, XAdES, PAdES and triphase signing |
| `packages/companion` | Encrypted desktop ↔ phone channel for DNIe signatures |
| `packages/vault` | Encrypted data, documents and credentials with OS-backed key wrapping |
| `packages/pii` | Spanish personal data detection and feedback scrubbing |
| `packages/gateway-keys` | Users' LiteLLM keys as auth for our services |
| `packages/shared` | Validated contracts between app, agent and services |
| `services` | Voucher (LiteLLM keys), anonymous feedback, maps and phone relay backends |
| `apps/mock-sede`, `tools/mock-llm`, `e2e` | Local simulation and integration tests |
| `tools/eval` | SpainBench eval suite ([docs/EVAL.md](docs/EVAL.md)) |
| `infra` | Docker Compose for a local stack, Terraform for production |

See [architecture](docs/ARCHITECTURE.md) and each package's README for APIs and configuration.
Backends and production are in [infra/README.md](infra/README.md). Local setup deploys nothing.

## Licence

* Default: [MIT](LICENSE).
* Android build of the phone app: EUPL-1.2, see [apps/mobile/NOTICE](apps/mobile/NOTICE).
