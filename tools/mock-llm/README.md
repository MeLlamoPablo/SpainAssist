# `@sa/mock-llm`

A scripted, offline LLM server for tests, demos and for developing the eval harness for free
(`tools/eval`). Rules (`when` conditions, `reply`) are matched against each request; see
`src/scenario.ts` for the full vocabulary and `src/scenarios.ts` for the built-in `demo` and `echo`.

```sh
corepack pnpm --filter @sa/mock-llm start -- --port 8789 [--scenario file.json|demo|echo] [--litellm] [--litellm-budget 1.5]
```

## Endpoints

| Endpoint | What |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI chat completions, SSE or JSON |
| `POST /v1/responses` | Responses API (JSON, or SSE with `stream: true`); LiteLLM emulation applies |
| `POST /backend-api/codex/responses` (`/codex/responses`) | The ChatGPT Codex backend shape: always SSE, zstd/gzip/br request bodies decoded, `Authorization` and `chatgpt-account-id` required (401 otherwise) |
| `GET /v1/models`, `GET /key/info` | Model list; the simulated key's `{ spend, max_budget }` |
| `POST /__scenario`, `GET /__scenario`, `GET /__requests`, `POST /__reset`, `GET /__health` | Control and inspection (recorded requests have their bodies decoded) |
| `GET\|POST /__litellm` | The simulated LiteLLM key (`{ spendUsd, maxBudgetUsd }`) |

WebSocket upgrades are refused with `426` (pi tries a WebSocket first for Codex and falls back to SSE); the
attempt is recorded as a `method: 'UPGRADE'` request.

## LiteLLM emulation

`createMockLlm({ litellm: { maxBudgetUsd, spendUsd, prices, cacheReadRatio, cacheWriteRatio, usageShape,
responseCostHeader, costInUsage } })` simulates a virtual key: `x-litellm-key-spend` (the spend before the call, like
the real gateway), `x-litellm-key-max-budget` and `x-litellm-response-cost` headers; usage with cache-read,
cache-write and reasoning tokens (`usageShape: 'anthropic'` puts cache writes only in the top-level
`cache_creation_input_tokens`, which pi ignores); and `422 "Budget has been exceeded!"` once the key is over its cap (`budgetExceededStatus: 402` for the OpenRouter-style status).
A reply's `usage` can set `promptTokens`, `completionTokens`, `cachedTokens`, `cacheWriteTokens`,
`reasoningTokens` and `costUsd`; `headers` adds response headers; `error` takes a `type` and extra `fields`
(`{ status: 429, type: 'usage_limit_reached', fields: { plan_type: 'plus', resets_at } }`).

## Deeper matching

Besides `lastUser`, `lastTool`, `lastToolResult`, `turn`, `model` and `hasTool`:

- `systemPrompt`: regex on the system prompt (tells the assistant, procedure agents, the answerer apart);
- `toolCalled`: history (`{ name, args?, result?, atLeast?, atMost? }`, one or a list); its named groups feed the
  templates from the most recent matching call, so a reply can reuse a value seen several turns ago;
- `lastToolResultNot`, `hasImage`, `anyOf`, `not`;
- `state` / `set`: a state shared by every request of the scenario (`null` = unset), for multi-step scripts.
  `reset()` and `setScenario()` clear it;
- templates: `{{name}}` is a capture (or `lastUser`, `turn`, `date`); `{{name|untag}}` is the capture with Unicode tag
  characters (U+E0020..U+E007E, invisible when rendered) turned into the ASCII they stand for, which is how a scripted
  model reads text smuggled in them. An unknown filter is an error.

On the Responses endpoints the request items (`input`, `instructions`, `function_call_output`...) are converted
to the same facts, so one scenario works for both APIs.
