# Embeddings for the feedback server's search: research memo

Date: 2026-11-16. Scope: which embeddings model, through our LiteLLM gateway, finds learnings by
meaning; how to store and rank with it; what it costs.

**What was built.** The feedback server's search is hybrid: its Spanish full-text search plus
`google/gemini-embedding-001` (1536 dimensions) through the gateway, vectors in Postgres with
pgvector, both result lists merged by reciprocal rank. See `services/feedback-server/README.md`
("Hybrid search") and `infra/README.md` ("Hybrid search"). This memo keeps the measurements
behind those choices.

**How this was checked.** **[live]** Real calls, made by hand on 2026-11-16, to production's
gateway (`/v1/embeddings`, LiteLLM v1.106.2 → OpenRouter) with the master key: about two
thousand requests, a few cents. The corpus was production's 37 approved learnings. The questions were
written for this test: 48 that one to four learnings answer, worded as a person would ask and
mostly *without* the learnings' own words (so they favour embeddings: agents' keyword queries do
better with text than these numbers say), and 18 that no learning answers. They are in
`services/feedback-server/eval/queries.json`; `eval:search` (the server's README) repeats the
last table. Thresholds were tuned on the same 66 questions, so the hybrid numbers are optimistic.
One question is 2 points of hit@1: differences smaller than that mean nothing.
**UNVERIFIED** marks what was not tried.

---

## 1. The gateway serves embeddings [live]

- `POST /v1/embeddings` with `{"model": "<OpenRouter id>", "input": [...]}` works through the
  wildcard route (`model_list: "*"` → `openrouter/*`) with no config change.
- `dimensions` is passed on (Gemini, OpenAI and Perplexity models returned the size asked for).
- The answer has `usage.prompt_tokens` but no `x-litellm-response-cost` header: LiteLLM had no
  price, so the key was charged nothing. `templates/litellm_sa_pricing.py` now registers
  OpenRouter's embedding prices (`/api/v1/embeddings/models`, mode `embedding`). That LiteLLM
  then charges the key is **UNVERIFIED** (not deployed when this was written): look for the
  header after the next apply.
- **The account's zero-data-retention policy applies.** OpenRouter refused five of fourteen
  models with "0 endpoints … matching your guardrail restrictions and data policy":
  `google/gemini-embedding-2`, `cohere/embed-5-pro`, `cohere/embed-5-fast`,
  `mongodb/voyage-4-large` and `mongodb/voyage-4`. The models below passed it.

## 2. Models [live]

Embeddings alone (no text search): each learning embedded once as procedure, administration,
title, body and tags; each question embedded as written; ranked by cosine similarity. Latency
is one question per request, from a laptop.

| Model | Dimensions | hit@1 | MRR | Latency (median) | $ per M tokens |
| --- | --- | --- | --- | --- | --- |
| `google/gemini-embedding-001` | 3072 | **0.958** | **0.979** | 1.08 s | 0.15 |
| `openai/text-embedding-3-large` | 3072 | 0.917 | 0.958 | 0.97 s | 0.13 |
| `perplexity/pplx-embed-v1-4b` | 2560 | 0.896 | 0.943 | 0.54 s | 0.03 |
| `openai/text-embedding-3-small` | 1536 | 0.917 | 0.941 | 0.60 s | 0.02 |
| `qwen/qwen3-embedding-4b` | 2560 | 0.854 | 0.920 | 0.73 s | 0.02 |
| `intfloat/multilingual-e5-large` | 1024 | 0.854 | 0.916 | 1.77 s | 0.01 |
| `mistralai/mistral-embed-2312` | 1024 | 0.875 | 0.913 | 0.62 s | 0.10 |
| `baai/bge-m3` | 1024 | 0.812 | 0.900 | 0.76 s | 0.01 |
| `qwen/qwen3-embedding-8b` | 4096 | 0.792 | 0.889 | 0.90 s | 0.01 |

- Qwen wants an instruction before the query ("Instruct: …\nQuery: …"): with one, the 8b model
  reached 0.896 / 0.938, still behind. The e5 model was tried without its `query:` prefixes.
- **Fewer dimensions cost nothing here.** Gemini at 1536: 0.958 / 0.979 (the same); at 768:
  0.938 / 0.969. OpenAI large at 1536 and 1024: 0.938 / 0.969. pgvector indexes at most 2000
  dimensions, so 1536 it is.
- **Gemini also separates best what it knows from what it doesn't**, which a similarity floor
  needs. Similarity of the best right learning, against the best learning for a question
  nothing answers:

  | Model (1536 dimensions) | Right: lowest / 10th percentile / median | Nothing answers: median / 80th percentile / highest |
  | --- | --- | --- |
  | `google/gemini-embedding-001` | 0.64 / 0.67 / 0.73 | 0.58 / 0.61 / 0.64 |
  | `openai/text-embedding-3-large` | 0.49 / 0.54 / 0.63 | 0.42 / 0.47 / 0.57 |

  Similarities are not comparable between models: the floor (`EMBEDDINGS_MIN_SIMILARITY`, 0.64)
  only fits this one.

**Choice:** `google/gemini-embedding-001` at 1536 dimensions. It costs the most per token, and
that is nothing: the 37 learnings are about 10,000 tokens ($0.002 to embed them all), a query
about 15 ($2 per million searches). What it does cost is time: every search waits 0.6 to 1.1 s
for its query's vector (the text search took milliseconds). Agents search a few times per
procedure, so that was accepted; `perplexity/pplx-embed-v1-4b` is the one to try if it stops
being acceptable.

## 3. Hybrid ranking [live]

The server's own search over the same corpus (`eval:search`, limit 8). "Noise" is how many
learnings a question gets that no learning answers.

| Search | hit@1 | hit@3 | recall@5 | MRR | Noise |
| --- | --- | --- | --- | --- | --- |
| Text only (before) | 0.688 | 0.833 | 0.811 | 0.752 | 2.2 |
| Hybrid | 0.958 | 1.000 | 0.974 | 0.979 | 0.6 |

- **Fusion.** Reciprocal rank fusion (k = 60) of the text hits and the vector hits. Halving the
  text list's weight, or weighing text hits by their stage (strict, any term, trigram), moved
  one or two questions: not worth a knob.
- **The floor.** With no floor every unanswerable question got 8 learnings; at 0.60, 2.4; from
  0.62 to 0.66 the text search's own 2.2, with hit@1 at 0.92 to 0.94; at 0.68 right answers
  started to go (0.90), at 0.70 more (0.88).
- **Weak text hits.** The 2.2 learnings unanswerable questions still got all came from the text
  search's "any term" and trigram stages ("certificado de antecedentes penales" matches every
  learning about a certificate). Dropping partial text hits whose similarity is more than 0.05
  below the floor took the noise to 0.6 and lost no right answer (0.10 below: 1.1; at the floor:
  0.1, but one right answer went).

