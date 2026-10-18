# pi 1.x: embedding research memo

Status: verified against the published npm tarballs of `@earendil-works/pi-coding-agent@1.0.0`, `@earendil-works/pi-ai@1.0.0` and `@earendil-works/pi-agent-core@1.0.0` (released 2026-10-01, git tag `v1.0.0`, gitHead `a13d35a7`), plus local experiments run on 2026-10-03 (macOS arm64, Node 24.9, Electron 44.5.1). The app now pins `^1.1.0` (`packages/agent/package.json`); the facts below were not re-checked against 1.1 unless noted. Anything not tested or not read in source is marked **UNVERIFIED**.

**What was built.** An SDK agent host (`packages/agent/src/host/`: `ModelRuntime` + `AgentSession` + `runRpcMode`), spawned per agent with Electron as Node and driven over stdio JSONL by our own `PiRpcClient`. Its isolation (offline, no telemetry, private agent dir, no extensions/skills/context files, exact system prompt, `bash` blocked, `BridgeCredentialStore`) is described in `packages/agent/README.md` ("Architecture"). This memo keeps pi's protocol, behaviour and risks behind that design.

Sources:

- Package docs shipped in the tarball: `node_modules/@earendil-works/pi-coding-agent/docs/*.md`. Same content as `https://github.com/earendil-works/pi/tree/v1.0.0/packages/coding-agent/docs`.
- Type definitions:
  - `pi-coding-agent/dist/modes/rpc/rpc-types.d.ts`
  - `dist/core/extensions/types.d.ts`
  - `dist/core/sdk.d.ts`
  - `dist/core/agent-session-runtime.d.ts`
  - `dist/core/agent-session-services.d.ts`
  - `dist/core/model-runtime.d.ts`
  - `dist/core/model-config.d.ts`
  - `dist/core/system-prompt.{d.ts,js}`
- pi-ai: `dist/auth/types.d.ts`, `dist/models.d.ts`, `dist/auth/oauth/*.js`.
- pi-agent-core: `dist/types.d.ts`.
- Experiment scripts lived in a session scratchpad and are not part of the repo. They included a mock OpenAI server, RPC drivers, an SDK agent host, login probes and test extensions.

---

## 0. TL;DR

- **RPC mode works as needed.** I tested it end to end under `ELECTRON_RUN_AS_NODE=1` with Electron 44.5.1 (Node 24.21.0). The test covered a custom tool returning an image, a confirm dialog, the mock LLM, streaming, abort, steer, retry and sessions. Packages installed with pnpm 10 also work.
- **Launch:** not the CLI. The host builds the session with the SDK and calls `runRpcMode` (§8), so CLI flags in §3–§5 matter only for their SDK equivalents.
- **Big 1.0 changes compared with older pi:**
  - The package scope is `@earendil-works`.
  - Auth is now `ModelRuntime` + pi-ai `CredentialStore`. `AuthStorage` is no longer exported.
  - OAuth uses one `AuthInteraction {prompt, notify, signal}` instead of the old `onAuth/onPrompt` callbacks. The old callbacks survive only for extension-defined providers.
  - "Sign in with ChatGPT" now lives on the **`openai`** provider and calls api.openai.com. **`openai-codex` is labelled "(legacy)"**.
  - System prompts and tool declarations are now `role:"system"` messages inside the transcript and event stream.
  - MCP and codemode are built-in extensions.
- **Surprises and risks:** §12.
---

## 1. RPC mode

### 1.1 Launch and framing

- **Launch:**
  - `pi --mode rpc [normal CLI flags]`.
  - The dedicated entry `dist/bundle/rpc-entry.js` (package export `./rpc-entry`) is equivalent to `main(["--mode","rpc",…argv])`.
  - `@file` args are rejected in RPC mode.
- **Framing:**
  - Strict JSONL in both directions. Split on `\n` only and strip an optional `\r`.
  - Do **not** use Node `readline`: it also splits on U+2028/2029, which are valid inside JSON strings.
  - Stdout carries protocol records only.
  - In RPC mode pi redirects `process.stdout.write` to stderr (`takeOverStdout()`). Verified: a `console.log` inside an extension went to stderr.
  - Read stdout continuously, because pi honours backpressure.
- **Shutdown:**
  - Close stdin to get an orderly shutdown: `runtime.dispose()`, then `process.exit(0)`.
  - SIGTERM and SIGHUP are handled (exit codes 143 and 129).
  - Extensions can call `ctx.shutdown()`. Pi then exits after the current command, or at `agent_settled`.

### 1.2 Commands (stdin), from `rpc-types.d.ts` (`RpcCommand`)

Every command accepts an optional `id?: string`, and the response echoes it.

| Command | Shape | Success `data` |
|---|---|---|
| prompt | `{"type":"prompt","message":string,"images"?:ImageContent[],"streamingBehavior"?:"steer"\|"followUp"}` | `{"disposition":"started"\|"queued"\|"handled"}` |
| steer | `{"type":"steer","message":string,"images"?:ImageContent[]}` | `{"disposition":"queued"\|"handled"}` |
| follow_up | `{"type":"follow_up","message":string,"images"?:ImageContent[]}` | `{"disposition":"queued"\|"handled"}` |
| abort | `{"type":"abort"}` | none. The response is sent after the session is idle. |
| clear_queue | `{"type":"clear_queue"}` | `{"steering":string[],"followUp":string[]}` |
| new_session | `{"type":"new_session","parentSession"?:string}` | `{"cancelled":boolean}` |
| get_state | `{"type":"get_state"}` | `RpcSessionState` (see below) |
| get_messages | `{"type":"get_messages"}` | `{"messages":AgentMessage[]}`. This includes the `system` message. |
| set_model | `{"type":"set_model","provider":string,"modelId":string}` | the full `Model` object |
| cycle_model | `{"type":"cycle_model"}` | `{"model","thinkingLevel","isScoped"}` or `null` |
| get_available_models | `{"type":"get_available_models"}` | `{"models":Model[]}`. Only models whose provider has auth. |
| set_thinking_level | `{"type":"set_thinking_level","level":"off"\|"minimal"\|"low"\|"medium"\|"high"\|"xhigh"\|"max"}` | none |
| cycle_thinking_level | `{"type":"cycle_thinking_level"}` | `{"level"}` or `null` |
| get_available_thinking_levels | `{"type":"get_available_thinking_levels"}` | `{"levels":ThinkingLevel[]}` |
| set_steering_mode | `{"type":"set_steering_mode","mode":"all"\|"one-at-a-time"}` | none |
| set_follow_up_mode | `{"type":"set_follow_up_mode","mode":"all"\|"one-at-a-time"}` | none |
| compact | `{"type":"compact","customInstructions"?:string}` | `CompactionResult {summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details?}` |
| set_auto_compaction | `{"type":"set_auto_compaction","enabled":boolean}` | none |
| set_auto_retry | `{"type":"set_auto_retry","enabled":boolean}` | none |
| abort_retry | `{"type":"abort_retry"}` | none |
| bash | `{"type":"bash","command":string,"excludeFromContext"?:boolean}` | `{"output","exitCode","cancelled","truncated","fullOutputPath"?}`. This is a **client-side shell** that runs even when all tools are disabled. Never expose it. |
| abort_bash | `{"type":"abort_bash"}` | none |
| get_session_stats | `{"type":"get_session_stats"}` | `{sessionFile?, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens:{input,output,cacheRead,cacheWrite,total}, cost:number, contextUsage?:{tokens\|null, contextWindow, percent\|null}}` |
| export_html | `{"type":"export_html","outputPath"?:string}` | `{"path"}` |
| switch_session | `{"type":"switch_session","sessionPath":string}` | `{"cancelled":boolean}` |
| fork | `{"type":"fork","entryId":string}` | `{"text","cancelled"}` |
| clone | `{"type":"clone"}` | `{"cancelled"}` |
| get_fork_messages | `{"type":"get_fork_messages"}` | `{"messages":[{"entryId","text"}]}` |
| get_entries | `{"type":"get_entries","since"?:entryId}` | `{"entries":SessionEntry[],"leafId":string\|null}`. This is a durable cursor. |
| get_tree | `{"type":"get_tree"}` | `{"tree":SessionTreeNode[],"leafId"}` |
| get_last_assistant_text | `{"type":"get_last_assistant_text"}` | `{"text":string\|null}` |
| set_session_name | `{"type":"set_session_name","name":string}` | none |
| get_commands | `{"type":"get_commands"}` | `{"commands":[{"name","description"?,"source":"extension"\|"prompt"\|"skill","sourceInfo"}]}` |

