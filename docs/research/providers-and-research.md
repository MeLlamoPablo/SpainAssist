# Inference providers, research tools and feedback server: research memo

Date: 2026-10-03. Scope: (A) inference via vouchers and "Sign in with ChatGPT", (B) research tools for the agent, (C) the feedback server (Spanish full-text search and PII scrubbing).

**What was built is documented elsewhere.** Vouchers: `services/key-server/README.md` and
`infra/README.md`. Agent research tools (`exa_search`, `fetch_url`, `boe_search`):
`packages/agent/README.md` and `docs/ARCHITECTURE.md`. Feedback search:
`services/feedback-server/README.md`. PII: `packages/pii/src`. This memo keeps only what the code
doesn't record: external-service facts, measured results, rejected options and open questions.

**How this was checked.** Official docs fetched on 2026-10-03, or live tests run the same day from a Spanish residential IP (Telefónica). Labels: **[live]** I called it and saw the result; **[docs]** vendor documentation; **UNVERIFIED** secondary source, inference, or not testable without credentials.

---

## Outcomes

1. **Vouchers became capped LiteLLM virtual keys**, not OpenRouter management keys as this memo first
   recommended. OpenRouter sits behind LiteLLM. `infra/README.md` ("Why it looks like this") gives
   the reason: Parallel has no per-key limits, so our gateway has to meter it, and we accepted that
   prompts pass through our server (LiteLLM stores none). LiteLLM measurements:
   [litellm-gateway.md](litellm-gateway.md).
