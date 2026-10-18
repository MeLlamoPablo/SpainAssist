# Scan frame gate: research memo

Dates: 2026-10-04 to 2026-10-17. Scope: which model screens camera frames before extraction, with
what questions and thresholds, and how it is billed.

**What was built** (sampling and the 1408 px resize, the three-frame buffer, the two yes/no
questions with 0.8/0.7 thresholds, the gateway route, retries and the 3-second bypass, recapture
pauses) is in `apps/desktop/src/main/scanner/` (`decider.ts`, `frame-buffer.ts`, `screening.ts`,
`retry.ts`); `docs/ARCHITECTURE.md` ("Document scanning") has the overview.
This memo keeps the measurements and the reasons behind those choices. No frames or personal
values are copied here, and automated tests stay offline.

## API facts

- OpenRouter documents two endpoints for the same `DecisionsRequest`/`DecisionsResponse` schema,
  billed alike: `POST /api/alpha/decisions` (Decisions API) and `POST /api/v1/systemone` (System
  One API). Yes/no answers come back as `{type: "noul", noul: probability}`. LiteLLM v1.104 only
  prices the former, so the gateway route is `/openrouter/alpha/decisions`.
- Images go into `state` as OpenAI-style `image_url` parts with base64 data URLs
  ([Perplexity Decisions API](https://docs.perplexity.ai/docs/decisions/quickstart)). They must stay
  below 2,048 tiles of 32×32 px, and **oversized inputs can time out instead of being rejected**.
  Resizing the longest edge to 1408 px keeps every aspect ratio below the limit.
- OpenRouter's model page for the original decider said image input was unsupported, while its
  endpoint metadata and FAQ said otherwise. A manual replay on 2026-10-04 confirmed images work.

## Questions and thresholds

- **First replay (2026-10-04, nine saved frames):** three face-only frames scored about 2% on
  presence and legibility; six document frames passed. A third question ("does it satisfy the
  capture reason?") rejected two readable front frames that scored about 85% and 82% on
  legibility, so it was removed: document type, person, side and passport page belong to the
  extraction agent. About 0.58 s per request.
- **Legibility review (2026-10-04, one real scan):** 107 valid decisions, 9 accepted; three HTTP
  429s recovered by retry. The reverse side waited about 53 s, with 79 consecutive rejections
  before its first acceptance. Of 17 rejected frames inspected, only 4 had real blur or finger
  obstruction; the other 13 had readable main fields and MRZ, several comparable to an accepted
  frame. Glare sat mainly over the hologram. Requiring "full visibility, no significant glare"
  confused photo quality with usefulness for extraction.
- **Result:** the legibility question now tolerates reflections outside the main text, unreadable
  security microprinting and missing nonessential edges, and rejects frames where most main fields
  and the MRZ can't be read. Legibility moved from 0.8 to 0.7 (presence stays at 0.8). On the saved
  scores alone, 0.7 would have accepted 65 of 107 frames. That is a retrospective calculation, not
  a replay. **The thresholds are application choices, not broadly calibrated.**

## Model history

| Date | Model | Why it changed |
| --- | --- | --- |
| 2026-10-04 | `perplexity/pplx-decider-v1-27b` | Original choice. |
| 2026-10-04 | `cloudflare/clef-flash` (via OpenRouter) | Trial; no live comparison was recorded. |
| 2026-10-05 | `perplexity/pplx-decider-v1-27b` | OpenRouter's zero-data-retention setting went on for all providers, and Clef-flash has no ZDR endpoint, so screening was blocked. |
| 2026-10-17 | `~perplexity/pplx-decider-flash-latest` | `pplx-decider-v1.1-27b` started answering 404 "No endpoints found", so screening fell through to the bypass. |

**Decider Flash bench (2026-10-17, through our gateway, same request and thresholds as the app).**
144 images, each three times: the 23 saved scan-eval frames (should pass), 69 made unreadable from
them (strong blur, shrunk to 56 px) plus 6 without a document (should fail), and 115 borderline
variants (mild blur, dim, dark) reported but not scored.

| Model | Score | Median latency | Cost per ~1,300-token frame |
| --- | --- | --- | --- |
| `pplx-decider-flash-v1.2-20261016` | 99% (one dim, blurred DNI frame rejected at 0.69 legibility; no false accepts) | 535 ms | $0.000013 |
| `pplx-decider-v1.2-20261016` | 97% (two such frames rejected) | 670 ms | $0.000026 |

Both answered identically on every repeat. The negatives are synthetic and the hard real frames
are few: a signal, not a calibration. The `-latest` alias means a new Flash version needs no
release. **Risk:** the gateway's hand-registered decider price follows the alias and must be
checked whenever the alias moves. ChatGPT keys had the old model id in their model list (LiteLLM
checks it on the decisions route too), so the key server now gives the team and every ChatGPT key
the configured `DECIDER_MODEL` at startup.

## Billing through LiteLLM (2026-10-05)

Checked against a local LiteLLM v1.104.0 proxy (Postgres, fake OpenRouter upstream, no paid calls):

- A `model_list` entry alone left the cost at $0. With the decider price registered by a callback
  module, each decision was charged `input_tokens × $4e-8` to the key.
- `budget_limits` windows (`1d`, `1mo`) and a team budget rejected the next call with 422
  `budget_exceeded` (one call of overshoot for back-to-back calls). Window spend survived a proxy
  restart.
- Keys limited to `allowed_routes: ["/openrouter/alpha/decisions", "/key/info"]` got 403 on other
  routes, but **`/openrouter/alpha/decisions/../../v1/chat/completions` (also with `%2e%2e`)
  reached the upstream chat endpoint with the proxy's key**. The public reverse proxy must forward
  only the exact path; see `services/key-server/README.md` ("Behaviour worth knowing").

## Open

- Whether buffering several accepted frames improves extraction accuracy is unmeasured. It gives
  more distinct observations, not an accuracy guarantee.
