# SpainAssist — Architecture (MVP)

> Status: living document, written by the project coordinator. See `docs/DECISIONS.md` for the
> reasoning behind the stack and `docs/research/` for the underlying research.

## 1. Big picture

```
┌──────────────────────────── Electron app (apps/desktop) ────────────────────────────┐
│                                                                                     │
│  Renderer (React)  ◄── window.sa (typed IPC, @sa/shared ipc.ts) ──►  Main (Node)    │
│  • one conversation (left), procedure cards / Mis datos / Ajustes (right)           │
│  • native prompts (forms, confirmations,          ┌─────────────────────────────┐   │
│    manual actions)                                │ Services in main            │   │
│  • "Mis datos" vault UI, document scanning (model vision)  │ • Settings store            │   │
│  • onboarding / provider setup                    │ • Vault (@sa/vault)         │   │
│                                                   │   KeyProvider = safeStorage │   │
│                                                   │ • Conversation, procedures, │   │
│                                                   │   activity logs; Coordinator│   │
│                                                   │ • Browser (@sa/browser)     │──────► Chromium window(s)
│                                                   │   + AutoFirma shim/signer   │   │   (Playwright, one
│                                                   │ • Feedback client + PII     │   │    context per procedure)
│                                                   │   scrub (@sa/pii)           │   │
│                                                   │ • AgentManager              │   │
│                                                   │ • Host bridge (HTTP, local) │   │
│                                                   └──────┬──────────────▲───────┘   │
│                                                          │ spawn         │ HTTP     │
│                                                          │ JSON-lines    │ (token)  │
│                                                   ┌──────▼──────────────┴───────┐   │
│                                                   │ pi agent hosts (RPC, Electron│   │
│                                                   │ as Node), @sa/agent:        │──────► LLM provider (vouchers: LiteLLM)
│                                                   │ • the assistant: 1, owns the│   │
│                                                   │   chat, delegates           │   │
│                                                   │ • one per active procedure: │──────► key server (research) / fetch
│                                                   │   research, browser, card   │──────► feedback server (search)
│                                                   └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘

  services/key-server       voucher code → capped LiteLLM virtual key (never sees conversations);
                            ChatGPT ID token → the account's scan-decider key (D12)
  LiteLLM gateway (infra)   voucher LLM calls → OpenRouter, search tools → Parallel,
                            scan decider → OpenRouter Decisions API, phone-call transcription
                            (voucher and ChatGPT keys); budgets per key, stores no prompts
                            (D10, D12)
  services/feedback-server  anonymous, PII-scrubbed learnings; Postgres full-text search;
                            sharing and votes need the user's LiteLLM key, like maps
  services/maps-server      Mapbox address lookups for map forms; checks the user's LiteLLM
                            key (active, has credit) and daily and weekly limits per key
  services/relay-server     desktop ↔ phone relay for DNIe signatures: end-to-end encrypted
                            frames only, no accounts; the pairing links' landing page
  apps/mobile               the phone app (Compose Multiplatform, Android): reads the DNIe
                            over NFC and signs what the desktop sends, after the user approves
```

## 2. Processes

- **Main process** owns all state and secrets: settings, vault, procedures, transcripts, the
  browser, and agent processes. It exposes:
  - the **renderer API** (`window.sa`, see `packages/shared/src/ipc.ts`): one `invoke` channel
    + one push `event` channel;
  - the **host bridge** (see `packages/shared/src/bridge.ts`): HTTP on `127.0.0.1:<random>`,
    one bearer token per agent process, used only by agent processes. The token identifies the
    agent, and methods are gated by kind: the assistant gets `procedures.*`, `prompt.form` and
    `vault.*`; procedure agents get everything else.
- **Agent processes** (see `docs/DECISIONS.md` D9), spawned with Electron's own Node
  (`ELECTRON_RUN_AS_NODE=1`), so nothing else needs to be bundled:
  - **the assistant** (orchestrator): one pi session behind the app's single, perpetual chat
    (`assistant/session.jsonl`, auto-compacted). It never researches or browses; it starts and
    briefs procedure agents and talks to the user;
  - **one procedure agent per active procedure**: does every tool call for that procedure and
    keeps its card current. Its final message of each run is a short report, which main clips
    and queues to the assistant. **Redaction** (`packages/agent/src/host/redaction.ts`), opt-in
    by model (`REDACTED_MODELS`, empty for now: Haiku looped re-reading pages it had lost): before
    each LLM call, the model sees every page result (snapshot or screenshot) since its latest
    snapshot; older ones are sent without their snapshot and screenshot (URL, title, downloads
    and dialogs stay). The session file keeps everything. Old snapshots
    were about 80% of a long procedure's context; redacting them the same way on every call
    keeps the prompt prefix cached.
  **Idle compaction** (`packages/agent/src/host/idle-compaction.ts`): when a run settles, a
  timer fires at 90% of the prompt cache lifetime of its last request (the model's
  `promptCache`; off for models that declare none). If the agent is still idle and its
  context has at least 50k tokens, it compacts then, so the user's next message sends a short
  context instead of rewriting the whole one to the cache. The summary request is the last request, exactly as
  sent, plus its response and a "summarize" message, so it reads the cached prompt (pi's own
  summarizer sends the conversation as new text). A message from the user during an idle
  compaction cancels it: the cache is still warm.
  **Prompt caching on LiteLLM** (`packages/agent/src/host/model.ts`): pi's OpenRouter catalog
  lists Claude models for the Anthropic API without a marker format, so `anthropic/*` models get
  `cacheControlFormat: 'anthropic'` explicitly (pi then marks the system prompt, the last tool
  and the last message). `openai/*` models cache on their own; the extension sends the session
  id as `prompt_cache_key` so a session's requests reach the same cache. Both get a
  `promptCache` lifetime, which turns idle compaction on for them.
  Idle agents are stopped; pi session files keep the context, so any agent resumes transparently.
  pi's built-in coding tools are disabled; only SpainAssist tools exist.
