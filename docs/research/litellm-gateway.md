# LiteLLM as a gateway for capped keys, Exa and Parallel: research memo

Date: 2026-10-05. Context: [SPEC.md](../../SPEC.md) ("OpenRouter / LiteLLM API keys with capped
usage issued by voucher server"), [providers-and-research.md](providers-and-research.md) (which
recommends OpenRouter for vouchers). Scope: can one LiteLLM virtual key cap spend on LLM calls,
web search (Exa, Parallel) and research agents (Exa Agent, Parallel Task API)?

**How this was checked.** A throwaway LiteLLM proxy (**v1.104.0**, `litellm[proxy]` via `uv`,
Postgres 17 in Docker for keys and spend) ran locally on port 4000. LLM calls went to
`tools/mock-llm` (echo scenario, fake token prices). Exa and Parallel calls were **real, paid
calls** with temporary keys the user created, made by hand during a demo session (not by tests).
Labels:

- **[live]**: I made the call and saw the result.
- **[docs]**: from the vendor's documentation (linked at the end).
- **UNVERIFIED**: inference, or not tested.

No keys are recorded here; `sk-…`, `$EXA_API_KEY` and `$PARALLEL_API_KEY` are placeholders.

---

## TL;DR

1. **Virtual keys with a budget work as advertised for LLM calls and search tools.** A key with
   `max_budget` is charged per call and the spend is visible in the admin UI. [live]
2. **Native search tools are billed to the key.** `POST /v1/search/{tool}` worked for Exa and
   Parallel, and each search added **$0.005** to the key. That is LiteLLM's own price map, not
   the vendor's price (Exa reported $0.004 per search inside an agent run). [live]
3. **Research agents can be routed, but LiteLLM charges them $0.** Exa Agent works as an
   OpenAI-compatible Responses model; Parallel's processors work as chat models. Neither returns
   token usage, so LiteLLM logs `spend: 0` and **the key's budget does not cap them**. [live]
4. **Exa reports exact cost after the fact; Parallel does not.** Exa's
   `GET /agent/runs/{id}` returns `costDollars.total`, and the Responses reply carries the run id,
   so a proxy callback could bill exact cost. Parallel returns no cost anywhere. [live]
5. **Parallel's native Task API through LiteLLM needs Enterprise.** Pass-through endpoints with
   virtual-key auth require per-key `allowed_passthrough_routes`, an Enterprise-only field. [live]
6. **A key can read its own budget**: from response headers on every call
   (`x-litellm-key-spend`, `x-litellm-key-max-budget`), or from `GET /key/info` if the key was
   created with `info_routes` allowed. Default keys only get `llm_api_routes`. [live]
7. **The architectural catch is unchanged**: every request goes through *our* LiteLLM server,
   which sees all prompts and results and holds the master vendor keys. That contradicts
   "conversations are not proxied" (D3 in [DECISIONS.md](../DECISIONS.md)). LiteLLM is only
   worth it if we accept proxying, e.g. for research tools only, while chat stays on OpenRouter.

---

## 1. Setup

```yaml
# config.yaml (demo)
model_list:
  - model_name: mock-model
    litellm_params:
      model: openai/mock-model
      api_base: http://127.0.0.1:8789/v1
      api_key: not-a-real-key
      input_cost_per_token: 0.000002
      output_cost_per_token: 0.000008
general_settings:
  master_key: sk-demo-master
  database_url: postgresql://postgres:demo@127.0.0.1:5433/litellm
  store_model_in_db: true
```

- The Python package needs `prisma generate --schema <site-packages>/litellm/proxy/schema.prisma`
  once, or startup fails with "Unable to find Prisma binaries". [live]
- Search tools (Exa, Parallel) were added in the admin UI. They are stored in
  `LiteLLM_SearchToolsTable` with the vendor key **in plain text** (no salt key set). [live]
- Models added with `POST /model/new` are stored in the DB and survive restarts while the DB
  lives. [live]

## 2. Virtual keys, budgets and permissions

| Check | Result |
| --- | --- |
| `POST /key/generate {"max_budget":5,"models":[…],"duration":"1d"}` then a chat call | Works; spend updated a few seconds later. [live] |
| `models: []` on a key | Means **all models**, not none. [live] |
| `models: ["no-default-models"]` | Blocks every model: chat returns 403 `key_model_access_denied`. Not offered in the UI; set it via API. [live] |
| `object_permission.search_tools: ["Exa"]` | Limits search tools; an empty list means all. Enforced in `auth_checks.py`. Only one tool existed, so refusal of another tool is **UNVERIFIED**. [live] |
| Key with `no-default-models` + `search_tools: ["Exa"]` | Chat 403, Exa search 200: an "Exa-only" key. [live] |

