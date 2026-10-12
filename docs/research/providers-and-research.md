# Inference providers, research tools and feedback server: research memo

Date: 2026-10-03. Context: [SPEC.md](../../SPEC.md). Scope: (A) inference via vouchers and "Sign in with ChatGPT", (B) research tools for the agent, (C) the feedback server (Spanish full-text search and PII scrubbing).

**How this was checked.** Everything comes from official docs fetched on 2026-10-03 (as `.md` twins where available) or from live tests run the same day from a Spanish residential IP (Telefónica). Labels used below:

- **[live]**: I called the endpoint or ran the code myself and saw the result.
- **[docs]**: taken from the vendor's official documentation (linked).
- **UNVERIFIED**: secondary source, inference, or not testable without credentials.

Live tests: BOE API, the PAG/SIA export, Catalonia SODA, Jina Reader, DuckDuckGo, Mojeek, 28 public SearXNG instances, the keyless Exa MCP, Bing in headless Chrome, Readability with linkedom and jsdom, defuddle, unpdf, pdfjs-dist, the PGlite FTS/unaccent/pg_trgm SQL, and the PII scrubber (type-checked with `tsc --strict` and unit-tested). Nothing was tested against OpenRouter, Exa, Tavily, Brave, Serper or OpenAI with paid keys, because I had no credentials.

---

## TL;DR (recommendations)

1. **Vouchers: use the OpenRouter Management API** (this is the renamed "Provisioning API"). The KMS calls `POST https://openrouter.ai/api/v1/keys` with `{name, limit, expires_at}`, returns the `key` to the client once, and stores only `data.hash`. The client calls OpenRouter directly and reads its balance from `GET /api/v1/key` (`data.limit_remaining`). `GET /api/v1/credits` **now needs a management key**, so clients cannot use it. You can restrict models and enforce ZDR with **Guardrails**: assign them per key, or set the **workspace default guardrail** on a dedicated "vouchers" workspace. A management key requires the paid Standard plan. Fee: 5.5% on credit purchases.
2. **The SPEC conflicts on "LiteLLM keys, conversations not proxied".** LiteLLM virtual keys only work when requests go through *our* LiteLLM proxy. Drop LiteLLM for vouchers. Note that OpenRouter is itself a proxy: it sees prompts but does not store them unless you opt in. Enforce ZDR with a guardrail and keep logging and broadcast off. Live LiteLLM tests (virtual keys, Exa/Parallel search and research agents): [litellm-gateway.md](litellm-gateway.md).
3. **openanonymity.ai** is a Stanford/EF-backed research project. Its "OA stations" mint **short-lived, USD-capped OpenRouter keys** in exchange for **blind-signed (Privacy Pass) tickets**, so even the station cannot link a key to a payment. It is not production infrastructure for us. Its design is worth copying later: blind-signed vouchers make the KMS unable to link a voucher purchase to a key.
4. **Sign in with ChatGPT is now official (DevDay, 2026-09-29).** There is a documented OAuth flow for **open-source, locally hosted apps** (`client_id=dynamic_agent_client`, loopback `127.0.0.1` callback, scope `chatgpt.tokens.use.direct`). Tokens are used against the **public** `https://api.openai.com/v1/responses` with `store:false, stream:true`, and `web_search` is allowed "subject to model and account/workspace policy". **pi already implements it** (`openai` provider). Do **not** use the legacy route that reuses Codex CLI's client ID against `chatgpt.com/backend-api/codex`. OpenAI's docs tell SIWC apps not to call backend-api, and impersonating Codex is a ToS risk. **Eligibility depends on SpainAssist being open-source and locally hosted.** A closed-source or paid app has to apply through OpenAI's interest form.
5. **Web search: use Exa as the primary.** `POST https://api.exa.ai/search` with `includeDomains: ["*.gob.es","boe.es",…]` and `userLocation:"ES"`. It costs $7/1k (`auto`/`fast`) or $4/1k (`instant`), with $10/month of free credits. **No dependable keyless general web search exists in 2026.** In live tests DuckDuckGo HTML/lite returned HTTP 202 bot challenges (curl, Node fetch and headless Chrome). Mojeek showed a captcha. 0 of 28 "healthy" public SearXNG instances returned JSON. Exa's keyless MCP hit its rate limit on the first call. The **free, keyless fallback should therefore be official-source tools**: the BOE API, a local index of the SIA/PAG procedure catalogue, and regional SODA/CKAN catalogues, plus the provider-native search the user already pays for (OpenRouter `openrouter:web_search` billed to the voucher, or ChatGPT's `web_search`).
6. **Official sources are machine-readable.** The BOE has a clean keyless REST API (search plus article-level blocks). The **PAG "buscador de trámites" has an official XML/CSV export** of up to 10,000 results per request. AGE alone is 7,977 procedures (34 MB XML), with SIA code, URL, requirements, identification systems (Cl@ve, certificate…), deadlines and more. Harvest it nightly server-side, respecting robots `Crawl-delay: 60` and `Visit-time: 0100-0645`, and index it next to the feedback.
7. **fetch_url**: use `@mozilla/readability` with `linkedom` (about 4x faster than jsdom in tests, same output), plus `turndown` and `turndown-plugin-gfm`. Use `defuddle` as an alternative. Decode charsets correctly, because many gov sites still serve ISO-8859-1. Extract PDF text with `unpdf`; for BOE, prefer the XML endpoints over PDFs.
8. **Postgres FTS has a pitfall.** `unaccent → spanish_stem` breaks Snowball suffixes that need accents: `renovación` becomes `renovacion`, not `renov`. Index **both** `spanish` and `spanish_unaccent`, query both, and add `pg_trgm` for typos. Verified in **PGlite 0.5.8 (Postgres 18.3)**, which ships `spanish`, `unaccent` and `pg_trgm`.
9. **PII has to be handled in layers.** (a) Redact the user's own *known* values from the local vault before upload; this is the strongest layer. (b) Deterministic regex plus checksums for DNI, NIE, CIF, IBAN, CCC, NAF, cards, phones, emails, plates, cadastre refs, addresses, DOB and case numbers (a tested module is below). (c) Optional NER: transformers.js, or Presidio, which has ES_NIF, ES_NIE and ES_PASSPORT recognizers. (d) The server re-scans and **rejects** anything that still contains PII.

---

## A. Inference via vouchers (Key Management Server)

### A1. OpenRouter Management ("Provisioning") API [docs]

OpenRouter renamed "Provisioning API keys" to **Management API keys**. `GET /api/v1/key` still returns `is_provisioning_key` alongside `is_management_key`.

**Prerequisites**

- Create a management key at <https://openrouter.ai/settings/management-keys> and give it an expiration. The expiration cannot be changed later, and an expired key returns `401 API key expired`.
- Management keys cannot call completion endpoints.
- The pricing table lists "Management API key: Free No / Standard Yes", so you need to have bought credits.
- In an organization, only Org Admins can create management keys.

**Endpoints.** Base URL `https://openrouter.ai/api/v1`, header `Authorization: Bearer <MANAGEMENT_KEY>`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/keys` | Create. Body below. Returns **201**. |
| `GET` | `/keys?offset=0&include_disabled=false&workspace_id=<uuid>` | List. The SDK comment says pages hold "the most recent 100". By default it lists only the default workspace. |
| `GET` | `/keys/{hash}` | Get one key. |
| `PATCH` | `/keys/{hash}` | Update `name`, `disabled`, `limit` (number or null), `limit_reset` (`daily`/`weekly`/`monthly`/null), `include_byok_in_limit`. A body with no accepted fields returns `400 No update fields provided`. `workspace_id` and `expires_at` cannot be changed. |
| `DELETE` | `/keys/{hash}` | Returns `{"deleted": true}`. |
| `GET` | `/credits` | Account-wide `{data:{total_credits,total_usage}}`. **Management key required** (regular keys get 403). |
| `GET` / `PATCH` | `/organization/settings` | Org accounts only (personal accounts get 404). `is_filtered_model_catalog_enabled` makes `GET /api/v1/models` return only the models a key may use. |

**Create a key: request**

```http
POST https://openrouter.ai/api/v1/keys
Authorization: Bearer $OPENROUTER_MANAGEMENT_KEY
Content-Type: application/json

