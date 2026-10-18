# LiteLLM as a gateway for capped keys, Exa and Parallel: research memo

Date: 2026-10-05. Scope: can one LiteLLM virtual key cap spend on LLM calls, web search (Exa,
Parallel) and research agents (Exa Agent, Parallel Task API)?

**What was built.** Vouchers are capped LiteLLM virtual keys, with OpenRouter behind LiteLLM and
Parallel search through `POST /v1/search/parallel`. We accepted that prompts pass through our
server (LiteLLM stores none). Parallel Task runs are sold by the key server itself
(`POST /v1/research`), because LiteLLM can't cap them (§3). See `infra/README.md` ("Why it looks
like this") and `services/key-server/README.md` ("Web research", "Behaviour worth knowing"). This
memo keeps the measured LiteLLM, Exa and Parallel behaviour behind those choices.

**How this was checked.** A throwaway LiteLLM proxy (**v1.104.0**, Postgres 17) ran locally. LLM
calls went to `tools/mock-llm`. Exa and Parallel calls were **real, paid calls** made by hand with
temporary keys during a demo session (not by tests). **[live]** I made the call and saw the result;
**[docs]** vendor documentation; **UNVERIFIED** inference or untested.

---

## 1. LiteLLM virtual keys [live]

| Check | Result |
| --- | --- |
| `max_budget` on a key, then a chat call | Works; spend shows up a few seconds later. |
| `models: []` | Means **all models**, not none. |
| `models: ["no-default-models"]` | Blocks every model (403 `key_model_access_denied`). API only, not in the UI. |
| `object_permission.search_tools: ["Exa"]` | Limits search tools; an empty list means all. Refusal of another tool is UNVERIFIED (only one existed). |
| `GET /key/info` with the key itself | 403 for default keys (`llm_api_routes` only). Works when the key's `allowed_routes` include `info_routes`, and still can't read other keys. |
| Response headers on every LLM call | `x-litellm-response-cost`, `x-litellm-key-spend`, `x-litellm-key-max-budget`, for any key. |
| Search tools added in the admin UI | Stored in `LiteLLM_SearchToolsTable` with the vendor key **in plain text** (no salt key set). |

- **Search price:** `POST /v1/search/{tool}` worked for Exa and Parallel and charged **$0.005 per
  search** to the key. That is LiteLLM's price map, not the vendor's (Exa reported $0.004 per
  search inside an agent run).
- **Setup gotcha:** the Python package needs
  `prisma generate --schema <site-packages>/litellm/proxy/schema.prisma` once, or startup fails
  with "Unable to find Prisma binaries".

## 2. Exa Agent (not built)

[docs]

- Native API: `POST https://api.exa.ai/agent/runs` (async; poll `GET /agent/runs/{id}`, stream with `Accept: text/event-stream`, cancel with `POST /agent/runs/{id}/cancel`).
- Prices per request by `effort`: `minimal` $0.012, `low` $0.025, `medium` $0.10, `high` $0.50, `xhigh` $1.00. `auto` and `ultra` are metered ($5 and $20 default caps); metered runs accept `budget.maxCostDollars` ($1–$100).
- OpenAI-compatible: `POST https://api.exa.ai/responses` with `model: "exa-agent"` and `reasoning.effort`. `high`, `xhigh` and `ultra` need `stream: true` or `background: true`.
- With ZDR on, runs are kept only 10 minutes after completion.

Through LiteLLM [live]:

- Register it as `openai/exa-agent` with `api_base: https://api.exa.ai` and `model_info: {mode: "responses", supports_reasoning: true}`. Without `supports_reasoning`, LiteLLM rejects `reasoning.effort` with 400 `UnsupportedParamsError`.
- `minimal` took about 11 s and returned a correct, cited Spanish answer.
- `usage` is `null`, so **LiteLLM logs $0 and the key's budget doesn't cap it**.
- **Exa reports exact cost after the fact:** the output message id is `msg_agent_run_<id>`, and `GET /agent/runs/agent_run_<id>` returns `costDollars: {total: 0.012, …}` and `usage.searches`. Reading a run is free.
- To bill it, a LiteLLM callback could fetch `costDollars.total` after each response. Open points: which hook can set cost after the fact (UNVERIFIED); cost is only known afterwards, so a key could overspend unless the remaining budget is sent as `budget.maxCostDollars` (minimum $1; whether the Responses route accepts `budget` is UNVERIFIED).

## 3. Parallel Task API

[docs]

- Native: `POST https://api.parallel.ai/v1/tasks/runs` with `{input, processor}` returns a `run_id`. Block on `GET /v1/tasks/runs/{run_id}/result?timeout=…`.
- Processors per 1,000 runs: `lite` $5 (10–60 s), `base` $10 (15–100 s), `core` $25 (60 s–5 min), up to `ultra` $300.
- Also a Responses API (`model: "parallel"`, no processor choice) and a beta Chat Completions API that "can also be used with the Task API processors".

Through LiteLLM [live]:

- **Pass-through** (`/parallel` → `https://api.parallel.ai`): virtual keys get "Key/team not allowed to access passthrough route", and granting `allowed_passthrough_routes` is **LiteLLM Enterprise only**. Only the master key could use it. `cost_per_request` would also charge every poll.
- **Chat model** (`openai/base` at `https://api.parallel.ai/v1beta`): works with any key, 200 in 8–10 s with a cited answer and a `basis` array. `usage` is all zeros, so **LiteLLM logs $0**.

Is chat `base` the Base processor? [live]

| Test | Result |
| --- | --- |
| Chat with `model: "nonsense-model-xyz"` | "Invalid processor": model names are processor names. |
| Chat `base` (8–10 s) vs native Task `base` (51 s) | Same Task-style `basis`, but chat is far faster. |
| `GET /v1/tasks/runs/chatcmpl_…` | "Invalid v1 task run id": chat calls have no task run. |
| Parallel dashboard run history | The native run and 3 search runs appear; **none of the 4 chat calls does**. |
| Cost fields in any reply or run | None. Listing runs via API fails: "Product(s) unavailable to provided credential". |

How Parallel bills chat calls is **UNVERIFIED** (no Chat API price on the pricing page). Check the billing page before trusting a flat price per request.

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