There is **no** command for login, logout, set-api-key, reload or tool listing. Auth must be handled outside RPC; see §6.

`RpcSessionState` (verbatim):

```ts
{ model?: Model<any>; thinkingLevel: ThinkingLevel; isStreaming: boolean; isCompacting: boolean;
  steeringMode: "all"|"one-at-a-time"; followUpMode: "all"|"one-at-a-time"; sessionFile?: string;
  sessionId: string; sessionName?: string; autoCompactionEnabled: boolean; messageCount: number; pendingMessageCount: number }
```

### 1.3 Responses

```json
{"id":"r1","type":"response","command":"get_state","success":true,"data":{}}
{"id":"r2","type":"response","command":"set_model","success":false,"error":"Model not found: openrouter/x"}
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: ..."}
```

Behaviour observed for `prompt`:

- The response arrives after "preflight". `success:true` only means the prompt was accepted.
- Provider errors arrive later in the event stream.
- If no auth is available for the model, the result is `success:false`, `"error":"No API key found for the selected model.\n\nUse /login…"`.
- A prompt sent while the agent is streaming, without `streamingBehavior`, fails with `success:false`, `"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."`.
- `"/cmd args"` for an extension command runs immediately, even mid-stream, and returns `disposition:"handled"`.

### 1.4 Events (stdout)

Events are `JsonAgentSessionEvent`: the SDK `AgentSessionEvent`, except that `message_update` carries deltas only. Shapes below are verbatim from a captured run.

```jsonc
{"type":"agent_start"}
{"type":"turn_start"}                       // wire form has no turnIndex
{"type":"message_start","message":{"role":"system","content":"","sections":{"preamble":"…","cwd":"<cwd>\n…\n</cwd>"},"toolsAdded":[{"name":"take_screenshot","description":"…","parameters":{…}}],"timestamp":…}}  // NEW in 1.0: skip role "system" in the UI
{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"Haz una captura"}],"timestamp":…}}
{"type":"message_start","message":{"role":"assistant","content":[],"api":"openai-completions","provider":"mock","model":"mock-model","usage":{…zeros…},"stopReason":"pending","timestamp":…}}
{"type":"message_update","usage":{"input":120,"output":12,"cacheRead":0,"cacheWrite":0,"reasoning":0,"totalTokens":132,"cost":{"input":0.00012,"output":0.000024,"cacheRead":0,"cacheWrite":0,"total":0.000144}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Voy a hacer una captura. "}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_start","contentIndex":1,"id":"call_1","toolName":"take_screenshot"}}
{"type":"message_update","usage":{…},"assistantMessageEvent":{"type":"toolcall_end","contentIndex":1,"toolCall":{"type":"toolCall","id":"call_1","name":"take_screenshot","arguments":{"url":"https://sede.example.gob.es"}}}}
{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"…"},{"type":"toolCall","id":"call_1","name":"take_screenshot","arguments":{…}}],"usage":{…},"stopReason":"toolUse","responseId":"…","rawStopReason":"tool_calls","thinkingLevel":"off",…}}
{"type":"tool_execution_start","toolCallId":"call_1","toolName":"take_screenshot","args":{"url":"…"}}
{"type":"tool_execution_update","toolCallId":"call_1","toolName":"take_screenshot","args":{…},"partialResult":{"content":[{"type":"text","text":"loading page..."}],"details":{"stage":"loading"}}}
{"type":"tool_execution_end","toolCallId":"call_1","toolName":"take_screenshot","result":{"content":[{"type":"text","text":"…"},{"type":"image","data":"<base64>","mimeType":"image/png"}],"details":{…}},"isError":false}
{"type":"message_end","message":{"role":"toolResult","toolCallId":"call_1","toolName":"take_screenshot","content":[…],"details":{…},"isError":false,"timestamp":…}}
{"type":"turn_end","message":{…assistant…},"toolResults":[{…toolResult…}]}
{"type":"agent_end","messages":[…messages of this run…],"willRetry":false}
{"type":"agent_settled"}                    // the real "done" signal; agent_end may be followed by retries or queued work
```

- **`assistantMessageEvent.type` values on the wire:**
  - `text_start {contentIndex}`
  - `text_delta {contentIndex, delta}`
  - `text_end {contentIndex, content}`
  - `thinking_start`, `thinking_delta {delta}`, `thinking_end {content}`
  - `toolcall_start {contentIndex, id, toolName}`
  - `toolcall_delta {contentIndex, delta}` (raw argument JSON fragments)
  - `toolcall_end {contentIndex, toolCall}`
  - `start`, `done` and `error` exist in the type but are normally converted into `message_start` / `message_end`.
- **Thinking deltas** were verified with a `reasoning_content` mock. The final block is `{"type":"thinking","thinking":"…","thinkingSignature":"reasoning_content"}`.
- **Other events**, verbatim union from `dist/core/agent-session.d.ts`:
  ```jsonc
  {"type":"queue_update","steering":["…"],"followUp":["…"]}          // full queue each time
  {"type":"compaction_start","reason":"manual"|"threshold"|"overflow"}
  {"type":"compaction_end","reason":…,"result":CompactionResult|undefined,"aborted":bool,"willRetry":bool,"errorMessage"?:string}
  {"type":"auto_retry_start","attempt":1,"maxAttempts":2,"delayMs":200,"errorMessage":"500: {…}"}
  {"type":"auto_retry_end","success":true,"attempt":1}             // or success:false + finalError
  {"type":"entry_appended","entry":SessionEntry}                    // e.g. a context_edit that drops a failed message before a retry
  {"type":"session_info_changed","name":string|undefined}
  {"type":"thinking_level_changed","level":…}
  {"type":"summarization_retry_scheduled",…} / {"type":"summarization_retry_attempt_start","source":"compaction"|"branchSummary",…} / {"type":"summarization_retry_finished"}
  {"type":"bash_execution_update","id"?:string,"delta":string}       // RPC bash command only
  {"type":"extension_error","extensionPath":"…","event":"tool_call","error":"…"}   // RPC only
  ```
- **Errors**, observed with the mock:
  - An HTTP 402 is **not retried**. The assistant `message_end` arrives with `"stopReason":"error","errorMessage":"402: {\"message\":\"Key limit exceeded…\",\"code\":402}"`, followed by `turn_end`, `agent_end` and `agent_settled`.
  - An HTTP 500 gives `agent_end{willRetry:true}`, then `auto_retry_start`, then `entry_appended(context_edit)`, then a new `agent_start` … `auto_retry_end{success:true}`, then `agent_settled`.
- **Abort**, observed:
  - The streaming message ends with `"stopReason":"aborted","errorMessage":"Request was aborted"`.
  - The `abort` response follows `agent_settled`.
  - A steer that was queued before the abort **stays queued** (`pendingMessageCount:1`). Send `clear_queue` before `abort`.
