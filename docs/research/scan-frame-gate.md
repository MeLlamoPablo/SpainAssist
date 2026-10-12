# Scan frame gate (2026-10-04)

The original model was `perplexity/pplx-decider-v1-27b`, through OpenRouter with a global
service credential separate from vouchers, provided as `OPENROUTER_DECIDER_API_KEY`
(development loads the desktop gitignored `.env`). This is a typed decision model, not a chat model.

Primary sources checked:

- [OpenRouter System One API](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request):
  `POST /api/v1/systemone`, Bearer auth, `model`, `state`, named typed `questions`; yes/no
  answers use `{type: "noul", noul: probability}`. Usage has `input_tokens`, `output_tokens`
  and optional `cost`.
- [OpenRouter endpoint metadata](https://openrouter.ai/api/v1/models/perplexity/pplx-decider-v1-27b/endpoints):
  currently advertises `text+image->decisions` with text/image input modalities.
- [Perplexity Decisions API](https://docs.perplexity.ai/docs/decisions/quickstart): images go
  into `state` as OpenAI-style `image_url` parts with base64 data URLs. Images must remain
  below 2,048 tiles of 32×32 pixels; oversized inputs can time out instead of being rejected.
  Resizing the longest edge to 1408 bounds every aspect ratio below the limit.

**Availability checked:** the [OpenRouter model description](https://openrouter.ai/perplexity/pplx-decider-v1-27b)
still says image inputs are unsupported, while its endpoint metadata and FAQ say otherwise.
A user-requested manual replay on 2026-10-04 successfully evaluated all nine saved frames
through OpenRouter using this multimodal state format: image support works on this route.
All three face-only frames scored about 2% on document presence/legibility. Six document frames
passed both checks. The previous third question about satisfying the capture reason rejected two
readable front frames despite legibility scores of about 85% and 82%. It has been removed;
document type, person, side and passport-page checks belong to the extraction agent.
The initial manual replay averaged 0.58 seconds per request and reported $0.00134 total cost.
A fresh two-question replay accepted both disputed frames with the same 85% and 82% legibility
scores, using 2,463 input tokens and reporting $0.00009852 per frame.
No personal fields or images are copied into this memo. Automated tests remain offline.

Two independent yes/no questions check document presence and text legibility. Document presence must be at least 0.8 and text legibility at least 0.7. These thresholds
are application choices, not broadly calibrated.
The camera samples every 200 ms and retains only the latest unchecked frame. Camera sessions
run one decision request at a time, including during extraction; actual check frequency depends on network/model latency. Only accepted
frames reach extraction. The first accepted frame enters the agent directly, eliminating an
otherwise unnecessary initial capture-only model call.

Development transcripts retain every checked frame with its reason, decision probabilities,
acceptance, timestamps, model and token/cost usage. Packaged builds never write scan artifacts
and remove earlier scanner debug storage at startup. Existing chat/procedure transcripts and
explicitly saved vault documents are outside the temporary scanner-artifact lifecycle.

Scan feedback follow-up (2026-10-04): the UI uses a single status pill with explicit scanner
states. Initial positioning is gray (“Acerca tu documento”). Ten consecutive checks below the
legibility threshold switch it to gray legibility help; a legible check resets the counter,
including when document presence fails. Starting each extraction turn shows blue
“No muevas tu documento”. The agent's `capture_images` accepts an optional localized reason and requires a boolean
`success`: successfully reading a side and requesting the next side shows green feedback with
an animated check; unreadable/incorrect frames show red feedback with a warning. The next
analysis turn restores blue after feedback has been visible for at least three seconds.
This three-second minimum affects presentation; successful camera side changes separately pause forwarding for two seconds. Rapid
feedback messages each receive their own three seconds; transient progress states are coalesced.
Completion also waits for the feedback minimum, while cancellation and fatal errors clear it immediately. Reasons are not combined with gate advice or inferred from text.
The separate `post_message` tool has been removed so all agent feedback uses this path. Photo
uploads share the same states with photo-appropriate waiting/reading copy. Check animations
respect reduced motion. Offline tests cover the ten-failure boundary, streak resets, success
and failure feedback, the next-turn reset, and cancellation.

Names (including parents) are requested in natural capitalization with printed accents preserved.
Validated all-uppercase names also receive a casing fallback in checkpoints and final results;
existing mixed-case spelling and document identifiers remain unchanged.

Camera startup and issue-date follow-up (2026-10-04): guidance pills appear only after the
camera is ready, so the camera-opening overlay is the only spinner during acquisition.
Inspection of the latest local scan transcript and accepted images showed a clearly printed
issue date on the front, omitted from the first checkpoint and later marked unavailable.
The prompt incorrectly assigned this field to the back, and the completion check did not
require it. The DNI prompt now explicitly checks EXPEDICIÓN / EMISIÓN / DATE OF ISSUE on the
front before dropping that image, keeps it separate from birth/expiry dates, and checks both
sides before declaring it absent. Completion requires the issue date or an explicit unavailable
entry; truly absent dates remain supported. This improves instructions and omission detection,
but the host still relies on the model to distinguish absent from unreadable fields.
No personal values or images from the inspected scan are included in this memo or test fixtures.

Continuous camera screening (2026-10-04): a background gate worker keeps checking newly sampled
frames while the extraction model is working. It retains at most three distinct accepted JPEGs
in memory, replaces older frames when full, and expires frames after ten seconds from capture.
Provider retries can consume the accepted batch immediately; the first turn need not wait
for a full batch. Exact duplicate JPEGs are omitted within a batch. A successful read requesting
another side/page clears the old batch and invalidates an already captured/in-flight frame.
The extraction model still verifies identity and side for each image: legibility acceptance
alone does not prove the requested side is present. Background rejections cannot replace the
blue pill while extraction is running. Checks remain serialized and have a 200 ms pause between
them, so slow checks never create a growing queue. Uploaded photos keep their on-demand path.
Completion, failure and cancellation stop the worker and clear its memory before the scan ends;
a late JPEG during shutdown is discarded. Existing development-only transcript retention and
production no-artifact behavior apply to background decisions too. The desktop-only start API
now declares camera/photo source; shared contracts are unchanged.

Offline tests cover concurrent checking, three-frame batches, rejection/deduplication, expiry,
side changes with in-flight decisions, cancellation, multi-image extraction inputs and late
frames during completion. The new integration tests mock provider fetch in memory and do not
require a local HTTP listener. Any improvement in extraction accuracy remains to be measured
with real use; buffering provides additional distinct observations, not an accuracy guarantee.

Scan resilience follow-up (2026-10-04): failed decision requests previously terminated the
camera session before extraction, while the UI blamed photo sharpness. Camera screening now
logs every failure with sanitized categories (HTTP status, missing key, malformed response,
timeout or network), duration and retry count, then retries a fresh frame with bounded backoff.
Accepted buffered frames survive screening errors. Extraction failures retry the same context,
with background screening continuing; camera frame delivery errors retry too. Camera sessions
have no overall three-minute deadline. Invalid model responses and conversation limits restart
extraction automatically instead of publishing a fatal camera error. User cancellation,
window closure and successful completion still stop all work promptly. Photo sessions retain
their existing bound and error flow. Offline tests exercise repeated screening failures,
extraction recovery, automatic conversation restart, logging redaction and retry cancellation.

Screening fallback (2026-10-04): each screening operation now has a three-second total
budget including requests and retry delays. Errors are still logged safely. A stalled request
is aborted at the deadline. If screening has not recovered, a single bypass diagnostic is
logged and the gate remains disabled for that scan, including subsequent side changes and
extraction conversation restarts. Camera frames continue buffering and reach extraction
without a fabricated acceptance decision; uploads use the same fallback. A valid negative
decision is a normal rejection, not a screening error, and never activates bypass.
Cancellation stops the budget timer and pending requests without activating fallback.

Scanner turn-over follow-up (2026-10-04): after a successful read requests another camera
side/page, forwarding pauses for two seconds. Sampling and screening continue, but buffered
and in-flight frames from before or during this pause are discarded before waiting for a
fresh accepted frame. This gives the user time to turn the document; the extraction agent
still verifies the requested side. `capture_images` requires success but permits an omitted
reason: the previous instruction is restored/retained without blue or legibility updates
until new explicit feedback arrives. The prompt tells the agent to request another capture
with success false and no reason when the user has not yet completed the requested turn-over
(or, since 2026-10-10, any requested rotation or close-up).
Cancellation interrupts the pause immediately. Shared contracts remain unchanged.

Legibility review (2026-10-04, latest scan 17:30:57–17:32:14 UTC): 107 valid decisions,
9 accepted. Three HTTP 429 errors recovered through retry, with no bypass. The reverse
waited about 53 seconds after turn-over feedback; 79 consecutive valid rejections preceded
its first acceptance. Visual inspection sampled 17 rejected frames and one accepted control:
three rejected frames showed substantial blur or finger obstruction (0003, 0016, 0018),
and 0030 had both obstruction and blur. The other 13 rejected samples had readable main
fields/MRZ despite varying softness; several were visually comparable to accepted 0093.
Glare was mainly over the hologram rather than the personal text. The model supplies no
explanation, so glare cannot be established as the sole cause. Requiring full visibility and
no significant glare conflated photographic quality with extraction usefulness.

The legibility question now explicitly tolerates reflections outside main text, unreadable
security microprinting and missing nonessential edges, while rejecting frames where most
main fields and the MRZ cannot be read. Presence stays at 0.8; legibility moves to 0.7,
including the UI rejection-streak cutoff. Applied to the saved scores alone, the new cutoff
would accept 65/107 frames (first reverse at 0022 instead of 0093). This is a retrospective
threshold calculation, not a replay or a guarantee of extraction accuracy. The new prompt
has not been sent to a paid provider; automated tests use synthetic responses only. Further
real scans are needed to assess its effect. No personal values/images enter this memo or fixtures.

Clef-flash trial via OpenRouter (2026-10-04): the active screening model is now
`cloudflare/clef-flash` through the existing `/api/v1/systemone` endpoint and
`OPENROUTER_DECIDER_API_KEY`. No Cloudflare account or token is required. The direct
Cloudflare trial was replaced before the user's comparison scan.
[OpenRouter model page](https://openrouter.ai/cloudflare/clef-flash) and
[endpoint metadata](https://openrouter.ai/api/v1/models/cloudflare/clef-flash/endpoints)
confirm image input and decision output, served by Cloudflare. The existing multimodal
state format, typed responses, two questions, 0.8/0.7 thresholds, buffering, request timing
and retry/bypass behavior remain unchanged. Offline adapter/environment/scanner tests
validate the existing route with the new model selector; no live paid request was made.
The user's next scan will assess real latency and rejection quality.

Failed-read recapture follow-up (2026-10-04): `capture_images` with success false now clears
buffered frames and invalidates an in-flight old frame before waiting for a fresh accepted
frame (or an unscreened frame after bypass). It adds no fixed delay. Success true still
clears frames and pauses forwarding for two seconds. Background sampling/screening continue.
This prevents immediate reuse of the previous side but does not verify the requested side.

Perplexity Decider switch (2026-10-05): OpenRouter's zero-data-retention setting is now on
for all providers, and `cloudflare/clef-flash` has no ZDR endpoint, so screening was blocked.
The active screening model is now `perplexity/pplx-decider-v1-27b`, which OpenRouter lists as
ZDR (served by Perplexity), with text+image input and decision output on the same
`/api/v1/systemone` endpoint and `OPENROUTER_DECIDER_API_KEY`. Prompt, questions, 0.8/0.7
thresholds, timeout and bypass behavior are unchanged. Offline tests only; no live paid
request was made. The user's next scan will assess its latency and rejection quality.

Screening through LiteLLM (2026-10-05, D12): screening now calls our LiteLLM gateway at
`/openrouter/alpha/decisions` with the user's voucher key or ChatGPT subsidy key. OpenRouter
documents both `POST /api/alpha/decisions` (Decisions API) and `POST /api/v1/systemone` (System
One API) for the same `DecisionsRequest`/`DecisionsResponse` schema, billed alike
([Jev guide](https://openrouter.ai/docs/guides/community/jev.md),
[Decisions API reference](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request));
LiteLLM v1.104 only prices the former. Checked against a local LiteLLM v1.104.0 proxy (Postgres,
fake OpenRouter upstream, no paid calls): with the decider price registered by a callback module,
each decision was charged `input_tokens × $4e-8` to the key; `budget_limits` windows (`1d`,
`1mo`) and a team budget rejected the next call with 422 `budget_exceeded` (one call of overshoot
for back-to-back calls), window spend survived a proxy restart; a `model_list` entry alone left
the cost at $0. Keys limited to `allowed_routes: ["/openrouter/alpha/decisions", "/key/info"]`
got 403 on `/openrouter/v1/systemone`, `/openrouter/v1/chat/completions` and `/v1/chat/completions`,
but `/openrouter/alpha/decisions/../../v1/chat/completions` (also `%2e%2e`) reached the upstream
chat endpoint with the proxy's key: the public reverse proxy must forward only the exact path.
Not yet checked against the live gateway or a real OpenRouter decision.