2. **Idea for later: unlinkable vouchers.** [Open Anonymity](https://openanonymity.ai/) (Stanford; EF and HRF grants) mints short-lived, USD-capped OpenRouter keys in exchange for **blind-signed Privacy Pass tickets** (RFC 9474), so even the minting station can't link a key to a payment. It's a research project, not infrastructure for us. The design is worth copying: blind-signed vouchers would stop the key server from linking a voucher purchase to a key. Reference station: [oa-station-reference](https://github.com/OpenAnonymity/oa-station-reference) (MIT).
3. **Sign in with ChatGPT** uses the official open-source flow (§A3), with our own login so the consent screen says "Spain Assist" (`packages/agent/src/providers/chatgpt.ts`).
4. **Web search is Exa** through its hosted MCP (`packages/agent/src/research/exa.ts`), with `includeDomains` built from `OFFICIAL_DOMAINS` in `@sa/shared`. No dependable keyless general search exists (§B4).
5. **The SIA/PAG procedure catalogue was built and then removed.** Exa search replaced it (`services/feedback-server/migrations/004_drop_catalog.sql`). What we learned about the export is in §B5.

---

## A3. "Sign in with ChatGPT" for Plus and Pro

**Eligibility** [docs: <https://developers.openai.com/siwc>]

- On 2026-09-29 (DevDay), SIWC was extended to let **Plus and Pro** users spend their plan allowance in third-party apps.
- "ChatGPT plan usage is available to all open-source partners and selected private clients." The OSS docs cover "**open-source and locally hosted apps**. If you're interested in offering it in a **paid or remotely hosted app**, complete the [interest form](https://openai.com/form/sign-in-with-chatgpt-interest/)." **Our eligibility depends on Spain Assist staying open-source and locally hosted.**
- Usage counts toward the user's plan limits. Users can cap each app as a percentage of their weekly plan usage (Settings → Usage → App limits). The app gets no access to conversations or memories.

**Flow facts the code relies on** [docs: siwc/token-sharing-open-source/*]

- Persist a per-installation `ext_agent_host_id` **before the first login** (`urn:uuid:…`, a JWK thumbprint, or `did:key:…`). Never use the email or user ID.
- First registration uses `client_id=dynamic_agent_client` and `agent_name_hint`. The callback returns the issued `oaiapp_…` client id; persist it per ChatGPT account.
- The redirect must be `127.0.0.1`, not `localhost`. Later logins may change only the port.
- Scope: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`. **Proceed only if the returned `scope` contains `chatgpt.tokens.use.direct`.**
- Tokens: `access_token` lasts 1 h, `refresh_token` 30 days and rotates. Serialize refreshes.
- Inference: `POST https://api.openai.com/v1/responses` with `"store": false, "stream": true`, `input` as an array. System-role items are rejected; use `instructions` or developer messages. List models with `GET /v1/models` (`visibility=="list"`): what SIWC exposes depends on the account.

**Preview limits** [docs]

- **Fields that must be omitted:** `background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt, prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user`. Over HTTP, `previous_response_id` is not accepted either.
- **Tools:** function/custom tools go in namespaces or `additional_tools`. "Web search remains subject to model and account/workspace policy." Unsupported: image generation, file search, Code Interpreter, computer use, hosted MCP, `tool_search`.
- **Errors:** `subscription_sharing_usage_limit_exceeded` (429: link to <https://chatgpt.com/settings/usage>), `…_user_not_eligible` (403), `…_unsupported_capability` (400; read `error.param`). Errors can arrive mid-stream as `response.failed`.
- **UX:** label the button **Continue with ChatGPT**, show "Using ChatGPT plan" next to the model picker, add a **Manage usage** link.

**Legacy Codex OAuth route** (development only; never ship)

The route reuses Codex CLI's own `client_id` (`app_EMoamEEZ73f0CkXaXp7hrann`) and calls `POST https://chatgpt.com/backend-api/codex/responses` with `chatgpt-account-id`, `OpenAI-Beta: responses=experimental` and `originator` headers. A third-party app presenting itself as Codex CLI and calling an internal endpoint is a ToS risk: OpenAI's SIWC docs say "do not point it at ChatGPT's `backend-api` endpoints". Expect blocking or account action (UNVERIFIED enforcement). `packages/agent/src/providers/codex.ts` keeps it behind `import.meta.env.DEV`.

---

## B. Research tools for the agent

### B4. Web search APIs

| Service | Price (2026-10) | Free tier | Domain filter | Notes |
|---|---|---|---|---|
| **Exa** (chosen) | `instant` $4/1k, `fast`/`auto` $7/1k, `deep*` $12–15/1k, `/contents` $1/1k pages | $10 credits every month (no card); keyless hosted MCP, rate-limited | `includeDomains`/`excludeDomains`, ≤1,200 entries, `host`, `host/path`, `*.host`; `userLocation:"ES"` | 10 QPS. ZDR on Enterprise only. |
| Brave Search | $5/1k | The 5k/month free plan is gone for new users (Feb 2026); $5 monthly credits, card required | `site:` or Goggles (UNVERIFIED) | Storing results needs a plan with storage rights. |
| Tavily | 1–2 credits/search; PAYG $0.008/credit | 1,000 credits/month, no card | `include_domains` ≤300, `exclude_domains` ≤150 | `include_raw_content: "markdown"`, `/extract`. |
| Serper (Google SERP) | $1/1k down to $0.30/1k | 2,500 free queries (one-time) | `site:` in `q` | Snippets only. |
| Jina | Token-based | `r.jina.ai` reader works keyless at 20 RPM [live]; `s.jina.ai` search returns 401 without a key [live] | UNVERIFIED | Reader handles PDFs and JS pages. |
| OpenRouter web | Exa engine $0.007/request | Billed to the same key | Engine-dependent | Server tool is beta; not on `eu.openrouter.ai`. |

**Keyless options: live results (2026-10-03, Spanish residential IP)**

| Option | Result |
|---|---|
| DuckDuckGo HTML/lite (curl, Node fetch, headless Chrome) | **HTTP 202 "anomaly" bot challenge**, 0 results, on the first request (IP possibly flagged by earlier probes) |
| Mojeek | JS captcha / 403 |
| Public SearXNG (`format=json`), 28 instances listed as healthy | **0/28** returned JSON results (429, 403, HTML) |
| Exa hosted MCP, keyless | Protocol works, but the **first call hit "You've hit Exa's free MCP rate limit"** |
| Bing SERP in headless Chrome | 10 results, but scraping breaks Bing's terms. **The #1 result for "cita previa DNI" was an unofficial site (citapreviadnie.es)**: the accuracy risk to guard against |

Don't ship DuckDuckGo or SearXNG scraping as a dependency.

### B5. Official Spanish sources

**BOE open-data API** [live] (`packages/agent/src/research/boe.ts`). Keyless, GET only, format via the `Accept` header. Docs: [APIconsolidada.pdf](https://www.boe.es/datosabiertos/documentos/APIconsolidada.pdf). Quirks:

- `…/texto/bloque/{id_bloque}` (one article with its version history) is **XML only**; JSON returns 400.
- In JSON responses single children become objects and repeated children arrays, so normalize or use XML.
- `https://www.boe.es/diario_boe/xml.php?id=BOE-A-…` returns any published item without PDF parsing.
- Measured latency: about 0.14 s for a title search, 0.5 s for a full-text search.

**SIA/PAG procedure catalogue** (built, then removed). There is no public REST API. The "Buscador de trámites" page has an official XML/CSV export (max 10,000 results per request; AGE alone is 7,977 procedures, 34 MB, 12 s). It is an undocumented form backend that returns **403 without the `Referer` header and the `serviceCurrentPathPage`/`pag_orders` fields**. robots.txt asks for `Crawl-delay: 60` and `Visit-time: 0100-0645` GMT. Data quality is uneven: broken or concatenated URLs and generic descriptions. Reuse terms are UNVERIFIED.

**Regional catalogues** [live where noted]: Catalunya Socrata `analisi.transparenciacatalunya.cat/resource/9p3b-4s2k.json` [live]; Castilla y León `datosabiertos.jcyl.es/…/tramites/1284165766476.json` (502 during the test); Andalucía CKAN `package_search?q=procedimientos` [live]; others via `datos.gob.es/apidata/catalog/dataset/keyword/procedimientos.json` [live]. Madrid and Euskadi are UNVERIFIED.

### B6. `fetch_url` choices [live]

`packages/agent/src/research/fetch.ts` uses `@mozilla/readability` on `linkedom`, `turndown` with the GFM plugin, and `unpdf`. Measurements behind the choice:

- `linkedom` 27–34 ms per page vs `jsdom` 106–125 ms, with identical Readability output.
- `unpdf`: 18-page BOE PDF in 158 ms. `defuddle` also worked (84 ms) as an alternative extractor.
- Many gov sites still serve ISO-8859-1 (e.g. dnielectronico.es): honour the header, then `<meta charset>`.
- Avoid `mupdf` (AGPL).
- `r.jina.ai` returns clean Markdown keyless at 20 RPM, but it sends the URL to a third party: never use it for URLs that carry session tokens.

---

## C. Feedback server

### C7. Spanish full-text search: the unaccent pitfall [live: PGlite 0.5.8 = PostgreSQL 18.3]

Snowball's Spanish suffixes include accents, so running `unaccent` before `spanish_stem` changes some stems:

| word | `spanish_stem` | `unaccent` → `spanish_stem` |
|---|---|---|
| renovación | **renov** | **renovacion** |
| renovar | renov | renov |
| información | **inform** | **informacion** |

With only `spanish_unaccent`, "renovación" no longer matches "renovar". That's why
`services/feedback-server/src/search.ts` indexes and queries **both** `spanish` and
`spanish_unaccent`, plus `pg_trgm` for typos. PGlite ships `spanish`, `unaccent` and `pg_trgm`.
`unaccent(text)` isn't `IMMUTABLE`, so indexes need an immutable wrapper. If ranking falls short,
PGlite also has `pg_textsearch` (BM25) as an external extension (UNVERIFIED in prod).

### C8. PII scrubbing for Spanish text

Implemented in `packages/pii` (known values, then checksummed detectors). Facts and options not recorded there:

- **Layers, strongest first:** (1) redact the user's own known values from the vault before anything leaves the device; (2) deterministic detectors with checksums on client and server; (3) optional NER for names and places; (4) the server re-scans and **rejects instead of storing**; (5) treat quasi-identifiers (case numbers, register receipts, exact appointment times, cadastre refs) as PII.
- **NER options, not built:** `@huggingface/transformers` with a Spanish NER ONNX model (model choice UNVERIFIED), or **Microsoft Presidio** as a sidecar. Presidio is Python, uses spaCy `es` models, and ships `EsNifRecognizer`, `EsNieRecognizer` and `EsPassportRecognizer`.
- **npm libraries surveyed:** `validator`, `ibantools` and `libphonenumber-js` validate but don't find. Generic redactors (`openredaction`, `@redactpii/node`, `@arcjet/redact`, `redact-pii`) are US/UK-centric: openredaction has a `SPANISH_DNI` rule but no NIE/NAF/CCC checksums. **None is enough alone.**
- **NUSS/NAF checksum:** no official TGSS spec was found. Two validators use `CC = (N < 10⁷ ? PP·10⁷+N : PP·10⁸+N) mod 97`; Faker uses plain `PPNNNNNNNN mod 97`. Accept both.
- **Context-only detectors** (frequent false positives otherwise): passports and DNI support numbers (`[A-Z]{3}\d{6}`), plates, postal codes, and dates of birth. Keep deadlines and publication dates: they are useful feedback.
- **Known gaps:** names are caught only through known values or NER; free-form addresses without a street-type keyword are missed; regional health cards (CIP/TSI, formats vary by region) aren't covered; 9-digit numbers starting with 6–9 get over-redacted as phones.

---

## Sources

- Sign in with ChatGPT: <https://developers.openai.com/siwc/quickstart>, <https://developers.openai.com/siwc/token-sharing-open-source>, `…/sign-in`, `…/models-and-inference`, `…/preview-limitations`, `…/errors-and-recovery`, <https://developers.openai.com/siwc/ui-ux-guidelines>; user docs <https://learn.chatgpt.com/docs/sign-in-with-chatgpt>
- Open Anonymity: <https://openanonymity.ai/blog/unlinkable-inference/>, <https://github.com/OpenAnonymity/oa-station-reference>
- Search: <https://exa.ai/docs/admin/pricing>, <https://exa.ai/docs/reference/search>, <https://exa.ai/docs/get-started/exa-mcp>, <https://brave.com/search/api/>, <https://docs.tavily.com/documentation/api-credits>, <https://serper.dev/>, <https://jina.ai/reader/>, <https://searx.space/data/instances.json>
- Official sources: <https://www.boe.es/datosabiertos/api/api.php>, <https://administracion.gob.es/tramites-electronicos/resultadosActuaciones>, <https://administracion.gob.es/robots.txt>, <https://datos.gob.es/apidata/>
- Postgres: <https://pglite.dev/extensions/>, <https://www.postgresql.org/docs/current/unaccent.html>, <https://www.postgresql.org/docs/current/pgtrgm.html>
- Presidio Spain recognizers: <https://github.com/microsoft/presidio/tree/main/presidio-analyzer/presidio_analyzer/predefined_recognizers/country_specific/spain>

## Open questions

- Which models SIWC exposes on Plus vs Pro (account-specific), and how `web_search` is billed on plan usage.
- Exa: the rate limits of the keyless MCP.
- NAF/NUSS: no official TGSS checksum specification.