- **Usage and cost:**
  - Each `message_update.usage` is cumulative for that response.
  - The final value is in `message_end.message.usage` (`cost` in USD, computed from the model's `cost` per million tokens).
  - Session totals come from `get_session_stats`.

### 1.5 Extension UI sub-protocol

Source: `docs/rpc-extension-ui.md`, `rpc-types.d.ts`; behaviour verified in experiments.

Requests (stdout). Every request has `"type":"extension_ui_request"` and a unique `id`.

```jsonc
{"type":"extension_ui_request","id":"…","method":"select","title":"…","options":["A","B"],"timeout"?:ms}
{"type":"extension_ui_request","id":"…","method":"confirm","title":"…","message":"…","timeout"?:ms}
{"type":"extension_ui_request","id":"…","method":"input","title":"…","placeholder"?:"…","timeout"?:ms}
{"type":"extension_ui_request","id":"…","method":"editor","title":"…","prefill"?:"…"}            // no timeout/signal support
// fire-and-forget (no response):
{"type":"extension_ui_request","id":"…","method":"notify","message":"…","notifyType"?:"info"|"warning"|"error"}
{"type":"extension_ui_request","id":"…","method":"setStatus","statusKey":"…","statusText":"…"|undefined}
{"type":"extension_ui_request","id":"…","method":"setWidget","widgetKey":"…","widgetLines":["…"]|undefined,"widgetPlacement"?:"aboveEditor"|"belowEditor"}
{"type":"extension_ui_request","id":"…","method":"setTitle","title":"…"}
{"type":"extension_ui_request","id":"…","method":"set_editor_text","text":"…"}
```

Responses (stdin). These are for dialogs only and get no command response back.

```json
{"type":"extension_ui_response","id":"…","value":"A"}
{"type":"extension_ui_response","id":"…","confirmed":true}
{"type":"extension_ui_response","id":"…","cancelled":true}
```

- In RPC mode, `ctx.mode === "rpc"` and `ctx.hasUI === true`.
- `custom()` returns `undefined`.
- The theme, footer, header, editor-component and working-indicator methods are no-ops.
- `getEditorText()` returns `""`.
- **Dialog timeout or `signal` abort:** the dialog resolves on the agent side with its default value (`undefined` / `false`). Pi sends **no message** to the client, so the client must close stale dialogs itself, for example on `tool_execution_end` or `agent_settled`.
- **Abort deadlock, verified.** If a tool `await`s `ctx.ui.confirm(...)` **without** `{ signal }`, an RPC `abort` does not return until the dialog is answered: it timed out after 8 s, then completed as soon as we sent `cancelled:true`. With `ctx.ui.confirm(title, msg, { signal })` the abort returned in 2 ms. Rules for us:
  1. Always pass the tool's `signal` to dialogs and long operations.
  2. On abort, the client should answer open dialogs with `cancelled:true`.

### 1.6 `RpcClient` (exported): why we wrote `PiRpcClient`

pi exports `RpcClient({ cliPath?, cwd?, env?, provider?, model?, args? })` with a method per
command. Blockers for Electron, from the source in `dist/modes/rpc/rpc-client.js`:

- `spawn("node", [cliPath, "--mode","rpc", …])` is hard-coded, so the executable cannot be chosen.
- It has **no API to send `extension_ui_response`**. UI requests are passed to `onEvent` as if they were events.
- `bash()` drops `excludeFromContext`.
- `stop()` sends SIGTERM, then SIGKILL after 1 s.
- The `./client` subpath export is source-only (`src/client/index.ts`), and `src` is not published, so it cannot be imported.
- `@earendil-works/pi-client`, `pi-protocol` and `pi-server` are a separate **experimental** CBOR service protocol and are not needed here.

Our client is `PiRpcClient` (`packages/agent/src/rpc/`), with the framing rules of §1.1.

---

## 2. Extensions

### 2.1 Format and loading

- **Module format:** an ES or CJS module whose **default export** is `(pi: ExtensionAPI) => void | Promise<void>`. Async factories are awaited before startup continues.
- **Loading mechanism:**
  - Modules are loaded with **jiti**, so TypeScript needs no build step.
  - With the bundled CLI, imports of the host packages resolve to **virtual modules**: `typebox`, `typebox/compile`, `typebox/value`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai` (mapped to `pi-ai/compat`), `pi-ai/oauth` and `pi-ai/providers/all`. Legacy `@mariozechner/*` and `@sinclair/typebox` aliases also resolve.
  - jiti only creates an empty `os.tmpdir()/jiti` folder and writes nothing into the package.
- **Where extensions come from:**
  - `-e/--extension <path>` (repeatable) accepts a file, a directory, or `builtin:<name>`.
  - Directories are discovered in `<agentDir>/extensions/` and in `.pi/extensions/` (the latter only for trusted projects).
  - The settings `"extensions"` array and Pi packages are also read.
  - Discovery accepts `*.ts` / `*.js` files and subdirectories containing `index.ts` / `index.js`. A `package.json` with `"pi": {"extensions": [...]}` is also honoured.
  - `--no-extensions` (`-ne`) disables discovered, configured **and built-in** extensions. Explicit `-e` paths still load.
- **Prebuilt `.js`: verified working.** Both an ESM and a CJS esbuild bundle loaded via `-e` and ran their tools.
  - Even a bundle that inlined its own copy of typebox worked.
  - Still, mark host modules as external:
    ```bash
    esbuild src/ext.ts --bundle --platform=node --format=esm --target=node22 \
      --external:typebox --external:'@earendil-works/*' --outfile=dist/spain.js
    ```
  - Other npm dependencies, for example Playwright, should either be bundled or sit in a `node_modules` next to the extension.

### 2.2 Tool registration (verbatim excerpts, `dist/core/extensions/types.d.ts`)

```ts
pi.registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): void;
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(tool: ToolDefinition<TParams, TDetails, TState>): ...;

interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string; label: string; description: string;
  promptSnippet?: string;          // only used by the DEFAULT system prompt
  promptGuidelines?: string[];     // only used by the DEFAULT system prompt
  parameters: TParams;             // TypeBox 1.x schema
  constrainedSampling?: false | ConstrainedSamplingConfig;
  prepareArguments?: (args: unknown) => Static<TParams>;
  outputSchema?: TSchema;          // then return structuredContent (codemode scripts get it)
  exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";   // default "direct"
  namespace?: { name: string; description?: string; instructions?: string };
  annotations?: { readOnlyHint?; destructiveHint?; idempotentHint?; openWorldHint? };
  defaultActive?: boolean;
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<TDetails>>;
  renderCall?(...); renderResult?(...);   // TUI only
}

// pi-agent-core
interface AgentToolResult<T = JsonValue | undefined> {
  content: (TextContent | ImageContent)[];   // model-facing
  details: T;                                 // UI/state, not sent to the model (use `undefined` if none)
  structuredContent?: JsonValue; usage?: Usage;
  isError?: boolean;     // report failure without throwing (throwing also yields an error result)
  terminate?: boolean;   // stop after this batch if all results agree
}
type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;   // -> tool_execution_update
```

**Returning images (screenshots), verified.** Return `content: [{type:"text",text:"…"}, {type:"image", data:<base64>, mimeType:"image/png"}]`.

- **Automatic resize:** a 3000×2000 PNG was resized automatically with photon WASM to 2000×1333 JPEG. The resize is controlled by the `images.autoResize` setting and `inputLimits.images.resize` in models.json.
- **Coordinate note:** pi appended `"[Image: original 3000x2000, displayed at 2000x1333. Multiply coordinates by 1.50 to map to original image.]"` to the tool's text. This is useful for click-by-coordinates browser automation.
- **Wire format for `openai-completions`:** the tool message carries the text, and pi adds a follow-up user message `[{text:"Attached image(s) from tool result:"},{type:"image_url",image_url:{url:"data:image/jpeg;base64,…"}}]`.
- **Model support:** the model must declare `input: ["text","image"]`.

### 2.3 Events and hooks (`pi.on(event, handler)`; handler `(event, ctx) => result | void`)

| Event | Use | Result type |
|---|---|---|
| `session_start` `{reason:"startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile?}` | start resources (browser, etc.) | none |
| `session_shutdown` `{reason:"quit"\|"reload"\|"new"\|"resume"\|"fork", targetSessionFile?}` | cleanup (make it idempotent) | none |
| `before_agent_start` `{prompt, images?, systemPrompt (readonly), systemPromptOptions (mutable)}` | change the system prompt | `{ systemPrompt?: string /* full replacement */, message?: {customType, content, display, details} }` |
| `context` `{messages}` / `context_with_system` | rewrite the LLM context before each call | `{ messages? }` |
| `tool_call` `{toolName, toolCallId, input (mutable), parentToolCallId?}` | permission gate / patch args | `{ block?: boolean, reason?: string, terminate?: boolean }` |
| `tool_result` `{toolName, input, content, details, isError, structuredContent?, usage?}` | redact or replace results | `{ content?, details?, structuredContent?, isError?, usage? }` |
| `input` `{text, images?, source:"interactive"\|"rpc"\|"extension", streamingBehavior?}` | intercept user input | `{action:"continue"} \| {action:"transform",text,images?} \| {action:"handled"}` |
| `message_end` | replace a finalized message (same role) | `{ message? }` |
| `turn_end` / `agent_before_settle` | append entries or request one continuation | `{ entries?, continue? }` |
| `before_provider_request` / `before_provider_headers` / `after_provider_response` / `provider_stream_event` | inspect or patch requests, inject headers | varies |
| also | `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `message_start/update`, `tool_execution_start/update/end`, `model_select`, `thinking_level_select`, `session_before_switch/fork/compact/tree` (can cancel), `session_compact`, `ui_prompt_start/end`, `resources_discover`, `mcp_servers_change`, `cache_warming_decision`, `project_trust`, `user_bash` | |

