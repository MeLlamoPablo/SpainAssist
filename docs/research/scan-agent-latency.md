# Scan extraction model comparison (2026-10-04)

Luna baseline: latest completed development scan, session
`30df7d67-c575-404e-aeea-dabbcfb3f279`, started at 18:03:53.880 UTC.
Extraction used `gpt-6-luna` through `openai-codex`, with reasoning off.
Decider screening stays in place for the next scan.

| Turn | Response time (s) | Output tokens | Tool calls |
| --- | ---: | ---: | --- |
| 1 | 5.839 | 105 | record_fields |
| 2 | 5.918 | 150 | record_fields, capture_images |
| 3 | 3.436 | 18 | capture_images |
| 4 | 3.502 | 52 | record_fields, capture_images |
| 5 | 6.746 | 120 | record_fields, capture_images |
| 6 | 9.105 | 184 | record_fields, capture_images |
| 7 | 5.762 | 172 | finish_scan |

Seven turns total 40.308 s, mean 5.758 s, median 5.839 s, range 3.436–9.105 s.
The complete scan took 49.688 s; approximately 81% was spent awaiting extraction turns.
Total output: 801 tokens; no reasoning tokens reported. Even the 18-token response took
3.436 s, so shorter output alone cannot explain or eliminate these waits.

Method: assistant message timestamp (request start) to the first following toolResult
message timestamp (before capture waiting). This estimates full request-to-response latency,
including transport, queueing and generation; it does not measure first-token time or isolate
inference. Capture waits are excluded from individual turn times. Screening proceeds concurrently.
One scan is a baseline, not a stable latency distribution or a controlled model benchmark.

Temporary production override (removed 2026-10-10): `google/gemini-3.5-flash-lite`, hardcoded to OpenRouter
at `https://openrouter.ai/api/v1`, using the same main-only `OPENROUTER_DECIDER_API_KEY`
as the decider. No chat credential fallback, settings mutation, or credential persistence.
E2E retains the existing mock route. Prompt, tool contracts, capture behavior and output limit
remain the same. The development transcript records the actual model, provider and effort.

[OpenRouter model metadata](https://openrouter.ai/api/v1/models) advertises mandatory reasoning
for Flash Lite, with `minimal` as its lowest supported/default effort. The bundled pi model
catalog agrees (`off: null`). This trial explicitly uses `minimal`, rather than sending an
unsupported request to disable thinking. See the
[reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
The next real scan measures Gemini; no authenticated paid requests were made during this change.
The comparison changes both model and provider route (Codex to OpenRouter) and reasoning
configuration (off to minimal), so results describe the practical application configurations.
No personal values or image content are included here.