{
  "name": "voucher-7f3a",                     // required, ≥1 char
  "limit": 5,                                  // USD; omit for unlimited
  "limit_reset": null,                         // "daily" | "weekly" | "monthly" | null (resets 00:00 UTC; weeks Mon–Sun)
  "include_byok_in_limit": false,
  "expires_at": "2027-04-01T00:00:00Z",        // ISO 8601 UTC, seconds required; other TZ rejected
  "workspace_id": "<vouchers-workspace-uuid>"  // optional; default workspace otherwise
  // also accepted: "creator_user_id", "external": {"user": "...", "api_key": "..."}
}
```

**Create a key: response (201).** The plaintext key appears **only here**, in top-level `key`. Every later operation uses `data.hash`.

```json
{
  "key": "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",
  "data": {
    "hash": "f01d52606dc8f0a8303a7b5cc3fa07109c2e346cec7c0a16b40de462992ce943",
    "name": "My New API Key", "label": "My New API Key", "disabled": false,
    "limit": 50, "limit_remaining": 50, "limit_reset": "monthly", "include_byok_in_limit": true,
    "usage": 0, "usage_daily": 0, "usage_weekly": 0, "usage_monthly": 0,
    "byok_usage": 0, "byok_usage_daily": 0, "byok_usage_weekly": 0, "byok_usage_monthly": 0,
    "created_at": "2025-08-24T10:30:00Z", "updated_at": null, "expires_at": "2027-12-31T23:59:59Z",
    "external_user": null, "creator_user_id": "user_…", "workspace_id": "0df9e665-…"
  }
}
```

In list responses `label` holds a masked key (`"sk-or-v1-abc...123"`). Errors are 400, 401, `403 "Only management keys can perform this operation"`, 429 and 500.

**Client-side balance check, using the client's own key**

```http
GET https://openrouter.ai/api/v1/key
Authorization: Bearer sk-or-v1-…
```

The response contains `data.{label, limit, limit_remaining, limit_reset, include_byok_in_limit, usage, usage_daily, usage_weekly, usage_monthly, byok_usage*, is_free_tier, is_management_key, is_provisioning_key, expires_at, allowed_data_regions, free_model_daily_requests{used,limit,remaining}, workspace_id, …}`. The `rate_limit` object is deprecated.

When a key runs out, requests fail with **402** and `error.metadata.limit_source = "openrouter_key_limit"`. Branch on `limit_source`, not on the message text.

**Restricting models (Guardrails)** [docs]

A guardrail can hold:

- `allowed_models` and `ignored_models` (slugs)
- `allowed_providers` and `ignored_providers`
- `enforce_zdr_{anthropic,openai,google,xai,other}`
- `enable_paid_model_training`, `enable_free_model_training` and `enable_free_model_publication`
- `limit_usd` together with `reset_interval`
- `allowed_data_regions` (needs a Business or Enterprise plan)
- regex `content_filters` and `content_filter_builtins` (PII presets)

A guardrail **enforces nothing until it is assigned**. A key can hold one guardrail. When several apply, allowlists are intersected and "the lower limit wins".

```http
POST https://openrouter.ai/api/v1/guardrails
{ "name": "spainassist-vouchers",
  "allowed_models": ["anthropic/claude-…", "openai/gpt-…", "google/gemini-…"],
  "enforce_zdr_anthropic": true, "enforce_zdr_openai": true, "enforce_zdr_google": true, "enforce_zdr_other": true,
  "enable_paid_model_training": false, "enable_free_model_training": false, "enable_free_model_publication": false }

POST https://openrouter.ai/api/v1/guardrails/{id}/assignments/keys
{ "key_hashes": ["f01d5260…"] }            → { "assigned_count": 1 }
```

Instead of assigning per key, you can create the keys in a dedicated workspace and PATCH that **workspace's default guardrail** (named `Workspace <uuid> Default`) through `PATCH /api/v1/guardrails/{id}`. That applies to all traffic in the workspace. Standard accounts are limited to 5 workspaces. Pooled **workspace budgets** are Enterprise-only.

**Costs, limits and privacy** [docs]

- **Fees.** 5.5% on credit purchases ($0.80 minimum) by card, 5% by crypto, and no markup on inference. Refunds are possible only within 24 h. OpenRouter "reserve[s] the right to expire unused credits after one year".
- **Rate limits.** Paid models pass through the provider's limits. `:free` models allow 20 rpm and 50 rpd, or 1,000 rpd once ≥$10 has ever been purchased. Creating more keys does not raise global limits.
- **In-flight budget.** Low-balance accounts and new accounts without spending history can get `402 in_flight_budget_exhausted` when many requests run at once. Keep a healthy balance with auto top-up, since all voucher keys draw from our balance.
- **Management API.** Rate limits for the management API itself are not documented (UNVERIFIED). Key creation has no fee.
- **Privacy.** OpenRouter "does not store your prompts or responses, *unless* you opt in" (I/O logging, or the 1% discount for allowing data use). It does store per-request metadata. Keep I/O logging, Broadcast/observability destinations and data use **off**, and enforce ZDR with the guardrail. The OA project's verifier checks exactly these toggles, because Broadcast would forward prompts back to the key owner.
- **Alternative to vouchers.** OpenRouter's **OAuth PKCE** lets a user connect their *own* OpenRouter account. Send them to `https://openrouter.ai/auth?callback_url=http://localhost:<any-port>/cb&code_challenge=…&code_challenge_method=S256`, then exchange the code with `POST https://openrouter.ai/api/v1/auth/keys` `{code, code_verifier, code_challenge_method}`. This is a good "advanced" option that needs no KMS.

**KMS redeem flow** (sketch, untested)

```ts
// POST /v1/vouchers/redeem { code }  -> { key, limitUsd, expiresAt }
// 1. tx: SELECT … FOR UPDATE voucher WHERE code_hash = sha256(code) AND status='unused' → status='redeeming'
// 2. create key (store nothing but the hash; never log the response body)
const r = await fetch("https://openrouter.ai/api/v1/keys", {
  method: "POST",
  headers: { Authorization: `Bearer ${env.OPENROUTER_MANAGEMENT_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ name: `v-${crypto.randomUUID().slice(0, 8)}`, limit: voucher.usd, limit_reset: null,
    include_byok_in_limit: false, expires_at: isoPlusDays(180), workspace_id: env.OR_VOUCHER_WORKSPACE }),
});
const { key, data } = await r.json();            // data.hash
// 3. tx: voucher.status='redeemed', voucher.or_key_hash=data.hash  (or store only batch_id → hash for unlinkability)
// 4. return { key, limitUsd: data.limit, expiresAt: data.expires_at } — client stores key in OS keychain
// Cron: DELETE /api/v1/keys/{hash} for expired/exhausted keys (GET /api/v1/keys?offset=… to sweep).
```

### A2. Alternatives for capped keys without proxying conversations

| Option | Prompts go through **our** server? | Per-key USD cap via API | Model restriction | Requirements | Verdict |
|---|---|---|---|---|---|
| **OpenRouter management keys** | No (client → OpenRouter → provider) | Yes (`limit`, `limit_reset`, `expires_at`) | Yes (guardrails) | Standard paid account | **MVP choice** |
| **LiteLLM virtual keys** (`POST /key/generate` with `max_budget`, `budget_duration`, `models`, `duration`) | **Yes.** Keys are only checked by *our* LiteLLM proxy, which needs a master key and Postgres [docs] | Yes | Yes | Self-host proxy + Postgres | Contradicts "not proxied". Drop it for vouchers. |
| **Open Anonymity (OA)**, openanonymity.ai | No. The client talks to the provider directly with an ephemeral key. | Yes: the station mints OpenRouter keys (reference tiers: 1/2/3 tickets → $2/$3/$4 for 60 min) | Through the station's OpenRouter account | Tickets (Stripe), or zkAPI with an ETH deposit; Python SDK only | Research project (Stanford; EF and HRF grants). Not for MVP. Copy the blind-voucher idea. |
| **Requesty** key management API (`https://api.requesty.ai/v1/manage/apikey`) | Yes (it is a gateway) | Monthly limit (`POST /v1/manage/apikey/{id}/limit`) | Yes | **Enterprise only** [docs] | No |
| **Portkey** budgets | Yes (gateway) | Cost or token budgets per API key | Yes | Enterprise and "select Pro" [docs] | No |
| **OpenRouter OAuth PKCE** | No | The user's own account | The user's own settings | User has an OpenRouter account | Good as a BYOK-lite option |

**How OA works** [docs: blog posts and the GitHub reference implementation]

