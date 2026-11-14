# @sa/agent

Everything pi-specific in SpainAssist: the **agent host** (one process per active agent: the
coordinator behind the chat, or a background agent), the **tools** the model can call (the
coordinator's, and the background agents' `codemode` with its workflow API), the **system
prompts**, the **RPC client** the desktop app uses to drive a host, and **provider helpers**
(Sign in with ChatGPT, vouchers, BYOK, credit).

Background: [`docs/research/pi.md`](../../docs/research/pi.md) (pi 1.x facts),
[`docs/research/providers-and-research.md`](../../docs/research/providers-and-research.md),
contracts in [`@sa/shared`](../shared/src) (`bridge.ts`, `procedure.ts`, `chat.ts`).

## Architecture

```
desktop main ──spawn (buildAgentLaunch)──► dist/host.js   (Electron as Node, one per agent)
     ▲   │                                     │  pi SDK: ModelRuntime + AgentSession + runRpcMode
     │   └── PiRpcClient ◄── stdio JSONL ─────►│  inline extension: the tools + exact system prompt
     │                                         │
     └──── host bridge (HTTP, bearer token) ◄──┘  background agents: workflow.*, procs.*,
                                                  prompts/vault/browser/feedback; the
                                                  coordinator: agents.*, procs.* (role in config);
                                                  credentials (agent.credential)
                                               ──► LLM provider (direct)
                                               ──► api.fetchUrl, api.fetch, BOE open-data API (direct)
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
- Roles (`config.role`, required; `docs/codemode.md`): `orchestrator` is the coordinator, the
  chat's agent. It gets `createCoordinatorTools()` (delegation only, see "Tools") and
  `buildCoordinatorPrompt()`, and its final messages are checked: one that links a document the
  vault does not have gets an error and is written again, once per prompt
  (`host/document-links.ts`). `agent` is a background agent: its only tool is `codemode` (see
  "Codemode"), with web research behind `api.search` (`web_research` for voucher users and
  ChatGPT plans, or Exa for BYOK and custom endpoints, see `host/research.ts`), and
  `buildCodemodePrompt()`, whose final message per run is a short report for the coordinator.
- `src/tools/` — the coordinator's tools (TypeBox schemas, English model-facing text). Bridge
  calls pass the tool's `AbortSignal` to the HTTP request, so aborting a run cancels a pending
  request in the app (no abort deadlock).
- `src/research/` — the core of `api.fetchUrl` (Readability + linkedom → Turndown/GFM, unpdf,
  charset handling, SSRF guard, also behind `api.fetch`), BOE client, web research (key server,
  ChatGPT, Exa).
- `src/rpc/` — `PiRpcClient`, JSONL framing, event normalization, pluggable transport.
- `src/providers/` — ChatGPT OAuth, refresh, model lists/defaults, BYOK catalogue, key server,
  LiteLLM gateway credit and models (vouchers).
- `src/index.ts` — what the desktop main process imports (light: no HTML/PDF libraries).
- `src/host/hooks.ts`, `src/host/runtime.ts` — `HostHooks` and the `@sa/agent/host-runtime`
  subpath for harnesses (see "Eval hooks"); the shipped host does not use them.

## Codemode

Background agents (role `agent`, `docs/codemode.md`) have one tool, `codemode`, which runs a
workflow module in QuickJS (`src/codemode/`). Everything they do is a call of the workflow API
(`api.*`, declared in the system prompt): research (`api.search`, `api.fetchUrl`, `api.fetch`,
`api.boe.search`), procedures, vault and documents, the browser, the user's prompts and
interfaces, community learnings. A workflow that waits for the user detaches: the tool returns,
and the run's outcome reaches the agent as a message through the app.

| File | What |
| --- | --- |
| `kernel.ts` | JavaScript evaluated in every run: `api`, `@spainassist/ui`, durable state, the hooks renderer, event dispatch |
| `transform.ts` | sucrase: JSX and ESM to the kernel's module format, keeping line numbers |
| `workflow-run.ts` | One run in a fresh QuickJS instance: host calls, CPU slices, cancellation |
| `host-ops.ts` | What each `api.*` operation does: bridge calls (with the procedure header), research, fetch |
| `engine.ts` | Runs in the host: begin/end with main, event long-poll, detaching, periodic resume |
| `tool.ts`, `declarations.ts` | The tool, the API's `.d.ts` per role |

## Tools

The names are in `src/tools/names.ts`. Background agents have only `codemode`; the coordinator
has these, and delegates every request to background agents:

| Tool | Backed by | Notes |
| --- | --- | --- |
| `agent_start` | `agents.start` | A background agent for a new request, with the user's words as its brief and its first status line. Returns right away; its report reaches the coordinator as a message |
| `agent_message` | `agents.message` | The user's news, answers or corrections to a working agent; `urgent` only for corrections |
| `agent_stop` | `agents.stop` | Only when the user asks to stop or pause |
| `agent_list` | `agents.list` | The agents and what each is doing |
| `procedure_list`, `procedure_read` | `procs.list`, `procs.get` | The user's procedures as the user sees them |

`agent_start`, `agent_message` and `agent_stop` run sequentially (`executionMode`).

## Using it from the desktop main process

```ts
import { buildAgentLaunch, BUNDLED_MODEL_LISTS, PiRpcClient, type AgentEvent } from '@sa/agent';

