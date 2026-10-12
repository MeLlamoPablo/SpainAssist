# @sa/maps-server

Address lookups for the desktop app's maps. It forwards them to Mapbox Geocoding v6 with our
secret token, so no Mapbox token ships in the app, and it limits each user. Hono on Node; no
database.

## API

| Method & path | What |
| --- | --- |
| `GET /v1/geocode?q=<address>` | Mapbox forward geocoding for Spain, passed through (Bearer gateway key) |
| `GET /health` | `{ "status": "ok" }` |

The app sends only `q` (1–500 characters). The server fixes everything else: `country=es`,
`language=es`, `types=address,street` (no place-name results), `autocomplete=false`, `limit=5`.

**Authentication.** `Authorization: Bearer sk-…` with the user's LiteLLM gateway key (a voucher
key, or a ChatGPT account's key from the key server). The server calls LiteLLM's `GET /key/info`
with that key (keys may read their own info). The key must be active, unexpired and below its
`max_budget`. Answers are cached by key hash for 5 minutes (1 minute for rejections). The check
and the quota live in `@sa/gateway-keys`, shared with the feedback server.

**Limits.** `DAILY_LIMIT` lookups per key per UTC day (default 250), `WEEKLY_LIMIT` per UTC
week from Monday (default 500), and `RATE_LIMIT_PER_IP_PER_MINUTE` requests per client IP (default 60, before any key check). All are
in memory: a restart resets them.

Errors look like `{ "error": { "code": "…", "message": "…" } }`: `bad_request` (400),
`unauthorized` (401), `no_credit` (403), `rate_limited` / `quota_exceeded` (429, with
`Retry-After`), `upstream` (502), `unavailable` (503, LiteLLM unreachable).

**Privacy and Mapbox terms.** Results are Mapbox temporary geocodes: the server passes them
straight through (`Cache-Control: no-store`) and never caches or stores them. Queries are
personal addresses: the access log has method, path, status and duration only. Raw keys are
never kept, only their SHA-256.

## Configuration

| Variable | Default | What |
| --- | --- | --- |
| `MAPBOX_TOKEN` | required | Mapbox token (`sk.…` in production) |
| `LITELLM_URL` | required | LiteLLM base URL (internal URL in production) |
| `DAILY_LIMIT` | 250 | Lookups per key per UTC day |
| `WEEKLY_LIMIT` | 500 | Lookups per key per UTC week (from Monday) |
| `RATE_LIMIT_PER_IP_PER_MINUTE` | 60 | Requests per client IP per minute (0 disables) |
| `TRUST_PROXY` | off | Client IP from `X-Forwarded-For` (behind our reverse proxy only) |
| `HOST` / `PORT` | 127.0.0.1 / 8793 | Listen address |

Local development: `MAPBOX_TOKEN=… LITELLM_URL=https://llm.… corepack pnpm services` starts it on
port 8793 next to the other services, and `corepack pnpm dev:local` points the app at it. Tests
use fakes and never call Mapbox or LiteLLM.

Production: Coolify app `maps-server` (`infra/terraform/coolify.tf`), token from the
`mapbox_secret_token` Terraform variable.