Self-service budget check:

- Every LLM call returns `x-litellm-response-cost`, `x-litellm-key-spend` and
  `x-litellm-key-max-budget` headers, for any key. [live]
- `GET /key/info` with the key itself returns 403 for default keys
  ("Only allowed to call routes: ['llm_api_routes']"). A key created with
  `"allowed_routes": ["llm_api_routes","info_routes"]` can read its own `spend` and `max_budget`,
  and still gets 403 when reading another key or calling `/key/generate`. [live]

## 3. Search tools: `POST /v1/search/{tool_name}`

```sh
curl localhost:4000/v1/search/Exa -H 'Authorization: Bearer sk-…' -H 'Content-Type: application/json' \
  -d '{"query":"renovar DNI cita previa","max_results":3,"search_domain_filter":["gob.es"]}'
```

- **Exa** (`exa_ai`): 200, three relevant gov.es results. Supported `type`s in LiteLLM's
  transformer: `keyword`, `neural`, `fast`, `auto`. [live]
- **Parallel** (`parallel_ai`): 200, three `interior.gob.es` results. Parallel's run history lists
  these as `search` runs with processor `basic_search_partial_sources`. [live]
- Both charged **$0.005 per search** to the key. [live]

## 4. Exa Agent

How it works [docs]:

- Native API: `POST https://api.exa.ai/agent/runs` (async; poll `GET /agent/runs/{id}`, stream
  with `Accept: text/event-stream`, cancel with `POST /agent/runs/{id}/cancel`).
- `effort`: `minimal` $0.012, `low` $0.025, `medium` $0.10, `high` $0.50, `xhigh` $1.00 per
  request; `auto` (metered, $5 default cap) and `ultra` (metered, $20 cap). Metered runs accept
  `budget.maxCostDollars` ($1–$100).
- OpenAI-compatible: `POST https://api.exa.ai/responses` with `model: "exa-agent"` and
  `reasoning.effort`. `high`, `xhigh` and `ultra` need `stream: true` or `background: true`.
- With ZDR on, runs are kept only 10 minutes after completion.

Through LiteLLM [live]:

```sh
# register (admin)
curl localhost:4000/model/new -H 'Authorization: Bearer sk-demo-master' -H 'Content-Type: application/json' -d '{
  "model_name": "exa-agent",
  "litellm_params": {"model": "openai/exa-agent", "api_base": "https://api.exa.ai", "api_key": "$EXA_API_KEY"},
  "model_info": {"mode": "responses", "supports_reasoning": true}
}'
# call (any key)
curl localhost:4000/v1/responses -H 'Authorization: Bearer sk-…' -H 'Content-Type: application/json' \
  -d '{"model":"exa-agent","input":"¿Cuánto cuesta renovar el DNI en España en 2026?","reasoning":{"effort":"minimal"}}'
```

- Without `supports_reasoning: true`, LiteLLM rejects `reasoning.effort` with 400
  `UnsupportedParamsError` before the call reaches Exa.
- `minimal` took ~11 s and returned a correct, cited Spanish answer (12 €; free for address or
  data changes and for familia numerosa; renewable 180 days before expiry).
- `usage` is `null` in the reply, so LiteLLM logged **$0**.
- The output message id is `msg_agent_run_<id>`. `GET https://api.exa.ai/agent/runs/agent_run_<id>`
  returned `costDollars: {total: 0.012, search: 0.012, agentCompute: 0}` and
  `usage.searches: 3`. Reading a run is free.

**Billing it to the key (not built):** a LiteLLM custom callback (Python, loaded by the proxy via
`litellm_settings.callbacks`) that, after each `exa-agent` response, parses the run id, fetches
`costDollars.total` and records it as the request's cost. It would work for every effort level,
including `auto`. Open points: which hook can set the cost after the fact (UNVERIFIED); cost is
only known after the run, so a key could overspend unless the callback also sends the remaining
budget as `budget.maxCostDollars` (Exa's minimum is $1, and whether the Responses route accepts
`budget` is UNVERIFIED); background and streaming runs need the cost fetched on completion.