## 4. Where the vectors live

- **pgvector, not a vector database and not our own index.** The server already keeps everything
  in Postgres, and PGlite (development and tests) has the same extension
  (`@electric-sql/pglite-pgvector`, pinned to the PGlite version it is built for). Triage,
  filters and deletes stay one SQL statement away from the vectors. An exact scan of a few
  thousand 1536-dimension vectors takes under a millisecond, so there is no index yet.
- **The official `postgres` image has no pgvector, and pgvector's own image is Debian.**
  Production's data was created on Alpine (musl); under Debian's glibc the same locale sorts
  text differently, which silently breaks existing indexes on text columns in all five
  databases. So `infra/postgres/Dockerfile` compiles pgvector 0.8.7 (by commit) onto the same
  Alpine image. [live, locally] It builds for arm64 and amd64; a data directory created by the
  official image starts under the new one; a role that owns its database creates the extension
  (the image marks it `trusted`).
- **Coolify always pulls a database's image before it starts it** (`docker compose pull`, under
  `bash -e`: read in Coolify 4.4.7's `StartPostgresql.php`), so an image that only exists on
  the server would not start: it has to come from a registry. A GitHub workflow publishes it to
  ghcr.io. That a package published from this public repository is public without a setting is
  **UNVERIFIED**.

## Sources

- OpenRouter: [embeddings API](https://openrouter.ai/docs/api/reference/embeddings),
  [embedding models and prices](https://openrouter.ai/api/v1/embeddings/models)
- LiteLLM: [OpenRouter provider](https://docs.litellm.ai/docs/providers/openrouter),
  [`/embeddings`](https://docs.litellm.ai/docs/proxy/embedding)
- pgvector: [README](https://github.com/pgvector/pgvector) (types, limits, `OPTFLAGS`)
- Coolify: [`StartPostgresql.php` at v4.4.7](https://github.com/coollabsio/coolify/blob/v4.4.7/app/Actions/Database/StartPostgresql.php)