- **Browser**: a single Playwright-managed Chromium with one isolated context (cookies,
  certificates) per procedure. Desktop windows stay minimized during automation and restore
  only when the user clicks “Ver navegador” in a pending `request_user_action` that needs
  browser help (CAPTCHA, QR scan, manual step). Posting the request never opens the window.
  Completing or cancelling the request minimizes them again without recreating the
  session. Settings and procedure menus do not offer browser visibility controls; main gates
  `browser.show` on the pending help request. The legacy shared `browser.headless` settings
  field is retained for compatibility and ignored by browser creation. A development/e2e-only
  `SA_BROWSER_HEADLESS` override supports fully headless test runs. At startup main checks that
  the Chromium revision playwright-core needs is in the Playwright cache and, when it is missing,
  downloads it in the background (about 150 MB, once) with playwright-core's own installer
  (`ensureChromium` in `@sa/browser`, `gc: false` so other Playwright browsers stay). Browser
  actions wait for that download; when it fails, they return an actionable error and the next
  action tries again. E2e runs never download; the development-only `SA_BROWSER_EXECUTABLE`
  override launches a given Chromium instead.
- **Packaged app** (D17, `apps/desktop/electron-builder.ts`). app.asar holds `out/` (main,
  preload, renderer), the agent host as `agent-host/host.js`, and the node_modules of
  `dependencies`, which include the host's external imports. Agent processes run that host as
  Electron-as-Node, so the `runAsNode` fuse stays on. `sa-sidecar` sits in `<resources>/vendor/`,
  outside the ASAR. Chromium is not bundled: it downloads on first use, as described above.

## 3. Key flows

### 3.1 Conversation and delegation
User message → `chat.send` → the assistant (started on demand) gets it. For a new need it calls
`procedure_list`, then `procedure_start({title, brief})` → main creates the procedure and sends the
brief to a new procedure agent (the tool returns after acceptance; execution continues in the
background). More information later → `procedure_message` (queued as a follow-up if that agent is
busy). Questions about a
procedure → `procedure_read` (its card, runtime and pending questions, including field keys and
options), not the agent. Answers provided in chat → `procedure_respond` resolves the pending data
form through the same path as the native UI; omitting values dismisses that one request. Newly
available credentials, corrections or changed plans → `procedure_resume` aborts the current run,
cancels its pending requests and starts a new run with the update. Only the coordinator has this
control; cancellation never approves a confirmation or completes a manual action. Abort and new
delivery are serialized, and a failed abort stops the old process before starting a replacement
with the same session. Ordinary `procedure_message` queues a follow-up and cannot unblock a
pending request by itself. Message/resume results wait for agent acceptance and distinguish
started from queued; neither proves that the instruction has been acted on. These controls cannot
pass secrets/documents as model-generated answers. Only at the user's explicit request,
`procedure_stop` interrupts a procedure's agent and cancels pending questions, preserving the card
for later resumption with `procedure_message`. `procedure_cancel` marks an unwanted procedure
cancelled. Procedure cards do not expose a stop control.

### 3.2 Research and the card
The procedure agent first uses `web_research`, with anonymized context from the user's saved
data (age, municipality, document dates…) and a `mode` it chooses (`fast`, `balanced`,
`deep`: Parallel `base`, `core`, `pro`). Voucher users run it on Parallel's Task API through
our key server, paid from the voucher (D13). Other providers have no web research. One request
stays
open until a terminal event arrives: progress updates reach the activity log, and the model
receives only the final result, without polling turns. Abort closes the stream; a disconnect or
30-minute timeout reports the known run ID without automatically creating a replacement run.
After research completes, the agent refines and verifies the findings with `fetch_url`,
`boe_search`, read-only browser navigation and `feedback_search` (community learnings).
It resolves research uncertainties and formulates the plan before asking for missing user
information or executing it. Without web research, it reports the research blocker. It updates the card with `procedure_update` (status, steps,
requirements, facts, sources, next action). Main maps its pi events to the procedure's activity
log (`procedure.log` events) and `runtime.now` (what it is doing), never to the conversation.
When the run ends, the Coordinator adds a compact "news from …" row to the conversation and sends
the assistant a report (card status + the agent's last message, ≤ 600 characters), which it
relays to the user in a sentence or two.

### 3.3 Asking the user
Tools `ask_user` / `confirm_action` / `request_user_action` / `request_credential` /
`request_phone_call` → bridge `prompt.*` → main creates a
pending `PromptItem`. A procedure agent's goes to its procedure: `runtime.prompts` (pushed with
`procedure.upserted`) and its activity log; the renderer shows it inline on the card. The
assistant's own goes to the conversation and docks in place of the composer. The user answers →
`chat.respond(itemId)` → main resolves the pending bridge request of the agent that asked.
Form fields can declare `visibleWhen: {field, values}` against a dropdown in the same form.
The renderer shows and validates only applicable fields; main also removes hidden answers before
storing, returning or saving them to the vault.
Unanswered data forms (and phone calls, below) remain in the local transcripts across shutdown and are restored on startup,
including their procedure-card runtime state. Answering a restored form saves eligible values to the
vault and starts the owning agent from its saved session with the redacted answer. If delivery fails,
the form remains pending for retry. Secrets are never forwarded: the agent must request them again
through native tools. Confirmations and manual actions from interrupted runs are cancelled because
the browser operation they referred to is no longer live. Explicit stop, resume, dismissal and delete
still clear obsolete requests.