Other `ExtensionAPI` methods (verbatim names):

- `registerCommand(name, {description?, getArgumentCompletions?, handler(args, ctx: ExtensionCommandContext)})`
- `registerShortcut`, `registerFlag(name, {type:"boolean"|"string", default?, description?})` / `getFlag`
- `sendMessage({customType, content, display, details}, {triggerTurn?, deliverAs?:"steer"|"followUp"|"nextTurn"})`
- `sendUserMessage(content, {deliverAs?, expandPromptTemplates?})`
- `appendEntry(customType, data)` (persisted, not sent to the LLM)
- `setSessionName`, `getSessionName`, `setLabel`
- `exec(cmd, args, {signal?, timeout?, cwd?})`
- `getActiveTools`, `getAllTools`, `setActiveTools(names)`
- `getSettings`, `getCommands`
- `setModel(model) => Promise<boolean>`, `get/setThinkingLevel`
- `registerProvider(provider: Provider)` or `registerProvider(name, ProviderConfig)`, `unregisterProvider`
- `registerMcpServer(name, config)`, `unregisterMcpServer`, `getMcpServers`
- `registerVirtualModel`, `unregisterVirtualModel`
- `events` (bus between extensions)

Do not start processes, sockets or timers in the factory. Start them in `session_start`.

### 2.4 What `ctx` offers

```ts
interface ExtensionContext {
  ui: ExtensionUIContext; mode: "tui"|"rpc"|"json"|"print"; hasUI: boolean; cwd: string;
  sessionManager: ReadonlySessionManager;   // getCwd, getSessionDir, getSessionId, getSessionFile, getLeafId, getLeafEntry,
                                            // getEntry, getLabel, getBranch, buildContextEntries, buildSessionProjection,
                                            // getHeader, getEntries, getTree, getSessionName
  modelRegistry: ModelRegistry;             // refresh(), getAvailable(), find(), getApiKeyForProvider(), streamSimple(), complete(), classify(), generateImages()…
  model: Model<any> | undefined; scopedModels: readonly ScopedModel[]; thinkingLevel?: ThinkingLevel;
  isIdle(): boolean; isProjectTrusted(): boolean; signal: AbortSignal | undefined; abort(): void;
  hasPendingMessages(): boolean; shutdown(): void; getContextUsage(): ContextUsage | undefined;
  compact(options?): void; getSystemPrompt(): string;
}
interface ExtensionToolContext extends ExtensionContext {   // passed to execute()
  readonly tools: readonly AgentTool[];
  executeTool(name: string, args: unknown, options?: { signal?, onUpdate? }): Promise<AgentToolCallOutcome>;
}
interface ExtensionCommandContext extends ExtensionContext {  // command handlers only
  getSystemPromptOptions(); waitForIdle(); newSession({parentSession?, setup?, withSession?}); fork(entryId, …);
  navigateTree(targetId, …); switchSession(path, {withSession?}); reload();
}
// ExtensionUIContext: select(title, options, {signal?, timeout?}), confirm(title, message, opts), input(title, placeholder?, opts),
// editor(title, prefill?), notify(msg, "info"|"warning"|"error"), setStatus(key, text|undefined), setWidget(key, lines|undefined, {placement?}),
// setTitle, setEditorText, getEditorText, custom(...) [TUI only], theme, …
```

---

## 3. Restricting tools

Behaviour verified by inspecting the `tools` field of the request the mock server received:

| Flag | Effect |
|---|---|
| `--no-builtin-tools` / `-nbt` | Disables read, bash, edit and write (and the other built-ins). **Extension and SDK tools stay active.** Result: only `take_screenshot` was sent. This is the one we want. |
| `--no-tools` / `-nt` | Disables **all** tools, including extension tools. Result: `[]`. |
| `--tools a,b` / `-t` | Exact allowlist of built-in, extension and custom tools. It wins over `--no-tools`. `"--no-tools","--tools","take_screenshot"` sent `["take_screenshot"]`. |
| `--exclude-tools a,b` / `-xt` | Denylist, applied last. |

- **Settings equivalent:** `"defaultTools": []` disables built-ins but keeps extension tools. `"+name"` / `"-name"` edit the default list.
- **SDK equivalents:** `noTools: "builtin" | "all"`, `tools: [...]`, `excludeTools: [...]`, `customTools: [...]`.
- **Built-in tools:** `read`, `bash`, `powershell` (Windows), `edit`, `write`, `grep`, `find`, `ls`. The default set is read, bash, edit and write. `grep` and `find` download `fd`/`rg` from GitHub on first use unless `PI_OFFLINE=1`.
- **MCP and codemode:**
  - The CLI auto-loads the built-in extensions `builtin:mcp`, `builtin:codemode`, `builtin:tool-search` and `builtin:llama.cpp`.
  - Without MCP servers they declare **no tools**. Verified: only `/mcp` and `/llama` commands appeared.
  - Codemode only activates if an MCP server with `codemode` exposure connects, or if `defaultTools` names it.
  - To remove them, use `--no-extensions` (then load ours with `-e`), or set `"extensions": ["-builtin:mcp","-builtin:codemode","-builtin:tool-search","-builtin:llama.cpp"]`.
  - SDK sessions never load the built-in extensions.
- **Remaining exposure:** the RPC `bash` *command* still executes shell commands even when no tools exist (§1.2).

---

## 4. System prompt and context isolation

How the prompt is built (`dist/core/system-prompt.js`):

