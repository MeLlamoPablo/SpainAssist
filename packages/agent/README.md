# @sa/agent

Everything pi-specific in SpainAssist: the **agent host** (one process per active agent:
the assistant behind the chat, or one procedure's agent), the **tools** the model can call, the **system prompt**, the **RPC client** the desktop app uses
to drive a host, and **provider helpers** (Sign in with ChatGPT, vouchers, BYOK, credit).

Background: [`docs/research/pi.md`](../../docs/research/pi.md) (pi 1.0 facts),
[`docs/research/providers-and-research.md`](../../docs/research/providers-and-research.md),
contracts in [`@sa/shared`](../shared/src) (`bridge.ts`, `procedure.ts`, `chat.ts`).

## Architecture

```
desktop main ──spawn (buildAgentLaunch)──► dist/host.js   (Electron as Node, one per agent)
     ▲   │                                     │  pi SDK: ModelRuntime + AgentSession + runRpcMode
     │   └── PiRpcClient ◄── stdio JSONL ─────►│  inline extension: 26 tools + exact system prompt
     │                                         │
     └──── host bridge (HTTP, bearer token) ◄──┘  procedure agents: procedure/prompts/vault/
                                                  browser/search/feedback; the assistant:
                                                  procedures.*, ask_user, vault (role in config);
                                                  credentials (agent.credential)
                                               ──► LLM provider (direct)
                                               ──► fetch_url, run_script fetch, BOE open-data API (direct)
```

- `src/host/` — the host. Reads `SA_AGENT_CONFIG` (JSON, non-secret), `SA_BRIDGE_URL`,
  `SA_BRIDGE_TOKEN` (removed from its env after reading). Forces `PI_OFFLINE=1`,
  `PI_TELEMETRY=0`, a private `PI_CODING_AGENT_DIR` and `umask 077`. Builds a `ModelRuntime` with
  `modelsPath: null`, no network catalog refresh and a `BridgeCredentialStore` (credentials come
  from the app on every read, cached ≤ 5 s; OAuth refresh is delegated to the app). In-memory
  settings (retries, compaction, image resize, no telemetry), `SessionManager.open(sessionFile)`
  (file 0600, directory 0700), a resource loader with no extensions/skills/prompts/themes/context
  files, and an inline extension that registers the tools, returns the exact system prompt from
  `before_agent_start` (no `<cwd>` leak), blocks pi's `bash` RPC command and any unknown tool.
  Then `runRpcMode`.
- Roles (`config.role`, D9): `assistant` gets `createAssistantTools()` (delegation, `ask_user`,
  vault) and `buildAssistantPrompt()`; `procedure` gets `createTools()` (everything else, plus
  `web_research` for voucher users and ChatGPT plans, or `exa_search`/`exa_fetch` for BYOK and
  custom endpoints, see `host/research.ts`) and `buildSystemPrompt()`, whose final message per run is a short
  report for the assistant.
- `src/tools/` — tool definitions (TypeBox schemas, English model-facing text). Bridge-backed
  tools pass the tool's `AbortSignal` to the HTTP request, so aborting a run cancels a pending
  form/confirmation in the app (no abort deadlock).
- `src/research/` — `fetch_url` core (Readability + linkedom → Turndown/GFM, unpdf, charset
  handling, SSRF guard), BOE client, web research (key server, ChatGPT, Exa).
- `src/rpc/` — `PiRpcClient`, JSONL framing, event normalization, pluggable transport.
- `src/providers/` — ChatGPT OAuth, refresh, model lists/defaults, BYOK catalogue, key server,
  LiteLLM gateway credit and models (vouchers).
- `src/index.ts` — what the desktop main process imports (light: no HTML/PDF libraries).
- `src/host/hooks.ts`, `src/host/runtime.ts` — `HostHooks` and the `@sa/agent/host-runtime`
  subpath for harnesses (see "Eval hooks"); the shipped host does not use them.

## Tools

| Tool | Backed by | Notes |
| --- | --- | --- |
| `procedure_update` | `procedure.update` | Arrays replace the previous list (send complete lists); `clearNextAction` → `nextAction: null`. `nextAction.appointment` (address + local `startsAt`) gets Maps/Calendar buttons on the card. Result includes `Status: <status>` |
| `ask_user` | `prompt.form` | Structured fields, `vaultKey` answers are always saved to my data; `secret` fields are not exposed to the model |
| `confirm_action` | `prompt.confirm` | `confirmKind`: action / submission / payment |
| `request_user_action` | `prompt.userAction` | captcha, qr_scan, phone_approval, manual_step, offline |
| `vault_read`, `vault_save` | `vault.read`, `vault.save` | Values of personal data; credential summaries only |
| `download_save` | `downloads.save` | Moves a temporary browser download into the vault under a readable name (extension kept) |
| `browser_open`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select`, `browser_check`, `browser_press`, `browser_wait`, `browser_back`, `browser_upload` | `browser.*` | Result = compact observation text (URL, tabs, downloads, signatures, dialogs, page script errors, notes, then the snapshot). `details.imageId` carries the UI screenshot id |
| `browser_fill_from_vault` | `browser.fillFromVault` | `source` personal (`key`) or credential (`credentialId`, `field`) |
| `browser_fill_from_user` | `browser.fillFromUser` | One-time codes typed by the app; the model never sees them |
| `browser_tabs`, `browser_screenshot`, `browser_use_certificate`, `browser_close` | `browser.*` | Screenshot returns an image block (refused when the model has no vision) |
| `web_research` | Vouchers: key server `POST /v1/research`, paid from the voucher (D13); `mode` picks the Parallel processor: `fast` → `lite` ($0.005), `balanced` → `core` ($0.025), `deep` → `pro` ($0.10). ChatGPT plans (`openai`/`openai-codex` with OAuth): one Responses request with OpenAI's hosted `web_search` on the plan (D21); `mode` picks model and effort: `fast` → `gpt-6-luna`, `balanced` → `gpt-6.1-sol`, `deep` → `gpt-6-astra`, all at high effort | One request stays open until completion; progress goes to the app, no model polling turns. Abort closes it; failures never start a replacement run. |
| `exa_search`, `exa_fetch` | local (Exa REST API, `api.exa.ai`), with the user's own key from `agent.exaKey` | BYOK and custom endpoints only, instead of `web_research` (D23). `exa_search`: `POST /search`, `userLocation: "ES"`, `sources` `official` (default, `includeDomains` of Spanish administrations) or `any`, ≤ 10 results with 1,500 characters each. `exa_fetch`: `POST /contents`, ≤ 5 URLs, 12,000 (≤ 30,000) characters each, `fresh` asks for a new copy. No key, a rejected key or no credit: a research-blocker result that names where the user adds the key |
| `feedback_search`, `feedback_submit`, `feedback_vote` | `feedback.*` | Submit text must be PII-free (the app scrubs again); votes rate a search result by id |
| `fetch_url` | local | 20 s timeout, 6 MB (HTML) / 25 MB (PDF) cap, ≤ 5 redirects (each re-checked), private hosts blocked, `offset`/`maxChars` paging, `mode: full`, 10-minute cache |
| `boe_search` | local (BOE open data) | `legislacion-consolidada` search, in-force by default |
| `run_script` | local (QuickJS in WebAssembly) | Model-written JavaScript, fresh engine per call, 30 s (≤ 120 s) and 64 MB caps, no Node APIs; `fetch` to public URLs (any method/headers/body, text or binary; no localhost or private networks, each redirect re-checked like `fetch_url`; responses ≤ 10 MB, ≤ 50 requests), plus URL, URLSearchParams, TextEncoder/TextDecoder and atob/btoa (`src/tools/run-script-prelude.ts`); returns logs + JSON result (≤ 30k chars) |

Browser, prompt, plan and vault-write tools run sequentially (`executionMode`); research tools
may run in parallel.

## Using it from the desktop main process

```ts
import { buildAgentLaunch, PiRpcClient, type AgentEvent } from '@sa/agent';

const client = new PiRpcClient(
  buildAgentLaunch({
    nodeBinary: process.execPath,          // Electron
    electronRunAsNode: true,
    cwd: procedureWorkDir,                 // empty, app-owned directory
    hostPath: resourcesHostJs,             // dist/host.js shipped with the app (see Packaging)
    config: {
      procedureId: p.id,
      sessionFile: join(appData, 'sessions', `${p.id}.jsonl`),
      language: settings.language,
      model: { provider: 'litellm', id: 'moonshotai/kimi-k2.6', baseUrl: voucherBaseUrl, maxTokens: 8192 },
    },
    bridge: { url: bridgeUrl, token: perProcedureToken },
  }),
);
client.on((event: AgentEvent) => mapToChatItems(event));
await client.start();                      // resolves when the session is loaded
await client.prompt('Quiero renovar el DNI'); // rejects on preflight errors (e.g. no credential)
await client.abort();                      // clear_queue + abort; pending prompt.* requests close
await client.stop();                       // stdin close → SIGTERM → SIGKILL
```

- **Events.** `run_start` / `run_end {error?, errorKind?, aborted?}` wrap one run (pi retries
  stay inside it). `assistant_start|delta|end` stream a message (`retrying: true` marks a failed
  attempt pi retries: drop it). `tool_start` / `tool_end {summary, details}` map to activity rows.
  `usage {inputTokens, outputTokens, costUsd}` per model response. `log` (host stderr, pi
  notices) and `process_exit {code, signal, stderrTail}`. `errorKind`: auth, quota (402,
  LiteLLM "budget has been exceeded", ChatGPT usage limit), rate_limit, context, network, provider, crash, unknown.
- **Prompts while running.** `prompt()` steers by default when a run is active. If the agent is
  blocked on a `prompt.*` request, the steering message waits until the user answers that
  prompt or the run is aborted (the app cancels the assistant's own questions when the user
  types in the chat).
- **Abort.** The bridge connection of a pending `prompt.*` / `browser.*` request is closed: mark
  the PromptItem cancelled.
- **Bridge timeouts (host side).** None for `prompt.*`, `browser.fillFromVault`,
  `browser.fillFromUser` and `browser.useCertificate` (they may wait for the user); 3 min for
  other `browser.*` calls (so a click must not block on a signature approval); 60 s for
  research/feedback; 30 s otherwise. Requests use plain `node:http` (no undici 300 s limits).
- **Credentials.** `agent.credential {providerId}` → `{credential}` in pi-ai shape or `null`.
  `agent.refreshCredential` → return the stored credential if it is still valid for > 5 min,
  otherwise refresh it with `refreshOAuthCredential` (serialized across processes: refresh tokens
  rotate), persist it, return it; `null` when the user must sign in again. Changing provider or
  model = restart the host (rotating a key is live).
- **Other RPC.** `getState()`, `getSessionStats()` (tokens, cost), `getMessages()`,
  `setThinkingLevel()`, `compact()`, `send(command)` (the `bash` commands are always refused).
- **Transport.** `new PiRpcClient(launch, { transport })` accepts another `RpcTransportFactory`,
  e.g. an Electron `utilityProcess.fork` transport for hardened builds where the `runAsNode` fuse
  is off (the host would then need a parentPort ↔ stdio adapter).

### Host config (`AgentHostConfig`, JSON in `SA_AGENT_CONFIG`)

| Field | Meaning |
| --- | --- |
| `procedureId`, `sessionFile`, `language` | Session file is created if missing and resumed otherwise |
| `model.provider`, `model.id` | `openai` (ChatGPT OAuth), `litellm` (vouchers), any pi provider (BYOK), or `custom` |
| `model.baseUrl` | Required for `custom` and `litellm`; for built-in providers overrides the endpoint (dev/e2e: → mock LLM). Unknown ids are cloned from a sibling catalog model |
| `model.api`, `supportsImages`, `contextWindow`, `reasoning` | `custom` only (`openai-completions` uses `max_tokens`, `system` role, no `store`) |
| `model.maxTokens` | Output cap (capped voucher keys) |
| `model.thinkingLevel` | Default `medium`, clamped to the model |
| `research.keyServerUrl` | Our key server: vouchers' `web_research` |
| `research.exa` | BYOK and custom endpoints: `exa_search`/`exa_fetch` with the user's Exa key, no `web_research` (D23) |
| `research.boeBaseUrl`, `research.exaBaseUrl`, `research.allowPrivateHosts` | Tests / e2e (mock sede on localhost) |
| `extraTrustedHosts` | Dev/e2e hosts allowed for credentials |
| `timeZone` | For "today" in the prompt; default `Europe/Madrid` |

`buildAgentLaunch` passes only an allow-list of the parent environment (PATH, HOME, temp dirs,
locale, proxies, CA bundles) plus `PI_*`, `SA_*` and `ELECTRON_RUN_AS_NODE` when requested: no
API keys, no `NODE_OPTIONS`.

### Eval hooks (`HostHooks`)

`runHost(env, hooks)` takes optional `HostHooks` (`src/host/hooks.ts`) for code that runs the host
outside the app: the eval suite (`tools/eval`, `docs/EVAL.md`) and tests. All are optional, and a
call without them is the product host.

| Hook | What it does |
| --- | --- |
| `egress.fetch` | All outbound HTTP of `fetch_url`, `run_script` and `boe_search` (`ToolDeps.fetchImpl`), with the real URL the agent asked for |
| `egress.resolveHost` | DNS stand-in for the SSRF guard (`ToolDeps.resolveHost`, `HostResolver` in `research/fetch.ts`). The guard still blocks IP literals, `localhost` and private answers with the production messages; every other name resolves through it, so nothing touches real DNS before `egress.fetch` is called |
| `research` | Replaces the web research backend (`researchBackend()`: which prompt text and tool shape the agent gets) and its tools. Procedure agents only: the assistant never researches |
| `wrapTool` | Wraps every tool, research ones included, once at startup (an `AsyncLocalStorage` per tool call, logging). The wrapper must keep `tool.name` (checked) |
| `onModel` | Called with the configured model right after `configureModel`, before the host talks to anything: install guards that need the gateway's origin |
| `now` | Clock of "Today is …" in both system prompts, read on every turn |

The shipped entry `src/host/main.ts` (bundled to `dist/host.js`) calls `runHost()` with none of
them and imports nothing else: hooks are function values given by the code that calls `runHost`,
so no config key or environment variable switches them on in a packaged app (`test/host-entry.test.ts`
and the bundle check in `test/integration.test.ts` guard this). An embedder bundles its own entry
from the `@sa/agent/host-runtime` subpath, which exports `runHost`, the hook types, `HostResolver`,
the research factories (`createKeyServerResearchTool`, `createChatGPTResearchTool`,
`createExaTools`) with their option types and `ResearchBackend`, and `hostLog` (stderr: stdout is
the RPC protocol). The bundle keeps `@earendil-works/*`, `typebox` and
`@napi-rs/canvas` external like `scripts/build-host.mjs`, and must resolve them from where it
runs. `test/helpers/hook-host.ts` is a worked example (see `test/host-hooks.test.ts`).
`parseLiteLLMSpendHeaders` is exported from the package index for meters that read LiteLLM's
spend headers.

## Providers

- `loginChatGPT({ deviceId, onAuthUrl, signal, clientId?, manualRedirectUrl? })` — official
  "Sign in with ChatGPT" OSS flow: loopback `http://127.0.0.1:1455/auth/callback`, PKCE (S256),
  state, nonce, `client_id=dynamic_agent_client` + `agent_name_hint=Spain Assist` on first
  registration (or the issued `clientId` on re-auth), `ext_agent_host_id=urn:uuid:<deviceId>`,
  code exchange, ID-token validation (JWKS via OpenID discovery, issuer, audience = issued client
  id, nonce), and the `chatgpt.tokens.use.direct` scope check. Returns the credential pi's
  `openai` provider expects: `{type:'oauth', access, refresh, expires (3 min early), clientId,
  scopes}` plus the account e-mail. Errors: `ChatGPTLoginError.code` (`port_in_use`, `cancelled`,
  `timeout`, `denied`, `missing_scope`, `invalid_id_token`, …). Port 1455 busy → pass
  `manualRedirectUrl` (the URL the user pastes).
- `refreshOAuthCredential('openai', credential)`, `credentialNeedsRefresh(credential)`.
- `DEFAULT_MODELS = { chatgpt: 'gpt-6.1-sol', voucher: 'anthropic/claude-haiku-5.5' }` (procedure
  agents) and `ASSISTANT_MODELS` (the assistant/orchestrator: `gpt-6-luna` for ChatGPT/Codex and
  `anthropic/claude-haiku-5.5` for vouchers, both with thinking level `high`). The desktop app
  always runs ChatGPT, Codex and voucher agents on these (not stored in settings, so an app update
  changes the model); only BYOK and custom endpoints keep a user-chosen model, for every role.
- `listByokProviders()` — pi-ai's built-in providers with API-key auth and their chat models.
- `redeemVoucher(keyServerUrl, code)` → `KeyServerError {code, status}` on failure.
- Vouchers run on our LiteLLM gateway (D10): the `litellm` provider is OpenAI-compatible at the
  voucher's `baseUrl`, with model metadata (context window, images, reasoning levels) from pi's
  OpenRouter catalog, since LiteLLM serves models under their OpenRouter ids. Requests use the
  standard `reasoning_effort` and `max_tokens`, no `store` and no `developer` role.
  The gateway passes every OpenRouter model through, so the voucher model list is that catalog.
  `getVoucherCredit(keyServerUrl, apiKey)` (GET `/v1/vouchers/credit` on the key server with the
  key itself): what the vouchers add up to, LiteLLM's spend and cap, and expiry. Research lowers
  the cap, so remaining is cap minus spend.

## Development

```sh
corepack pnpm --filter @sa/agent build       # dist/host.js (+ dist/package.json)
corepack pnpm --filter @sa/agent typecheck
corepack pnpm --filter @sa/agent test        # unit + integration (spawns real hosts)
SA_TEST_ELECTRON=<path to Electron binary> corepack pnpm --filter @sa/agent test   # + Electron-as-Node run
```

### Run the host by hand against the mock LLM

```sh
corepack pnpm --filter @sa/mock-llm start -- --port 8789          # demo scenario by default
corepack pnpm --filter @sa/agent build
corepack pnpm --filter @sa/agent dev:chat                         # then type: Quiero renovar el DNI
# a real model with your own key (served through the fake bridge, never in the host env):
corepack pnpm --filter @sa/agent dev:chat -- --provider openrouter \
  --model moonshotai/kimi-k2.6 --key-env OPENROUTER_API_KEY
```

`scripts/dev-chat.ts` spawns the real host with a fake bridge: the plan card is printed, forms
and confirmations are asked in the terminal, the vault is in memory, browser and web search are
unavailable. Ctrl+C aborts the run.

### Debugging tips

- Host logs go to **stderr** as `[sa-host] <level> …` (stdout is the protocol) and arrive as
  `log` events; `process_exit.stderrTail` keeps the last 8 KiB.
- The session file is the source of truth: one JSONL entry per message/tool result; delete it to
  start over. Screenshots are stored there as base64 (the file is private, not encrypted).
- `GET http://127.0.0.1:8789/__requests` shows exactly what the model received (system prompt,
  tool schemas, auth header); `POST /__scenario` swaps the script at runtime.
- `node --inspect dist/host.js` works with the same environment (`buildAgentLaunch(...).env`).
- A tool returning `Could not reach the Spain Assist app` means the bridge URL/token is wrong.

## Packaging notes

- `dist/host.js` bundles everything except `@earendil-works/*`, `typebox` and `@napi-rs/canvas`,
  which must be resolvable from its location. The desktop app lists them in `dependencies`
  with the same versions (a test checks this). Packaging copies the host into app.asar as
  `agent-host/host.js`, next to those node_modules (`apps/desktop/electron-builder.ts`). Pass
  `hostPath` (or set `SA_AGENT_HOST_PATH`) when `@sa/agent` is bundled into the main process.
- Packaged builds keep the `runAsNode` fuse on for this host. Turning it off needs a
  `utilityProcess` transport (see `src/rpc/transport.ts`).