- The user buys **inference tickets**, which are blind-signed (Privacy Pass / RSA blind signatures, RFC 9474), with Stripe. Alternatively, zkAPI with an ETH deposit (launched 2026-09-25 with the Ethereum Foundation).
- The user presents tickets to a station: `POST /api/request_key` with header `Authorization: InferenceTicket token=<t>` or `tokens=<t1>,<t2>`.
- The station verifies the tickets without learning who the user is. It calls `POST https://openrouter.ai/api/v1/keys` with its `OPENROUTER_MANAGEMENT_KEY`, `{name, limit}`, and returns an **ephemeral, USD-capped key**. A cleanup job deletes expired keys.
- An attested TEE verifier (`verifier.openanonymity.ai`, Azure SEV-SNP) checks the stations' OpenRouter privacy toggles.
- OA claims prompts never pass through OA. This holds as long as the station does not collude with the provider, for example by enabling OpenRouter Broadcast.
- Repos: [oa-station-reference](https://github.com/OpenAnonymity/oa-station-reference) (MIT), [oa-sdk](https://github.com/OpenAnonymity/oa-sdk) (Python, work in progress), [oa-verifier](https://github.com/OpenAnonymity/oa-verifier).
- **API compatibility:** keys are plain OpenRouter keys, so they are OpenAI-compatible at `https://openrouter.ai/api/v1`.

**Recommendation.** Use OpenRouter management keys for MVP. Later, (a) make vouchers blind-signed tokens (Privacy Pass), so the KMS cannot link a voucher purchase to a key, and (b) optionally accept OA tickets as another provider.

### A3. "Sign in with ChatGPT" for Plus and Pro

**Status (2026-10)** [docs]

- SIWC launched as identity-only in July 2026 (UNVERIFIED date; secondary press). On 2026-09-29 (DevDay) it was extended to let **Plus and Pro** users spend their plan allowance in third-party apps.
- Docs: <https://developers.openai.com/siwc>. "Sign in with ChatGPT is currently available to selected commercial partners through a limited trial. **ChatGPT plan usage is available to all open-source partners and selected private clients.**"
- The OSS docs "explain ChatGPT plan usage for **open-source and locally hosted apps**. If you're interested in offering it in a **paid or remotely hosted app**, complete the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)."
- Listed OSS integrations: OpenClaw, OpenCode, **Pi**, T3. Commercial partners include Amp, Devin, Notion, Vercel, Warp, Kilo Code and others.
- Usage counts toward the user's normal plan limits. Users can cap each app as a percentage of their weekly plan usage (Settings → Usage → App limits). The app gets no access to conversations or memories.

**Official OSS flow** [docs: siwc/token-sharing-open-source/*]

1. **Before the first login**, persist a per-installation `ext_agent_host_id`. It can be `urn:uuid:<uuidv4>`, `urn:ietf:params:oauth:jwk-thumbprint:…` (preferred, RFC 9278) or `did:key:…`. Never use the email or user ID.
2. Start a loopback listener, generate `state`, `nonce` and a PKCE verifier, and open the system browser at:

```
https://auth.openai.com/api/accounts/authorize?
  client_id=dynamic_agent_client            # first registration; afterwards the issued oaiapp_… id
  &agent_name_hint=SpainAssist           # first registration only
  &ext_agent_host_id=urn%3Auuid%3A…
  &response_type=code
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback   # 127.0.0.1 (not localhost); later logins may change only the port
  &scope=openid%20profile%20email%20offline_access%20resource.invoke%20chatgpt.tokens.use.direct
  &resource=https%3A%2F%2Fapi.openai.com%2Fv1
  &state=…&nonce=…&code_challenge=…&code_challenge_method=S256
  [&id_token_hint=… &login_hint=…]          # re-auth
```

3. The callback receives `?code&state&scope&client_id=<oaiapp_…>`. Persist the issued `client_id` per ChatGPT account.
4. Exchange the code: `POST https://auth.openai.com/api/accounts/oauth/token` (form-encoded) with `grant_type=authorization_code, client_id=<issued>, code, code_verifier, redirect_uri, resource=https://api.openai.com/v1`. No client secret is needed. The response contains `access_token` (1 h), `refresh_token` (30 days, rotating), `id_token`, `scope`, `expires_in` and `earliest_refresh_at`.
5. Validate the ID token against the JWKS: issuer `https://auth.openai.com`, audience equal to the issued `client_id`, and the nonce. **Proceed only if `scope` contains `chatgpt.tokens.use.direct`.**
6. Refresh with the same token endpoint: `grant_type=refresh_token, client_id, refresh_token, resource`. Serialize refreshes. Revoke at the `revocation_endpoint` from `https://auth.openai.com/.well-known/openid-configuration`.
7. Get the models: `GET https://api.openai.com/v1/models` with the bearer token, then `.models[] | select(.visibility=="list") | {slug, display_name}`.
8. Run inference: `POST https://api.openai.com/v1/responses` with `"store": false, "stream": true`, `input` as an array, and instructions in `instructions` or developer messages (system-role items are rejected).

**Preview limits** [docs]

- **Fields that must be omitted:** `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user`. Over HTTP, `previous_response_id` is not accepted either.
- **Tools:** put function/custom tools in namespaces or in `additional_tools`. "Web search remains subject to model and account/workspace policy."
- **Unsupported tools:** image generation, file search, Code Interpreter, computer use, hosted MCP, `tool_search`.
- **Errors:**
  - `subscription_sharing_usage_limit_exceeded` (429): link the user to <https://chatgpt.com/settings/usage>.
  - `…_user_not_eligible` (403).
  - `…_unsupported_capability` (400; read `error.param`).
  - Errors can arrive mid-stream as `response.failed`.
- **UX:** label the button **Continue with ChatGPT**, show "Using ChatGPT plan" next to the model picker, and add a **Manage usage** link.

**Web search on this route.** An independent probe on 2026-09-30 found that `web_search` works on both the SIWC and Codex routes. See the [codegraff ADR 0221](https://github.com/justrach/codegraff/blob/main/docs/adr/0221-chatgpt-new-sign-in.md). It is third-party evidence (UNVERIFIED by me). Codex CLI's `--search` emits `web_search` items [docs: learn.chatgpt.com/docs/web-search].

**Models (Plus vs Pro)** [docs: learn.chatgpt.com/docs/pricing, /models]

- **Plus ($20):** "GPT-6.1 Sol and GPT-6 Luna". GPT-6 Astra (5–45) and GPT-6 Sol (15–150) also appear in the Plus usage table, with estimated local messages per 5 h.
- **Pro ($100/$200/$500):** "everything in Plus", currently no 5-hour limit, and Astra Ultrafast on Pro $500.
- **GPT-5.5 retires from ChatGPT and Codex on 2026-10-14.**
- Which models SIWC actually exposes depends on the account. Always use `GET /v1/models`.

**pi** [code]

- `earendil-works/pi`, `packages/ai/src/auth/oauth/openai-chatgpt.ts` implements this flow. Its constants are `AUTHORIZE_URL`, `TOKEN_URL`, `RESOURCE`, `127.0.0.1:1455/auth/callback` and the scope above. It hard-codes **`agent_name_hint = "Pi"`**. SpainAssist should get that made configurable upstream, or run its own login and hand the credential to pi (UNVERIFIED how pi ingests external OAuth credentials).
- pi still ships the legacy provider as "OpenAI Codex (legacy)".
- More pi detail is in [pi.md](pi.md), the separate pi memo: `LoginOptions.getDeviceId()` must return a stable UUID for `ext_agent_host_id`, pi strips the request fields the subscription token rejects, and extensions can register custom OAuth providers.
- **Conflict:** [DECISIONS.md](../DECISIONS.md) D3 currently says "pi-ai's `openai-codex` OAuth flow". It should switch to the `openai` (SIWC) provider.

**Legacy Codex OAuth route** (for reference only; not recommended) [code: openai/codex, pi]

| Item | Value |
|---|---|
| Authorize | `https://auth.openai.com/oauth/authorize` |
| Token | `https://auth.openai.com/oauth/token` (device code: `/api/accounts/deviceauth/usercode` and `/token`) |
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` (Codex CLI's own) |
| Redirect | `http://localhost:1455/auth/callback`; current Codex uses `127.0.0.1:1455` |
| Scope | `openid profile email offline_access`; Codex now also requests `api.connectors.read api.connectors.invoke` |
| Extra params | `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`, `originator=codex_cli_rs` |
| Inference | `POST https://chatgpt.com/backend-api/codex/responses` with headers `chatgpt-account-id` (from the access-token claim `https://api.openai.com/auth`), `OpenAI-Beta: responses=experimental` and `originator`. `store` must be `false`. |

**ToS and breakage risk.** This route makes a third-party app present itself as Codex CLI and calls an internal endpoint. OpenAI's SIWC docs now explicitly say "do not point it at ChatGPT's `backend-api` endpoints". Expect blocking or account action at OpenAI's discretion (UNVERIFIED enforcement). Use the official flow instead.

---

## B. Research tools for the agent

### B4. Web search APIs

| Service | API | Price (2026-10) | Free tier | Domain filter | Notes |
|---|---|---|---|---|---|
| **Exa** [docs] | `POST https://api.exa.ai/search`, header `x-api-key` or `Authorization: Bearer` | `instant` $4/1k, `fast`/`auto` $7/1k (≤10 results, then +$1/1k results), `deep*` $12–15/1k, `/contents` $1/1k pages, summaries +$1/1k | **$10 credits every month** (~2,500 instant searches) plus $10 one-time; no card | `includeDomains`/`excludeDomains`, ≤1,200 entries, accepts `host`, `host/path` and `*.host`; also `userLocation:"ES"`, `startPublishedDate`, `includeText` | 10 QPS. `contents.maxAgeHours` (0 = fresh fetch). ZDR on Enterprise only. Keyless hosted MCP at `https://mcp.exa.ai/mcp` (rate-limited; see test). |
| **Brave Search** [docs] | `GET https://api.search.brave.com/res/v1/web/search?q=&country=ES&search_lang=es`, header `X-Subscription-Token` | $5/1k (Search plan); Answers $4/1k + tokens | **The 5k/month free plan is gone for new users (Feb 2026).** $5 of monthly credits instead; card required | `site:` operators or Goggles (no include list; UNVERIFIED) | 50 QPS. Storing results needs a plan with storage rights. Has an "LLM Context" endpoint. |
| **Tavily** [docs] | `POST https://api.tavily.com/search`, `Authorization: Bearer tvly-…` | basic = 1 credit, advanced = 2; PAYG $0.008/credit; plans $30/4k … $500/100k | **1,000 credits/month, no card** | `include_domains` (≤300), `exclude_domains` (≤150), `country` boost | `search_depth: basic\|advanced\|fast\|ultra-fast`, `include_raw_content: "markdown"`, `/extract` (1 credit per 5 URLs) |
| **Serper** (Google SERP) [site] | `POST https://google.serper.dev/search`, header `X-API-KEY`, body `{q, gl:"es", hl:"es", num, page, tbs}` | $50/50k ($1/1k) down to $0.30/1k at 12.5M; credits valid 6 months | **2,500 free queries** (one-time) | `site:` in `q` | 50 QPS on Starter. Results are Google snippets only (fetch pages yourself). |
| **Jina** [docs] | `https://s.jina.ai/?q=` (search), `https://r.jina.ai/<url>` (reader) | Token-based; 10M free tokens per new key | **r.jina.ai works without a key (20 RPM) [live]**; s.jina.ai returns `401` without a key [live] | (search) UNVERIFIED | Reader handles PDFs and JS pages. Useful as a `fetch_url` fallback, not as a keyless search. |
| **OpenRouter web** [docs] | Plugin `plugins:[{id:"web", engine, max_results, include_domains, exclude_domains}]` or `model:"…:online"`; preferred: server tool `tools:[{type:"openrouter:web_search", parameters:{engine:"exa", max_results, max_total_results, allowed_domains, excluded_domains, max_uses}}]` | Exa engine $0.007/request (+$0.001 per result over 10); Parallel $0.001–0.005; Perplexity $0.005; native search passes through provider pricing | Billed to the same key (voucher), so no extra key | Yes (engine-dependent; Anthropic native: include *or* exclude; OpenAI native: include only; Google native: none) | Server tool is **beta**. Not available on `eu.openrouter.ai`. Results arrive as `url_citation` annotations. |
| **OpenAI `web_search`** (SIWC route) | Hosted Responses tool | Counts against the ChatGPT plan | n/a | UNVERIFIED on this route | Allowed "subject to model and account/workspace policy" [docs] |

**Keyless options: live results (2026-10-03, Spanish residential IP)**

| Option | Result |
|---|---|
| `POST https://html.duckduckgo.com/html/` (curl and Node fetch) | **HTTP 202 "anomaly" bot challenge**, 0 results, on the first request |
| `lite.duckduckgo.com/lite/`, `duckduckgo.com/?q=` in headless Chrome (Playwright) | Same 202 challenge (IP possibly flagged by earlier probes; reliability for normal users UNVERIFIED) |
| Mojeek `www.mojeek.com/search?q=` (fetch / headless) | JS captcha / 403. Mojeek sells a paid Search API. |
| Public SearXNG (`format=json`), the 28 instances searx.space lists as healthy | **0/28** returned JSON results (429, 403, HTML) |
| Exa hosted MCP, keyless (`tools/call web_search_exa`) | Protocol works (MCP 2025-06-18; tools `web_search_exa`, `web_search_advanced_exa` with `includeDomains`, `web_fetch_exa`), but the **first call returned "You've hit Exa's free MCP rate limit"** |
| Bing SERP in headless Chrome | Returned 10 results, but scraping is against Bing's terms. **The #1 result for "cita previa DNI" was an unofficial site (citapreviadnie.es)**, which is exactly the accuracy risk to guard against. |

**Recommendation**

- **Primary: Exa.** Call it from the client-side `web_search` tool through a small **search proxy on our backend** (KMS). That gives the same behavior for every inference provider, puts the domain allowlist under our control, needs no user key and logs no queries. For voucher users you can instead use OpenRouter's `openrouter:web_search` with `engine:"exa"` and `allowed_domains`, billed to their voucher. Run the PII scrubber (C8) on outgoing queries, because queries can contain personal data.
- **Search strategy.** Pass 1 uses `includeDomains` = official allowlist and `userLocation:"ES"`. Pass 2 runs only if needed, without the filter, and marks results as *unofficial* to the model.
- **Bootstrap the allowlist from the SIA export**: the hosts of the `url` field (B5), plus `*.gob.es`, `boe.es`, `*.boe.es`, `seg-social.es`, `policia.es`, `dnielectronico.es`, `dgt.es`, `sepe.es`, and the regional domains `gencat.cat`, `juntadeandalucia.es`, `comunidad.madrid`, `madrid.es`, `euskadi.eus`, `xunta.gal`, `gva.es`, `jcyl.es`, `aragon.es`, `navarra.es`, `carm.es`, `gobiernodecanarias.org`, `caib.es`, `asturias.es`, `cantabria.es`, `castillalamancha.es`, `juntaex.es`, `larioja.org`, `ceuta.es`, `melilla.es`. The list's completeness is UNVERIFIED. Whether `gob.es` alone matches subdomains in Exa is UNVERIFIED, so also list `*.gob.es`.
- **Free fallback with no API key.** Use the **official-source tools in B5**: the BOE API, a local or server index of the SIA/PAG catalogue, regional SODA/CKAN catalogues, and `r.jina.ai`/local `fetch_url` for reading. Also use the **provider-native search the user already has**: ChatGPT `web_search`, or the OpenRouter server tool on vouchers. Do not ship DuckDuckGo or SearXNG scraping as a dependency. If you want a keyless general engine anyway, self-host SearXNG on the backend (UNVERIFIED stability: its upstream engines also rate-limit).

### B5. Official Spanish sources with machine-readable access

#### BOE open data API [live] [docs]

Base URL `https://www.boe.es/datosabiertos/api/`. GET only, keyless. Set the format with the `Accept` header. Technical docs: [APIconsolidada.pdf](https://www.boe.es/datosabiertos/documentos/APIconsolidada.pdf) (dated 2025-09-02), [APIsumarioBOE.pdf](https://www.boe.es/datosabiertos/documentos/APIsumarioBOE.pdf). Reuse conditions: <https://www.boe.es/informacion/aviso_legal/index.php#reutilizacion>.

| Endpoint | Formats | Use |
|---|---|---|
| `legislacion-consolidada?query=<json>&from=AAAAMMDD&to=AAAAMMDD&offset=&limit=` (default 50; −1 = all) | xml, **json** | Search consolidated laws |
| `legislacion-consolidada/id/{id}` | xml | Full law |
| `…/id/{id}/metadatos`, `…/analisis` | xml, json | Metadata; subjects, notes and references |
| `…/id/{id}/metadata-eli` | xml | ELI |
| `…/id/{id}/texto` | xml | Full consolidated text |
| `…/id/{id}/texto/indice` | xml, json | Block list (preámbulo, a1, a2, …) |
| `…/id/{id}/texto/bloque/{id_bloque}` | **xml only** (JSON returns 400) | One article, with its version history |
| `boe/sumario/{AAAAMMDD}` | xml, json | Daily BOE summary |
| `borme/sumario/{AAAAMMDD}` | xml, json | Daily BORME summary |
| `datos-auxiliares/{materias,ambitos,estados-consolidacion,departamentos,rangos,relaciones-anteriores,relaciones-posteriores}` | xml, json | Code tables |
| `https://www.boe.es/diario_boe/xml.php?id=BOE-A-…` and `…/txt.php?id=…` | xml, html | Any published BOE item (avoids PDF parsing) |

**Query syntax**

- JSON of the form `{"query":{"query_string":{"query":"…"},"range":{…}},"sort":[…]}`.
- Fields: `titulo`, `texto` (full text), `materia@codigo`, `departamento@codigo`, `rango@codigo`, `ambito@codigo`, `estado_consolidacion@codigo`, `fecha_publicacion`, `fecha_disposicion`, `numero_oficial`, `diario_numero`, `vigencia_agotada`.
- Operators `and`/`or`/`not` and parentheses.
- `range` works on date fields: `{"fecha_publicacion":{"gte":"19990101","lte":"19991231"}}`.

```bash
curl -s -G -H "Accept: application/json" "https://www.boe.es/datosabiertos/api/legislacion-consolidada" \
  --data-urlencode 'query={"query":{"query_string":{"query":"titulo:(procedimiento and administrativo) and vigencia_agotada:N"}},"sort":[{"fecha_publicacion":"desc"}]}' \
  --data-urlencode 'limit=3'
```

```json
{"status":{"code":"200","text":"ok"},"data":[{"fecha_actualizacion":"20260216T092301Z","identificador":"BOE-A-2022-18104",
 "ambito":{"codigo":"1","texto":"Estatal"},"departamento":{"codigo":"4810","texto":"Ministerio de Justicia"},
 "rango":{"codigo":"1350","texto":"Orden"},"fecha_disposicion":"20221031","numero_oficial":"JUS/1052/2022",
 "titulo":"Orden JUS/1052/2022, de 31 de octubre, por la que se regula el procedimiento …","fecha_publicacion":"20221104",
 "fecha_vigencia":"20221105","vigencia_agotada":"N","estado_consolidacion":{"codigo":"3","texto":"Finalizado"},
 "url_eli":"https://www.boe.es/eli/es/o/2022/10/31/jus1052","url_html_consolidada":"https://www.boe.es/buscar/act.php?id=BOE-A-2022-18104"}]}
```

Measured latency: about 0.14 s for title search and 0.5 s for `texto:"documento nacional de identidad"`.

```bash
curl -s -H "Accept: application/xml" https://www.boe.es/datosabiertos/api/legislacion-consolidada/id/BOE-A-2015-10565/texto/bloque/a16
```

```xml
<response><status><code>200</code><text>ok</text></status><data>
 <bloque id="a16" tipo="precepto" titulo="Artículo 16">
  <version id_norma="BOE-A-2015-10565" fecha_publicacion="20151002" fecha_vigencia="20161002">
   <p class="articulo">Artículo 16. Registros.</p>
   <p class="parrafo">1. Cada Administración dispondrá de un Registro Electrónico General, …</p>
```

**Daily summary.** Each item has `{identificador, control, titulo, url_pdf{texto,szBytes,pagina_inicial,pagina_final}, url_html, url_xml}`. The path is `sumario/diario/seccion/departamento/[epigrafe]/item`. In the JSON form, single children become objects and repeated children become arrays, so normalize, or just use XML.

#### Punto de Acceso General: SIA procedure catalogue [live]

- SIA ([about](https://administracion.gob.es/espanaadmon/sia)) is the legally mandated catalogue (Ley 39/2015, art. 21.4) of procedures and services from the AGE, CCAA, local entities and universities. **There is no documented public REST API.** SIA web services exist for public administrations only (UNVERIFIED for third parties). No national SIA dataset was found on datos.gob.es.
- The **"Buscador de trámites" page** (<https://administracion.gob.es/tramites-electronicos/resultadosActuaciones>) has an **official "Exportar a XML / Exportar a CSV" button (max 10,000 results)**. It POSTs the search form to:

```bash
curl -s -X POST "https://administracion.gob.es/content/sling/endpoints/pag/front-elastic/actuacion-elastic/descargar" \
  -H "Accept: application/octet-stream" -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8" \
  -H "Referer: https://administracion.gob.es/tramites-electronicos/resultadosActuaciones" \
  --data-urlencode "serviceCurrentPathPage=/content/pag-home/es/tramites-electronicos/resultadosActuaciones/jcr:content" \
  --data-urlencode "pag_orders=relevancia" \
  -d "pag_ambito=1&type=xml&exportSize=10000&pag_tam=10000&tam=10000&p=0&pag_desde=0&numRegistrosMostrar=10000&p.limit=10000"
# → 200, Content-Disposition: attachment; filename="Actuaciones.xml"; 7,977 <actuacion> for pag_ambito=1 (AGE), 34 MB, 12 s
```

A request without the `Referer` header and the `serviceCurrentPathPage`/`pag_orders` fields got a **403**. With them it got a 200. With `type=csv`, pick columns with repeated `exportarChecks[]=codigoActuacion|denominacion|url|organismoResponsable.desDepartamento|descripcion|efectoSilencio|formaIniciacion|materias.desmateria|normativa|requisitosIniciacion|sistemasIdentificacion.dessistemaidentificacion|…`. The CSV is `;`-separated.

**Filters**

- `pag_descripcion` (free text)
- `pag_codigoActuacion` (SIA code)
- `pag_ambito`: 1 AGE, 2 autonómica, 3 local, 4 universidades, 5 otras
- `pag_comunidadAutonoma` (1–19)
- `pag_ministerios` (DIR3 codes, e.g. `E00003801` Interior)
- `pag_materias` (e.g. 44 "Ciudadanía y nacionalidad")
- `pag_orders`

**Sample record** (trimmed, real):

```xml
<actuacion><codigoActuacion>203129</codigoActuacion><denominacion>Cita previa  para DNI  y/o pasaporte</denominacion>
 <url>https://sede.policia.gob.es/portalCiudadano/sede/inf_dni.html</url><desNivelAdministracionElectronica>…</desNivelAdministracionElectronica>
 <organismoResponsable><desDepartamento>Ministerio del Interior</desDepartamento>…</organismoResponsable>
 <requisitosIniciacion>…</requisitosIniciacion><plazoResolucion>…</plazoResolucion><sujetoATasas>N</sujetoATasas><finVia>…</finVia>
 <sistemasIdentificacion><dessistemaidentificacion>Cl@ve permanente</dessistemaidentificacion></sistemasIdentificacion>
 <materias><desmateria>Ciudadanía y nacionalidad</desmateria></materias><fechaUltimaActualizacion>…</fechaUltimaActualizacion></actuacion>
```

**Use it this way**

- Harvest **server-side, nightly**, sliced by `pag_ambito` × `pag_comunidadAutonoma` (and `pag_materias` if any slice exceeds 10k). Store it in Postgres with the same FTS as the feedback, and expose a `find_procedure(query, region)` tool.
- Respect [robots.txt](https://administracion.gob.es/robots.txt): `Crawl-delay: 60`, `Visit-time: 0100-0645` GMT; `/content/pag-home/` is disallowed (the export endpoint lives under `/content/sling/…`).
- Reuse terms for PAG data are UNVERIFIED; check before redistributing the data inside the app.
- **Data quality:** some URLs are broken. Interior's DGT entry 202334, for example, has a concatenated URL. Some descriptions are generic, such as "Expedición y renovación del DNI → http://www.policia.es/". Treat the export as an index, not ground truth, and still fetch the official page.

#### Regional catalogues [live where noted]

- **Catalunya (Socrata):** "Catàleg de procediments administratius" `https://analisi.transparenciacatalunya.cat/resource/9p3b-4s2k.json?$limit=…&$q=…` [live: returns `codi_proces, procediment_administratiu, tramit_a_realitzar, departament_responsable, tramitaci_electronica, sentit_del_silenci, enllac_portal_tramits_gencat`]. Also "Tràmits de la Generalitat" `mpt8-vn6c`.
- **Castilla y León:** `https://datosabiertos.jcyl.es/web/jcyl/risp/es/sector-publico/tramites/1284165766476.{json,csv,xml}`. It returned **502** during the test; retry.
- **Andalucía (CKAN):** dataset "Catálogo de procedimientos administrativos de la Junta de Andalucía", found via `https://www.juntadeandalucia.es/datosabiertos/portal/api/3/action/package_search?q=procedimientos` [live].
- **Canarias, Aragón and several municipalities** are listed on datos.gob.es. API: `https://datos.gob.es/apidata/catalog/dataset/keyword/procedimientos.json?_pageSize=50` [live].
- Madrid and Euskadi procedure APIs are UNVERIFIED (the endpoints I guessed redirected or returned 404).

### B6. `fetch_url`: HTML→Markdown and PDF→text in Node [live]

| Package (latest, license) | Role | Measured |
|---|---|---|
| `@mozilla/readability` 0.6.0 (Apache-2.0) | Main-content extraction | Same output on linkedom and jsdom |
| `linkedom` 0.18.13 (ISC) | Fast DOM | 27–34 ms per page vs jsdom 106–125 ms (2 gov pages) |
| `jsdom` 29/30 (MIT) | Spec-complete DOM (the DOM Readability recommends) | Use if linkedom breaks on a page |
| `turndown` 7.2.4 + `turndown-plugin-gfm` (MIT) | HTML→Markdown (GFM tables) | Use the GFM plugin; gov pages are table-heavy |
| `defuddle` 0.19.4 (MIT) | Alternative extractor with built-in Markdown | `Defuddle(document, url, {markdown:true})` worked on linkedom, 84 ms |
| `unpdf` 1.8.1 (MIT, wraps PDF.js) | PDF→text | 18-page BOE PDF in 158 ms; 1-page BOE item in 71 ms |
| `pdfjs-dist` 6.3.289 (Apache-2.0) | PDF→text (use `pdfjs-dist/legacy/build/pdf.mjs` in Node) | Same output as unpdf, 68 ms |
| `tesseract.js` 7 (Apache-2.0) | OCR for scanned PDFs (`spa` model) | Not tested |
| Avoid `mupdf` (AGPL) in a closed-source app | | |

```ts
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { extractText, getDocumentProxy } from "unpdf";

const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" }).use(gfm);
td.remove(["script", "style", "noscript", "iframe", "form", "button"]);

export async function fetchUrl(url: string, maxChars = 60_000) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error("blocked URL"); // no localhost/LAN/file:
  const res = await fetch(u, { redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "es-ES,es;q=0.9" }, signal: AbortSignal.timeout(20_000) });
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("pdf") || u.pathname.toLowerCase().endsWith(".pdf")) {
    const { text } = await extractText(await getDocumentProxy(buf), { mergePages: true });
    return { url: res.url, kind: "pdf", markdown: text.slice(0, maxChars) };          // empty text ⇒ scanned → OCR / vision model
  }
  // Many gov sites are ISO-8859-1 (e.g. dnielectronico.es): honour header, then <meta charset>
  const charset = /charset=([\w-]+)/i.exec(ct)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder("latin1").decode(buf.slice(0, 4096)))?.[1] ?? "utf-8";
  const html = new TextDecoder(charset.toLowerCase()).decode(buf);
  const { document } = parseHTML(html);
  const art = isProbablyReaderable(document) ? new Readability(document, { charThreshold: 300 }).parse() : null;
  const md = art?.content ? td.turndown(art.content)
           : td.turndown(document.querySelector("main")?.innerHTML ?? document.body?.innerHTML ?? ""); // non-article pages (listings, forms)
  return { url: res.url, kind: "html", title: art?.title ?? document.title, markdown: md.slice(0, maxChars) };
}
```

**Notes**

- **JS-rendered sedes** (JSF/SPA): render them in the app's embedded browser, then run the same extraction on `page.content()`.
- **Jina fallback:** `https://r.jina.ai/<url>` returns clean Markdown without a key at 20 RPM [live: BOE page OK in 5.3 s]. It sends the URL to a third party, so never use it for URLs that carry session tokens.
- **Prompt injection:** treat fetched content as untrusted. OpenAI's own docs say "Treat all web results as untrusted input."

---

## C. Feedback server

### C7. Postgres full-text search for Spanish [live: PGlite 0.5.8 = PostgreSQL 18.3]

**PGlite** ships the `spanish` configuration (alongside catalan, basque, portuguese and others), plus `unaccent` and `pg_trgm` as contrib modules: `import { unaccent } from "@electric-sql/pglite/contrib/unaccent"` and the same for `pg_trgm`. pgvector is a separate package, `@electric-sql/pglite-pgvector`. The official `postgres` Docker images include both contrib modules.

**The pitfall** [live]

Snowball's Spanish suffixes include accents. When `unaccent` runs before `spanish_stem`, some stems change:

| word | `spanish_stem` | `unaccent` → `spanish_stem` |
|---|---|---|
| renovación | **renov** | **renovacion** |
| renovaciones | renov | renov |
| renovar | renov | renov |
| información | **inform** | **informacion** |
| certificación | certif | certificacion |
| trámite / tramite | tramit | tramit |

With only the `spanish_unaccent` config, "renovación" no longer matches "renovar". **Fix:** index both configs and query with both (verified below).

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Spanish stemming + accent folding
CREATE TEXT SEARCH CONFIGURATION public.spanish_unaccent (COPY = pg_catalog.spanish);
ALTER TEXT SEARCH CONFIGURATION public.spanish_unaccent
  ALTER MAPPING FOR hword, hword_part, word
  WITH public.unaccent, pg_catalog.spanish_stem;

-- IMMUTABLE wrappers (unaccent(text) and array_to_string are not immutable → cannot be used in indexes/generated cols)
CREATE OR REPLACE FUNCTION public.f_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  RETURN public.unaccent('public.unaccent'::regdictionary, $1);
CREATE OR REPLACE FUNCTION public.f_tags_to_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN array_to_string($1, ' ');

CREATE TABLE feedback (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  procedure_key text NOT NULL,                 -- SIA code when known, else slug
  region        text,                          -- e.g. 'ES-MD' (ISO 3166-2) or NULL = nationwide
  title         text NOT NULL,
  body          text NOT NULL,
  tags          text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  search_tsv    tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('pg_catalog.spanish',      coalesce(title,'')), 'A') ||
      setweight(to_tsvector('public.spanish_unaccent', coalesce(title,'')), 'A') ||
      setweight(to_tsvector('public.spanish_unaccent', public.f_tags_to_text(tags)), 'B') ||
      setweight(to_tsvector('pg_catalog.spanish',      coalesce(body,'')), 'C') ||
      setweight(to_tsvector('public.spanish_unaccent', coalesce(body,'')), 'C')
  ) STORED
);
CREATE INDEX feedback_search_idx     ON feedback USING gin (search_tsv);
CREATE INDEX feedback_title_trgm_idx ON feedback USING gin (public.f_unaccent(lower(title)) gin_trgm_ops);
CREATE INDEX feedback_proc_idx       ON feedback (procedure_key, created_at DESC);
```

**Queries** (all verified):

```sql
-- 1) Strict (AND) search; websearch syntax supports "phrases", or, -negation
SELECT id, title,
       ts_rank_cd(search_tsv, q, 32) AS rank,                         -- 32: rank/(rank+1) ∈ [0,1)
       ts_headline('pg_catalog.spanish', body, q, 'MaxFragments=1,MaxWords=18,MinWords=5') AS snippet
FROM feedback,
     LATERAL (SELECT websearch_to_tsquery('pg_catalog.spanish', $1)
                  || websearch_to_tsquery('public.spanish_unaccent', $1) AS q) s
WHERE search_tsv @@ q AND ($2::text IS NULL OR procedure_key = $2)
ORDER BY rank DESC, created_at DESC LIMIT 20;

-- 2) If few hits: OR fallback ("renovar dni madrid" → any term), ranked
WITH q AS (SELECT replace(plainto_tsquery('pg_catalog.spanish', $1)::text, ' & ', ' | ')::tsquery
               || replace(plainto_tsquery('public.spanish_unaccent', $1)::text, ' & ', ' | ')::tsquery AS q)
SELECT f.id, f.title, ts_rank_cd(f.search_tsv, q.q, 32) AS rank
FROM feedback f, q WHERE f.search_tsv @@ q.q ORDER BY rank DESC, f.created_at DESC LIMIT 20;

-- 3) Prefix:   search_tsv @@ to_tsquery('public.spanish_unaccent', 'empadron:*')
-- 4) Typos on titles (pg_trgm, default threshold 0.3 for %):
SELECT id, title, similarity(public.f_unaccent(lower(title)), public.f_unaccent(lower($1))) AS sim
FROM feedback WHERE public.f_unaccent(lower(title)) % public.f_unaccent(lower($1)) ORDER BY sim DESC LIMIT 10;
```

**Test results**

- "renovar dni cita" returned the DNI item with rank 0.349 and the snippet "Las **citas** para renovación del".
- "policia renovacion" matched, so the search is accent-insensitive.
- `enpadronamiento madrid` found "Empadronamiento en Madrid" through trigrams (sim 0.77).
- With `enable_seqscan=off` the plan uses `Bitmap Index Scan on …_tsv_idx`. On tiny tables Postgres correctly prefers a seq scan.

```ts
import { PGlite } from "@electric-sql/pglite";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
const db = await PGlite.create({ extensions: { unaccent, pg_trgm } });   // then db.exec(schemaSql)
```

**Ranking notes**

- `setweight` A/B/C/D map to the default weights {D=0.1, C=0.2, B=0.4, A=1.0}.
- Add recency in SQL, e.g. `rank * (1 / (1 + extract(epoch from now()-created_at)/86400/180))`.
- If FTS ranking is not good enough, PGlite also offers `pg_textsearch` (BM25) as an external extension (UNVERIFIED in prod).

### C8. PII scrubbing for Spanish text

**Layers, in order of effectiveness**

1. **Known-values redaction, on-device.** The app already holds the user's PII (scanned DNI, address, phone, email, names). Redact every occurrence, case- and accent-insensitive, before anything leaves the device.
2. **Deterministic detectors with checksums**, in the module below, on both client and server.
3. **Optional NER** for names and places:
   - `@huggingface/transformers` 4.x with a multilingual or Spanish NER ONNX model, run locally or on the server (model choice UNVERIFIED).
   - Or **Microsoft Presidio** as a Docker sidecar on the feedback server. It is Python, ships `EsNifRecognizer` (`\b[0-9]?[0-9]{7}[-]?[A-Z]\b` plus checksum), `EsNieRecognizer` and `EsPassportRecognizer` (`\b[A-Z]{3}[0-9]{6}\b`, with context words), and uses spaCy `es` models.
4. **Server policy.** Re-run the detectors, **reject instead of storing** if anything is found, cap free-text length, and prefer structured fields (step, problem, workaround, office type, region) over prose.
5. **Quasi-identifiers.** Case numbers, register receipts, exact appointment times and cadastre refs are treated as PII too.

**Libraries** [npm metadata 2026-10-03]

| Package | Use | Notes |
|---|---|---|
| `validator` 13.15 (MIT, 30M/wk) | `isIdentityCard(s,'ES')` (DNI/NIE), `isIBAN`, `isPassportNumber(s,'ES')`, `isPostalCode(s,'ES')`, `isMobilePhone(s,'es-ES')`, `isTaxID(s,'es-ES')` | Validation only; you still need finders |
| `ibantools` 4.5, `libphonenumber-js` 1.13 | IBAN/BBAN; phone parsing and validation (`parsePhoneNumberFromString(s,'ES').isValid()`) | Phone: also `findPhoneNumbersInText` |
| `nif-dni-nie-cif-validation` 2.0 (MIT) / `better-dni` 4.4 (2021) | NIF/NIE/CIF validation | |
| `openredaction` 1.1.5, `@redactpii/node` 1.0.19, `@arcjet/redact` 1.14, `redact-pii` 3.4 (last release 2022) | Generic regex redaction | Mostly US/UK-centric. openredaction has a `SPANISH_DNI` rule but no NIE/NAF/CCC checksums. **Not sufficient alone.** |
| OpenRouter "Sensitive Info" guardrail | Regex and Presidio-based redaction of *prompts* at the gateway | Protects inference traffic, not our DB |

**Algorithms (all implemented and tested below)**

- **DNI:** 8 digits + letter, where `letter = "TRWAGMYFPDXBNJZSQVHLCKE"[n % 23]`. Example: 12345678Z.
- **NIE:** X/Y/Z + 7 digits + letter. Replace X→0, Y→1, Z→2, then apply the DNI rule. Examples: X1234567L, Y1234567X, Z1234567R.
- **CIF (NIF of legal entities):** `[ABCDEFGHJNPQRSUVW]` + 7 digits + control.
  - Double the digits at odd positions (1, 3, 5, 7) and sum their digits; add the even-position digits.
  - `d = (10 − sum % 10) % 10`; the control letter is `"JABCDEFGHI"[d]`.
  - P, Q, R, S, N and W take a letter; A, B, E and H take a digit; the others accept either.
  - Example: Q2826000H, AEAT's own CIF.
- **IBAN:** move the first 4 characters to the end, map A=10…Z=35, and require `mod 97 == 1`. ES IBANs have 24 characters. Example: ES91 2100 0418 4502 0005 1332.
- **CCC** (inside an ES IBAN): `DC = 11 − Σ(dᵢ·wᵢ) mod 11` with weights `[1,2,4,8,5,10,9,7,3,6]` (11→0, 10→1). The first DC is computed over `"00"+entity+office`, the second over the 10-digit account.
- **NUSS/NAF:** 12 digits `PP NNNNNNNN CC`, where `CC = (N < 10⁷ ? PP·10⁷+N : PP·10⁸+N) mod 97`. Two independent validators use this; Faker uses plain `PPNNNNNNNN mod 97`, and both are accepted. **No official TGSS spec was found (UNVERIFIED).**
- **Passport (ES):** `[A-Z]{3}\d{6}`, the same pattern Presidio uses. Only redact it near "pasaporte" to limit false positives. DNI support numbers ("nº de soporte") share the format.
- **Plates:** current format `\d{4} ?[BCDFGHJKLMNPRSTVWXYZ]{3}` (no vowels, Ñ or Q); provincial format `[A-Z]{1,2}-?\d{4}-?[A-Z]{1,2}`. Use only with context, since false positives are frequent.
- **Phones:** optional `+34`/`0034` prefix, then mobile `[67]\d{8}` or landline `[89]\d{8}`, in 3-3-3, 3-2-2-2 or 2-3-2-2 groupings.
- **Postal codes:** `(0[1-9]|[1-4]\d|5[0-2])\d{3}`, i.e. province 01–52. Only redact them in an address context.
- **DOB:** only redact dates near "nacimiento", "nacido/a", "F. nac." or "DOB". Deadlines and publication dates are useful feedback and should stay.
- Also covered: emails, Luhn-valid card numbers, cadastre references (`\d{7}[A-Z]{2}\d{4}[A-Z]\d{4}[A-Z]{2}`), IPv4 addresses, and case/receipt numbers after "expediente", "justificante", "localizador" or "nº de registro".

**Module.** It type-checks with `tsc --strict` (ES2022) and runs on Node 24 with type stripping. All 24 unit asserts pass, including cross-checks against `validator`, `ibantools` and `libphonenumber-js`.

```ts
// Spanish PII scrubber: regex candidates + checksum validation. Node >= 18 (lookbehind + \p{..} with /u).
const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const L = "(?<![\\p{L}\\p{N}])"; // left boundary (Unicode-aware)
const R = "(?![\\p{L}\\p{N}])";  // right boundary
const strip = (s: string): string => s.replace(/[\s.\-\/]/g, "").toUpperCase();

export function isValidDni(raw: string): boolean {           // 8 digits + control letter
  const s = strip(raw); const m = /^(\d{8})([A-Z])$/.exec(s);
  return !!m && DNI_LETTERS[Number(m[1]) % 23] === m[2];
}
export function isValidNie(raw: string): boolean {           // X/Y/Z + 7 digits + letter; X→0, Y→1, Z→2
  const s = strip(raw); const m = /^([XYZ])(\d{7})([A-Z])$/.exec(s);
  if (!m) return false;
  const n = Number("XYZ".indexOf(m[1]) + m[2]);
  return DNI_LETTERS[n % 23] === m[3];
}
export function isValidCif(raw: string): boolean {           // letter + 7 digits + control (digit or letter)
  const s = strip(raw); const m = /^([ABCDEFGHJNPQRSUVW])(\d{7})([0-9A-J])$/.exec(s);
  if (!m) return false;
  const [, org, body, ctrl] = m;
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    let d = Number(body[i]);
    if (i % 2 === 0) { d *= 2; d = Math.floor(d / 10) + (d % 10); } // positions 1,3,5,7 (1-based) are doubled
    sum += d;
  }
  const digit = (10 - (sum % 10)) % 10;
  const letter = "JABCDEFGHI"[digit];
  if ("PQRSNW".includes(org)) return ctrl === letter;   // must be a letter
  if ("ABEH".includes(org)) return ctrl === String(digit); // must be a digit
  return ctrl === letter || ctrl === String(digit);       // C,D,F,G,J,U,V: either
}
export function isValidIban(raw: string): boolean {          // ISO 13616 mod-97 (any country)
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  if (s.startsWith("ES") && s.length !== 24) return false;
  const rearr = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearr) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
export function isValidCcc(raw: string): boolean {           // Spanish 20-digit CCC (entidad 4, oficina 4, DC 2, cuenta 10)
  const s = raw.replace(/[\s\-]/g, ""); if (!/^\d{20}$/.test(s)) return false;
  const w = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];
  const dc = (digits: string): number => { const r = 11 - (digits.split("").reduce((a, d, i) => a + Number(d) * w[i], 0) % 11); return r === 11 ? 0 : r === 10 ? 1 : r; };
  return dc("00" + s.slice(0, 8)) === Number(s[8]) && dc(s.slice(10)) === Number(s[9]);
}
export function isValidNaf(raw: string): boolean {           // NUSS/NAF: PP NNNNNNNN CC, CC = f(PP,N) mod 97
  const s = raw.replace(/[\s.\-\/]/g, ""); const m = /^(\d{2})(\d{8})(\d{2})$/.exec(s);
  if (!m) return false;
  const prov = Number(m[1]), num = Number(m[2]), cc = Number(m[3]);
  if (prov < 1 || prov > 66) return false;
  const a = num < 10_000_000 ? prov * 10_000_000 + num : prov * 100_000_000 + num; // variant used by most validators
  const b = Number(m[1] + m[2]);                                                     // plain concatenation (e.g. Faker)
  return a % 97 === cc || b % 97 === cc;
}
export function isLuhn(raw: string): boolean {
  const s = raw.replace(/[\s\-]/g, ""); if (!/^\d{13,19}$/.test(s)) return false;
  let sum = 0, dbl = false;
  for (let i = s.length - 1; i >= 0; i--) { let d = Number(s[i]); if (dbl) { d *= 2; if (d > 9) d -= 9; } sum += d; dbl = !dbl; }
  return sum % 10 === 0;
}

// Order matters: longer/more specific identifiers first so they win over sub-matches.
export interface Rule { type: string; re: RegExp; validate?: (v: string) => boolean; context?: RegExp; group?: number }
export interface Finding { type: string; start: number; end: number }

export const RULES: Rule[] = [
  { type: "EMAIL",  re: new RegExp(`${L}[\\p{L}\\p{N}._%+\\-]+@[\\p{L}\\p{N}.\\-]+\\.[\\p{L}]{2,}${R}`, "giu") },
  { type: "IBAN",   re: new RegExp(`${L}[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?${R}`, "giu"), validate: isValidIban },
  { type: "CCC",    re: new RegExp(`${L}\\d{4}[ \\-]?\\d{4}[ \\-]?\\d{2}[ \\-]?\\d{10}${R}`, "gu"), validate: isValidCcc },
  { type: "CARD",   re: new RegExp(`${L}(?:\\d[ \\-]?){12,18}\\d${R}`, "gu"), validate: isLuhn },
  { type: "NIE",    re: new RegExp(`${L}[XYZ][ .\\-]?\\d{7}[ .\\-]?[A-Z]${R}`, "giu"), validate: isValidNie },
  { type: "DNI",    re: new RegExp(`${L}\\d{1,2}\\.?\\d{3}\\.?\\d{3}[ \\-]?[A-Z]${R}`, "giu"), validate: (s: string) => isValidDni(strip(s).padStart(9, "0")) },
  { type: "CIF",    re: new RegExp(`${L}[ABCDEFGHJNPQRSUVW][ .\\-]?\\d{7}[ .\\-]?[0-9A-J]${R}`, "giu"), validate: isValidCif },
  { type: "NAF",    re: new RegExp(`${L}\\d{2}[ \\/\\-]?\\d{8}[ \\/\\-]?\\d{2}${R}`, "gu"), validate: isValidNaf },
  { type: "PASSPORT", re: new RegExp(`${L}[A-Z]{3}\\d{6}${R}`, "gu"), context: /pasaporte|passport/i },
  { type: "SOPORTE_DNI", re: new RegExp(`${L}[A-Z]{3}\\d{6}${R}`, "gu"), context: /soporte|idesp|n[ºo°]\.? ?de ?soporte/i },
  { type: "PHONE",  re: new RegExp(`${L}(?:(?:\\+|00)34[ .\\-]?)?(?:[6789]\\d{2}[ .\\-]?\\d{3}[ .\\-]?\\d{3}|[6789]\\d{2}[ .\\-]?\\d{2}[ .\\-]?\\d{2}[ .\\-]?\\d{2}|[89]\\d[ .\\-]?\\d{3}[ .\\-]?\\d{2}[ .\\-]?\\d{2})${R}`, "gu") },
  { type: "PLATE",  re: new RegExp(`${L}(?:\\d{4}[ \\-]?[BCDFGHJKLMNPRSTVWXYZ]{3}|(?:[A-Z]{1,2})[ \\-]?\\d{4}[ \\-]?[A-Z]{1,2})${R}`, "gu"), context: /matr[ií]cula|coche|veh[ií]culo|moto|placa|itv|dgt/i },
  { type: "CATASTRO", re: new RegExp(`${L}\\d{7}[A-Z]{2}\\d{4}[A-Z]\\d{4}[A-Z]{2}${R}`, "gu") }, // referencia catastral (20 chars)
  { type: "POSTCODE", re: new RegExp(`${L}(?:0[1-9]|[1-4]\\d|5[0-2])\\d{3}${R}`, "gu"), context: /c\.?\s?p\.?|c[oó]digo postal|calle|c\/|avda|avenida|plaza|paseo|piso|portal/i },
  { type: "ADDRESS", re: new RegExp(`${L}(?:c\\/|calle|avda\\.?|avenida|av\\.|plaza|pza\\.?|paseo|p[ºo]\\.?|ronda|traves[ií]a|camino|carretera|ctra\\.?|glorieta|urbanizaci[oó]n|urb\\.)\\s+[\\p{L}\\p{N} .'ºª\\-]{2,60}?,?\\s*(?:n[ºo°]\\.?\\s*)?\\d{1,4}(?:\\s*[,\\-]?\\s*(?:\\d{1,2}\\s*[ºª°]?\\s*[A-Z]?|bajo|bj|entlo?|izq(?:da)?|dcha|dch|pta\\.?\\s*\\d+|esc\\.?\\s*\\w))*${R}`, "giu") },
  { type: "DOB", re: new RegExp(`(?:nacid[oa]|nacimiento|f\\.\\s?nac\\.?|fecha de nac\\w*|born|dob)[^\\n]{0,25}?(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.](?:19|20)?\\d{2}|\\d{1,2} de [a-záéíóú]+ de (?:19|20)\\d{2})`, "giu"), group: 1 },
  { type: "CASE_REF", re: new RegExp(`(?:expediente|exp\\.|n[ºo°]\\.?\\s*(?:de\\s*)?registro|justificante|localizador|n[ºo°]\\.?\\s*de\\s*referencia|c[oó]digo de solicitud)\\s*[:#nº°]*\\s*([A-Z0-9][A-Z0-9\\/\\-]{4,30})`, "giu"), group: 1 },
  { type: "IP", re: new RegExp(`${L}(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)${R}`, "gu") },
];

export function scrub(text: string, { known = [] as string[] } = {}): { text: string; findings: Finding[] } {
  const hits: Finding[] = [];
  // 1) Known values of this user (from the local vault): exact, case/accent-insensitive.
  const norm = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const nText = norm(text); // NFD+strip keeps length only for precomposed input; normalize input to NFC first in real code
  for (const k of known.filter((k) => k && k.length >= 3)) {
    let i = 0, nk = norm(k);
    while ((i = nText.indexOf(nk, i)) !== -1) { hits.push({ start: i, end: i + nk.length, type: "KNOWN" }); i += nk.length; }
  }
  // 2) Pattern rules with validation / context.
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const value = rule.group ? m[rule.group] : m[0];
      const start = rule.group ? m.index! + m[0].lastIndexOf(value) : m.index!;
      if (rule.validate && !rule.validate(value)) continue;
      if (rule.context) {
        const win = text.slice(Math.max(0, start - 60), start + value.length + 30);
        if (!rule.context.test(win)) continue;
      }
      hits.push({ start, end: start + value.length, type: rule.type });
    }
  }
  // 3) Resolve overlaps: earliest start, then longest span wins.
  hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Finding[] = []; let lastEnd = -1;
  for (const h of hits) if (h.start >= lastEnd) { kept.push(h); lastEnd = h.end; }
  let out = "", pos = 0;
  for (const h of kept) { out += text.slice(pos, h.start) + `[${h.type}]`; pos = h.end; }
  return { text: out + text.slice(pos), findings: kept.map(({ type, start, end }) => ({ type, start, end })) };
}
```

**Test run** (`known: ["Pablo", "Rodríguez Caballero"]`). Input:

```
Hola, soy Pablo Rodríguez Caballero (DNI 12.345.678-Z, NIE X1234567L). Mi email es pablo.rc@example.es y mi móvil +34 612 34 56 78; fijo 91 123 45 67.
Vivo en C/ Mayor 12, 3º B, 28013 Madrid. IBAN ES91 2100 0418 4502 0005 1332. Nº afiliación SS 281234567840. Fecha de nacimiento: 03/04/1985.
Pasaporte PAA123456, matrícula del coche 1234 BCD. La empresa B12345674 me cobró. Ref. catastral 9872023VH5797S0001WX. Tarjeta 4111 1111 1111 1111.
Plazo: 10 días hábiles desde el 30/06/2026; Ley 39/2015; expediente 2026/000123; código SIA 110340; cita a las 9:00; 28 euros.
```

Output:

```
Hola, soy [KNOWN] [KNOWN] (DNI [DNI], NIE [NIE]). Mi email es [EMAIL] y mi móvil [PHONE]; fijo [PHONE].
Vivo en [ADDRESS] Madrid. IBAN [IBAN]. Nº afiliación SS [NAF]. Fecha de nacimiento: [DOB].
Pasaporte [PASSPORT], matrícula del coche [PLATE]. La empresa [CIF] me cobró. Ref. catastral [CATASTRO]. Tarjeta [CARD].
Plazo: 10 días hábiles desde el 30/06/2026; Ley 39/2015; expediente [CASE_REF]; código SIA 110340; cita a las 9:00; 28 euros.
```

**False-positive check.** This text was left untouched: "Real Decreto 1065/2007, de 27 de julio; BOE-A-2015-10565; código SIA 110340; artículo 16.4; tasa 12,00 €; modelo 790 código 012; llamar al 012 o al 112; 10:30h; 2026-10-03".

**Known gaps**

- **Names** are only caught via known values or NER.
- **Free-form addresses** without a street-type keyword are missed.
- **Regional health cards** (CIP/TSI formats vary by CCAA) are not covered.
- **Phone false positives** on 9-digit numbers starting with 6–9 (accepting over-redaction).
- **KNOWN index mapping** assumes NFC input.

---

## Sources

**OpenRouter**

- Management API keys: <https://openrouter.ai/docs/guides/overview/auth/management-api-keys>
- Create key: <https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key>
- Update key: <https://openrouter.ai/docs/api/api-reference/api-keys/update-an-api-key>
- List keys: <https://openrouter.ai/docs/api/api-reference/api-keys/list-api-keys>
- Delete key: <https://openrouter.ai/docs/api/api-reference/api-keys/delete-an-api-key>
- Current key: <https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key>
- Credits: <https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits>
- Limits: <https://openrouter.ai/docs/api_reference/limits>
- Guardrails: <https://openrouter.ai/docs/guides/features/guardrails>, <https://openrouter.ai/docs/api/api-reference/guardrails/create-a-guardrail>, <https://openrouter.ai/docs/api/api-reference/guardrails/bulk-assign-keys-to-a-guardrail>
- Workspace budgets: <https://openrouter.ai/docs/guides/features/workspaces/workspace-budgets>
- Pricing and FAQ: <https://openrouter.ai/pricing>, <https://openrouter.ai/docs/faq>
- Data collection: <https://openrouter.ai/docs/guides/privacy/data-collection>
- OAuth PKCE: <https://openrouter.ai/docs/guides/overview/auth/oauth>
- Web search plugin: <https://openrouter.ai/docs/guides/features/plugins/web-search>
- Web search server tool: <https://openrouter.ai/docs/guides/features/server-tools/web-search>
- Sensitive Info guardrail: <https://openrouter.ai/docs/guides/features/guardrails/sensitive-info>

**Alternatives**

- LiteLLM virtual keys: <https://docs.litellm.ai/docs/proxy/virtual_keys>
- Requesty: <https://docs.requesty.ai/features/key-management-api>
- Portkey: <https://portkey.ai/docs/product/administration/enforce-budget-and-rate-limit>
- Open Anonymity: <https://openanonymity.ai/>, <https://openanonymity.ai/blog/unlinkable-inference/>, <https://openanonymity.ai/blog/oa-ethereum-foundation-collab/>, <https://github.com/OpenAnonymity/oa-station-reference>, <https://github.com/OpenAnonymity/oa-sdk>, <https://github.com/OpenAnonymity/oa-verifier>

**Sign in with ChatGPT**

- Developer docs: <https://developers.openai.com/siwc/quickstart>, <https://developers.openai.com/siwc/token-sharing-open-source>, <https://developers.openai.com/siwc/token-sharing-open-source/sign-in>, `…/models-and-inference`, `…/preview-limitations`, `…/token-reference`, `…/errors-and-recovery`, `…/profiles-and-sessions`, <https://developers.openai.com/siwc/ui-ux-guidelines>, <https://developers.openai.com/siwc/request-client-id>
- User docs: <https://learn.chatgpt.com/docs/sign-in-with-chatgpt>, <https://learn.chatgpt.com/docs/models>, <https://learn.chatgpt.com/docs/pricing>, <https://learn.chatgpt.com/docs/web-search>
- Press (secondary): <https://xenospectrum.com/en/chatgpt-sign-in-subscription-apps/>, <https://securitybrief.asia/story/openai-launches-chatgpt-sign-in-for-16-partner-tools>
- Code: <https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs>, <https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/oauth/openai-chatgpt.ts>, `…/openai-codex.ts`, `…/packages/ai/src/api/openai-codex-responses.ts`
- Third-party probe: <https://github.com/justrach/codegraff/blob/main/docs/adr/0221-chatgpt-new-sign-in.md>

**Search**

- Exa: <https://exa.ai/docs/admin/pricing>, <https://exa.ai/docs/admin/billing>, <https://exa.ai/docs/reference/search>, <https://exa.ai/docs/reference/get-contents>, <https://exa.ai/docs/get-started/exa-mcp>
- Brave: <https://brave.com/search/api/>, <https://api-dashboard.search.brave.com/app/documentation/web-search/get-started>; free-tier change (secondary): <https://agentdeals.dev/alternative-to/brave-search-api>
- Tavily: <https://docs.tavily.com/documentation/api-credits>, <https://docs.tavily.com/documentation/api-reference/endpoint/search>
- Serper: <https://serper.dev/>
- Jina Reader: <https://jina.ai/reader/>
- SearXNG instance list: <https://searx.space/data/instances.json>

**Official sources**

- BOE API: <https://www.boe.es/datosabiertos/api/api.php>, <https://www.boe.es/datosabiertos/documentos/APIconsolidada.pdf>
- PAG: <https://administracion.gob.es/espanaadmon/sia>, <https://administracion.gob.es/tramites-electronicos/resultadosActuaciones>, <https://administracion.gob.es/robots.txt>
- datos.gob.es API: <https://datos.gob.es/apidata/>
- Catalunya: <https://analisi.transparenciacatalunya.cat/resource/9p3b-4s2k.json>
- Castilla y León: <https://datosabiertos.jcyl.es/web/jcyl/risp/es/sector-publico/tramites/1284165766476.json>

**Libraries and Postgres**

- PGlite extensions: <https://pglite.dev/extensions/>
- Postgres: <https://www.postgresql.org/docs/current/unaccent.html>, <https://www.postgresql.org/docs/current/textsearch-controls.html>, <https://www.postgresql.org/docs/current/pgtrgm.html>
- Presidio (Spain recognizers): <https://github.com/microsoft/presidio/tree/main/presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/spain>
- npm registry pages for the packages named above (versions and dates as of 2026-10-03).

## UNVERIFIED and open items

- Rate limits of OpenRouter's management API; whether Guardrails are available on the Standard plan (the pricing table says "Budgets & Spend Controls: Standard Yes").
- How pi ingests an externally obtained SIWC credential, and whether its `agent_name_hint` can be overridden.
- Which models SIWC exposes on Plus vs Pro (account-specific; check `GET /v1/models`); whether `web_search` works on the SIWC route (third-party probe only); billing of `web_search` on plan usage.
- Exa: whether `includeDomains: ["gob.es"]` also matches subdomains; the rate limits of the keyless MCP.
- Brave: domain filtering via Goggles.
- DuckDuckGo: behaviour for typical users (our IP may have been flagged by earlier probes).
- PAG/SIA: reuse/licence terms; whether SIA web services are open to non-administrations; stability of the export endpoint (undocumented form backend).
- Madrid and Euskadi procedure APIs.
- NAF/NUSS: no official TGSS checksum specification was found.
- The date SIWC launched as identity-only (July 2026, press only).