const client = new PiRpcClient(
  buildAgentLaunch({
    nodeBinary: process.execPath,          // Electron
    electronRunAsNode: true,
    cwd: procedureWorkDir,                 // empty, app-owned directory
    hostPath: resourcesHostJs,             // dist/host.js shipped with the app (see Packaging)
    config: {
      role: 'agent',                       // or 'orchestrator' for the chat's coordinator
      procedureId: agent.id,
      sessionFile: join(appData, 'sessions', `${agent.id}.jsonl`),
      language: settings.language,
      model: { provider: 'litellm', ...BUNDLED_MODEL_LISTS.voucher.procedures[0], baseUrl: voucherBaseUrl, maxTokens: 8192 },
    },
    bridge: { url: bridgeUrl, token: perAgentToken },
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
  attempt pi retries: drop it); `assistant_rewrite {messageId}` follows a finished message the
  host rejected: the next message replaces it. `tool_start` / `tool_end {summary, details}` map to activity rows.
  `usage {inputTokens, outputTokens, costUsd}` per model response. `log` (host stderr, pi
  notices) and `process_exit {code, signal, stderrTail}`. `errorKind`: auth, quota (402,
  LiteLLM "budget has been exceeded", ChatGPT usage limit), rate_limit, context, network,
  provider, crash, unknown.
- **Prompts while running.** `prompt()` steers by default when a run is active. If the agent is
  blocked on a `prompt.*` request, the steering message waits until the user answers that
  prompt or the run is aborted.
- **Abort.** The bridge connection of a pending `prompt.*` / `browser.*` request is closed: mark
  the PromptItem cancelled.
- **Bridge timeouts (host side).** None for `prompt.*`, `browser.loginClave`,
  `browser.fillFromUser`, `browser.useCertificate` and `workflow.events` (they may wait for the
  user); 3 min for
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
| `role` | `orchestrator` (the coordinator) or `agent` (a background agent); required |
| `procedureId`, `sessionFile`, `language` | Session file is created if missing and resumed otherwise |
| `model.provider`, `model.id` | `openai` (ChatGPT OAuth), `litellm` (vouchers), any pi provider (BYOK), or `custom` |
| `model.baseUrl` | Required for `custom` and `litellm`; for built-in providers overrides the endpoint (dev/e2e: → mock LLM). Unknown ids are cloned from a sibling catalog model |
| `model.api`, `supportsImages`, `contextWindow`, `reasoning` | `custom` only (`openai-completions` uses `max_tokens`, `system` role, no `store`) |
| `model.maxTokens` | Output cap (capped voucher keys) |
| `model.thinkingLevel` | Default `medium`, clamped to the model |
| `research.keyServerUrl` | Our key server: vouchers' web research (`web_research` behind `api.search`) |
| `research.chatgptModels` | ChatGPT plans: model and effort of each `web_research` mode (`fast`, `balanced`, `deep`); default each mode's first bundled model |
| `research.exa` | BYOK and custom endpoints: `api.search` on Exa instead of `web_research` (the optional key comes from the app at call time) |
| `research.boeBaseUrl`, `research.exaBaseUrl`, `research.allowPrivateHosts` | Tests / e2e (mock sede on localhost) |
| `feedback` | `{submit, vote}` when the app has a feedback server: `api.feedback.search`, plus submit and vote when on |
| `dniePhone` | The DNIe through the phone app (`dnie-phone` flag) is offered |
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
| `egress.fetch` | All outbound HTTP of `api.fetchUrl`, `api.fetch` and `api.boe.search` (`HostOpsDeps.fetchImpl`), with the real URL the agent asked for |
| `egress.resolveHost` | DNS stand-in for the SSRF guard (`HostOpsDeps.resolveHost`, `HostResolver` in `research/fetch.ts`). The guard still blocks IP literals, `localhost` and private answers with the production messages; every other name resolves through it, so nothing touches real DNS before `egress.fetch` is called |
| `research` | Replaces the web research backend (`researchBackend()`: which prompt text and `api.search` the agent gets) and its tools. Background agents only: the coordinator never researches |
| `wrapTool` | Wraps every tool once at startup, the research tool behind `api.search` included (an `AsyncLocalStorage` per tool call, logging). The wrapper must keep `tool.name` (checked) |
| `onModel` | Called with the configured model right after `configureModel`, before the host talks to anything: install guards that need the gateway's origin |
| `now` | Clock of "Today is …" in both system prompts, read on every turn |

The shipped entry `src/host/main.ts` (bundled to `dist/host.js`) calls `runHost()` with none of
them and imports nothing else: hooks are function values given by the code that calls
`runHost`, so no config key or environment variable switches them on in a packaged app
(`test/host-entry.test.ts` and the bundle check in `test/integration.test.ts` guard this). An
embedder bundles its own entry from the `@sa/agent/host-runtime` subpath (`src/host/runtime.ts`
lists its exports: `runHost`, the hook types, the research factories, `hostLog`…; stdout is the
RPC protocol, so log to stderr). The bundle keeps `@earendil-works/*`, `typebox` and
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
- The models of ChatGPT, Codex and vouchers live in the repository's `models_warningUpdatingThisWillChangeItInAllClientsOnPushToMaster.json`:
  per role (`procedures` for background agents, `assistant` for the coordinator, the document
  `scanner`, and on ChatGPT each `research`
  mode), a list of `"<model id>:<reasoning level>"` entries, best first; and per user type the
  scan frame `decider`, one OpenRouter id that the key server also reads so keys allow it.
  `voucher.compaction` (`assistant`, `procedures`): the context size in tokens past which those
  agents compact (the host config's `model.compactAtTokens`); pi otherwise compacts near the
  model's context window.
  `BUNDLED_MODEL_LISTS` is that file as this
  build bundles it; `parseModelLists(json, fallback)` reads a downloaded one (see the desktop app
  below). Only BYOK and custom endpoints keep a user-chosen model, for every role.
- **Every installed app reads the file from master on GitHub**, so pushing a change to it changes
  the models of every app version at once. Released apps read it too, so the format can only grow:
  they ignore fields they don't know and skip entries they can't read (an unknown reasoning level),
  a list left empty falls back to the bundled one, and another `version` is ignored whole. An
  incompatible format needs a new file name.
- The desktop app (packaged builds) downloads the file at most once an hour, keeping the last one
  read, else the bundled one, when GitHub can't be reached; development builds and e2e runs use
  the bundled one (the working copy's). Vouchers and Codex run each list's first model.
- ChatGPT plans offer different models (Plus has no `gpt-6.1-sol`, Go neither `gpt-6-astra`). The
  desktop app asks OpenAI which models the account has (`GET /v1/models`) and runs each role on the
  first model of its list the account lists, else on the model OpenAI ranks first (`priority`),
  preferring one pi's catalog knows with images, at the effort of the list's first; when that
  lookup fails it uses each list's first. The research modes' picks reach the host as
  `research.chatgptModels`.
- `listByokProviders()` — pi-ai's built-in providers with API-key auth and their chat models.
- `redeemVoucher(keyServerUrl, code)` → `KeyServerError {code, status}` on failure.
- Vouchers run on our LiteLLM gateway: the `litellm` provider is OpenAI-compatible at the
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

### Debugging tips

- Host logs go to **stderr** as `[sa-host] <level> …` (stdout is the protocol) and arrive as
  `log` events; `process_exit.stderrTail` keeps the last 8 KiB.
- The session file is the source of truth: one JSONL entry per message/tool result; delete it to
  start over. Screenshots are stored there as base64 (the file is private, not encrypted).
- With the mock LLM (`tools/mock-llm`, e.g. on port 8789), `GET http://127.0.0.1:8789/__requests`
  shows exactly what the model received (system prompt, tool schemas, auth header);
  `POST /__scenario` swaps the script at runtime.
- `node --inspect dist/host.js` works with the same environment (`buildAgentLaunch(...).env`).
- A coordinator tool returning `Could not reach the Spain Assist app` means the bridge URL/token
  is wrong.

## Packaging notes

- `dist/host.js` bundles everything except `@earendil-works/*`, `typebox` and `@napi-rs/canvas`,
  which must be resolvable from its location. The desktop app lists them in `dependencies`
  with the same versions (a test checks this). Packaging copies the host into app.asar as
  `agent-host/host.js`, next to those node_modules (`apps/desktop/electron-builder.ts`). Pass
  `hostPath` (or set `SA_AGENT_HOST_PATH`) when `@sa/agent` is bundled into the main process.
- Packaged builds keep the `runAsNode` fuse on for this host. Turning it off needs a
  `utilityProcess` transport (see `src/rpc/transport.ts`).