**Phone calls.** When a step can only be done by phone, `request_phone_call` → `prompt.phoneCall`
posts a `phone_call` prompt (organisation, number, purpose, ordered questions, what to have at
hand, opening sentence, hours). The card can record the call from the microphone (Web Audio,
16 kHz mono WAV, at most 20 minutes) and sends the audio to main with
`phoneCall.transcribe(itemId)`, which works only while that prompt is pending. Main transcribes
it on our LiteLLM gateway with the user's own key (voucher, or the ChatGPT subsidy key; never in
the renderer): `/v1/chat/completions` with an `input_audio` part, `TRANSCRIPTION_MODEL`, OpenRouter
ZDR routing, 5-minute parts in parallel. BYOK, custom endpoints and Codex have no gateway key, so
the card offers notes only. The user edits the transcript, then answers with the outcome, the
transcript and notes; the agent gets them as the tool result. Audio is never stored. Like data
forms, pending phone calls survive a restart.

Questions never block the chat. The coordinator can answer or dismiss data forms when the user
provides the answer. When the user changes plans, resume cancels obsolete forms, confirmations
and manual-action requests without answering them; late responses to cancelled prompts are rejected.
Stopping a procedure cancels its questions; a chat message cancels the assistant's. Form answers
for fields with a `vaultKey`
(except secrets and documents) are always written to the vault.

Place choices use the `map-options` form type: the agent gives several places (a value, a name
and a street address with its town each, researched from official sources) and gets back one
chosen value. Agents never supply coordinates. Map lookups use Mapbox Geocoding v6 through our
maps server (`apps/desktop/src/main/places/maps.ts` → `services/maps-server`) for the address
only, sent as written with no clean-up, restricted to Spain (`country=es`, and the response country is checked too). A result
counts only if it is an address or street in the address's own town. Place names are never
searched: Mapbox's terms tie place-name (POI) results to a Mapbox map, and fuzzy name matches
picked the wrong centre in tests. An address Mapbox does not know goes back to the agent.

Mapbox results are temporary geocodes: they may place pins and sort by distance, but must never
be stored, cached on disk, logged, shown as numbers or sent to the agent. So each address is
looked up once:
- Before `prompt.form` publishes anything, main places every option (`locateMapForm`). If any
  place has no match, no partial form is shown: the bridge returns the failed option identifiers
  to the agent with instructions to research street addresses and retry. Service failures also
  return to the agent.
- The pins go to `PromptManager.ask` beside the prompt, not inside it: they live in memory on the
  pending prompt and disappear when it is answered or cancelled. The published prompt, and so the
  saved transcript, is the agent's own form.
- The picker asks main for them (`places.pins(promptId, fieldKey)`). A form restored after a
  restart has none in memory, so main looks its addresses up once and keeps them the same way.
- The home works the same way: only the address is saved in Mis datos, and its pin is looked up
  again (`places.locateHome`, sent as saved) each time a map prompt opens.

Public queries never add the saved home address. The home step is optional: when the street and
town are already in Mis datos, the picker skips it and places the home in the background. Typing
an address and choosing “Buscar mi dirección” does the same lookup. Either way, the best match is
shown as the home pin, with no list of candidates; “Cambiar” corrects it. No lookup logs queries
or raw service errors. Distances and sorting use local great-circle calculations, labelled as
straight-line distances. Only the selected option value is returned to the asking agent.

No Mapbox token ships in the app. Main sends each lookup to the maps server
(`PRODUCTION_SERVICES.mapsServerUrl`; dev override `SA_MAPS_SERVER_URL`) with the user key
(see "Users" below). The server checks that key with LiteLLM (active, unexpired, below its
budget), allows 250 lookups per key per UTC day and 500 per UTC week, and forwards the query to
Mapbox with our secret token, passing the result straight through (see
`services/maps-server/README.md`). Users without a user key (own API key, custom endpoint) get no
lookups: the form shows the list without pins. When a key's lookups are used up
(`quota_exceeded`), the form is shown anyway as a list with no map, and the agent is not told to
retry. If a map form is not shown (an address not found, the service down), main keeps that
procedure's lookup results in memory for 10 minutes, until its next form, so the agent's retry
only looks up the addresses that changed. E2e runs have no maps server.

