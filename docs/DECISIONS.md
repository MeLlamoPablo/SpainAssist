# Decisions log

Short records of the important calls made while building the MVP, with the reasoning, so they
can be revisited. Newest last.

## D1 — Desktop framework: Electron + React instead of Compose Multiplatform

**Context.** The SPEC suggested Compose Multiplatform (cross-platform, long-term bet, Java helps
with AutoFirma) and asked agents to challenge it.

**Decision.** Electron (latest) + React + TypeScript, built with electron-vite.

**Why.**
- *One language end to end.* pi (the agent harness) is TypeScript; tools are pi extensions in
  TypeScript; browser automation is Playwright (TypeScript-first); backends are TypeScript. With
  Compose we would have had Kotlin UI + a Node runtime for pi + IPC between them anyway.
- *pi runs on Electron's bundled Node* (`ELECTRON_RUN_AS_NODE=1`) — no separate runtime to ship.
- *Batteries the SPEC needs are built in:* OS-backed encryption (`safeStorage`: Keychain /
  DPAPI / libsecret), Touch ID (`systemPreferences.promptTouchID`), webcam (`getUserMedia`) for
  document scanning, drag & drop, rich text rendering. On the JVM each of these needs JNA/JNI
  or extra native helpers (webcam and Touch ID in particular).
- *E2E testing:* Playwright drives Electron natively, so the same tool tests the app and drives
  the mocked government site.
- *AutoFirma:* the hard part is not Java crypto but the browser ↔ signer bridge. We replace it
  inside our controlled browser with an injected AutoScript shim and sign in Node (see D4), so
  Java brings no advantage. All signing formats are implemented in TypeScript (`@sa/signer`), so
  the app ships no JRE.

**Costs.** Bigger binary and memory footprint than a JVM app with jlink? Comparable (~150 MB).
Not "native widgets" — we interpret "native UI element" as first-class UI, not OS widgets.

## D2 — Agent harness: pi SDK host per active procedure, speaking pi's RPC protocol

