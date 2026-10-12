# @sa/key-server

Exchanges voucher codes for **capped LiteLLM virtual keys**, and gives each "Sign in with
ChatGPT" account one small **scan-decider key** (document-scan frame screening, which their
ChatGPT plan cannot pay for). Both work on our LiteLLM gateway, which proxies LLM calls to
OpenRouter, web search to Exa / Parallel and the scan decider to OpenRouter's Decisions API
(D10, D12 in [`docs/DECISIONS.md`](../../docs/DECISIONS.md)). It also runs **web research**
for voucher users on Parallel's Task API and charges it to the voucher (D13). This server never
sees conversations, searches or frames, and it relays research without storing or logging it.

Hono on Node 24, raw SQL on Postgres (production) or PGlite (development and tests).
HTTP contracts: `packages/shared/src/services.ts`.

## Quick start (no Docker, no accounts)

```sh
DEV_SEED=1 corepack pnpm --filter @sa/key-server start      # http://127.0.0.1:8787

curl -s localhost:8787/v1/vouchers/redeem -H 'content-type: application/json' \
  -d '{"code":"SA-DEMO42"}'
```

`POST /v1/chatgpt-keys` needs a real OpenAI ID token (the app sends the one from its ChatGPT
sign-in); the server fetches OpenAI's public keys on the first such request. Without
`KEY_ENCRYPTION_KEY`, PGlite uses a public development key.

Without `LITELLM_ADMIN_URL` the server hands out mock keys (`sk-mock-…`) for the local mock LLM
(`tools/mock-llm`, `MOCK_LLM_BASE_URL`), which also answers `GET /key/info`. Data lives in
`.data/key-server` (PGlite, git-ignored). With `DEV_SEED=1` the public demo voucher
`SA-DEMO42` ($5) is active and is re-armed after every redemption (only with mock keys).

| Command (`corepack pnpm --filter @sa/key-server …`) | What |
| --- | --- |
| `dev` / `start` | Run with watch / once (`src/main.ts`: env → migrations → listen) |
| `test` | Vitest on in-memory PGlite, LiteLLM faked through an injected `fetch` (offline) |
| `typecheck` | `tsc` |
| `vouchers:create -- --count 5 --amount 5 [--note demo] [--batch name] [--expires-at ISO]` | Create vouchers and print the codes (stdout, one per line) |
| `vouchers:admin [--print] [--local] [--url <base>]` | Open the admin page signed in (see below); `corepack pnpm vouchers` from the repo root |

The CLI uses the same `DATABASE_URL` and `VOUCHER_PEPPER` as the server. PGlite is
single-process: stop the server first (a lock file next to the data directory enforces it), or
use the admin API.

## Admin page

`GET /admin` serves a small page to create, list and revoke vouchers (Spanish, with English). It
only exists when `ADMIN_TOKEN` is set, holds no data itself, and calls the admin API below with
the token.

- **Production**: `corepack pnpm vouchers` (repo root, with git-crypt unlocked) reads
  `key_server_admin_token` from `infra/terraform/terraform.tfvars` and the key server URL from
  the Terraform state (`urls.key_server`, else `https://keys.<domain>`), then opens
  `https://keys.<domain>/admin#token=…`. `--print` prints the link instead.
- **Locally**: start the server with `ADMIN_TOKEN=<16+ chars>`, then
  `ADMIN_TOKEN=… corepack pnpm vouchers --local`, or open `http://127.0.0.1:8787/admin` and
  paste the token.

The token travels in the URL **fragment**, which browsers never send to the server, put in
`Referer` or write to access logs. The page moves it to `sessionStorage` (this tab only) and
clears the address bar; still, treat the link like the token itself. New codes are shown once,
with copy buttons. The page carries a CSP that allows only its own inline script and style (by
hash) and same-origin API calls, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and
`no-store`.

## API

All bodies are JSON. Errors are `{"error":{"code","message"}}`. Responses carry
`Cache-Control: no-store`.