## 5. Parallel Task API

How it works [docs]:

- Native API: `POST https://api.parallel.ai/v1/tasks/runs` with `{input, processor}` and
  `x-api-key`; returns `run_id` and `status: queued`. Block on
  `GET /v1/tasks/runs/{run_id}/result?timeout=…`.
- Processors (per 1,000 runs): `lite` $5 (10–60 s), `base` $10 (15–100 s), `core` $25
  (60 s–5 min), up to `ultra` $300.
- Responses API: `POST https://api.parallel.ai/v1/responses`, `model: "parallel"`,
  `reasoning.effort` `low`/`medium`/`high`. No processor choice.
- Chat Completions (beta): `POST https://api.parallel.ai/v1beta/chat/completions`. The docs say it
  "can also be used with the Task API processors".

Through LiteLLM:

- **Pass-through endpoint** (`/parallel` → `https://api.parallel.ai`, `include_subpath`,
  `auth: true`, `cost_per_request: 0.01`): calls without a key get 401, but virtual keys get
  "Key/team not allowed to access passthrough route". Granting `allowed_passthrough_routes`
  fails with "only available for LiteLLM Enterprise users". Only the master key could use it.
  Note that `cost_per_request` would also charge every poll. [live]
- **Chat model** (works with any key) [live]:

  ```sh
  curl localhost:4000/model/new -H 'Authorization: Bearer sk-demo-master' -H 'Content-Type: application/json' -d '{
    "model_name": "parallel-base",
    "litellm_params": {"model": "openai/base", "api_base": "https://api.parallel.ai/v1beta", "api_key": "$PARALLEL_API_KEY", "timeout": 240},
    "model_info": {"mode": "chat"}
  }'
  ```

  Returns 200 in 8–10 s with a cited answer, an `interaction_id` (`chatcmpl_…`) and a `basis`
  array. `usage` is all zeros, so LiteLLM logged **$0**.

Is chat `base` the Base processor? [live]

| Test | Result |
| --- | --- |
| Chat with `model: "nonsense-model-xyz"` | Error "Invalid processor: nonsense-model-xyz": model names are processor names. |
| Chat `speed` (7 s) | Long answer, no `basis`. |
| Chat `base` (8–10 s) | Short answer with Task-style `basis` (`field`, `citations`, `reasoning`, `confidence`). |
| Native Task API `base` (51 s) | `status: completed`, JSON output, one `basis` entry. |
| `GET /v1/tasks/runs/chatcmpl_…` | "Invalid v1 task run id": chat calls have no task run id. |
| Parallel dashboard, Run History (all types, 2026-09-29 to 10-05) | 1 `task` run (the native `base` run) and 3 `search` runs. **None of the 4 chat calls appears** as a task run. |
| Cost fields in any reply or run | None. Listing runs via API fails: "Product(s) unavailable to provided credential". |

So chat `base` uses the Base processor's output format but is **not recorded as a Task API run**,
and runs far faster than native Base. How Parallel bills chat calls is **UNVERIFIED**: the pricing
page lists no Chat API price, and the run history does not show them. Check the billing or usage
page before trusting a flat $0.01 per request.

## 6. Where a cost callback would run

Inside the LiteLLM proxy process: a Python file next to `config.yaml`, registered under
`litellm_settings.callbacks`. In production that is our server, so research traffic would be
proxied and our master Exa/Parallel keys would live there. Nothing runs on the user's machine.

## Sources

- LiteLLM: [virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys),
  [pass-through endpoints](https://docs.litellm.ai/docs/proxy/pass_through),
  [v1.79.0 release notes (search APIs)](https://docs.litellm.ai/release_notes/v1.79.0-stable/v1-79-0)
- Exa: [Agent guide](https://exa.ai/docs/reference/agent-api-guide),
  [Create a run](https://exa.ai/docs/reference/agent-api/create-a-run),
  [OpenAI SDK compatibility](https://exa.ai/docs/integrations/openai-sdk),
  [Pricing](https://exa.ai/docs/admin/pricing)
- Parallel: [Pricing](https://docs.parallel.ai/getting-started/pricing),
  [Chat Completions (beta)](https://docs.parallel.ai/api-reference/chat-api-beta/chat-completions.md),
  [Responses API quickstart](https://docs.parallel.ai/responses-api/responses-quickstart.md),
  [LiteLLM integration](https://docs.parallel.ai/integrations/litellm)