Each active procedure gets its own small agent host process (`@sa/agent` `dist/host.js`, run
with Electron's Node via `ELECTRON_RUN_AS_NODE=1`). The host uses the pi 1.0 SDK
(`createAgentSessionRuntime` + `runRpcMode`), so the app talks pi's documented JSONL RPC
protocol over stdio, while we keep full control: only SpainAssist tools (no built-in
coding tools, no context files/skills/extension discovery), an exact system prompt, no
telemetry or catalogue refresh, and an in-memory credential store that fetches credentials from
the app over the local host bridge (nothing secret on disk or in env). Tools reach the app via
the bridge with per-procedure tokens. One process per active procedure gives isolation, real
concurrency and natural context switching; idle agents stop and resume from their session file.
Packaging note: packaged builds keep the `runAsNode` fuse on so the host can run this way
(D17). Turning it off needs the host on `utilityProcess.fork` first (see
`research/electron-packaging.md`).

## D3 — Inference routing: OpenRouter for vouchers, pi providers for the rest

- **Sign in with ChatGPT**: OpenAI's official "Sign in with ChatGPT" for open-source, locally
  hosted apps (launched for plan usage at DevDay 2026-09-29): OAuth with `client_id=
  dynamic_agent_client` + a per-install `ext_agent_host_id`, tokens used against the public
  Responses API. pi supports it as the `openai` provider. We run the login ourselves (so the
  consent screen says "SpainAssist", not "Pi") and hand the credential to pi. The legacy
  `openai-codex` route (impersonating Codex CLI against chatgpt.com/backend-api) is NOT used.
  Note: plan usage is available to open-source apps; a closed-source/paid app must apply via
  OpenAI's interest form.
- **Vouchers** (superseded by D10: vouchers are now LiteLLM virtual keys on our own gateway,
  so voucher conversations do pass through our server): our key server exchanges a voucher for
  an OpenRouter key created with the Provisioning API and a USD `limit`; the client then talks to
  OpenRouter directly, so conversations are never proxied (LiteLLM virtual keys would require
  proxying).
- **BYOK / custom endpoint**: any pi provider, or any OpenAI-compatible base URL (local models
  welcome) — under "Advanced".

## D4 — AutoFirma: injected AutoScript shim + Node signer

Instead of bundling AutoFirma and its protocol handler (`afirma://`, local WebSocket, or the
storage/retrieve servlets), the agent's browser injects a replacement for the site's
`AutoScript` object. Calls are forwarded to the main process, which asks the user for approval
and signs with the `.p12` (CAdES / XAdES / PAdES, triphase when requested). The user never sees
AutoFirma. Limitation: works only inside SpainAssist's browser (by design).

## D5 — Backends: Hono + Postgres (PGlite for dev/tests), raw SQL

Both services are small: Hono on Node, raw SQL with a tiny migration runner, Postgres in
Docker for production-like runs, PGlite (embedded Postgres) for local dev and tests so nothing
requires Docker. Feedback search uses Postgres full-text search with a Spanish, accent-
insensitive configuration plus trigram similarity.

## D6 — Tooling

pnpm workspaces (via corepack), TypeScript 7, Vitest, Biome. Internal packages export TS source
and are bundled by consumers (no per-package build step) except the pi extension, which is
bundled into a single JS file pi can load.

## D7 — Research sources: official-first, search through our backend

> **Superseded by D8** (2026-10-03) for web search, the procedure catalogue and the "official"
> labels. BOE, `fetch_url` and the browser are unchanged.

There is no reliable keyless web search in 2026 (DuckDuckGo/Mojeek/SearXNG all challenge bots).
- `web_search` went through the app (bridge `research.search`): PII was scrubbed from the query,
  then the app called our key server's search proxy (Exa, restricted to official domains first)
  with a per-install search token, or the user's own Exa key (advanced).
- Free official sources were first-class tools: BOE open-data API, the national procedure
  catalogue (SIA/PAG export, harvested server-side and indexed with the feedback), `fetch_url`
  (Readability → Markdown, PDF text), and the agent's own browser as last resort.

## D8 — Research: Exa's streaming Agent API and hosted MCP, straight from the agent host

> **Superseded 2026-10-12: Exa is removed.** Its key was a temporary development key. The agent
> no longer has `mcp__exa__*` web search or Exa's Agent API, and LiteLLM no longer registers an
> `exa` search tool. Deep research is D13's voucher path and, for ChatGPT plans, D21; other
> providers get the "research blocked" path. Refinement uses `fetch_url`, `boe_search` and the browser.
>
> 2026-10-13: Exa is back for BYOK and custom endpoints only, on its REST API with the user's own
> key (D23). There is still no shared or development key.

Simplify research to one provider.
- **Exa only.** The agent host registers Exa's hosted MCP server (`https://mcp.exa.ai/mcp`,
  Streamable HTTP) with pi's built-in MCP extension, for the session only (no `mcp.json`). Only
  `web_search_exa` and `web_fetch_exa` are enabled (`?tools=`), with
  `exposure: "direct"`. The model sees them as `mcp__exa__<tool>` next to our tools.
  Initial research uses our `deep_research` tool with `effort: "auto"`: one POST to the Agent
  API with `Accept: text/event-stream` stays open until completion. The model receives one final
  result; progress updates go to the activity log, with no polling turns or MCP resume calls.
  Exa's MCP `agent_run` has a bounded waiting window, so long runs previously needed additional
  model-issued calls. The streaming API removes that handoff. See the
  [Agent streaming documentation](https://exa.ai/docs/agent/quickstart#stream-events).
  Abort closes the stream; a disconnect or 30-minute timeout reports the known run ID without
  creating a replacement. Refinement follows only after research completes.
  Questions and execution wait until the plan is clear and research uncertainties are resolved.
  They are in the session's tool allowlist and our `tool_call` guard; anything else Exa offers
  stays blocked. See [Exa MCP documentation](https://github.com/exa-labs/exa-mcp-server) for tool
  enablement.
- **Key.** One global key for now: `EXA_API_KEY` in `apps/desktop/.env`, read by dev builds only
  (`process.loadEnvFile`). Main passes it to each agent host as an environment variable (never in
  `SA_AGENT_CONFIG`), and pi resolves the `x-api-key: ${EXA_API_KEY}` header when it connects, so
  the key is not in the config, the session file or anything the model sees. Without a key the
  agent reports that the required initial Exa research is blocked; it does not collect user
  information or execute the procedure. E2e runs ignore the key unless both `SA_EXA_MCP_URL`
  and `SA_EXA_AGENT_URL` are supplied for fake servers.
- **Removed:** the "Buscador" setting (it never did anything), the app's `ResearchService` and the
  `research.search` / `research.catalog` bridge methods, search tokens in the app, the procedure
  catalogue (feedback-server table, harvester, snapshot, HTTP and MCP endpoints, `catalog_search`
  tool), and the "official" classification of sources (badges, `Source.official`,
  `fetch_url`/browser "Site: official" lines).
- **Kept:** the government-domain list in `@sa/shared` (`OFFICIAL_DOMAINS`), now only as the
  anti-phishing allowlist for `credentialAllowedOn` (where certificates and Cl@ve credentials may
  be used). The prompt still prefers the administration's own websites. The key server's search
  proxy and search tokens stay untouched: they are one way to solve problem 1 below. (D10 later
  removed both: voucher keys pay for search on our LiteLLM gateway.)
- **Trade-off:** the app no longer removes personal data from search queries before they leave
  the device: pi sends them to Exa as the model wrote them. The prompt forbids personal data in
  searches. If that is not enough, scrub (or block) in the host extension's `tool_call` hook.

### Open problems

**1. Distribute Exa access through the voucher system.** Packaged builds have no `.env`, so they
have no web search today. Options:
- *Our key server proxies Exa's MCP (recommended).* The key server already issues per-voucher
  search tokens with quotas (`RedeemVoucherResponse.searchToken`, `POST /v1/search-tokens`, Exa
  backend). Add a `/mcp` endpoint there that forwards to `mcp.exa.ai` with our key, authenticated
  by `Authorization: Bearer <searchToken>`, counting tool calls against the quota. The app stores
  the token from the voucher (it currently ignores it) and the host registers our `/mcp` URL
  instead of Exa's. The Exa key never leaves our server, tokens are revocable, and the agent side
  barely changes (only the URL and the header).
- *A capped Exa key per voucher*, like OpenRouter keys. Needs an Exa admin API for sub-keys with
  limits (UNVERIFIED) and puts an extractable key on the device.
- *OpenRouter's server-side web search* (`openrouter:web_search` with `engine: "exa"`) billed to
  the voucher. No Exa key at all, but it only works for OpenRouter models, and results arrive as
  annotations, not as a tool the agent controls.

**2. How do "Sign in with ChatGPT" users search without a voucher?** They pay for inference with
their ChatGPT plan but have no Exa access. Options:
- *OpenAI's hosted `web_search` tool* on the Responses route, billed to their plan. OpenAI allows
  it "subject to model and account/workspace policy" (UNVERIFIED on this route, see
  `docs/research/providers-and-research.md`). Needs pi support for provider-native tools, and the
  tool shape differs from Exa's (no domain control).
- *Anonymous search tokens* from the key server (already built: one per network per 24 h, small
  quota). Costs us money and invites abuse; fine as a small free allowance.
- *Bring your own Exa key* (an advanced setting, stored in the vault). Exa has monthly free credit,
  but it is friction for non-technical users.
- *No Exa key*: initial research is blocked; the agent reports this before asking questions or executing.

A reasonable path: OpenAI's `web_search` if it works on the SIWC route, else a small anonymous
quota through the same proxy as problem 1, with "your own Exa key" as an advanced escape hatch.

## D9 — One perpetual conversation; an orchestrator delegates to one agent per procedure

Procedures are often related (a move means empadronamiento, Hacienda, DGT…), so one chat per
procedure made users repeat themselves and switch contexts. Now:
- **The assistant** (orchestrator) owns the app's single chat. It is one pi session
  (`<userData>/assistant/session.jsonl`) with pi's auto-compaction, so the conversation never
  ends. It has no research, browser or web-search tools: only `procedure_list`, `procedure_read`,
  `procedure_start`, `procedure_message`, `procedure_cancel`, `ask_user`, `vault_read`,
  `vault_save` (bridge methods `procedures.*`, gated to the assistant's token).
- **Procedure agents** (pi sub-agents, one process per active procedure as before) do every tool
  call themselves: research, browser, signing, the plan card. pi has no built-in sub-agents
  (only an example extension that spawns pi processes); our AgentManager already spawns and
  resumes isolated pi hosts, so a sub-agent is simply a procedure agent started by the assistant.
- **Minimal upward communication.** When a procedure agent finishes a run, main sends the
  assistant a report: one header line (procedure id, title, status, next action) plus the agent's
  final message, clipped to 600 characters, queued as a pi follow-up if the assistant is busy.
  Aborted runs are not reported. The assistant never sees procedure tool calls, page snapshots or
  form answers; it reads a card on demand with `procedure_read`.
- **Questions go straight to the user, on the procedure's card.** `ask_user` / `confirm_action` /
  `request_user_action` and app prompts (credentials, signatures) of a procedure agent are held
  in its runtime (`ProcedureRuntime.prompts`) and its activity log, never in the conversation;
  the card shows them inline and the answer goes back to that agent only. Several agents can ask
  at once, each on its own card. Questions never block the chat, so there is nothing to skip:
  forms have no "not now" (`allowDismiss` is legacy, always false); stopping the procedure
  cancels its questions. The assistant's own `ask_user` still docks in place of the composer,
  and typing a message cancels it.
- **UI.** Chat on the left (only the assistant's own questions dock in place of the composer); on
  the right, tabs: procedure cards (key facts, steps with owners, the agent's questions, what it
  is doing now, next action; details: requirements, documents and official sources), Mis datos,
  Ajustes. Cards show no agent activity log: what matters reaches the user through the chat and
  the card. A card waiting on the user has no status pill: the highlight and its question say so.
- **Trade-offs.** Two model calls where one used to suffice (the agent's report, then the
  assistant's reply), and the assistant only knows what reports and cards say. The conversation
  transcript keeps the latest 1,500 items on disk; the assistant's own memory is pi's compacted
  session.

## D10 — LiteLLM gateway for vouchers and search

> Supersedes the **Vouchers** bullet of D3 (2026-10-05) and the key-server search proxy that D8
> kept. Research in the app is unchanged for now (see "Not yet" below).

Exa and Parallel cannot cap API keys, and an OpenRouter key cannot pay for web search. One
self-hosted **LiteLLM proxy** (v1.104, on the same VM as the key server) now sits in front of
every paid upstream, so one capped key covers both. See
[research/litellm-gateway.md](research/litellm-gateway.md).

- **Upstreams.** LLM calls go to OpenRouter (its key lives only in LiteLLM's config; LiteLLM
  model names are the OpenRouter ids, e.g. `openai/gpt-6-luna`). Web search uses LiteLLM's search
  tools (`POST /v1/search/{tool}`) backed by Exa and/or Parallel.
- **Vouchers.** The key server redeems a voucher by creating a LiteLLM virtual key with the admin
  API (`POST /key/generate`, master key): `max_budget` = the voucher's USD amount (LLM calls and
  searches share it), `duration` = until the voucher's `expiresAt` (else `KEY_TTL_DAYS`), `models` = `LITELLM_KEY_MODELS` (empty = all),
  `object_permission.search_tools` = `LITELLM_SEARCH_TOOLS` (empty = all), a unique `key_alias`
  with the voucher id (never the code). We store LiteLLM's hashed token, never the key.
  An app that already holds an active voucher key sends it when it redeems another voucher: the
  voucher tops that key up (`max_budget` += its amount; the key expires at the later of the two
  deadlines), so the app keeps one balance. Revoking a voucher takes its amount back; once no
  valid voucher funds a key, the key is blocked (`POST /key/block`; unknown keys count as
  blocked).
- **Routes.** Keys get explicit `allowed_routes` (`/v1/chat/completions`, `/v1/models`,
  `/v1/search`, `/key/info`), not LiteLLM's `llm_api_routes` group: that group includes the
  provider pass-through routes (`/openrouter/*`, `/openai/*`, …), which call the provider with
  the proxy's own credentials and record no spend for OpenRouter chat, so a key could bypass its
  budget and model allowlist. It also opens MCP, agents, files, batches and vector stores.
  `/key/info` lets the app read the key's own spend and budget (never other keys').
- ~~**Anonymous search**~~ (removed by D12: the ChatGPT allowance is per OpenAI account and pays
  for scan screening, not search) (`POST /v1/search-tokens`, for ChatGPT / BYOK users): a search-only key
  (`models: ["no-default-models"]`, the search tools, `ANON_SEARCH_BUDGET_USD`, default $0.25 ≈
  50 searches at LiteLLM's $0.005), still one per network per `ANON_SEARCH_IP_WINDOW_HOURS`.
- **Removed:** the key server's Exa search proxy (`POST /v1/search`), its fixtures, search
  tokens and per-voucher search quotas. `RedeemVoucherResponse` has no `searchToken`; the
  voucher key itself works for search, and both responses list the allowed `searchTools`.
- **App.** A voucher is the pi provider `litellm`: OpenAI-compatible at the voucher's `baseUrl`,
  with model metadata from pi's OpenRouter catalog. Requests use the standard
  `reasoning_effort` and `max_tokens` (LiteLLM maps them for OpenRouter). The balance comes from
  the key server's `GET /v1/vouchers/credit` when a run ends (what the vouchers add up to, plus
  LiteLLM's spend and cap) and from the `x-litellm-key-spend` / `x-litellm-key-max-budget`
  headers of each agent call (live, one call behind). Web research lowers the cap, so the app
  shows remaining = cap − spend out of the vouchers' total, never the cap as the total. The model
  list comes from `{baseUrl}/models`. LiteLLM's 422 "Budget has been exceeded"
  reads as "out of credit".
- **Trade-offs.**
  - Our server now sees the prompts and answers of voucher users, and every search query. This
    reverses D3's "conversations are never proxied". LiteLLM must not keep them:
    `general_settings.store_prompts_in_spend_logs: false`, `litellm_settings.turn_off_message_logging: true`,
    no logging callbacks (Langfuse etc.) and no request/response logging at the reverse proxy.
    Spend logs keep only metadata (key, model, tokens, cost). OpenRouter's zero-data-retention
    settings still apply upstream.
  - One more hop and one more service to keep up: if LiteLLM is down, vouchers stop working.
  - LiteLLM prices searches from its own map ($0.005), not the vendor's. Spend is recorded after
    each call, so parallel calls can overshoot a budget by a few cents.
  - Research agents (Exa Agent, Parallel Task API) are billed $0 by LiteLLM, so they are not
    offered through voucher keys.
- **Not yet.** The app's research still reaches Exa directly (MCP and Agent API, with the dev
  `.env` key, D8), so packaged builds have no web search. Moving research to LiteLLM search tools
  with the voucher key (or the anonymous key) is the next step; it replaces D8's open problem 1.

## D11 — Production: one Hetzner VM running Coolify, declared in Terraform

Replaces the single-VM docker-compose + Caddy deployment, which was never applied. Details and
runbook: [infra/README.md](../infra/README.md#production-hetzner--coolify-terraform).

- **Coolify** runs the key server, the feedback server, Postgres and LiteLLM (D10) on one cx23
  in Nuremberg: a UI for logs, redeploys and backups, Let's Encrypt through its proxy, and a
  Terraform provider (`coolify-terraform/coolify`) so everything stays declared in
  `infra/terraform/`.
- **Bootstrap without secrets in cloud-init**: the metadata service is readable from every
  container. cloud-init only installs Coolify; Terraform sets its root user, API token and
  dashboard domain over SSH. The Coolify API is reached through an SSH tunnel (`tf.sh`), never
  a public port. The first apply is two-step (`tf.sh bootstrap`, then `tf.sh apply`) because
  the provider needs a running Coolify to plan.
- **One Postgres, one role and database per service**, created over SSH (Coolify's API has no
  init scripts). Services are built by Coolify from GitHub with a read-only deploy key, so a
  deploy needs a push.
- **Domains**: `<ip>.sslip.io` until the apps move to `spainassist.es` (Route 53 Domains and a
  Route 53 hosted zone). Its records point straight at the server: no CDN proxy that cuts long
  LiteLLM streams or sees prompts.
- **Trade-offs**: on the 4 GB server Coolify takes about 0.5 GB and LiteLLM 0.75 GB; with both
  services and Postgres about 1.9 GB stays free (plus 2 GB swap). The provider is young (0.1.x)
  and Coolify 4.3.23 needed two workarounds (LiteLLM joins Coolify's network from its compose
  file; its config travels base64 in an env var because compose `content:` files are written
  only once). Auto-update is off: Coolify upgrades go through `coolify_version`.

## D12 — Scan screening through LiteLLM; one subsidy key per ChatGPT account

> Amends D10's **Anonymous search** bullet (2026-10-05): anonymous search keys are gone.

Frame screening (Perplexity Decider via OpenRouter's Decisions API) costs money that ChatGPT
plans cannot pay, and it ran on a global `OPENROUTER_DECIDER_API_KEY` that only dev builds had.
Now it runs on our LiteLLM gateway with the user's own key.

- **Route.** `POST {gateway}/openrouter/alpha/decisions`: LiteLLM's OpenRouter pass-through to
  `https://openrouter.ai/api/alpha/decisions`, the same API (same request and answer) as System
  One's `/api/v1/systemone`. LiteLLM v1.104 prices exactly this path from each answer's token
  usage (`is_openrouter_decisions_route` → `TypeSafePassthroughLoggingHandler`), charges the key
  and checks budgets before the call (pass-through routes are LLM routes for budget checks); it
  does not price `/systemone`. Its price map lacks the model, so the proxy registers
  `openrouter/perplexity/pplx-decider-v1-27b` at $0.04/M input tokens with a small callback
  module. Keys get only that exact path, never `/openrouter/*` (D10), and their `models` must
  include the decider: LiteLLM checks the body's `model` on pass-through routes too.
- **Who pays.** Voucher keys: charged to the voucher (route and model added to every new
  voucher key). "Sign in with ChatGPT": one permanent subsidy key per OpenAI account, decider
  only, with LiteLLM `budget_limits` of $0.10 per UTC day and $0.50 per calendar month (both
  enforced before each call, persisted per window), all in one LiteLLM team whose monthly
  budget is an optional global cap (`CHATGPT_GLOBAL_MONTHLY_BUDGET_USD`, off by default). BYOK,
  custom endpoints and Codex: no gateway key, so no screening (frames go straight to
  extraction), unless a developer sets `OPENROUTER_DECIDER_API_KEY`, which overrides the user
  key in any build that has it.
- **Identity.** The app keeps the OpenAI ID token of the sign-in (verified locally, nonce
  included) in memory and posts it to `POST /v1/chatgpt-keys`; the access token never leaves
  for our server. The key server verifies it with OpenAI's JWKS (RS256, issuer, expiry, at most
  24 h old, `aud` = a per-install `oaiapp_…` client) and uses `sub` (OpenAI publishes `public`
  subjects, so it is the same on every install) as the identity, stored only as an HMAC.
- **Storage.** Unlike voucher keys, the subsidy key is stored (AES-256-GCM, new
  `KEY_ENCRYPTION_KEY`, the account hash as authenticated data) so a second device of the
  account gets the same key and the same allowance. The app stores it in the vault with the
  ChatGPT credential; signing out forgets it.
- **Out of allowance.** LiteLLM answers 422 `budget_exceeded`; the scanner (like for a missing
  or refused key) skips screening for the rest of that scan at once instead of retrying. The
  user sees the scan go on as usual, only every frame reaches the extraction model (slower,
  more retries from blurry frames); there is no message.
- **Removed:** `POST /v1/search-tokens`, `SearchTokenResponse`, `ANON_SEARCH_*`, the
  `anon_token_grants` table and anonymous key rows (migration 002), the `anon_tokens_disabled`
  error code.
- **Trade-offs.** Frames of ChatGPT and voucher users now pass our gateway (same no-logging
  settings as D10). The server holds keys it can decrypt. A stolen ID token (valid ≤ 24 h)
  reveals that account's $0.50/month key. LiteLLM accepts sub-paths of an allowed route and
  resolves `..` in pass-through paths, so the public reverse proxy must forward only the exact
  decider path. An ID token is only available right after a sign-in: users signed in before
  this change, or whose key request failed for longer than the token lives, must sign in
  again to get screening.

## D13 — Deep research for vouchers: Parallel `core2x` through the key server

> Amends D8 (deep research is no longer Exa-only) and D10's "Research agents … are not offered
> through voucher keys" (2026-10-05).
>
> 2026-10-08: the default processor is now **`pro`** ($0.10 per completed run, 2–10 min).
> A real `core2x` run took 40 s and read 7 pages of one site; it found the right options but
> missed thresholds and submission details. The text below still says `core2x`.
>
> 2026-10-12: the tool is now **`web_research`** with a required `mode`: `fast` → `base`
> ($0.01), `balanced` → `core` ($0.025), `deep` → `pro` ($0.10), at list price.
> `RESEARCH_PROCESSOR` and `RESEARCH_PRICE_USD` are gone. The prompt gives no guidance on the
> mode, to see what agents pick. Agents put anonymized user context (age, municipality,
> document dates) into the query.
>
> 2026-10-12: `fast` → **`lite`** ($0.005). A `fast` run on `base` took 2 minutes to read one
> page.

Voucher users get deep research on **Parallel's Task API, processor `core2x`** ($0.05 per
completed run, 1–10 min), paid from their voucher. LiteLLM v1.104 cannot sell it per key (no
Task provider, its chat route to Parallel logs $0, pass-through for virtual keys is
Enterprise-only; see [research/litellm-gateway.md](research/litellm-gateway.md) §5), and
Parallel keys have no processor lock or spending cap, so the **key server** runs it.

- **API.** `POST /v1/research {input, outputSchema?, requestId?}` with the voucher key as
  bearer; the answer is an SSE stream (`created`, `progress`, then `completed` or `failed`).
  `GET /v1/research/:id[/events]` lets the same key read or re-follow its run; other keys get
  404. The processor and price come from server config (`RESEARCH_PROCESSOR`,
  `RESEARCH_PRICE_USD`); the strict request schema rejects anything else. Only active voucher
  keys qualify (not ChatGPT subsidy keys).
- **Charging.** The key server lowers the key's LiteLLM `max_budget` by the price before
  creating the run (after checking `max_budget - spend ≥ price` via `/key/info`), and raises it
  back if the run fails or never starts (Parallel bills only completed runs). It never writes
  `spend`, which LiteLLM's batch writer owns. Budget changes of one key run in a transaction
  holding its `issued_keys` row lock, together with the run's state change, so concurrent
  requests cannot both spend the last cents and a refund happens once. Runs are rows in
  `research_runs` (key, Parallel run id, state, price, timestamps; no content).
- **Following.** The server follows each run in the background (Parallel's blocking result
  call), independent of the client, so a client that leaves does not leave a run unsettled;
  Parallel has no cancel for task runs, so a run the user aborts still completes and is charged.
  After `RESEARCH_MAX_MINUTES` (30) it stops following and keeps the charge. A restart resumes
  unfinished runs.
- **App.** The agent host's `deep_research` tool calls the key server with the voucher key
  (read from the app's credential store at call time, never in the config or the model's
  context) when the model provider is the voucher gateway. ChatGPT plans research with
  OpenAI's web search (D21); BYOK users research with their own Exa key (D23). Research is refined with
  `fetch_url`, `boe_search` and the browser.
- **Trade-offs.** The research input and output pass through our server (not stored or
  logged). The price is charged up front and refunded on failure, so a voucher with less than
  $0.05 left cannot research even if the run would have failed. Abandoned or timed-out runs
  stay charged although Parallel might still fail them.

## D14 — DNIe signatures through a phone app and a relay

The DNIe needs a card reader on the computer, and most users don't have one; almost all have
an Android phone with NFC (`SPEC.md`, `docs/research/dnie.md` §5). So the phone is the reader
and the signer: **SpainAssist Firma** (`apps/mobile`, Compose Multiplatform, Android first)
pairs with the desktop through a QR code and signs AutoFirma requests with the DNIe. Autofirma
for Android exists, but it is a separate flow with its own file handling, and it fails with
AA300103 when the card moves during a read.

- **Transport: a relay, not the local network.** Guest and corporate Wi-Fi often block traffic
  between devices, and iOS asks for local-network permission. `services/relay-server` is a small
  Hono + `ws` service with rooms, no accounts and no database. It sees only end-to-end encrypted
  frames, keyed from the QR (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, with nonces from both sides
  on every connection). P-256, HMAC and AES-GCM are built into Node, Electron's BoringSSL, JCA
  and CryptoKit, so there's no native library to ship (instead of the libsodium first planned).
  No gateway key is needed: the relay costs no money per use. Limits per room and per address
  stop abuse.
- **Pairing: one desktop session.** 72 hours (12 at first; D20) or until the desktop app quits, no push
  notifications, nothing to unpair later. The phone keeps the pairing (Keystore-encrypted) to
  reconnect after the app is killed. A new QR means a new pairing.
- **Consent on the phone, and what you see is what you sign.** The phone shows the document
  (the PDF itself), the site and the format. For CAdES and PAdES built by the desktop, it checks
  that every blob it signs binds to that document (CMS messageDigest; PAdES byte range and update
  shape). Otherwise it says up front that it can't check. A compromised desktop can't get a
  different PDF signed than the one the phone shows; it can still get XAdES and triphase blobs
  signed under a misleading description.
- **Card layer: jmulticard on Android.** It's the government's battle-tested library (PACE with
  Brainpool, CWA-14890), wrapped behind a `Card` interface in common code. Its licences make the
  Android app EUPL-1.2 as a whole (D16) until our own implementation replaces it, which iOS
  needs anyway (CryptoKit has no Brainpool).
- **Signer port.** `@sa/signer` signs through an async `KeySigner` (a `.p12` key or an
  `ExternalSigningKey`), so every format works with the DNIe without new format code.
- **Trade-offs.** One relay to run. Signatures need the phone's app open (no push). Logins use the sidecar proxy (D15).


## D15 — Native sidecar for certificate logins (2026-10-11)

Use `packages/sidecar` (`sa-sidecar`, Go standard library) for both `.p12` and phone DNIe
certificate logins. Node TLS has no external handshake-signing callback, and Electron's
BoringSSL cannot load an OpenSSL engine. Go's `crypto.Signer` accepts a remote key and handles
TLS 1.2 renegotiation. There is no USB reader or PKCS#11 path in this implementation.

- Each browser session receives a separate loopback proxy port. A per-launch password is
  answered by one browser-level DevTools handler, including out-of-process frames. The
  password and `.p12` private key reach the helper only on stdin. It exits when stdin closes.
- Only enabled certificate hosts are intercepted. Chromium trusts the helper's ephemeral key
  through an SPKI pin; other hosts remain raw tunnels with normal Chromium verification.
  Upstream HTTPS uses the platform verifier. `.p12` login no longer ignores HTTPS errors.
- Remote RSA keys use TLS 1.2 because DNIe cards support PKCS#1 v1.5, while TLS 1.3 client
  authentication requires PSS. Connections are reused, handshakes per host are serialized,
  and TLS sessions resume when the server allows it.
- The phone shows a login approval for the site, reads AUTENTICACIÓN, and signs pre-hashed
  digests. FIRMA remains the document key. Approval ends after 30 quiet seconds; later
  handshakes ask again. PIN caching and card-moved recovery stay on the phone.
- Protocol 2 adds the `login` purpose and optional `prehashed` flag; old phones must update.
  The `dnie_signature` prompt adds `purpose` over the existing renderer IPC methods. Without the helper the desktop runs and the certificate
  tool explains that certificate logins are unavailable.

Offline tests cover Chromium → sidecar → mock-sede, with `.p12` and an encrypted simulated
phone, plus Kotlin controller and transport interoperability. Real DNIe/NFC timing, real-host
resumption and WAF compatibility remain unverified. Packaging builds and ships the helper for
each OS and CPU (D17); signing and notarizing it are in `PRODUCTION_CHECKLIST.md`.

**Behind a feature flag (D14 and D15, 2026-10-11).** Signatures and logins with the DNIe in the
phone are behind the Unleash flag `dnie-phone` (type experiment, off in production) until the
phone app is published and tested on real cards. Off, the desktop behaves as if the feature
didn't exist: no pairing or relay connection, no DNIe in Mis datos, the certificate picker or
the agent's prompt and tools, and main refuses DNIe calls. A saved `dnie` credential stays in the
vault, hidden. `.p12` certificate logins through the sidecar are not gated. Flags are read at
start-up, so turning it on applies at the next launch (`docs/ARCHITECTURE.md`, "Feature
flags").

**The desktop gives the phone the DNI CAN (D14 and D15, 2026-10-11).** The phone asked for the
CAN on first use, though the desktop scanner sees it on the DNI front. The scanner reads it again
(`dniAccessNumber`, a standard DNI field in Mis datos, reversing the 2026-10-04 removal), and
every `sign.request` carries it as an optional `can` when Mis datos has six valid digits.
- **Not in the QR.** The pairing QR is on screen and in screenshots, and the DNI may be scanned
  after pairing. The CAN travels only inside the end-to-end encrypted channel, per request.
- **Kept from agents.** Forms never ask for it, so the bridge hides it from `vault.read` and
  refuses it in `vault.save`, `browser.fillFromVault` and form fields; learnings scrub it. The
  scanner may read it: the card image already goes to the vision model.
- **On the phone,** the desktop's CAN skips the CAN step and replaces the stored one once the card
  accepts it (a new card means a new CAN). A refused one falls back to the wrong-CAN step, which
  says the CAN on the computer doesn't match, and isn't tried again while the app runs. The phone
  doesn't report it to the desktop: no existing frame fits, and the user fixes Mis datos.
- Protocol 3: phones on protocol 2 can't decode the new field, so the version check makes them
  update. Only DNI: the phone reads only DNIe, so a TIE CAN isn't kept.

## D16 — Licensing: MIT, and EUPL-1.2 for the Android app as a whole (2026-10-11)

Our code is MIT (`LICENSE`, `"license": "MIT"` in every `package.json`): the desktop app, the
packages, the services, the tools and the phone app's own source. A permissive licence lets
anyone reuse it, and keeps the desktop and services free to use any permissive dependency.

- **Desktop and services: nothing copyleft.** The desktop ships 366 third-party components
  (2026-10-11): MIT, Apache-2.0, BSD, ISC, 0BSD, BlueOak, Unlicense, Zlib and Python-2.0 (the
  PSF licence of `argparse`, through electron-updater's js-yaml; 2026-10-12), plus two OFL-1.1
  fonts (Inter, Instrument Serif), which may be bundled with any software. `node-forge` is
  "BSD-3-Clause OR GPL-2.0"; we use it under BSD-3-Clause. Electron is MIT, Chromium's notices
  ship as Electron's `LICENSES.chromium.html`, and `sa-sidecar` uses only Go's standard library
  (BSD-3-Clause). The services' dependencies are MIT, ISC, BSD and Apache-2.0 (PGlite).
- **Rule.** No copyleft (GPL, LGPL, AGPL, MPL, EUPL, CC-BY-SA) or proprietary dependency goes
  into the desktop, the services or the packages without a new decision. For the desktop,
  `apps/desktop/scripts/notices.ts` enforces it: it fails on a licence outside its permissive
  list, and its test runs with the desktop tests.
- **Phone app: our source is MIT; the Android build as distributed is EUPL-1.2.** It bundles
  jmulticard 2.1, whose files offer different licences:

  | Files | Licence offered |
  | --- | --- |
  | 170 with a header | LGPL-2.1+ or EUPL-1.1+ |
  | 12 (the PACE secure-messaging classes `DO87`, `DO8E`, `DO97`, `DO99`, `SecureMessaging`, and some callback and provider classes) | GPL-2.0+ or EUPL-1.1+ |
  | About 1,213 without a header (per the `jmulticard-base` POM) | GPL-2.0 and EUPL-1.1, no "or later" |
  | The Bouncy Castle classes in `jmulticard-crypto` | Bouncy Castle licence (MIT) |

  The EUPL is the only licence every file offers. The headerless files don't offer the LGPL,
  and GPL-2.0-only can't be combined with our Apache-2.0 dependencies (Compose, AndroidX,
  CameraX, Ktor, OkHttp), so neither is a route. EUPL-1.1 lets a work be redistributed under a
  later version (article 5), so the Android app as a whole goes out under EUPL-1.2. MIT code
  can be part of an EUPL work, and our files stay MIT on their own.
  - **What it asks of us:** every APK comes with the EUPL text and the notices, and its
    complete source must be available to whoever gets it (a public repository, or a source
    archive per release) for as long as we distribute it (`apps/mobile/NOTICE`).
  - **Linked libraries keep their own licences.** Under the European Commission's reading of
    the EUPL, linking for interoperability doesn't create a derivative work. That covers the
    Apache-2.0 libraries, and also ML Kit barcode scanning (with the Play services libraries
    it pulls in), which is proprietary. Under a strict reading of copyleft, a proprietary
    library inside an EUPL work is a risk. Replacing ML Kit with ZXing (Apache-2.0) would
    remove it, and ML Kit's Google Data Transport with it. Not done; it's an option.
- **iOS has no jmulticard, so it's plain MIT.** Our own card layer (PACE + CWA-14890), which
  iOS needs anyway, would make the Android app plain MIT too.
- **Notices.** Desktop packaging writes `THIRD_PARTY_NOTICES.txt` with `notices.ts` and ships
  it, with `LICENSE.txt`, in the app's Resources. The phone app has a "Licencias de código
  abierto" screen on its start and home screens: the EUPL-1.2, MIT, Apache-2.0, Bouncy Castle
  and BSD-3-Clause (libyuv, in CameraX) texts, the components under each, links to the source,
  and the notices of the open-source code inside ML Kit and Play services, merged from their
  AARs at build time.
- **Not covered by the MIT licence:** the files encrypted with git-crypt (production secrets,
  scanner fixtures with real ID documents), which are private, and the test fixture
  `packages/signer/test/fixtures/autoscript.min.js` (clienteafirma, GPL-2.0 / EUPL-1.1), which
  is never shipped.
- **Legal review before the APK is distributed:** the EUPL route, including EUPL-1.1 → 1.2 for
  the headerless files, and the ML Kit question.

## D17 — Desktop packaging: electron-builder, one native build per OS and CPU (2026-10-11)

Package the desktop app with electron-builder 26.17.0 (pinned; `apps/desktop/electron-builder.ts`),
not Forge: it supports pnpm's isolated `node_modules` and is what electron-vite documents
(`research/electron-packaging.md` §6.2–6.3). `corepack pnpm --filter @sa/desktop package`.

- **Targets.** macOS dmg + zip, arm64 and x64 as separate builds (a universal app would carry two
  copies of every native helper). Windows NSIS x64, per-user, no admin rights. Linux: a `.deb` x64
  only, package `spain-assist` (no AppImage, snap or apt repository; users download it from the
  release). Its maintainer is `pablo@rodriguezcaballero.me`. App id
  `es.spainassist.desktop`, product name "Spain Assist". The internal name stays
  `SpainAssistant` (the name before the rename to Spain Assist), so userData and the Keychain
  item don't move.
- **One build per OS and CPU, on that machine.** pnpm installs native packages
  (`@napi-rs/canvas`) for the host only, so `beforePack` refuses any other target. CI needs one
  runner per target, an Intel Mac included: `.github/workflows/release.yml` builds macOS arm64
  (`macos-15`), macOS x64 (`macos-15-intel`, GitHub's last Intel image, until August 2027) and
  Windows x64, plus Linux x64 (`ubuntu-24.04`), for each `v*` tag and publishes a GitHub
  Release.
- **sa-sidecar.** `beforePack` builds it for the target with Go (`CGO_ENABLED=0`, cross-builds
  with `--all`). `extraResources` copies it to `<resources>/vendor/`, outside the ASAR and
  executable. `sidecarBinaryPath` (`@sa/sidecar`) is the one lookup for dev and packaged
  builds, and a test checks that it matches the config. Packaging fails without Go;
  development still runs without it.
- **What main needs at runtime.** `out/` and the agent host (`agent-host/host.js`) go in
  app.asar. The host's external imports (pi, `typebox`, `@napi-rs/canvas`) are `dependencies`,
  collected into `app.asar/node_modules`. The host runs from the ASAR as Electron-as-Node.
  Native files are unpacked automatically. Chromium is not bundled: the app downloads it on
  first use into Playwright's cache, as in development.
- **Fuses.** `runAsNode` stays on: the agent host and Playwright's browser download need it.
  `NODE_OPTIONS` also stays on, because the same fuse gates `NODE_EXTRA_CA_CERTS` behind
  corporate proxies. Both go off when the host moves to `utilityProcess`. Everything else is
  hardened: cookie encryption, ASAR integrity, app only from the ASAR, no `--inspect`, no extra
  `file://` privileges.
- **Signing comes from environment variables, and is skipped without them.** Until the Apple
  Developer account is bought, macOS builds are ad-hoc signed: all nested code, sa-sidecar
  included, with no hardened runtime and no notarization. Gatekeeper warns once.
  `CSC_LINK`/`CSC_NAME` switch to Developer ID, the hardened runtime and the
  `packaging/entitlements.mac*.plist` files. The notarytool variables then add notarization.
  Windows uses Azure Artifact Signing (`SA_AZURE_SIGNING_*`) or a `.pfx` (`WIN_CSC_LINK`), and
  is unsigned otherwise. `PRODUCTION_CHECKLIST.md` has the steps.
- **Auto-update: D19.** Windows first; Squirrel.Mac only updates signed apps, and the macOS zip
  is already built for it.

## D18 — The DNIe PIN as a desktop credential, sent only to the paired phone (2026-10-12)

**Superseded by D20:** the PIN is no longer saved in the vault; the desktop asks for it per use
and keeps it in memory. The secrets rule and the one-try rule below still hold.

The phone asked for the DNIe PIN, kept it in memory for an hour and asked again after that. Users
who sign often would rather type it once, like their Cl@ve password. So the `dnie` credential
may hold the PIN, and the desktop gives it to the phone with the request.

- **Stored like the other credential secrets.** In the encrypted vault (`vault.bin`, AES-256-GCM
  under the OS-protected data key), on the `dnie` credential. Mis datos ("DNIe con el móvil")
  saves, changes and removes it: the renderer sends it once, in `vault.setDniePin` (zod: 8 to 16
  characters, the phone's rule). Main never sends it back; the summary says only `pin: 'saved'`
  or `'wrong'`.
- **A new secrets rule.** The PIN never goes to the renderer (beyond that one entry), agents or
  the model, logs, learnings or the QR. It leaves the desktop only to the paired phone, inside
  the end-to-end encrypted channel, because it authenticates to the card that phone reads. The
  bridge has no path to it, and refuses PIN-like keys (`pin`, `custom.pin_dnie`) in `vault.save`,
  form fields and `browser.fillFromVault`, and hides them from `vault.read`. The logger masks it,
  and learnings scrub it in case the user writes it in the chat.
- **Released per request, after the desktop's approval.** Only with `dnie-phone` on (the
  companion exists), and only after the approval the credential's policy asks for that use.
  Logins already had it: `browser.useCertificate` asks (Touch ID where available) before
  `CompanionService.login`, so every approval request of that login carries the PIN, as a `.p12`
  key stays usable after the same consent. Signatures had none: the DNIe was approved on the
  phone only. With a saved PIN and the policy "ask" (the default; Mis datos shows no policy for
  the DNIe), the desktop now shows the signature confirmation with Touch ID before the request
  goes out; declining signs nothing. Without a saved PIN nothing changes. Certificate reads
  (`selectCertificate`) never carry it. It goes once per request: as soon as the phone answers,
  `PhoneSigner` drops it from the copy it keeps for re-sending after a reconnect.
- **Wrong PIN: never more than one try.** The DNIe blocks after three wrong PINs. When the card
  refuses the desktop's PIN, the phone drops it, never retries it (not even from a request re-sent
  after a reconnect), shows the PIN step with the tries left and a line saying the PIN saved on
  the computer is wrong, and sends `sign.wrongPin` (again after a reconnect). The desktop marks
  the PIN wrong in the vault and stops sending it until the user saves a new one; Mis datos shows
  it. A blocked card (`pin_blocked`) marks it too. Independently, the phone doesn't use a PIN from
  the desktop while it knows the card has fewer than three tries left (it saw a wrong PIN and no
  PIN was accepted since): the user types it. That covers the asked-for case (one try left) and
  keeps the one-try guarantee on the phone alone, even if the report never reached the desktop.
- **On the phone, for that request only.** Never stored, never cached: the 60-minute cache stays
  for PINs the user types. The request is kept without it, and the PIN is dropped when the
  request ends. The phone never sends a PIN.
- **Protocol 4.** `sign.request` gains the optional `pin`, and `sign.wrongPin` is new. The Kotlin
  side decodes strictly, so protocol-3 phones must update.
- **Trade-offs.** The PIN now lives on the computer too: malware running as the user can read
  it from the unlocked vault, as it can the Cl@ve password. Without the card it's useless, and
  the phone's review and the card tap remain. "The paired phone" is whoever connects with the
  pairing link: until a pairing pins its phone, someone who has the QR and takes the phone's place gets the PIN with the
  next request the user approves on the desktop. Signing with a saved PIN asks on both the desktop
  and the phone. A "use automatically" policy for the DNIe would remove the desktop step; Mis
  datos doesn't offer one yet.

## D19 — Silent auto-update from GitHub Releases, and a `must-update` flag (2026-10-12)

- **electron-updater, GitHub provider.** `publish` in `electron-builder.ts` points at the public
  repo `MeLlamoPablo/SpainAssist`: electron-builder writes it into the app as `app-update.yml`
  and writes `latest.yml` next to the Windows installer. The release workflow uploads
  `latest.yml` and the installer's blockmap (differential downloads) with the installers. The app
  needs no token.
- **Windows and the Linux .deb, for now** (`updatesSupported` in
  `apps/desktop/src/main/updates/updater.ts`: packaged, not e2e, and `win32` or Linux with
  `<resources>/package-type` = `deb`). Unsigned NSIS updates work: electron-updater checks the
  installer's SHA-512 from `latest.yml`, and a publisher signature only once one is configured.
  macOS waits for Developer ID signing, because Squirrel.Mac refuses an update that isn't signed by
  the same identity. It then needs the arm64 and x64 `latest-mac.yml` merged into one in CI.
  On Linux, electron-builder writes `latest-linux.yml` next to the .deb, and electron-updater's
  `DebUpdater` downloads the new .deb and installs it on quit with `dpkg -i`, behind a pkexec
  password prompt (sudo in a terminal without polkit). There is no apt repository: the app
  updates itself, like on Windows. An unpacked build (`package:dir`) has no `package-type` and
  doesn't update.
- **Silent.** It checks 30 s after startup and every 4 hours, downloads in the background and
  installs when the app quits (`autoInstallOnAppQuit`). There's no banner. The status still
  reaches the renderer (`updates.status`, `UpdateStatus`) for the must-update screen. Stable
  versions never get prereleases (`vX.Y.Z-suffix` tags); a prerelease install keeps getting
  them (electron-updater's default).
- **Unleash knows the version.** The flags request sends `properties[appVersion]`, so a flag can
  be constrained by version (`SEMVER_LT`). Unleash's `appVersion` context field is in Terraform
  (`unleash_context_field.app_version`, `infra/terraform/unleash.tf`); the flags themselves are
  made in Unleash's UI, since the provider can't manage them.
- **`must-update`.** When it's on for this version, the app shows only the must-update screen
  (`MustUpdate.tsx`), not the onboarding and not the shell. Where the app updates itself, main
  checks at once and installs the update as soon as it's downloaded, restarting the app.
  Elsewhere (macOS), and when the update fails, the screen links to the latest
  release. The flag fails open like every flag: if Unleash can't be reached, the app works. Always
  give it a version constraint: on its own it would block every version, the newest included.
- **Trust.** Unsigned, whoever can publish a release on the repo can ship code to every Windows
  install, and every .deb install (Linux has no code signing; electron-updater checks only the
  SHA-512 in `latest-linux.yml`, from the same release). Keep release rights limited.

## D20 — The DNIe CAN and PIN are typed only on the desktop (2026-10-12)

**Partly superseded by D22:** the PIN is saved in the vault again, and Mis datos has its row
back. Everything else below still holds.

The CAN and the PIN could be typed on the phone, saved on the phone (the CAN), saved in Mis datos
(the PIN, D18) or taken from the scanned DNI (the CAN). Too many places, and the phone screen was
doing two jobs. Now the desktop asks, and the phone only reviews and reads the card.

- **One place to type them.** When a DNIe signature or login needs them, the procedure's
  `dnie_signature` card starts in the `unlock` stage and asks for what the desktop lacks: the
  CAN (unless typed earlier in this run, or Mis datos has a valid one from the scanned DNI) and
  the PIN (unless typed in the last hour; certificate reads need none). It has short help on what
  the PIN is, where it came from (the sealed envelope given with the DNI), and how to reset or
  change it (the Puntos de Actualización del DNIe in the police stations that issue the DNI, with
  the fingerprint; it can't be changed online). Only then does the request go to the phone.
- **Memory only.** The renderer sends them once (`companion.unlock`, zod: 6 digits, 8 to 16
  characters). `CompanionService` keeps the PIN for 60 minutes and the CAN while the app runs;
  nothing is written to disk. The vault's `dnie` credential has no secret any more, Mis datos has
  no PIN row, and the phone has no CAN or PIN screens and stores neither.
- **Refused ones (protocol 5).** `sign.request` always carries `can`, and `pin` except for
  certificate reads. When the card refuses one, the phone sends `sign.need` (`what`, `refused`,
  `triesLeft`) and waits; the desktop forgets that value, asks again in the same card, and answers
  `sign.unlock` with a new deadline. The request goes on. The phone keeps a hash of every refused
  CAN and PIN in memory and never tries one again (a stale value from the desktop costs no try).
  A request re-sent without its PIN after a reconnect gets `sign.need` with `refused: false`.
- **Consent.** The phone's review stays. The desktop's extra confirmation for signatures with a
  saved PIN (D18) is gone: typing the PIN is the desktop step, and logins keep
  `browser.useCertificate`'s consent.
- **Pairing lasts 72 hours** (was 12), or until the desktop app quits; the relay keeps rooms 10
  minutes longer.
- **Trade-off.** The user types the PIN about once an hour of use, like the phone used to ask.

## D21 — Web research on ChatGPT plans: OpenAI's hosted `web_search` (2026-10-12)

ChatGPT users had no web research since Exa was removed (D8), so every procedure stopped at
"research blocked" (seen in a "Renovar el permiso de conducir" run on `gpt-6.1-sol`). SIWC allows
OpenAI's hosted `web_search` "subject to model and account/workspace policy" (D8 problem 2), and
it spends the plan the user already pays for.

- **Same tool, other backend.** A procedure agent whose provider is `openai` or `openai-codex`
  with an OAuth credential (a ChatGPT plan, not an API key, which would pay per search) gets
  `web_research` with the same parameters and result shape as the voucher one (D13). It sends one
  Responses request through pi's own provider (endpoint, tokens and refresh as for the agent's
  turns) with `tools: [{type: "web_search"}]`, and returns the answer with its `url_citation`s
  as `basis`. An `outputSchema` goes into the instructions; the answer is parsed as JSON when it
  can be.
- **Mode → model and effort.** All at high effort: `fast` → `gpt-6-luna`, `balanced` →
  `gpt-6.1-sol`, `deep` → `gpt-6-astra` (`CHATGPT_RESEARCH_MODELS`). The prompt still gives no guidance on
  the mode.
- **Progress.** Each finished `web_search_call` in the stream is a progress update; the model
  waits for the one final result, as with vouchers.
- **Trade-offs.** No domain allowlist: the instructions ask for official sources and say which
  facts come from unofficial ones. Research uses the user's plan limits. Plus includes GPT-6
  Astra only in Codex and Work, as it rolls out, with 5–45 local messages per 5 h; the SIWC docs
  don't list which models plan usage can call, so `deep` may be refused or soon run out on Plus. Unverified against the
  live SIWC route; e2e runs cannot cover it (the mock LLM has no Responses API).

## D22 — The DNIe PIN is saved in the vault, and managed in Mis datos (2026-10-12)

Typing the PIN about once an hour (D20) was friction for users who sign often, and they looked
for it in Mis datos ("DNIe con el móvil") and didn't find it. The PIN goes back to the vault, like
the Cl@ve password; D20's "typed only on the desktop" and its refused-PIN protocol stay.

- **Stored on the `dnie` credential.** In `vault.bin`, encrypted like the other credential
  secrets. `CredentialSummary.hasPin` says whether it's there; nothing returns the PIN to the
  renderer. Mis datos shows "PIN del DNIe · Guardado" with *Cambiar* and *Borrar*, or "Sin
  guardar" with *Guardar PIN*. `vault.setDniePin(id, pin | null)` (zod: `DniePin`, or null to
  delete) is the only write from the renderer.
- **Saved once the card accepts it.** A PIN typed in the signature card is kept for that request
  and saved after the first signature with it succeeds, so a typo never gets saved and later
  costs a try. The in-memory 60-minute cache (`DNIE_PIN_CACHE_MS`) is gone: the vault is the
  only place the desktop remembers it.
- **Forgotten when the card says so.** A `sign.need` that refuses the saved PIN, or
  `pin_blocked`, deletes it from the vault; the card then asks for a new one, as in D20. The
  phone still never retries a refused PIN, so a stale saved PIN costs at most that one try.
- **No new desktop confirmation.** With a saved PIN, a signature goes straight to the phone,
  whose review and the card tap are the consent (D20 dropped D18's Touch ID step). Logins keep
  `browser.useCertificate`'s consent.
- **Secrets rule unchanged.** The PIN never reaches the renderer (beyond typing it), agents,
  logs, learnings or the QR. The bridge still refuses PIN-like keys. `knownSensitiveValues`
  includes it, so learnings and feedback scrub it if the user writes it in the chat.
- **Trade-off.** As in D18: malware running as the user can read it from the unlocked vault, as
  it can the Cl@ve password. Without the card it's useless, and the phone's review and the card
  tap remain.

## D23 — Web research for BYOK and custom endpoints: the user's own Exa key (2026-10-13)

BYOK and custom-endpoint users had no web research (no gateway key, D8), so every procedure
stopped at "research blocked": the app was unusable for them. They now bring an Exa key, as they
bring their model's key.

- **Tools, not `web_research`.** Their procedure agents get `exa_search` (`POST /search`) and
  `exa_fetch` (`POST /contents`) on `api.exa.ai`, and no `web_research`. Vouchers (D13) and
  ChatGPT plans (D21) keep `web_research` and their prompt, word for word. Main sets
  `research.exa` in the host config for `byok` and `custom` (they share the "no gateway key"
  path); `host/research.ts` picks the backend.
- **REST, not Exa's hosted MCP.** The host has no MCP client wired (D8's was removed), and REST
  keeps the key out of the host's environment, lets us set `userLocation` and domain hints per
  call, shape compact results, and test with a mocked `fetch`. Exa's keyless MCP is rate-limited
  and was never an option.
- **Official sources first, not only.** `exa_search` sends `userLocation: "ES"` and, by default
  (`sources: "official"`), `includeDomains` with Spanish administrations' domains (`host` and
  `*.host`, a research list separate from the credential allowlist). `sources: "any"` drops the
  filter for the long tail (small town councils); the prompt asks to check unofficial results
  against official pages.
- **The key.** In the vault (`research.exa`), set and cleared in Settings → AI provider
  (`providers.setExaKey`, zod `ExaApiKey`, or null). The renderer sees only
  `ProviderStatus.exaKey`. The host reads it over the bridge (`agent.exaKey`, procedure agents
  only, null for other providers) on every call, so a key added mid-run works without a restart,
  and sends it only in the `x-api-key` header to Exa, with redirects refused. It is redacted
  from error text and the app's logs, and never in the config, prompt, session or transcript.
  Choosing a voucher or ChatGPT, or disconnecting, deletes it.
- **No key.** The tools answer with a research blocker that says the user needs an Exa key and
  where to add it ("Ajustes → Proveedor de IA"); the prompt has the agent report it and stop
  before questions or execution, as before.
- **No key ships.** `apps/desktop/scripts/secrets.ts` fails packaging when the build has
  `EXA_API_KEY`, a literal `x-api-key`, a key in an Exa URL, Exa's MCP host or a UUID next to an
  Exa mention, or a `.env` file; its test runs the same rules on the repository's sources.
- **Trade-offs.** Queries leave the device as the model wrote them (the prompt asks for
  anonymized ones, as for `web_research`). Exa bills the user: $7 per 1,000 searches, $1 per
  1,000 pages, with $10 of free credit a month. Exa offers zero data retention only on
  Enterprise. A free account is one more setup step for non-technical users.