| Endpoint | Auth | Success | Notes |
| --- | --- | --- | --- |
| `GET /health` | – | `200 {ok, service, keys}` | `keys`: `litellm` or `mock`. `503` if the database is down |
| `POST /v1/vouchers/redeem` `{code}` | optional voucher key | `200 RedeemVoucherResponse` | Rate-limited per IP. With an active voucher key, tops it up (see below) |
| `GET /v1/vouchers/credit` | `Bearer <voucher apiKey>` | `200 VoucherCreditResponse` | The key's balance (also of expired, blocked or revoked keys): what its vouchers add up to (`limitUsd`), LiteLLM's `spendUsd` and `maxBudgetUsd`, `expiresAt`. Research lowers the cap, so remaining = `maxBudgetUsd - spendUsd` |
| `POST /v1/chatgpt-keys` `{idToken}` | OpenAI ID token in the body | `200 ChatGPTKeyResponse` | The account's scan-decider key, the same on every device. Rate-limited per IP |
| `POST /v1/research` `ResearchRequest` | `Bearer <voucher apiKey>` | `200` SSE of `ResearchEvent`s | Web research on Parallel; the mode's price is taken from the voucher. See below |
| `GET /v1/research/:id` | same key | `200 ResearchRunInfo` | A run of this key (`404` for other keys' runs); `output` when completed |
| `GET /v1/research/:id/events` | same key | `200` SSE | Follow a run again after a dropped connection (no new charge) |
| `POST /admin/vouchers` `{count, amountUsd, expiresAt?, note?, batch?}` | `Bearer <ADMIN_TOKEN>` | `201 {codes, batch, amountUsd, expiresAt?}` | Plaintext codes are returned **only here, once** |
| `GET /admin` | – | `200` HTML | The admin page; `404` without `ADMIN_TOKEN` |
| `GET /admin/vouchers?status=&batch=&limit=` | admin | `200 {vouchers:[…]}` | No codes or hashes. `status`: `active` (still redeemable), `expired`, `redeemed`, `revoked`; `limit` up to 1000 (default 100) |
| `POST /admin/vouchers/:id/revoke` | admin | `200 {id, status, keysDisabled}` | Takes the voucher's amount off its LiteLLM key, or blocks the key if no other valid voucher funds it; idempotent |

Admin routes (and the page) answer `404` when `ADMIN_TOKEN` is not set.

Both key responses carry `provider: "litellm"`, `baseUrl` (`${LITELLM_PUBLIC_URL}/v1`) and
`apiKey`. Vouchers add `limitUsd`, `searchTools` and `expiresAt` when the key expires; ChatGPT
keys add `deciderModel`, `dailyLimitUsd` and `monthlyLimitUsd`. With the key, a client calls (`{gateway}` is `baseUrl` without `/v1`):

| Call | Keys | What |
| --- | --- | --- |
| `POST {baseUrl}/chat/completions` | voucher | LLM call (models in `LITELLM_KEY_MODELS`) |
| `POST {baseUrl}/chat/completions` | both | Phone-call transcription: `model: TRANSCRIPTION_MODEL` (`@sa/shared`, Gemini 3.5 Flash-Lite) with an `input_audio` part; the only chat model of ChatGPT keys |
| `GET {baseUrl}/models` | voucher | Models the key may call |
| `POST {baseUrl}/search/{tool}` `{query, max_results, search_domain_filter?}` | voucher | Web search, charged to the same budget ($0.005 per search in LiteLLM's price map) |
| `POST {gateway}/openrouter/alpha/decisions` | both | Scan frame screening: OpenRouter's Decisions API with `model: DECIDER_MODEL`, charged to the key by token usage |
| `GET {gateway}/key/info` | both | The key's own `spend`, `max_budget` and `budget_limits` |

| Error code | HTTP | When |
| --- | --- | --- |
| `invalid_code` | 400 | Unknown or malformed voucher code |
| `already_redeemed` | 409 | Voucher already used |
| `expired` | 410 | Voucher past its deadline |
| `revoked` | 410 | Voucher revoked |
| `rate_limited` | 429 | Per-IP bucket empty (`Retry-After` set), or `RESEARCH_MAX_ACTIVE_PER_KEY` runs in flight |
| `provider_error` | 502 / 503 | LiteLLM failed (the voucher stays active), OpenAI's keys could not be fetched, or Parallel could not start a run (refunded) |
| `invalid_identity` | 401 | The ID token failed a check (signature, issuer, expiry, age, audience) |
| `chatgpt_keys_disabled` | 403 | `CHATGPT_KEYS=0`, no `KEY_ENCRYPTION_KEY` with Postgres, or the account's key was blocked |
| `unauthorized` | 401 / 403 | Invalid admin token; for research: not an active voucher key (ChatGPT keys, revoked, blocked or expired keys) |
| `insufficient_budget` | 402 | Research: the voucher's remaining budget is below the mode's price |
| `research_unavailable` | 503 | Research: no `PARALLEL_API_KEY` on this server |
| `bad_request` | 400 / 413 | Invalid request body, body over 16 KB |
| `not_found` / `internal` | 404 / 500 | Unknown route or voucher / unexpected error |

### Web research (`POST /v1/research`)

LiteLLM v1.104 cannot sell Parallel Task runs per key (no Task provider, chat to Parallel is
logged at $0, pass-through for virtual keys is Enterprise-only), so the key server does it.

- **Request**: `{input, mode, outputSchema?, requestId?}` (`ResearchRequest`, strict: unknown
  fields such as `processor` are a `400`). `mode` maps to a fixed processor, charged at its list
  price per completed run: `fast` → `lite` ($0.005), `balanced` → `core` ($0.025), `deep` →
  `pro` ($0.10). Parallel has no per-key processor lock or spending cap, so clients never name a
  processor. `outputSchema` is a text description or a JSON Schema
  object; `requestId` (UUID) makes retries safe: the same id from the same key returns the same
  run.
- **Auth**: `Authorization: Bearer <voucher key>`. The server hashes it (SHA-256, LiteLLM's token
  id) and accepts only `issued_keys` rows of kind `voucher` that are not disabled or expired, funded
  by at least one voucher that is not revoked, and that LiteLLM reports active.
- **Charging**: in one transaction holding the key's `issued_keys` row lock (`FOR UPDATE`, so
  concurrent requests of one key go one at a time), it reads `spend` and `max_budget` from
  `GET /key/info?key=<hash>` (master key), requires `max_budget - spend ≥ price`, records the run
  (`reserved`) and lowers the key's `max_budget` by the price with `POST /key/update`. It never
  writes `spend`: LiteLLM's batch writer keeps updating it from chat and search calls, while
  `max_budget` is only ours. A run that fails (or never starts) gives the price back the same
  way, once (state change and cap change in one transaction); completed runs keep it, as Parallel
  bills only completed runs. LiteLLM writes `spend` to its database in batches (it can lag a minute), so the
  remaining-budget check can be a few cents optimistic, like LiteLLM's own budget checks.
- **Lifecycle** (`research_runs`, no research content): `reserved` → `running` (Parallel run id
  stored) → `completed` | `refunded` | `expired` (no result after `RESEARCH_MAX_MINUTES`; stays
  charged). A refund that fails at LiteLLM leaves `refunding`; hourly housekeeping (and startup)
  retries it, follows `running` runs nobody follows (after a restart) and refunds `reserved` runs
  older than 10 minutes.
- **Streaming**: the server follows each run in the background with Parallel's blocking result
  call (`GET /v1/tasks/runs/{id}/result?timeout=25`, then the run status on 404) and fans events
  out to clients: `created` (id, price), `progress` (at least every ~25 s, keeps proxies awake),
  then `completed` (Parallel's `{type, content, basis}`) or `failed` (`code`, `charged`). The
  run goes on if the client leaves (Parallel has no cancel for task runs); a client reconnects
  with `GET /v1/research/:id/events` or reads `GET /v1/research/:id`. Results stay in memory for
  5 minutes; after that they are fetched from Parallel again.

### Behaviour worth knowing

- **Codes**: `SA-XXXXXX`, 6 Crockford base32 characters (30 random bits; format and
  normalization in `@sa/shared` `voucher-code.ts`, shared with the app's input mask). Input is
  normalized: case, spaces and dashes are ignored, the `SA` prefix is optional, `I`/`L` read as
  `1` and `O` as `0`. Short codes are easy to type but guessable in principle: with 1,000 unused
  vouchers one guess hits with odds of about 1 in a million, and the redeem rate limit allows
  ~300 guesses a day per network, so keep unused batches small and give them an `--expires-at`.
- **The keys we create** (`POST /key/generate` with the master key, tested against LiteLLM
  v1.104):

  | Field | Voucher key | ChatGPT key |
  | --- | --- | --- |
  | `key_alias` | `sa-voucher-<voucher id>` (unique, never the code) | `sa-chatgpt-<random uuid>` (never the account) |
  | `max_budget` | the voucher's `amountUsd` | – |
  | `budget_limits` | – | `[{1d, CHATGPT_DAILY_BUDGET_USD}, {1mo, CHATGPT_MONTHLY_BUDGET_USD}]` |
  | `team_id` | – | the `sa-chatgpt-keys` team (global cap) |
  | `duration` | seconds until the voucher's `expiresAt`; without one, `KEY_TTL_DAYS` in seconds (omitted when 0) | – (permanent) |
  | `models` | `LITELLM_KEY_MODELS` + `DECIDER_MODEL` + `TRANSCRIPTION_MODEL` (`[]` = every model on the proxy) | `[DECIDER_MODEL, TRANSCRIPTION_MODEL]` |
  | `object_permission.search_tools` | `LITELLM_SEARCH_TOOLS` (omitted when empty = all) | – (no search route) |
  | `allowed_routes` | `/v1/chat/completions`, `/v1/models`, `/v1/search`, `/openrouter/alpha/decisions`, `/key/info` | `/openrouter/alpha/decisions`, `/v1/chat/completions`, `/key/info` |
  | `metadata` | `{sa_kind: "voucher", sa_voucher_id}` | `{sa_kind: "chatgpt"}` |

  `allowed_routes` are exact paths or path prefixes. We deliberately avoid LiteLLM's
  `llm_api_routes` group: it includes the provider pass-through routes (`/openrouter/*`,
  `/openai/*`, …), which call the provider with the proxy's own credentials and record no spend
  for OpenRouter chat, so a key could bypass its budget and model allowlist. The one
  pass-through path keys get is the decider's `/openrouter/alpha/decisions`, which LiteLLM v1.104
  prices from each answer's token usage (`is_openrouter_decisions_route`). LiteLLM checks the
  body's `model` against the key's `models` on that route too. Keys have no `user_id`, so
  `/key/info` returns only their own row.
- **Path traversal on the decider route (must be blocked at the reverse proxy).** LiteLLM matches
  `allowed_routes` as prefixes on the raw path and its pass-through then resolves `..`: tested on
  v1.104, `/openrouter/alpha/decisions/../../v1/chat/completions` (also with `%2e%2e`) passes the
  route check and reaches OpenRouter's chat API with the proxy's own key and no spend; a body
  without `model` also skips the model check. The public reverse proxy must forward
  `/openrouter/…` only for the exact path `/openrouter/alpha/decisions` (and reject `..`/`%2e`).
- **ChatGPT keys**: the app sends the OpenAI ID token of its "Sign in with ChatGPT" login
  (never the access token). The server verifies it against OpenAI's published JWKS
  (`OPENAI_JWKS_URL`, cached by `jose`): RS256 signature, `iss` = `OPENAI_ISSUER`, `exp` (60 s
  leeway), `iat` at most 24 h old, and every `aud` starting with `CHATGPT_AUDIENCE_PREFIX`
  (`oaiapp_`: each install registers its own client, so there is no fixed client id; this keeps
  out tokens issued to OpenAI's own clients such as Codex CLI). The identity is `sub`, which
  OpenAI publishes as a `public` subject type (the same for every client); we store only
  HMAC-SHA256(`iss|sub`, `VOUCHER_PEPPER`). The first request of an account creates the key and
  stores it AES-256-GCM-encrypted with `KEY_ENCRYPTION_KEY` (the account hash is authenticated
  data, so a ciphertext copied to another row does not decrypt); later requests from any device
  return the same key. Concurrent first requests: one key wins, the others are blocked at once.
  The nonce was checked by the app; a replayed token only returns that account's own key.
- **Budget windows**: `budget_limits` are enforced by LiteLLM before every call, each window
  with its own spend counter persisted in `LiteLLM_BudgetWindowSpend` (survives restarts);
  `1d` resets at 00:00 UTC, `1mo` on the 1st. All ChatGPT keys belong to the LiteLLM team
  `sa-chatgpt-keys` (created on first use, id kept in `server_settings`); its `max_budget` per
  `1mo` is `CHATGPT_GLOBAL_MONTHLY_BUDGET_USD` (unset = none), set again on the first request
  after each start, so the cap can be raised, lowered or removed later for existing keys.
- **Atomic redemption**: one transaction claims the voucher
  (`UPDATE … WHERE status = 'active' … RETURNING`), creates the key in LiteLLM and records it.
  If provisioning (or anything after it) fails, the transaction rolls back and the voucher stays
  active; a key created upstream but not recorded is blocked right away. Concurrent redemptions
  of one code: exactly one succeeds.
- **Top-ups (one balance per app)**: the app sends the voucher key it holds as
  `Authorization: Bearer`. While that key is active (enabled, unexpired, funded by a valid
  voucher, active in LiteLLM), the same transaction adds the voucher's amount to its
  `max_budget` (under the key's row lock, like research charges) and, with `POST /key/update
  {duration}`, moves its expiry to the later of the key's and the voucher's deadlines (`null` =
  never), instead of creating a key. The response returns the same key, what its vouchers now
  add up to (`limitUsd`), what it had used so far, research included (`usageUsd`), and the
  voucher's `addedUsd`. If recording fails after LiteLLM
  changed, the change is moved back. An unknown, expired, blocked or revoked key gets a new key.
  `vouchers.issued_key_id` is the key each voucher's amount went to; `issued_keys.limit_usd` is
  their sum.
- **Revocation** takes the voucher's amount off its key's `max_budget` (in the transaction that
  revokes it: if LiteLLM fails, the voucher stays as it was) while another valid voucher funds
  the key. A key no valid voucher funds is blocked with `POST /key/block {key: <hashed token>}`.
  A key LiteLLM no longer knows (404) counts as blocked. If LiteLLM is down, the voucher is
  revoked anyway and the key stays marked as enabled: revoke again to retry. Blocking is
  reversible in the LiteLLM UI.
- **Budgets**: LiteLLM checks the budget before each call and records spend after it, so parallel
  or back-to-back calls can overshoot by about one call (a cent for chat, ~$0.0001 for a
  decision). Out of budget, LiteLLM answers `422` with `error.type: "budget_exceeded"`; the app
  shows it as "no credit left" for chat and skips scan screening for that scan.
- **Privacy**: voucher codes are stored only as HMAC-SHA256 with `VOUCHER_PEPPER`; for voucher
  keys we keep only LiteLLM's hashed token (SHA-256 of the key, needed to block it). ChatGPT keys
  are the exception: kept encrypted (see above), next to an HMAC of the account, never its id,
  e-mail or the token. Logs contain method, path, status and timing only: no codes, keys, tokens,
  claims, the master key or IP addresses. Error messages from LiteLLM are logged with anything
  key-like redacted.
- **Rate limiting**: in-memory token buckets per client network on redeem (10 burst, 1/5 min) and
  chatgpt-keys (10, 1/min). Single-instance only: with several replicas, limit at the proxy as
  well. `X-Forwarded-For` is used only with `TRUST_PROXY=<hops>`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Listen address (Docker image: `0.0.0.0`) |
| `DATABASE_URL` | `pglite://.data/key-server` | `postgres://…`, `pglite://<dir>` (relative to this package) or `pglite://memory` |
| `VOUCHER_PEPPER` | dev pepper (PGlite only) | **Required with Postgres**, ≥ 16 chars. HMAC key for codes; changing it invalidates all codes |
| `ADMIN_TOKEN` | unset | ≥ 16 chars; enables `/admin/*` |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front (trust that many `X-Forwarded-For` hops) |
| `RATE_LIMIT` | `1` | `0` disables per-IP rate limiting (e.g. load tests) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `LITELLM_ADMIN_URL` | unset | LiteLLM base URL for the admin API, without `/v1` (internal, e.g. `http://litellm:4000`). Unset = mock keys |
| `LITELLM_MASTER_KEY` | unset | LiteLLM master key. **Required** with `LITELLM_ADMIN_URL`. Sent only to the admin API, never logged |
| `LITELLM_PUBLIC_URL` | `LITELLM_ADMIN_URL` | Base URL handed to clients, without `/v1` (they get `${LITELLM_PUBLIC_URL}/v1`) |
| `LITELLM_KEY_MODELS` | empty (all models) | Comma-separated LiteLLM model names voucher keys may call. Include the app's voucher model (`DEFAULT_MODELS.voucher` in `@sa/agent`) and `anthropic/claude-haiku-5.5` (document scanning). Keep it empty in production |
| `LITELLM_SEARCH_TOOLS` | empty (all tools) | Comma-separated LiteLLM search tool names keys may call; also told to clients as `searchTools` |
| `KEY_TTL_DAYS` | `180` | Lifetime of a key from a voucher with no `expiresAt` (`0` = no expiry); a voucher's own `expiresAt` always wins |
| `DECIDER_MODEL` | `perplexity/pplx-decider-v1.1-27b` | OpenRouter id of the scan decider; added to voucher keys' models, the only model of ChatGPT keys |
| `CHATGPT_KEYS` | `1` | `0` disables `POST /v1/chatgpt-keys` |
| `KEY_ENCRYPTION_KEY` | dev key (PGlite only) | 32 random bytes as 64 hex characters or base64 (`openssl rand -hex 32`). Encrypts stored ChatGPT keys; changing it makes them unreadable. Without it on Postgres, ChatGPT keys are disabled (warning at startup) |
| `CHATGPT_DAILY_BUDGET_USD` | `0.10` | Per-account cap per UTC day |
| `CHATGPT_MONTHLY_BUDGET_USD` | `0.50` | Per-account cap per calendar month |
| `CHATGPT_GLOBAL_MONTHLY_BUDGET_USD` | unset (no cap) | Cap on all ChatGPT keys together per calendar month (the `sa-chatgpt-keys` team) |
| `OPENAI_ISSUER` | `https://auth.openai.com` | Expected `iss` of ID tokens |
| `OPENAI_JWKS_URL` | `https://auth.openai.com/.well-known/jwks.json` | OpenAI's signing keys |
| `CHATGPT_AUDIENCE_PREFIX` | `oaiapp_` | Every `aud` of an ID token must start with this |
| `DEV_SEED` | `0` | `1` = demo voucher `SA-DEMO42` (ignored when LiteLLM is configured) |
| `MOCK_LLM_BASE_URL` | `http://127.0.0.1:8789/v1` | `baseUrl` of mock keys |
| `PARALLEL_API_KEY` | unset | Parallel API key (the same one LiteLLM uses for search). Enables `POST /v1/research`; sent only to Parallel, never logged |
| `PARALLEL_API_URL` | `https://api.parallel.ai` | Parallel API base URL |
| `RESEARCH_MAX_ACTIVE_PER_KEY` | `3` | Runs a key may have in flight |
| `RESEARCH_MAX_MINUTES` | `30` | Stop following a run after this long (it stays charged) |

Empty variables count as unset. Docker and deployment: see [`infra/README.md`](../../infra/README.md).

The LiteLLM proxy itself must not keep prompts or answers: `general_settings.store_prompts_in_spend_logs: false`,
`litellm_settings.turn_off_message_logging: true`, and no logging callbacks (the decider pricing
callback below logs nothing). Expose only the routes clients need (`/v1/chat/completions`,
`/v1/models`, `/v1/search/*`, exactly `/openrouter/alpha/decisions`, `/key/info`) at the public
reverse proxy; the admin API stays internal.

LiteLLM v1.104's price map has no `openrouter/perplexity/pplx-decider-v1.1-27b`, so without help
every decision costs $0 and budgets never fill. A `model_list` entry does not help (custom prices
are registered only under the deployment id, not the `openrouter/<model>` key the pass-through
looks up). The proxy needs a small callback module next to its config that registers the price
($0.02 per million input tokens, output free, as OpenRouter lists it):

```python
# sa_pricing.py, loaded with litellm_settings.callbacks: ["sa_pricing.handler"]
import litellm
from litellm.integrations.custom_logger import CustomLogger

litellm.register_model({"openrouter/perplexity/pplx-decider-v1.1-27b": {
    "input_cost_per_token": 2e-08, "output_cost_per_token": 0.0,
    "litellm_provider": "openrouter", "mode": "evaluation"}})
handler = CustomLogger()
```

## Layout

`src/app.ts` routes (`createApp(deps)`, tested with `app.request()`), `src/store.ts` all SQL,
`src/db/` Postgres/PGlite adapters and the migration runner (`migrations/*.sql`, recorded in
`schema_migrations`; never edit an applied one, add the next number), `src/providers/` LiteLLM /
mock key provisioners, `src/identity.ts` OpenAI ID-token checks, `src/subsidy-team.ts` the
ChatGPT keys' team, `src/research/` web research (Parallel client, charging and run
follower), `src/codes.ts` + `src/crypto.ts` codes, hashing and key encryption,
`src/admin-page.ts` the admin page, `src/cli/` the voucher CLI and the admin page opener.