Map tiles are OpenStreetMap's standard raster tiles (`tile.openstreetmap.org`) drawn by Leaflet,
with “© OpenStreetMap contributors” attribution. Main identifies the app with its own
User-Agent, as the [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/)
asks; ordinary HTTP caching stays on. The service has no guarantee and may block heavy users, so
self-hosting tiles (Protomaps or OpenFreeMap's open stack) is the fallback. Previews and e2e use
offline demo tiles and mock pins.


### 3.4 Using credentials (the model never sees secrets)
Before starting authentication, the procedure prompt requires matching the methods actually
offered by the service to saved credential summaries and capabilities the user explicitly confirmed.
Cl@ve Permanente does not imply Cl@ve Móvil availability. If no supported method is known to be
available, the agent explains the mismatch and asks before initiating authentication.

`browser_fill_from_vault({ref, value: {source:'credential', credentialId, field:'password'}})`
→ main checks: credential exists, policy (`ask` → confirmation prompt, with Touch ID when
available), the element's frame URL is on an allowed domain for that credential kind
(`credentialAllowedOn`), the field is a password input when typing a password → fetches the
secret from the vault → `browser.type(..., {secret:true})` → later snapshots mask the value.

Client certificates: `browser_use_certificate` → origin policy and consent (Touch ID when
available) → main opens the vault `.p12` with `@sa/signer.openP12`, or asks `CompanionService`
for the DNIe authentication key → `browser.useClientCertificate({origins, identity})`.
`packages/sidecar` supplies each browser context its own authenticated loopback proxy port.
Only enabled origins are intercepted; the sidecar verifies their HTTPS certificate with the
platform verifier. Other sites are raw tunnels verified by Chromium. A per-launch SPKI pin
trusts only the helper's ephemeral key. Updating the identity preserves cookies and page state.
The main process starts the helper and closes it on quit; a missing binary disables certificate
logins with a clear tool error. See D15 and the production packaging checklist.

### 3.5 Signing (AutoFirma replacement)
Every page gets the AutoScript shim (`@sa/signer`) injected before site scripts. When the site
calls `AutoScript.sign(...)`, the shim forwards the call to the `__saAfirma` binding → main shows
a signature confirmation (what, for whom, which certificate; Touch ID) → `@sa/signer` signs with
the `.p12` (CAdES/XAdES/PAdES, triphase when the site requests it) → the site's success callback
receives the signature exactly as if AutoFirma had produced it.

### Signing and logging in with the DNIe in the phone
All of this is behind the `dnie-phone` feature flag (see [Feature flags](#feature-flags)).
The user records once, in Mis datos, that they sign with their DNIe and phone (a `dnie`
credential, optionally with its PIN). From then on the certificate picker of every AutoFirma
signature offers it next to `.p12` certificates. Choosing it goes to `CompanionService`
(`main/companion`) instead of the desktop confirmation and Touch ID: the consent happens on the
phone, and so do the PIN and the CAN unless Mis datos has them (below). A saved PIN brings the
desktop confirmation back, before it is sent.

- **Pairing.** `CompanionService` starts a `DesktopPairing` (`@sa/companion`) on demand. The
  procedure card shows a `dnie_signature` prompt: the QR code while no phone is connected, then
  the phone's progress (`stage`: reviewing → card → reading → signing). The QR link (with the
  pairing secret) never goes into the prompt or the transcript; the renderer reads it from
  `companion.status` and `companion.changed`. Mis datos can pair and unpair too. A pairing lasts
  12 hours or until the app quits.
- **Transport.** Frames go through `services/relay-server` (`PRODUCTION_SERVICES.relayServerUrl`;
  dev `SA_RELAY_SERVER_URL`, whose loopback host is replaced by the LAN address in the QR so a
  phone can reach it; e2e runs have none). They are end-to-end encrypted with keys derived from
  the QR (ECDH P-256 + HKDF + AES-GCM, new keys on every connection). The relay sees room ids
  and ciphertext only. See `packages/companion/README.md`.
- **Signing.** `@sa/signer` signs through a `KeySigner` port. A `.p12` signs in memory; the DNIe
  is an `ExternalSigningKey` whose `sign()` is a `sign.toBeSigned` → `sign.signature` round trip
  while the card stays near the phone. The certificate comes from the card
  (`sign.certificate`) before anything is built; its details are kept on the credential. The
  signer gives every CAdES and PAdES signature it builds a binding to the approved document, and
  the phone refuses blobs that don't match what the user reviewed. XAdES, triphase and batches
  aren't verifiable, and the phone says so before approval.
- **The CAN.** PACE needs the card's CAN, printed on the DNI front. When Mis datos has a valid
  `dniAccessNumber` (scanned with the DNI or typed), every `sign.request` (documents, the
  certificate and logins) carries it as `can`, inside the encrypted channel only: never in the QR,
  which ends up in screenshots and may be shown before the DNI is scanned. Without one, the field
  is left out and the phone uses its stored CAN or asks once. The phone prefers the desktop's CAN
  and stores it when the card accepts it. If the card refuses it, the phone drops its stored CAN,
  asks the user ("the CAN saved on your computer doesn't match") and doesn't try that CAN again
  while the app runs; the desktop isn't told. Agents never see the CAN: the bridge leaves it out
  of `vault.read` and refuses it in `vault.save`, `browser.fillFromVault` and form fields, and
  learnings scrub it like other vault values.
- **The PIN** (D18). Mis datos can save the DNIe PIN on the `dnie` credential, encrypted in the
  vault like the Cl@ve password. The renderer sends it once (`vault.setDniePin`, 8 to 16
  characters) and only learns `pin: 'saved' | 'wrong'` back. `CompanionService` reads it per
  request, only when its caller has the approval the credential's policy asks for: logins after
  `browser.useCertificate`'s consent (every approval request of that login), signatures after
  `BrowserHolder` shows the signature confirmation with Touch ID (policy "ask", the default), or
  straight away with "auto". Certificate reads never carry it, and without a saved PIN nothing
  changes. It goes as `pin` in `sign.request`, inside the encrypted channel only, and once: when
  the phone answers, `PhoneSigner` drops it from the request it keeps for re-sending. The phone
  uses it for that request instead of asking, never stores it, and drops it when the request
  ends. The `dnie_signature` prompt says so (`savedPin`), so the card's steps don't ask for it.
  When the card refuses it, the phone shows the PIN step with the tries left and a line saying the
  PIN saved on the computer is wrong, never tries it again, and sends `sign.wrongPin` (again after
  a reconnect). `PhoneSigner` drops the PIN from its outbox, and `CompanionService` marks it wrong
  in the vault (also on `pin_blocked`): it isn't sent again until the user saves a new one, and
  Mis datos says so. While the phone knows the card has fewer than three tries left, it ignores a
  PIN from the desktop and asks. Agents have no path to it: the bridge refuses PIN-like keys
  (`pin`, `custom.pin_dnie`) in `vault.save`, form fields and `browser.fillFromVault` and hides
  them from `vault.read`; the logger masks it; learnings scrub it.
- **Failures** (blocked PIN, no FIRMA certificate, another card, no NFC, timeouts, the phone
  gone) end the signature with a notice in the procedure in plain words. Declines and cancels
  reach the site as AutoFirma's cancellation. Connections that drop mid-signature recover by
  themselves: both sides send again what the other hasn't answered, and duplicates are ignored.

- **Login.** The companion's `login` request shows the site, without a document. The phone reads
  AUTENTICACIÓN, while documents continue to use FIRMA. The sidecar's `RemoteKey.prepare`
  reuses the approval for that host; `sign` sends an already-hashed handshake digest with
  `prehashed: true`. The phone validates its length and wraps it in PKCS#1 DigestInfo without
  hashing it again. PACE/CWA hashing remains unchanged. `DNIE_LOGIN_IDLE_MS` (30 seconds)
  ends the approval after inactivity; another connection asks again. A different card is
  refused. Progress uses the existing `dnie_signature` prompt, with desktop cancellation.
  Phone approval can be declined; once approved, cancellation is on the desktop. Protocol 2
  added the login purpose, protocol 3 the `can` field, and protocol 4 the `pin` field and
  `sign.wrongPin`: old phones can't decode them, so they must update. The progress prompt adds `purpose` over the existing renderer IPC. RSA-only remote keys use TLS 1.2, with
  upstream connection reuse and resumption.

### Document scanning
The desktop scanner has its own `sa:scanner` preload API, restricted to the app's main frame.
Camera and photo reading require a connected provider; catalog models must support image input.
Custom endpoints are tried with image input because their capabilities are not catalogued.
The scanner explicitly requests macOS camera permission before device acquisition and offers a
camera-settings shortcut when access is denied. Concurrent requests share one native prompt.
On macOS, dev/preview use Launch Services so camera access belongs to Electron rather than the
terminal host. A private Unix socket transfers environment settings; launcher arguments and
files contain no environment secrets. Native app logs are relayed to the terminal, and the
launcher forwards shutdown/rebuild signals to Electron. Native permission state and capture lifecycle
(start, ready, timeout, error name) are recorded in main logs without images or device labels.
Opening the camera starts a small, isolated scanning agent. OpenAI / ChatGPT connections use
`gpt-6.1-sol` with `low` reasoning specifically for scanning (Sol's reasoning is mandatory); vouchers (our LiteLLM gateway) use
`anthropic/claude-haiku-5.5`, also with `low` reasoning (its adaptive thinking cannot be turned off). Chat model selections remain unchanged. Other providers, OpenRouter
BYOK included, use the model selected in Settings. Reasoning is off through pi's provider adapters;
custom OpenAI-compatible endpoints and our gateway receive an explicit `none` effort when the model can turn reasoning off. Flash Lite
cannot turn thinking off, so it scans with `minimal` effort. Other models whose catalog says
reasoning cannot be disabled are unavailable for scanning. The agent has only `capture_images`, `record_fields` and
`finish_scan`: it detects DNI/TIE/passport, accumulates confidently read fields, posts short
localized guidance, and requests fresh frames until the expected printed fields are read. DNI/TIE
require both readable sides; DNI guidance asks for the reverse side's address and birthplace.
Absent fields can be marked unavailable; unreadable fields require another capture. Permanent DNI
expiry and single-surname foreign passports are handled without inventing values. The DNI's CAN
(`dniAccessNumber`, six digits at the bottom right of the front) is read for the phone app, or
marked unavailable on DNIs older than 3.0; a TIE's CAN is not read. DNI postal
codes are explicitly forbidden and removed from model checkpoints/results. After extraction,
main fills a missing postal code from Catastro, the official property registry
(`apps/desktop/src/main/places/catastro.ts`; free JSON API, reuse with attribution, 7,200
requests per hour per IP). Its results may be stored, unlike Mapbox's. The DNI street line is
used as printed, with no abbreviation table: each number after the first word may be the house
number, and the words before it, with leading words (the street type, “DE LA”) dropped one by
one, are searched as a street name in the municipality. Catastro decides: exact names (ignoring
its trailing particles, as in “BUHAIRA (DE LA)”) win over partial ones, a dropped type word must
match the street's type code (“PZ.” → PZ, “C.” → C…), and the house number must exist as exactly
one parcel (“100”, not “100 A”). The code comes from that parcel's units at this address (a
block can have entrances on several streets) and must belong to the scanned province. Anything
uncertain — no match, several streets, a missing number — leaves the field blank for the user;
a wrong code is worse than none. The Basque Country and Navarra keep their own registries, so
they are skipped. Requests are spaced 0.35 s apart, at most 40 per address (a few seconds).
Existing codes are preserved, and lookup errors leave the field blank without failing the scan.
Live scans and photo uploads both save the enriched fields automatically to the vault.
Cancellation aborts the lookup. The scanned address goes only to Catastro, never to the agent or
logs; e2e disables the lookup and unit tests inject fakes. Development logs record the outcome
and request count, without addresses, codes or raw errors. A benchmark of 85 DNI-style lines
(2026-10-10) gave no wrong codes.
DNI address
numbers lose only leading zero padding (including printed floor markers such as P02);
meaningful zeroes are preserved. The prompt requests checkpoint, guidance and recapture in
one response, and direct completion with newly read fields, to avoid redundant model turns.

Camera frames are sampled every 200 ms as JPEGs, resized to at most 1408 pixels on the
longest edge (below Decider's 2,048 image-tile cap for any aspect ratio). Only the latest
unchecked frame is retained. For camera sessions, main continues checking frames during extraction, keeping at
most three distinct accepted JPEGs younger than ten seconds in memory for the next retry.
Uploaded photos are checked on demand. Main checks one frame at a time with OpenRouter's
Decisions API, using `perplexity/pplx-decider-v1.1-27b`. Two typed yes/no questions test
presence of an identity document and legibility. Document presence must reach 0.8 and text legibility 0.7 while screening is active; reflections outside readable main fields/MRZ are tolerated; rejected frames produce localized guidance and never reach
the extraction model. Screening goes through our LiteLLM gateway (`{gateway}/openrouter/alpha/decisions`,
D12) with the user's own gateway key, kept in main only: the voucher key (charged to the voucher),
or, for "Sign in with ChatGPT", the account's subsidy key ($0.10/day, $0.50/month), which main gets
from the key server with the sign-in's OpenAI ID token and stores in the vault with the ChatGPT
credential. Frames therefore pass our gateway to OpenRouter even when extraction uses a ChatGPT
connection. BYOK, custom endpoints and Codex have no gateway key: their scans skip screening. A
development `OPENROUTER_DECIDER_API_KEY` (gitignored `apps/desktop/.env`) overrides the user key
and calls OpenRouter's `/api/v1/systemone` directly. Decisions receive a 10-second timeout; a
missing or refused key and a used-up allowance (LiteLLM 422 `budget_exceeded`) skip screening for
the rest of that scan at once. E2e only permits an explicitly configured loopback Decisions mock
before passing the dev key to the gate.

The first accepted frame is supplied directly to the extraction agent, avoiding an initial
model turn that only requests a capture. Subsequent `capture_images` calls require a localized
reason and success flag, displayed in the UI. Every recapture discards buffered and in-flight frames and waits for a fresh frame. A recapture
with new guidance (a reason) or a successful read first pauses forwarding for four seconds so the
user can follow it; a recapture without a reason (still waiting for a turn-over) adds no pause. The extraction agent alone verifies the
document type, person, side and passport page; those do not affect decider acceptance. The agent
checkpoints fields and requests more in one response, or finishes directly with new fields.
Inference is serialized and goes directly from main to the selected extraction provider with
credentials held in main. Once fields are checkpointed, previous images are immediately omitted
from subsequent inference requests, including guidance-only turns. Uploaded photos use the same
gate and conversation and wait for another upload when the image is rejected or the agent asks
for another side. Closing, navigating away or retrying stops sampling, cancels pending captures
and aborts both models. Camera scans remain active until completion or user cancellation. Failed screening requests are
logged with a safe category, HTTP status when available, elapsed time, stage and retry count;
raw provider errors, response bodies, credentials and images never enter the application log.
Screening retries have a three-second total budget per frame, including request time and
backoff. If the service does not return a valid decision within that budget, screening is
bypassed for the remainder of the scan and frames go directly to extraction. Valid legibility
rejections do not trigger bypass. The bypass is logged once and persists across extraction
conversation restarts; accepted buffered frames remain available. Extraction errors retry the same turn while screening
continues. Camera frame delivery failures also retry. If a conversation fails validation or
reaches 40 captures/60 turns, camera scanning automatically starts a new extraction conversation.
Each extraction request still has a 45-second timeout, but a timeout no longer ends camera
scanning. Photo sessions retain the three-minute bound and existing error flow.

Development builds (`!app.isPackaged`) retain
`userData/scanner/conversations/<sessionId>/session.jsonl`: model, prompt, tool declarations,
assistant responses including usage, tool results and final status. Every checked frame has a
`frame_decision` entry with its request reason, probabilities, acceptance, start/end timestamps,
model and input/output token counts (plus provider cost when returned), referencing a private
sibling JPEG. Extraction inputs also reference JPEGs. These plaintext debug files have directory
mode 0700 and file mode 0600, are separate from chat and unavailable through the renderer API.
Credentials, request headers and raw provider errors are never written there. Packaged builds
remove earlier scanner debug directories at startup and never write new conversations or scan
frames, so completion, cancellation, errors or crashes leave no new disk artifacts. Debug
sessions are retained in development. Validated fields, including address, birthplace and parents
where printed, are saved directly to the vault without a confirmation form. Scan uploads are
not automatically retained as documents. Explicitly saved vault documents
are separate from temporary scan/debug artifacts.
The desktop scanner does not use OCR, MRZ voting, crop controls or a review form.

The desktop scanner separates personal fields from document fields with explicit DNI, TIE,
passport and driving-licence profiles. Prompts and extraction-tool JSON schemas advertise those
profiles; host validation rejects fields belonging to another document type in checkpoints,
completion and the unavailable-field list. Support numbers are permitted only for DNI/TIE.
Before the type is known, only common name/birth fields can be checkpointed; later partial
checkpoints are checked against the accumulated type. Rejected checkpoints do not change
accumulated fields or readable sides. The agent receives a correction request naming only the
field and document type, without rejected values, and can continue the same scan.
Checkpoints and completion also run the vault's field rules (DNI/NIE letters, support number
formats, past birth/issue dates, postal code province) and document rules (a licence number is a
valid DNI/NIE, birth < issue < expiry, TIE postal code in its province, DNI validity by age at
issue per RD 1553/2005 art. 6 and RD 255/2025 art. 7). Licence category rows must use EU
category codes and past issue dates (`LicenceCategories`). A failure asks the agent to re-read the named fields
from a closer frame; the scanner never accepts values that fail a rule. Completed
results use a document-specific TypeScript union. Postal enrichment is a later, separate step.
Saved vault names and shared contracts remain unchanged. Failed automatic saves offer “Volver a escanear” / “Scan
again”, returning to camera/photo selection and discarding the failed result. Personal-data
save failures log a fixed validation reason and an allowed field name before localization,
never values, custom key names or raw exceptions. Unknown/unexpected vault failures receive
only a safe category.

### Document files

Documents stay encrypted in `userData/vault/documents/<id>.bin`. Opening one decrypts a
private copy under the OS temporary directory, in an app/profile-specific folder. The app
attempts deletion after ten minutes, on normal quit and on the next startup; OS cleanup is
an additional fallback with no guaranteed deadline. Startup also removes copies left in the
older `userData/tmp` location. Cleanup failures are logged.

The document download button exports a decrypted copy to the user's Downloads folder.
Exclusive file creation avoids overwriting existing files or following file symlinks; duplicate
names receive a numeric suffix. Exported copies persist independently of the vault and its
cleanup. Tests and Electron e2e use isolated export folders instead of the real Downloads folder.

### 3.6 Learnings (self-improving)
At the end of a procedure (or after friction), the agent calls `feedback_submit` → main scrubs
PII twice (regex/checksums + exact match against every value in the vault) → feedback server
scrubs again and stores → future agents query `feedback_search` (Spanish full-text search).
Agents rate the learnings they checked with `feedback_vote` (up: useful and hard to find out
alone; down: wrong, misleading or not always applicable). Votes set how often an entry is served:
human votes weigh more, and every vote fades between 90 and 365 days (see
`services/feedback-server/README.md`). Maintainers curate entries (browse, vote, edit, delete)
on the server's admin page, `GET /admin` (`corepack pnpm feedback`).
Every procedure agent can search and rate (`feedback_vote`); sharing (`feedback_submit` and the
setting that turns sharing and rating off) is behind the `feedback-server` Unleash flag. Rating
and sharing need a user key (see "Users"), which the server checks like the maps server does
and limits per user per day. Each user has one vote per entry, stored with the vote (a new vote
replaces it): users with their own API key or a custom endpoint only search.

### Users
Our services know a user by a key on our LiteLLM gateway (`ProviderManager.userKey()`), which
they check with LiteLLM's `/key/info` and turn into a stable, pseudonymous id with
`userId(key, secret)` of `@sa/gateway-keys` (an HMAC of the key's hash with a server secret):

| Provider | User key |
| --- | --- |
| Voucher | The voucher key (top-ups add to the same key) |
| ChatGPT | The account's key from the key server: one per OpenAI account, the same on every device (D12) |
| Codex (development builds only) | `SA_DEV_USER_KEY`, e.g. the key from redeeming a development voucher; none without it |
| BYOK, custom endpoint | None |

Without a user key these are off: scan frame screening (frames go to the extractor unscreened),
phone-call transcription (`phoneCall.transcriptionAvailable` is false), map lookups (no pins),
and sharing and rating learnings (the agent gets neither `feedback_submit` nor
`feedback_vote`; it can still search). Web research is separate: it is paid from a voucher, so
only voucher users have it.

### Feature flags
Main reads the flags once per launch from Unleash's frontend API (`remote/flags.ts`, with
`PRODUCTION_SERVICES.flagsUrl` and a public frontend token from `flagsTokens`), so a change
applies at the next launch. Packaged builds read Unleash's `production` environment and
development builds its `development` one, so a flag can be tried in development first.
After reading them, main reports to Unleash's metrics endpoint that each flag was checked once
(on or off), with a random id per launch, so Unleash shows which flags are in use. It fails closed: when Unleash can't be reached, every flag is
off. They reach the renderer as `appInfo.features` (`FeatureFlags` in `@sa/shared`), but main
enforces them itself: the UI only hides what main already refuses. The flags are created by
hand in Unleash's UI (project `default`), not in Terraform.

| Flag (`FeatureFlags` key) | When it is off |
| --- | --- |
| `feedback-server` (`feedbackServer`) | Agents search and rate community learnings but don't share them: no `feedback_submit`, no sharing setting |
| `dnie-phone` (`dniePhone`), type experiment | No DNIe with the phone (D14, D15): see below |

Without `dnie-phone` the app behaves as if the DNIe with the phone didn't exist. Main never
creates `CompanionService`, so nothing pairs or connects to the relay. `companion.*` and
`vault.addDnie` IPC calls fail. Mis datos has no "DNIe con el móvil" card. The AutoFirma
certificate picker leaves the DNIe out. `browser_use_certificate` refuses a `dnie` credential
with an explanation for the agent. `vault_read` doesn't list it, and the system prompt and the
tool description don't mention the DNIe (`dniePhone` in the agent host config). A saved `dnie`
credential stays in the vault, hidden: the next launch with the flag on shows it again. `.p12`
certificate logins and the `sa-sidecar` don't depend on the flag. Neither does the DNI's CAN in
Mis datos (scanned with the DNI): only `CompanionService` sends it, so with the flag off it
stays in the vault. So does a saved DNIe PIN, and `vault.setDniePin` fails.

Development builds can skip Unleash with `SA_FEATURE_FLAGS` (comma-separated Unleash names;
`dev:local` turns on both). E2e runs set it too, and main-process tests pass `features` to the
test harness (every flag on by default). In the web preview, `?feedback=1` and `?dnie=1` turn
the flags on (`?companion`, `?dniePin` and the playground imply `?dnie=1`).
`?dniePin=none|saved|wrong` adds a saved DNIe to Mis datos in that PIN state.

## 4. Security model (MVP)

- Personal data stays on the device except when needed by the user's selected inference
  provider, including document images for model vision. Inference goes directly to that
  provider, except with a voucher: then it goes through our LiteLLM gateway, which forwards it
  to OpenRouter and keeps no prompts or answers (D10). The key server never sees it. Procedure execution sends the
  required information to the administration at the user's request; shared learnings stay anonymous.
- Vault data, documents, credentials and provider tokens are encrypted at rest with a random data key wrapped by the OS (Electron
  `safeStorage`: Keychain / DPAPI / libsecret). Linux without a keyring is flagged as insecure.
- The model never receives secrets; credentials are usable only on allow-listed official
  domains; certificate use and signatures require explicit approval by default. The DNIe PIN
  leaves the desktop only to the paired phone, per request and after that approval (D18).
- Agent processes only get: bridge URL + per-agent token, provider key (if any), language. The
  assistant's token cannot reach the browser, signer or credentials; procedure tokens cannot
  start or message other procedures.
- Web content is untrusted input; the system prompt and tool design limit prompt-injection
  impact (no shell/file tools, domain checks, confirmations for irreversible actions).
  `run_script` runs model-written JavaScript in QuickJS (WebAssembly, fresh per call, CPU and
  memory capped) with no Node APIs or secrets; its only I/O is unrestricted `fetch` (any URL,
  including localhost and private networks).
- Known MVP gaps: procedure metadata, transcripts, screenshots and pi session files are private
  local files without encryption. ChatGPT OAuth tokens are stored in the encrypted vault and
  supplied to pi in memory through the authenticated bridge.
- Secret typing is bound to the frame origin and input type checked before use; the browser
  rechecks both inside its queued action. Deleting a credential closes active browser contexts
  to discard previously installed client certificates.


## Agent UI playground

The standalone renderer preview exposes `?playground=1` (optional `&example=<id>` and `&lang=en`).
It lazy-loads a catalogue of the app's real prompt, message, notice and procedure components.
The catalogue is registered as pending items in the in-memory mock conversation, so submissions
and resets work through the same renderer API without contacting main or an agent. Playground
mode forces that mock even if an Electron preload exists. Links/browser actions are simulated,
map tiles and geocoding are mocked, and the inspector masks secret field responses. Reloading
resets all sandbox data. Enum-coverage tests ensure newly added form/confirmation/action types
require a corresponding example.

Scanner turn-over follow-up (2026-10-04): after a successful read requests another camera
side/page, forwarding pauses for four seconds. Sampling and screening continue, but buffered
and in-flight frames from before or during this pause are discarded before waiting for a
fresh accepted frame. This gives the user time to turn the document; the extraction agent
still verifies the requested side. `capture_images` requires success but permits an omitted
reason: the previous instruction is restored/retained without blue or legibility updates
until new explicit feedback arrives. The prompt tells the agent to request another capture
with success false and no reason when the user has not yet completed the requested turn-over
(or, since 2026-10-10, any requested rotation or close-up).
Cancellation interrupts the pause immediately. Shared contracts remain unchanged.

Personal data document separation (2026-10-04): identity fields describe the person,
independently of the scanned document. DNI, TIE and passport data use distinct vault keys:
`dniNumber`, `dniSupportNumber`, `dniIssueDate`, `dniExpiry`; `tieNumber` (NIE),
`tieSupportNumber`, `tieIssueDate`, `tieExpiry`; `passportNumber`, `passportIssueDate`,
`passportExpiry`. Scanner extraction still uses its single-document field vocabulary; saving
maps it to these keys, so different document types coexist. Permanent DNIs save the existing
`9999-01-01` sentinel, shown as “Permanente”. Each document section appears only while it
has saved fields. Agent forms, vault reads and browser filling use the new shared field
catalog. This pre-production schema change requires resetting existing development data;
there is no migration for the previous generic document keys.

Failed-read recapture follow-up (2026-10-04): `capture_images` with success false now clears
buffered frames and invalidates an in-flight old frame before waiting for a fresh accepted
frame (or an unscreened frame after bypass). Since 2026-10-10 it also pauses forwarding for
four seconds when it carries a new reason, like success true, so the user can follow the
guidance; without a reason it adds no delay. Background sampling/screening continue.
This prevents immediate reuse of the previous side but does not verify the requested side.