- **Default sections:** `preamble` ("You are an expert coding assistant operating inside pi…"), then `<tools>`, `<rules>` and `<docs>` (pointing at pi's own docs).
- **Sections appended after those:** `<addendum>` (append text), `<project_context>` (AGENTS.md/CLAUDE.md), `<skills>` (only if the `read` or `bash` tool is active), `<cwd>`, and custom sections.

Ways to change it:

- **`--system-prompt <text|path>`** replaces preamble, tools, rules and docs. Verified result:
  `"Eres SpainAssist. Responde en español.\n\n<cwd>\n/abs/work/dir\n</cwd>"`.
  - The `<cwd>` section is **always** appended, and it leaks the absolute path (including the username).
  - Tool `promptSnippet` / `promptGuidelines` are **not rendered** when a custom prompt is used, so put guidance in the tool descriptions or in our prompt.
- **Exact full replacement, verified:** returning `{ systemPrompt }` from `before_agent_start` made the provider receive exactly that text, with no `<cwd>` (what the host does). A softer option is to mutate `event.systemPromptOptions.sections` (add, replace or `delete` keys).
- **`--append-system-prompt <text|path>`** (repeatable) adds an `<addendum>`.
- **Files:** `<agentDir>/SYSTEM.md` replaces the default prompt and `<agentDir>/APPEND_SYSTEM.md` appends to it. `.pi/SYSTEM.md` and `.pi/APPEND_SYSTEM.md` do the same but only after project trust.
- **SDK:** `DefaultResourceLoader({ systemPromptOverride: () => "...", appendSystemPromptOverride: () => [] })`.

Preventing outside context from leaking in:

| Leak | Guard |
|---|---|
| `AGENTS.md` / `CLAUDE.md` / `AGENTS.override.md` from the agent dir **and the cwd plus every parent directory**, loaded even without trust | `--no-context-files` / `-nc` (SDK: `noContextFiles`) |
| Skills from `<agentDir>/skills`, `.pi/skills`, **`~/.agents/skills` (the real HOME, regardless of `PI_CODING_AGENT_DIR`)**, and `.agents/skills` in the cwd and its ancestors | `--no-skills` / `-ns` |
| Prompt templates | `--no-prompt-templates` / `-np` |
| Themes | `--no-themes` |
| Project `.pi/*` settings, extensions, mcp.json, SYSTEM.md | `--no-approve` / `-na`. In RPC mode the default `defaultProjectTrust:"ask"` already means "skip", but be explicit. |
| Auto-discovered extensions | `--no-extensions` / `-ne` |

The SDK equivalents are the `DefaultResourceLoaderOptions` `no*` flags (§8.1), which the host sets.

If we ever want skills (e.g. procedure playbooks), the model needs the `read` tool: pi only lists skills when `read` or `bash` is active. A `tool_call` gate could restrict `read` to the skills directory.

---

## 5. Config and storage locations

| Env var | Purpose |
|---|---|
| `PI_CODING_AGENT_DIR` | Agent dir (default `~/.pi/agent`). **Verified:** with it set, nothing was written to HOME. |
| `PI_CODING_AGENT_SESSION_DIR` | Session dir; `--session-dir` overrides it. |
| `PI_OFFLINE=1` / `--offline` | No startup network: no model-catalog refresh from `https://pi.dev/api/models/providers/<id>` (which RPC otherwise runs in the background), no package installs, no fd/rg download. |
| `PI_TELEMETRY=0` | Disables install telemetry (interactive mode only) **and** the provider attribution headers. Verified for OpenRouter: by default pi sends `HTTP-Referer: https://pi.dev`, `X-OpenRouter-Title: pi` and `X-OpenRouter-Categories: cli-agent`; with `0` none are sent. The setting equivalent is `enableInstallTelemetry:false`. |
| `PI_SKIP_VERSION_CHECK` | Skips the pi.dev version check (interactive mode only). |
| `PI_OAUTH_CALLBACK_HOST` | Host for OAuth loopback servers (default `127.0.0.1`). |
| `PI_PACKAGE_DIR` | Override the package directory. |
| `HTTP_PROXY`, `HTTPS_PROXY` | Outbound proxy. |

Pi sets `AI_AGENT=pi` and `PI_CODING_AGENT=true` on its children. The `bash` tool also receives `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL` and `PI_REASONING_LEVEL`.

**Agent dir contents:**

- `settings.json`, `models.json`, `auth.json` (created by the CLI with mode 0600, even for `--help`), `models-store.json` (catalog cache, created empty).
- `mcp.json`, `mcp-auth.json`, `mcp.log`, `trust.json`, `keybindings.json`.
- `SYSTEM.md`, `APPEND_SYSTEM.md`, `AGENTS.md`.
- `extensions/`, `skills/`, `prompts/`, `themes/`, `sessions/`, and `bin/` (downloaded fd/rg).

The SDK host with in-memory stores wrote **nothing at all**.

**Sessions (verified):**

| Flags | Result |
|---|---|
| `--no-session` | in memory only |
| `--session-dir <dir> --session-id <id>` | creates `<dir>/<ISO-ts>_<id>.jsonl` and **resumes the same file** on the next start |
| `--session <abs path>` | creates or opens exactly that file |
| default | `<agentDir>/sessions/--<cwd with / → ->--/<ts>_<uuid>.jsonl` |

Further rules:

- Session IDs may contain letters, digits, `.`, `_` and `-`.
- `--fork <path|id>` and `--continue` also exist. RPC `switch_session` / `new_session` change the session at runtime.
- pi creates session files with mode **0644**. They contain the full transcript, including base64 screenshots (the host creates them 0600 first, `host/session.ts`).

**Session format** (`docs/session-format.md`): JSONL, version 3, a tree via `id` / `parentId`. Verified first lines:

```jsonl
{"type":"session","version":3,"id":"tramite-dni-001","timestamp":"2026-10-03T00:01:12.350Z","cwd":"/…/work"}
{"type":"model_change","id":"e5c6063f","parentId":null,"timestamp":"…","provider":"mock","modelId":"mock-model"}
{"type":"thinking_level_change","id":"5cc01f38","parentId":"e5c6063f","timestamp":"…","thinkingLevel":"off"}
{"type":"message","id":"abd72fc3","parentId":"5cc01f38","timestamp":"…","message":{"role":"system","content":"","sections":{…},"toolsAdded":[…]}}
{"type":"message","id":"40cbf2f8","parentId":"abd72fc3","timestamp":"…","message":{"role":"user","content":[{"type":"text","text":"…"}],"timestamp":1790985672386}}
```

Other entry types: `compaction`, `context_edit`, `branch_summary`, `custom` (extension state, not sent to the LLM), `custom_message` (sent to the LLM), `label`, `session_info`, `usage`.

**Settings** (`docs/settings.md`). The keys that matter for an embedded app (the host passes its own in memory):

```json
{ "enableInstallTelemetry": false, "defaultTools": [], "defaultProjectTrust": "never",
  "extensions": ["-builtin:mcp", "-builtin:codemode", "-builtin:tool-search", "-builtin:llama.cpp"],
  "retry": { "enabled": true, "maxRetries": 3 }, "compaction": { "enabled": true },
  "images": { "autoResize": true }, "cacheWarming": "off" }
```

- Defaults: `defaultThinkingLevel: "medium"` (clamped to the model), `steeringMode` / `followUpMode` `"one-at-a-time"`, `retry` {enabled, maxRetries 3, baseDelayMs 2000}, `compaction` {enabled, reserveTokens 16384, keepRecentTokens 20000}, `httpIdleTimeoutMs` 300000.
- Login via the CLI also stores a `deviceId` here.

---

## 6. Auth and providers

### 6.1 API keys

- **Resolution order** (`docs/models.md`): runtime `--api-key` / `setRuntimeApiKey`, then stored `auth.json`, then `apiKey` in models.json, then environment variables or ambient cloud credentials.
- **Environment variables:** `OPENROUTER_API_KEY` (verified), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, and the rest listed in `pi --help` and `docs/providers.md`.
- **`--api-key <key>`:** needs `--model` and is not persisted. It is visible in `ps`, so avoid it.
- **`auth.json` format:** `{ "<providerId>": { "type": "api_key", "key": "sk-…" | "!shell command", "env"?: {…} } }`. A key value starting with `!` runs a command and caches its output for the process lifetime.
- **Live behaviour (verified):**
  - Rewriting the key of an **already configured** provider in `auth.json` takes effect on the next request without a restart. Ideal for rotating voucher keys.
  - A provider that was **not configured at startup** stays unavailable: `get_available_models` returned 0 and `set_model` said "Model not found".
  - **Workaround (verified):** a tiny extension command that the client sends as `prompt "/refresh-auth"` (the prompt result's `disposition` is `"handled"`). After it ran, 399 models were available and `set_model` worked:
    ```ts
    pi.registerCommand("refresh-auth", { handler: async (_a, ctx) => { await ctx.modelRegistry.refresh({ allowNetwork: false }); } });
    ```
  - The alternative is to restart the RPC process.
  - Note: with zero credentials, RPC still starts, using a placeholder model `{id:"unknown",provider:"unknown"}`.
- **Writing `auth.json` from our app:** pi uses `proper-lockfile` (an `auth.json.lock` directory). Either write it while pi is stopped, or write it through `ModelRuntime.create({ authPath })` so the same locking applies.

### 6.2 SDK credential store

The SDK takes any pi-ai `CredentialStore` (`read`, `list`, `modify` (serialized, also used for
OAuth refresh), `delete`; `dist/auth/types.d.ts`) through `ModelRuntime.create({ credentials })`.
Ours is `BridgeCredentialStore` (`packages/agent/src/host/credentials.ts`).

### 6.3 OAuth subscription logins

All flows were verified up to the authorization URL; no real sign-in was completed.

| Provider id | Name in pi | Flow | Endpoint used for inference |
|---|---|---|---|
| **`openai`** | "OpenAI (ChatGPT subscription)", login label "Sign in with ChatGPT", `isSubscription:true`. New in 0.99 and the recommended path. | PKCE with `client_id=dynamic_agent_client`; `agent_name_hint=Pi`; `ext_agent_host_id=urn:uuid:<deviceId>` (**`LoginOptions.getDeviceId()` must return a stable UUID**); `resource=https://api.openai.com/v1`; scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; callback server on **`http://127.0.0.1:1455/auth/callback`** raced against a pasted-URL `manual_code` prompt. | `https://api.openai.com/v1` (Responses API) with the OAuth access token. Pi strips fields the subscription token rejects. A usage-cap error mentions `subscription_sharing_usage_limit_exceeded`. |
| `openai-codex` | "OpenAI Codex (legacy)", OAuth name "OpenAI (ChatGPT Plus/Pro)" | First a `select` prompt: `browser` or `device_code`. Browser: `client_id=app_EMoamEEZ73f0CkXaXp7hrann` with redirect `http://localhost:1455/auth/callback` (the port is shared with the Codex CLI; if it is busy, only the pasted URL works). Device code: verification URI `https://auth.openai.com/codex/device`. | `https://chatgpt.com/backend-api` (api `openai-codex-responses`) |
| `openrouter` | "OpenRouter OAuth", login label "Sign in with OpenRouter" | PKCE on an ephemeral loopback port. It returns a **permanent user API key**. | openrouter.ai |

Login API, the same for `ModelRuntime.login` and pi-ai `Models.login`:

```ts
interface AuthInteraction { signal?: AbortSignal; prompt(p: AuthPrompt): Promise<string>; notify(e: AuthEvent): void; }
type AuthPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }); // return option id
type AuthEvent =
  | { type: "auth_url"; url: string; instructions?: string }      // host must open it: shell.openExternal(url)
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?; expiresInSeconds? }
  | { type: "progress"; message: string } | { type: "info"; message: string; links?: { url; label? }[] };
```

- **Callback sequence observed for `openai`:** `notify(auth_url)`, then `prompt({type:"manual_code", signal})`. The prompt's `signal` aborts when the browser callback wins. Then `notify(progress "Exchanging authorization code for tokens...")`.
- **Pure pi-ai alternative (verified):**
  ```ts
  builtinModels({ credentials }).login("openai", "oauth", interaction, { getDeviceId })
  ```
  `builtinModels` is imported from `@earendil-works/pi-ai/providers/all`.
- **Credential shapes** stored under the provider id:
  - `openai-codex`: `{type:"oauth", access, refresh, expires, accountId}`. `accountId` comes from the JWT claim `https://api.openai.com/auth.chatgpt_account_id`.
  - `openai`: `{type:"oauth", access, refresh, expires /* 3 min early */, clientId, scopes}`.
- **Verified:** writing these shapes into `auth.json` makes `pi auth check --provider openai --json` print `{"status":"ready","provider":"openai","authType":"oauth"}`, and the models appear in `--list-models`.
- **Token refresh** is automatic. `Models.getAuth()` refreshes inside `CredentialStore.modify` (locked) when less than `minOAuthValidityMs` (default 5 min) remains, and persists the new tokens. A failure surfaces as a stream error with code `"oauth"`.
- **CLI helpers:** `pi auth check`, `pi auth print-api-key`, `pi auth print-bearer-token --provider openai-codex [--min-expiry 30m]`.
- **Legacy callbacks:** the old `OAuthLoginCallbacks {onAuth, onDeviceCode, onPrompt, onProgress?, onManualCodeInput?, onSelect, signal?}` survive only for `pi.registerProvider(name, { oauth: { login(callbacks), refreshToken, getApiKey } })` in extensions. Standalone helpers such as `loginOpenAICodex()` are gone.

**Default models** (`defaultModelPerProvider` in `dist/core/model-resolver.js`):

- `openai`: `gpt-5.5`.
- `openai-codex`: `gpt-6.1-sol`. Its catalog: `gpt-5.3-codex-spark`, `gpt-5.5`, `gpt-5.6-{luna,sol,terra}`, `gpt-6-{astra,luna,sol}`, `gpt-6.1-sol`.
- `openrouter`: `moonshotai/kimi-k2.6` (399 OpenRouter models are bundled).
- Which models a given ChatGPT plan allows is **UNVERIFIED**.

---

## 7. Custom providers and models.json

Schema from `dist/core/model-config.d.ts`, all fields optional except model `id`:

```jsonc
{ "providers": { "<providerId>": {
    "name": "…", "baseUrl": "http://127.0.0.1:PORT/v1", "api": "openai-completions",
    "apiKey": "literal | $ENV | ${ENV} | !command",
    "headers": { "X-Title": "SpainAssist" }, "authHeader": true, "compat": { … }, "oauth": "radius",
    "models": [ { "id": "…", "name": "…", "api"?: "…", "baseUrl"?: "…", "reasoning": false,
                  "input": ["text","image"], "contextWindow": 128000, "maxTokens": 8192,
                  "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "tiers"?: […] },
                  "thinkingLevelMap"?: { "high": "high", "minimal": null }, "inputLimits"?: { "images": { "resize": { "maxWidth": 1568 } } },
                  "promptCache"?: { "short": 300 }, "headers"?: {…}, "samplingParams"?: {…}, "compat"?: {…} } ],
    "modelOverrides": { "<existingModelId>": { "maxTokens": 8192, … } } } } }
```

- **`api` values** (`KnownApi`): `openai-completions`, `openai-responses`, `azure-openai-responses`, `openai-codex-responses`, `anthropic-messages`, `mistral-conversations`, `bedrock-converse-stream`, `google-generative-ai`, `google-vertex`, `pi-messages`. Any other string requires an extension that provides `streamSimple`.
- **Useful `compat` keys for openai-completions:** `supportsDeveloperRole`, `supportsReasoningEffort`, `supportsUsageInStreaming`, `maxTokensField`, `thinkingFormat` (`openai`, `openrouter`, `deepseek` (reasoning_content; verified), `qwen`, …), `openRouterRouting` (`data_collection:"deny"`, `zdr`, `only`, `order`, `max_price` …), `supportsStrictMode`.

**(a) Mock LLM for e2e tests (verified).** Use a custom provider with `api:"openai-completions"` and `apiKey:"test-key"`, pointing at a local SSE server.

- Pi sent: `POST /v1/chat/completions` with `{"model","stream":true,"stream_options":{"include_usage":true},"store":false,"max_completion_tokens":<maxTokens>,"messages":[{"role":"system",…}],"tools":[{"type":"function","function":{name,description,parameters}}]}`, plus `Authorization: Bearer test-key` and `User-Agent: pi (darwin …)`.
- The mock replies with chunks like `data: {"choices":[{"index":0,"delta":{"content":"…"}}]}`, then a tool call:
  ```
  data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"take_screenshot","arguments":"{…}"}}]}}]}
  ```
  then `finish_reason: "tool_calls"`, a usage chunk `{"choices":[],"usage":{"prompt_tokens":…,"completion_tokens":…,"total_tokens":…}}`, and finally `data: [DONE]`.

Alternatives:

- **Override a built-in provider's endpoint (verified):** `{"providers":{"openrouter":{"baseUrl":"http://127.0.0.1:PORT/v1"}}}` keeps the whole built-in catalog, so e2e tests exercise the real provider code path.
- **In-process scripted LLM, no HTTP (verified):** a test-only extension does
  ```ts
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
  faux.setResponses([fauxAssistantMessage([fauxText("…"), fauxToolCall("take_screenshot", {url})], { stopReason: "toolUse" }), (ctx) => fauxAssistantMessage("…")]);
  pi.registerProvider(faux.provider);
  ```
  importing from `@earendil-works/pi-ai`, then runs with `--model faux/faux-1`.

**(b) OpenRouter voucher keys (verified).** Put the key in `OPENROUTER_API_KEY` or in `auth.json` as `{"openrouter":{"type":"api_key","key":"sk-or-…"}}`, and use the built-in `openrouter` provider.

- Pi sent `reasoning: {"effort":"low"}` for `--thinking low`.
- **Risk:** without an override, `max_completion_tokens` equals the model's catalog maximum (235,929 for kimi-k2.6). OpenRouter may reject capped keys that "can't afford" `max_tokens` (**UNVERIFIED** against the live service). Cap it with `modelOverrides`; verified, `maxTokens: 8192` produced `max_completion_tokens: 8192`.
- Add our own attribution headers via `headers`. With `PI_TELEMETRY=0`, pi's attribution headers are removed.

---

## 8. SDK

### 8.1 Key exports and signatures

```ts
createAgentSession(options?: {
  cwd?; agentDir?; modelRuntime?: ModelRuntime; model?: Model<any>; thinkingLevel?: ThinkingLevel;
  scopedModels?; noTools?: "all" | "builtin"; tools?: string[]; excludeTools?: string[]; customTools?: ToolDefinition[];
  resourceLoader?: ResourceLoader; sessionManager?: SessionManager; settingsManager?: SettingsManager; sessionStartEvent?;
}): Promise<{ session: AgentSession; extensionsResult; modelFallbackMessage? }>;
createAgentSessionServices({ cwd, agentDir?, settingsManager?, modelRuntime?, resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions,"cwd"|"agentDir"|"settingsManager">, … })
createAgentSessionFromServices({ services, sessionManager, sessionStartEvent?, model?, thinkingLevel?, tools?, excludeTools?, noTools?, customTools? })
createAgentSessionRuntime(factory: CreateAgentSessionRuntimeFactory, { cwd, agentDir, sessionManager, sessionStartEvent? }): Promise<AgentSessionRuntime>
runRpcMode(runtimeHost: AgentSessionRuntime): Promise<never>     // exported; reads process.stdin, writes process.stdout
// DefaultResourceLoaderOptions: noExtensions, noSkills, noPromptTemplates, noThemes, noContextFiles, systemPrompt?, appendSystemPrompt?,
//   systemPromptOverride, appendSystemPromptOverride, extensionFactories: InlineExtension[], additionalExtensionPaths, *Override hooks
// SessionManager.inMemory(cwd?) | create(cwd, sessionDir?, {id?}) | open(path) | continueRecent(cwd, sessionDir?) | list(cwd, dir?)
// SettingsManager.inMemory(partialSettings) | create(cwd, agentDir) | fromStorage(storage)
// AgentSession: prompt(text, {images?, streamingBehavior?}), steer(), followUp(), abort(), waitForIdle(), subscribe(listener),
//   dispose(), messages, model, systemPrompt, getActiveToolNames(), getLastAssistantText(), bindExtensions({uiContext?, mode?, …})
```

### 8.2 SDK agent host (verified)

A custom process built from these exports is a drop-in replacement for `pi --mode rpc` over
stdio: `createAgentSessionRuntime` + `runRpcMode` speak the same JSONL protocol as §1. Ours is
`packages/agent/src/host/run.ts` (described in `packages/agent/README.md`, "Architecture").

Verified behaviour:

- Inline `extensionFactories` still load with `noExtensions: true`.
- `get_commands` lists them as `sourceInfo.path:"<inline:spain>"`.
- The SDK does **not** load built-in MCP or codemode. Add `createMcpExtension()`, `createCodemodeExtension()` and `createToolSearchExtension()` to `extensionFactories` if needed.
- An `InMemoryCredentialStore` key reached the provider (`Authorization: Bearer …`), so any `CredentialStore` works; the CLI subprocess instead always reads `<agentDir>/auth.json`.

Concurrency:

- One RPC process has exactly **one active session**. `switch_session` and `new_session` replace it.
- The SDK can run **several `AgentSession`s concurrently in one process.** Verified: two parallel prompts of ~4 s each completed in 4.16 s. We chose one RPC host process per active agent.

Packaging note:

- An SDK host must declare `typebox` and `@earendil-works/pi-ai` itself to import them (versions matching pi's; with 1.0.0's shrinkwrap, nested duplicate copies also interoperated). `apps/desktop` keeps them equal to `@sa/agent`'s (`electron-packaging.md` §6.11).

---

## 9. Running under Electron and pnpm

- **Verified on macOS arm64 (with 1.0.0).** `ELECTRON_RUN_AS_NODE=1 <Electron 44.5.1 binary> node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode rpc …` behaved identically to Node 24.
  - Electron 44.5.1 bundles Node **24.21.0**, satisfying `engines.node >=22.19.0`.
  - The test covered streaming, the dialog, an extension loaded via jiti, a session file, and **photon WASM image resize in a worker thread**.
- **Native and WASM dependencies:**
  - `@silvia-odwyer/photon-node` is **WASM** (`photon_rs_bg.wasm`), not native. `quickjs-wasi` (codemode) is also WASM.
  - The only `.node` binaries are `@earendil-works/pi-tui` prebuilds (`darwin-platform.node`, `linux-platform-x11.node`, `win32-platform.node`). They are **N-API** (`napi_register_module_v1`), TUI-only (clipboard and modifier keys), and loaded lazily inside try/catch.
  - `esbuild` (≈10 MB platform binary, from `@earendil-works/chord`) is **never imported by the bundle** and can be pruned.
  - Optional `kerberos` and `@aws-sdk/signature-v4-crt` requires are not installed and not needed.
- **Size and dependencies:**
  - About 157 MB installed with npm, mostly SDKs for providers we do not use: Anthropic, Google, AWS and others.
  - The bundle `dist/bundle/*` (including its `image-resize-worker.js` and `codemode-worker.js` chunks) is self-contained, with two exceptions. It needs `@silvia-odwyer/photon-node` to be resolvable. The optional pi-tui native helper is also resolved from `node_modules`, but only for the TUI.
- **pnpm (verified on 10):** a strict-layout install works (CLI, RPC and image resize). pnpm warns about ignored build scripts (`@google/genai`, `esbuild`, `protobufjs`), and none of them is needed.
- **asar:** works in the packaged app with only smartUnpack, including the image-resize worker (`electron-packaging.md` §6.9, §6.11).
- **Electron Fuses:** setting the `RunAsNode` fuse to `false` (as Electron Forge templates do) **breaks** `ELECTRON_RUN_AS_NODE`, so the packaged app keeps it on. **UNVERIFIED:** whether `utilityProcess` offers a usable stdin for `runRpcMode`; otherwise use the SDK with `parentPort` messaging (`packages/agent/src/rpc/transport.ts` is the seam).
- **UNVERIFIED:** Windows and Linux; hardened-runtime or notarization interplay.
---

## 10. MCP (brief)

- **Built in.** The `builtin:mcp` extension supports stdio and Streamable HTTP, with OAuth (dynamic client registration, PKCE, credentials kept in `<agentDir>/mcp-auth.json`). The legacy SSE transport is rejected.
- **Configuration** goes in `<agentDir>/mcp.json`, or `.pi/mcp.json` in trusted projects:
  ```json
  { "mcpServers": { "feedback": { "url": "https://feedback.example/mcp", "headers": { "Authorization": "Bearer ${FEEDBACK_TOKEN}" }, "exposure": "direct", "description": "…" },
                    "local": { "command": "node", "args": ["server.js"], "env": {}, "cwd": "…" } } }
  ```
- **Exposure and naming:**
  - Exposure is one of `codemode` (default; reachable only through the codemode tool), `deferred` (found via `tool_search`), `direct` (declared to the model like a normal tool) or `hidden`. It can be overridden per tool with `toolExposure`.
  - Tools are named `mcp__<server>__<tool>`.
  - Resources are exposed through `list_mcp_resources` and `read_mcp_resource` tools.
  - All calls pass through the `tool_call` / `tool_result` hooks.
- **Extensions:** `pi.registerMcpServer(name, config)` adds a session-only server, so no `mcp.json` is needed.
- **SDK:** `createMcpExtension()`, then `session.bindExtensions()`.
- **CLI:** `pi mcp add|remove|list|login|logout`.
- **Standalone client:** `@earendil-works/pi-mcp` is a small MCP client (`McpClient`, `StdioTransport`, `StreamableHttpTransport`, `toLlmContent`) with no dependency on the official SDK.
- **For SpainAssist:** in-process extension tools are simpler than local MCP for the credential and data tools. Remote MCP is fine for the Feedback Server; prefer `exposure:"direct"` so codemode is not required.

---

## 11. Other notable 1.0 facts for a desktop app

- **No built-in web search or fetch tools.** Built-ins are only read, bash, powershell, edit, write, grep, find and ls, plus codemode, tool_search and the MCP resource tools. Research tools (Exa, BOE fetchers) must be our own extension tools or MCP servers.
- **Images:**
  - User prompts accept `images: ImageContent[]`, for example a DNI photo.
  - Pi resizes automatically to at most 2000×2000 at ≤4.5 MiB (JPEG quality 80) unless `images.autoResize:false`.
  - `images.blockImages` exists.
- **Thinking levels:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. They are clamped per model. `get_available_thinking_levels` reports them, and a `--model provider/id:high` suffix also works.
- **Steering:** `steer` is delivered after the current turn's tool calls finish, before the next LLM call. `follow_up` waits until the agent finishes. Each returns `disposition`, and `queue_update` events mirror the queue.
- **Compaction:** automatic near the context limit, and it uses the same model, so the conversation is sent to the same provider. Hooks are `session_before_compact` (can supply a custom summary or cancel) and `set_auto_compaction`.
- **Retry:** automatic retry of 5xx and overload errors at the agent level (`retry.*`). Verified with the mock: a 402 and a 401 each produced one request and no `auto_retry_start`.
- **Sessions are trees:** `fork`, `clone`, `get_tree`, `get_entries {since}` (a durable cursor, good for syncing UI state across restarts), and `context_edit` entries.
- **Extra model types:** classifier models (TypeSafe Jev) and image-generation models (OpenRouter) via `ctx.modelRegistry.classify()` and `generateImages()`. Virtual models (per-request routers, experimental) via `pi.registerVirtualModel()`.
- **Cost tracking:** per-response usage includes USD cost from catalog prices. `get_session_stats` aggregates it and includes tool-reported usage. This is useful for showing voucher spend, but the catalog price may differ from OpenRouter's actual billing.
- **Network calls pi can make on its own:**
  - the pi.dev model catalog (RPC, unless offline)
  - fd/rg downloads from GitHub (grep/find tools)
  - install telemetry and the version check (interactive mode only)
  - `/share` and `/bug` (interactive only)

  With `PI_OFFLINE=1 PI_TELEMETRY=0` and no built-in tools, the only remaining traffic goes to the inference provider.
- **Security model** (`docs/security.md`): no sandbox. Extensions and tools run with full user permissions. Project trust is not a security boundary.

---

## 12. Risks and surprises (summary)

Solved in the host, so dropped from this list: `RpcClient` (we have `PiRpcClient`), the `<cwd>`
prompt leak, telemetry and catalog calls, and session-file permissions (`packages/agent/README.md`).

1. **Abort can deadlock on an unanswered dialog** unless tools pass `{signal}`. Pi never tells the client that a dialog was dismissed (§1.5).
2. **There is no auth command in RPC.** With `auth.json`, a newly configured provider needs `ctx.modelRegistry.refresh()` (via an extension command) or a restart; key rotation for an existing provider is live. Whether the same holds for a provider that first appears in our `CredentialStore` mid-session is **UNVERIFIED**.
3. **"Sign in with ChatGPT" moved to the `openai` provider.**
   - The login needs a stable device UUID.
   - Port 1455 is shared with Codex CLI logins.
   - The host must open the browser itself.
   - `openai-codex` is legacy.
   - Whether the subscription token is supported long-term on api.openai.com is OpenAI's policy and is **UNVERIFIED**.
4. **`max_completion_tokens` defaults to the model maximum.** Override `maxTokens` for capped voucher keys (§7).
5. **The `bash` RPC command exists even when tools are disabled** (the host blocks it).
6. **Dependency pinning.** pi 1.1 no longer ships a shrinkwrap; our lockfile pins it. pi pulls about 157 MB of provider SDKs.
7. **Packaging unknowns:** whether `utilityProcess` gives `runRpcMode` a usable stdin (needed to turn the `RunAsNode` fuse off), and Windows/Linux. All **UNVERIFIED**. Running from the ASAR works (`electron-packaging.md` §6.11).
8. **The transcript includes `role:"system"` messages** in events and `get_messages`. UIs must filter them.

## 13. UNVERIFIED items

- Behaviour with real OpenAI, ChatGPT or OpenRouter endpoints, including completing a real OAuth login, which models a ChatGPT plan allows, and OpenRouter's `max_tokens`-versus-credit rejection.
- Windows and Linux.
- Electron Fuses with `RunAsNode` off, `utilityProcess` stdio, and macOS notarization.
- MCP servers in practice. Only the docs and types were read; no MCP connection was tested.
- Compaction behaviour. Read in docs; not triggered in tests.
