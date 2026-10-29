# Codemode harness: research and design options

Research: 2026-10-22–23. Saved: 2026-10-23. Status: planning only; no implementation.

This records the harness investigation, external research, API and UI alternatives, and the
subsequent user corrections. It distinguishes requirements from proposals: illustrative APIs in
this memo do not exist yet. Source observations describe the checkout inspected during the
discussion; dependency details should be checked again before implementation.

Related: [architecture](../ARCHITECTURE.md), [pi embedding](pi.md), [browser research](browser.md),
[prompt injection](prompt-injection-agents-2026.md), [evaluation](../EVAL.md).

## 1. Objective and agreed constraints

Replace the model-facing `run_script` tool with `codemode`. Other public agent tools become APIs
that generated JavaScript can call. Supply the agent with a compact generated `.d.ts` declaration
of its active capabilities, with minimal documentation comments.

The intended benefits are parallel operations, conditional execution and error recovery without
another inference, local processing of large results, richer user interaction, and reusable
website recipes shared through the feedback server.

The user explicitly established these constraints:

- Executable modules are **`.js`**. `.d.ts` is documentation for the agent, not an instruction to
  introduce TypeScript execution or mandatory typechecking of generated programs.
- Return structured objects where that is useful; retain strings where a string is the natural
  result. Structured output does not mean wrapping every value in an unnecessary object.
- Initially provide the **complete compact API for the agent's active capabilities**. Do not add
  discovery complexity before measuring the declaration size.
- Move toward Playwright's API. The user asked why this cannot simply expose Playwright itself.
- Investigate powerful `evaluate()` access rather than assuming it should be deferred.
- Compare QuickJS, V8 isolates, and execution in Chromium.
- Codemode must be **resumable from state**, including quitting the app while a form is active.
  This is part of the initial design, not an optional later improvement.
- The user prefers declarative, React-familiar UI authoring, but the final lifecycle and runtime
  remain undecided.
- **Recipes belong to the feedback server. There is no separate `api.recipes` namespace or
  recipe service.** Search, submission, moderation, and retrieval belong to feedback. Loading
  and execution mechanics remain open.
- This task is research and planning; implementation has not been authorized by the discussion.

JSX in `.js`, if selected, would require a syntax transform. That is separate from TypeScript;
plain JavaScript ESM itself does not require a TypeScript compiler.

## 2. Evidence and scope

Local findings were rechecked against `master` at `942b083` on 2026-10-23. They came from the
architecture and research memos, agent tools and host, shared contracts, browser service,
desktop prompts and renderer, feedback server, evaluation hooks,
and installed pi/codemode sources. The inspected dependencies included pi 1.1.0 and Playwright
1.64.1; the existing browser research memo documents an earlier Playwright 1.63 investigation.
The agent manifest declares pi `^1.1.0`; 1.1.0 is the inspected lockfile/installed version, not an
exact manifest pin. See the [manifest](../../packages/agent/package.json) and
[lockfile](../../pnpm-lock.yaml).

External findings came from primary documentation, project source, and research papers listed
below. Public performance numbers are their authors' results or illustrations. No comparable
codemode benchmark has been run for SpainAssist. No real government sites or paid APIs were
contacted for local testing, and no prototype was implemented.

## 3. External state of the art

### Cloudflare Code Mode and reusable snippets

The [2025-09-26 announcement](https://blog.cloudflare.com/code-mode/) describes generating
TypeScript declarations from MCP tools, executing JavaScript in isolated Workers, routing tool
calls through RPC, and returning script-emitted console output. Network access is blocked by default.
The [current package](https://github.com/cloudflare/agents/blob/main/packages/codemode/README.md)
also describes namespaced providers, MCP/OpenAPI connectors, on-demand search/description, and
durable execution. It is experimental. Its supplied Worker executor and durable runtime use
Workers/Durable Objects; the executor interface is replaceable.

[Saved snippets](https://github.com/cloudflare/agents/blob/main/docs/codemode/snippets.md) provide
successful source reuse, optional input schemas, descriptions, connector requirements, discovery,
and execution. The agent can write and reuse code while the host decides promotion. This is a
close precedent for recipes, but does not establish website compatibility or validation quality.
SpainAssist should put the equivalent artifact inside feedback rather than copying a separate
snippet API.

The [durable runtime design](https://github.com/cloudflare/agents/blob/main/docs/codemode/runtime.md)
separates execution from storage. Pauses interrupt execution; continuation reruns identical
source with recorded tool results. Named steps can record nondeterministic computations. Its
documented limitations are especially relevant:

- Parallel connector arrival order determines journal positions, so `Promise.all` is not
  replay-safe in runs that may later pause. The documentation advises sequential connector calls.
- A crash after an external effect but before recording completion can repeat the effect.
- Started, unawaited host calls can continue after the program returns.

These are design lessons, not guarantees to inherit. Preserving parallelism and durable waits
needs stable invocation identities and recorded ordering where it affects decisions. External
effects additionally need idempotency or reconciliation.

### Anthropic: code execution with MCP and hosted programmatic tool calling

The [2025-11-04 code execution/MCP article](https://www.anthropic.com/research/code-execution-with-mcp)
describes generated tool files, loading relevant definitions on demand, processing intermediate
results inside execution, and saving useful functions or skills. Its often quoted reduction from
150,000 to 2,000 tokens is an illustrative workflow, not a universal benchmark.

[Claude Programmatic Tool Calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
is a distinct hosted product: Python code calls eligible tools asynchronously, the application
supplies results, and execution resumes without intervening model inference. Pending tool calls
time out after approximately four minutes. The inspected documentation also restricts which
toolsets can be called programmatically. A self-managed SpainAssist runner would have a different
capability surface and can support user waits lasting hours.

### OpenAI Programmatic Tool Calling

[Official OpenAI documentation](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
describes fresh isolated V8 execution with JavaScript, top-level `await`, `tools.*`, and explicit
text/image output. There is no Node, filesystem, direct network, console, or persistent JavaScript
state between executions. Client-owned function results resume a program using continuation
information; MCP approval can also pause it. Deferred tools must be discovered before a program
that uses them starts.

Its `output_schema` is particularly relevant: predictable results need declarations as well as
arguments. Merely translating input schemas to `.d.ts` while returning prose would miss much of
the programming benefit. The hosted mechanism is a reference, not a requirement to move local
execution or private intermediate data to a vendor runtime.

### CodeAct, smolagents, and benchmark evidence

[CodeAct](https://arxiv.org/abs/2402.01030), submitted in February 2024 and revised in June 2024,
uses executable Python as a unified action representation and supports composition and correction
over multiple turns. It reports up to 20% higher success on evaluated tasks.

[smolagents](https://github.com/huggingface/smolagents) operationalizes code actions through
`CodeAgent` and reports approximately 30% fewer steps than JSON tool calling in its evaluations.
An additional [August 2026 preprint](https://arxiv.org/abs/2608.06370) compares typed Python
programmatic calls with native JSON calls across 14 models on BFCL v4; it reports matching or
exceeding baseline for 11 models, and 13 under parallel fan-out. These are benchmark-specific
findings, not measurements of Spanish government browser flows or interactive forms.

### Playwright and Stagehand

The [Playwright CLI](https://github.com/microsoft/playwright-cli/blob/main/README.md) emphasizes
concise commands and demand-loaded skills for coding agents while retaining MCP for exploratory
and introspective workflows. The transferable idea is controlling which observations enter
context.

Playwright's [server code-execution tool](https://playwright.dev/mcp/tools/code-execution) accepts
an async function with a `page`, but its inspected documentation calls it
`browser_run_code_unsafe` and describes execution in the Playwright server process as
RCE-equivalent. This is different from `page.evaluate()`, which runs inside the website.

Stagehand's [caching](https://docs.stagehand.dev/v3/best-practices/caching) and
[deterministic agent](https://docs.stagehand.dev/v3/best-practices/deterministic-agent) guides
describe caching discovered actions, portable cache files, inference-free replay, variables for
personal inputs, and repair or fallback when selectors fail. Claimed 10–100× speedups apply to
cached workflows; they do not establish likely gains here.

### Interactive UI precedents

[MCP Apps](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html) separates
tools from UI resources and renders interactive views in sandboxed iframes with host-mediated
communication. Views can support forms and multi-step interactions without requiring inference
for every event. Presentation and tool data have distinct lifecycles.

[A2UI data binding](https://a2ui.org/concepts/data-binding/) separates component structure from
state. Its [action model](https://a2ui.org/concepts/actions/) distinguishes local functions from
events sent to the agent side. Native component catalogs, reactive data, local validation, and
explicit event routing are relevant even if SpainAssist uses React rather than its JSON format.
Adopting either complete protocol is not a decision made in this discussion.

Research synthesis: typed imperative operations, local result processing, selective output, and
source reuse have strong precedents. None requires React effects to drive browser automation.
Declarative interaction can compose with imperative functions; durability determines the root
lifecycle more strongly than JSX syntax does.

## 4. Current harness and migration seams

### Processes, roles, and dispatch

The current flow is model → pi tool → agent host → authenticated loopback bridge → Electron main.
Main owns state, browser sessions, secrets, prompts, signing, and vault operations. The desktop
controls each agent host over JSONL RPC. The assistant has delegation, forms, and vault tools;
procedure agents have browsing, research, prompts, documents, and feedback. Research capability
depends on provider and configuration.

Relevant sources:

- [`host/run.ts`](../../packages/agent/src/host/run.ts): role selection, research backend, SDK setup.
- [`host/extension.ts`](../../packages/agent/src/host/extension.ts): public tool registration,
  exact system prompt, shell blocking, unknown-tool blocking, and context hooks.
- [`tools/index.ts`](../../packages/agent/src/tools/index.ts) and
  [`tools/names.ts`](../../packages/agent/src/tools/names.ts): active tool sets and scheduling.
- [`bridge.ts`](../../packages/shared/src/bridge.ts): request schemas, result types, and permissions.

The host disables ordinary coding tools and external context resources and loads its own inline
extension. Codemode must preserve these restrictions and existing role boundaries.

### Structured results already exist below the tool layer

`BridgeResults` already describes useful objects, including `BrowserObservation`, prompt answers,
vault results, procedure state, and feedback entries. Current tool helpers usually render those
as text plus UI-oriented `details`.

Examples are [`textResult` and `callBridge`](../../packages/agent/src/tools/common.ts),
[`pageResult`](../../packages/agent/src/tools/browser.ts),
[`vault tools`](../../packages/agent/src/tools/vault.ts), and
[`user tools`](../../packages/agent/src/tools/user.ts). Details often contain counts or keys rather
than the values that a program needs. Calling these tools unchanged would largely force programs
to parse prose.

`BridgeResults` provides compile-time types, not existing runtime output schemas. The bridge
validates requests; structured tool results still need explicit output contracts.

Define useful result schemas, preserve strings for naturally textual content, and keep script
data separate from activity metadata and model-facing formatting. Preserve meaningful error codes
instead of reducing every failure to an explanation string.

### Existing run_script

[`run-script.ts`](../../packages/agent/src/tools/run-script.ts) creates a fresh QuickJS/Wasm
instance per call. The inspected defaults are:

| Limit or capability | Current behavior |
| --- | --- |
| Source | JavaScript async function body; not an ESM module |
| Lifetime | 30-second default wall timeout; tool argument permits up to 120 seconds |
| Memory | 64 MiB engine budget, separate Wasm memory cap, 1 MiB stack |
| HTTP | Up to 50 requests; 10 MiB per response; public hosts and redirect checks |
| Output | Up to 500 log lines and 30,000 characters |
| APIs | Guarded fetch, URL helpers, encoders, response helpers, console |
| Absent | Node, filesystem, timers, Playwright objects, persistent JS state |

[`run-script-prelude.ts`](../../packages/agent/src/tools/run-script-prelude.ts) supplies expected
web helpers. Asynchronous fetch promises already permit parallel work and local filtering.
Fetch is host HTTP without the browser's authenticated cookie/certificate session; it is not a
replacement for page-authenticated requests.

The current synchronous Wasm execution is on the agent event loop. Deadline interrupts limit CPU
loops, but normal abort events cannot be processed promptly during a blocking loop. A worker
boundary improves termination. General codemode also needs human waits separated from execution
and API timeouts.

### pi already provides codemode

Installed pi 1.1.0 exports `createCodemodeExtension({ mode: "only", models: false })`. It is not
enabled in the current SpainAssist host. Its implementation provides worker-based QuickJS,
declaration generation, nested tool dispatch through `ctx.executeTool`, discovery, output helpers,
and session-backed JSON storage. Nested dispatch preserves argument validation and tool hooks.

Useful installed source locations, relative to `@earendil-works/pi-coding-agent`:

- `dist/extensions/codemode/index.d.ts`, `tool.js`, `execute.js`, and `worker.js`.
- `dist/core/nested-tool-calls.js` and `agent-session.js`.
- Declaration generation is in `@earendil-works/pi-codemode`.

Important adaptation work:

- The inspected extension uses a fresh worker and `quickjs-wasi`, whereas current SpainAssist
  uses `quickjs-emscripten`. This is more than turning on the existing sandbox.
- Its supplied source form is an async function body with imports disabled. Supporting `.js`
  modules requires module-loader integration even though QuickJS supports ESM.
- The extension's inspected heap cap is 256 MiB; its whole-program deadline is unlimited by
  default. SpainAssist needs its own resource policy.
- It returns `structuredContent` when a tool declares `outputSchema`; otherwise it joins text
  blocks. Existing screenshots and document images would be lost from the script value.
- Error results with structured content and those without can take different paths. Define one
  coherent public error convention instead of inheriting this accidentally.
- Oversized output and images can be written to temporary files and represented by paths. Our
  agent has no file-reading tool and deliberately suppresses local paths; use application artifacts.
- Its inline catalog budget and search/describe system are unnecessary initial complexity given
  the user's preference for the full compact active API.
- JSON store writes persist after successful execution. They are not continuations and do not
  restore a suspended form's call stack.

Reusing pi remains a promising starting point, but its compatibility with the final React and
durability model is an open decision.

### Scheduling, stopping, and steering

Current direct batches containing a sequential tool run sequentially. Browser tools, prompts,
card/vault writes, and several other stateful tools are marked sequential. Pi's nested scheduler
instead queues sequential nested calls against each other while permitting ordinary research
calls to proceed.

One shared sequential queue would let a waiting form block a card update. The browser service
also has a per-procedure queue and shared active-page state, so parallel tabs are not currently
independent resources.

Candidate scheduling policy:

- Bounded parallel HTTP/research and safe independent reads.
- Ordered mutations per stable page handle; explicit policy for shared context state.
- One visible interactive flow per procedure.
- Independent card updates and separately serialized vault writes.
- Defined behavior for detached/unawaited work when execution completes or stops.

Pi checks cancellation before nested tool dispatch, so calls not yet dispatched are stopped.
Bridge socket closure produces an abort signal, and prompts use it. Browser handlers generally
do not pass that signal into queued browser service operations. Killing generated execution
therefore does not necessarily stop an already queued click. Add cancellation/run-generation
checks before queued mutations start; already issued external effects cannot be undone.

Long code calls also delay model steering until tool execution yields or finishes. Cancellation
and cooperative interruption between API operations need a contract.

## 5. Public API and documentation design

Proposal: one explicit public-operation registry drives dispatch, validation, `.d.ts`, minimal
comments, availability filtering, scheduling, and activity events. Existing bridge methods can
implement those operations, but the internal bridge is not itself the public API.

Never expose the complete `BridgeParams`/`BridgeResults` map: methods such as `agent.credential`,
`agent.refreshCredential`, and `agent.exaKey` serve the trusted host and return provider secrets.
The broad internal `procedureMayCall` permission is not permission for model-written code.

Possible public groupings are browser, UI, vault, documents, research, procedure, and feedback.
Names and signatures remain proposals. There is no separate recipes grouping.

Documentation comments should capture semantics that types cannot express, for example that
procedure arrays replace prior contents. Avoid repeating argument names or copying long current
tool descriptions into JSDoc. Runtime schema validation and capability enforcement remain useful
even though `.d.ts` is documentation and generated modules are JavaScript.

Proposed data/output behavior:

- Return typed objects, arrays, primitives, or text according to the operation.
- Keep UI activity metadata separate from data given to code.
- Expose only program return values and explicit emissions to model context.
- Keep intermediate results in execution unless deliberately emitted.
- Represent images/documents with typed artifacts and explicit image emission, avoiding base64
  floods and filesystem paths.
- Send progress to the app independently of model-visible output.
- Preserve partial output and useful operation context on failure.
- Define temporary and durable state scopes; do not persist live browser objects as JSON.

Error fields worth considering include stable code, operation, recoverability, and effect status
(`not_started`, `applied`, or `unknown`). Denial, cancellation, missing locators, transient network
failure, and uncertain submission must not collapse into the same generic retry instruction.
Policy enforcement cannot depend on generated code honoring a comment or checking a boolean.

## 6. Actual Playwright, proxies, and evaluate

### Preserve the real API where practical

The backend already uses actual Playwright. A facade means a process/engine bridge and scoped
capabilities, not reimplementing Playwright's waiting or creating a new automation language.

QuickJS and browser renderers cannot directly receive a Node `Page` object. Options considered:

1. Actual Playwright in main, with broad compatible proxies in codemode. Keep method names,
   locator composition, strictness, waiting, and errors; mediate sensitive operations.
2. Actual Playwright client in an OS-isolated process, connected to a procedure-scoped service.
   This offers more compatibility but adds infrastructure.
3. A separate browser per procedure, with an isolated real client. This simplifies ownership at
   additional resource cost, while files and credentials still need host integration.
4. Generated Playwright code executing directly in main. This would run arbitrary code with
   main's privileges and is not a suitable boundary.

A raw Page exposes paths such as `page.context().browser().contexts()`, which can reach other
procedures in the shared browser. Cookies/storage state, network headers and bodies, raw
screenshots/input values, filesystem paths, traces, and CDP also cross current app boundaries.
See [BrowserContext](https://playwright.dev/docs/api/class-browsercontext) and
[APIRequestContext](https://playwright.dev/docs/api/class-apirequestcontext).

Snapshot refs remain useful for exploration but are unsuitable stored recipe selectors. Prefer
semantic locators (`getByRole`, `getByLabel`, `getByText`), scoped locators, frames, and stable page
handles. Locator descriptions can cross RPC while real objects remain in main.

Separate action results from observations. Current actions usually settle and build snapshots;
batching saves inference turns but retains that repeated work. Explicit snapshots plus compact
action results can reduce it. Downloads, dialogs, signatures, and page errors still need events.

### Include evaluate in the candidate design

The initial recommendation to defer unrestricted evaluation was revised after the user's
follow-up. Include it in the design and explicitly resolve the confidentiality contract.

Legitimate uses include large structured extraction, related attributes and geometry, application
or widget state, legacy page APIs, authenticated same-origin reads, and diagnostics. For example:

```js
const offices = await page.locator('select[name=oficina]').evaluate(select =>
  Array.from(select.options, option => ({
    value: option.value,
    label: option.text,
  }))
);
```

This is ordinary page evaluation, not host execution. Code and explicit arguments enter the page;
automation closures do not. [Playwright evaluation](https://playwright.dev/docs/evaluating).

The specific risk is that a password typed by main is still present in the DOM even when our
snapshots mask it. An evaluator can read `input.value`, transform it, or use it before returning.
Literal output scrubbing cannot guarantee confidentiality. An isolated JavaScript world shares
the DOM and therefore does not hide field values.

Distinguish its powers accurately:

- Page evaluation cannot directly read the host vault, provider keys, private keys, filesystem,
  or HttpOnly cookies.
- It can read DOM passwords, non-HttpOnly cookies, local storage, and page globals, and can make
  page actions and credentialed same-origin requests.
- Existing clicks can already submit forms, and navigation already permits outgoing requests;
  these risks are not all newly introduced by evaluation.
- AutoFirma calls still reach host signing logic, which derives frame origin and requests native
  approval. Initiating that call does not inherently bypass consent.
- Raw Playwright cookie/storage/network access is broader than page evaluation alone.

Two honest contracts remain open:

- Permit powerful page code scoped to owned pages/frames, with limits and preserved host approval.
  Generated code then has access to page-visible data; redaction is defense in depth.
- Preserve an absolute guarantee that generated code cannot obtain a typed credential. Arbitrary
  evaluation and other reads cannot coexist with that credential being accessible in the same
  page. Host-owned protected authentication or restricted evaluation states would be necessary.

There is no general AST classifier for read-only evaluation and no result scrubber that makes
arbitrary evaluation satisfy the strict contract. Including evaluation is the current planning
direction; changing the documented secret guarantee has not been approved as implementation.

## 7. Execution runtime alternatives

Chrome and Electron already use V8. Choose the engine separately from the privilege surface and
process/failure boundary. A JS realm, worker thread, renderer process, and government page are
different boundaries.

| Candidate | Advantages | Costs and limitations |
| --- | --- | --- |
| QuickJS/Wasm in a worker | Existing foundation; explicit capabilities; engine memory/stack/CPU controls; portable; headless tests; no native compilation | Interpreter performance; supplied web APIs; RPC copying; custom React renderer or UI transport |
| Native V8 isolate in a subprocess | Native execution, inspector, isolated globals | Native Electron/architecture builds; maintenance; approximate heap limits; isolate alone is not OS isolation |
| Dedicated sandboxed Electron renderer, optionally with a worker | Shipped V8, ESM and browser APIs; ordinary React; Chromium process sandbox | More runtime footprint; broad browser capabilities; no standard per-job worker heap cap; hidden-page throttling |
| Entire runtime in the target website | Direct DOM/application access | Website lifecycle and interference; navigation destroys execution; poor place for persistent orchestration |

Sources: [QuickJS](https://bellard.org/quickjs/),
[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten),
[isolated-vm](https://github.com/laverdet/isolated-vm), and
[Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox).

QuickJS supports ESM; current wrappers still need a module loader and an import policy. Decide
which bundled imports are available and how feedback-provided source is loaded and pinned.
`.d.ts` remains documentation regardless of engine.

Native `isolated-vm` was considered less attractive: it is in maintenance mode, adds native
packaging work, and solves neither React compatibility nor durable continuation. Node's `vm`
explicitly is not a security boundary. See [Node vm](https://nodejs.org/api/vm.html) and
[Electron native module requirements](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules).

Actual Chromium execution is a credible candidate. Use a dedicated sandboxed Electron renderer,
separate from the trusted application UI and government pages, with Node disabled, its own
origin/session, controlled network access, and a narrow host bridge. Electron already ships this
engine; an equivalent runner page in bundled Chrome for Testing is possible but needs more
transport/lifecycle plumbing.

A worker can be terminated during a runaway loop, but is not a guaranteed separate OS process.
Putting generated work in a dedicated renderer isolates its failure from the trusted UI. An
isolated world separates globals, not the DOM or process. Hidden renderers throttle background
timers by default; configure deliberately or avoid depending on UI clocks. See
[worker termination](https://html.spec.whatwg.org/multipage/workers.html#terminate-a-worker) and
[Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

Both QuickJS and Chromium can call the same host-owned Playwright implementation. CPU performance
differences need measurement; much of this workload waits for websites or users.

No engine automatically serializes pending promises, closures, host requests, browser handles,
event queues, or React state across shutdown. V8 startup snapshots and diagnostic heap snapshots
are not suspended workflow persistence.

Current shortlist: worker + QuickJS if native component rendering and explicit resource control
dominate; dedicated sandboxed Electron renderer/worker if ordinary React compatibility dominates.
No engine choice was finalized.

## 8. Interactive UI and lifecycle alternatives

### Current forms

`ask_user` already awaits `prompt.form`, which resolves when the user answers. Current native
forms include text/number/date/contact fields, select/multiselect/boolean, documents, province,
map choices, and appointments, with up to 20 fields. Agent-facing forms exclude secret fields.
`visibleWhen` references select values; references/cycles are validated and hidden values omitted.

The renderer owns local validation, vault defaults, scanning, maps, and appointment controls.
Main validates, resolves map addresses, saves appropriate answers, and redacts results. These are
valuable product semantics, not just visual components.

Sources: [`user.ts`](../../packages/agent/src/tools/user.ts),
[`chat.ts`](../../packages/shared/src/chat.ts),
[`FormPromptCard.tsx`](../../apps/desktop/src/renderer/src/features/chat/prompts/FormPromptCard.tsx),
[`formLogic.ts`](../../apps/desktop/src/renderer/src/features/chat/prompts/formLogic.ts), and
[`bridge handlers`](../../apps/desktop/src/main/bridge/handlers.ts).

Three capabilities must be distinguished:

| Interaction | Required mechanism |
| --- | --- |
| Ask → calculate/fetch/browse → ask again | Async execution and existing prompts; no intermediate inference necessary |
| Change an answer → update visibility, validation, or computed text | Reactive view state and rendering |
| Change an answer → load browser-derived options into the same view | Persistent UI event bridge, async handlers, loading/errors, cancellation and stale-result suppression |

Sequential `askUser()` calls solve only the first. Browser-backed reactive forms also need state
revisions, resource coordination, and explicit completion/cancellation semantics.

### Authoring and rendering are separate decisions

Initial proposal: one async workflow plus declarative React components that it awaits. For example:

```jsx
export async function run() {
  const page = await api.browser.currentPage();
  const choice = await api.ui.present(({ complete }) => (
    <OfficePicker
      loadOffices={province => findOffices(page, province)}
      onSubmit={complete}
    />
  ));
  return continueProcedure(page, choice);
}
```

This remains a valid alternative, but its suspended continuation needs replay or checkpoints
after restart. Persisting the displayed form does not restore `run()`.

UI implementation alternatives:

| Approach | Benefit | Cost |
| --- | --- | --- |
| Extended declarative schema with sandbox callbacks | Reuses current native controls and validation | Can become a bespoke reactive language |
| React with custom host renderer | Familiar hooks/composition; validated native component descriptors | Reconciliation, event transport, and deliberate runtime support |
| Generated React in isolated web renderer | Broad React/browser compatibility | Native integration, accessibility, transcript summaries, persistence, and larger capability surface |

JSX does not itself require DOM rendering or imply full React support. A custom host renderer
would keep component code and callbacks in isolation; trusted UI receives validated descriptors
and returns event IDs/data. Functions do not cross the bridge as executable host callbacks.
Generated components must not execute in the trusted application renderer.

Candidate native components include Form, Field, Select, Province, Document, MapOptions,
Appointment, progress, explanatory text, and errors. Credentials, signatures, and action approvals
remain host-owned primitives. Preserve map-result restrictions and document handles.

Browser workflow actions should be explicit tasks or event handlers, not accidental consequences
of mounting. Effects run on remount/dependency changes; ordinary client components with hooks are
synchronous. See [React effects](https://react.dev/reference/react/useEffect) and
[async component limitation](https://react.dev/errors/483).

## 9. Resumability and the React-first alternative

### What currently survives

[`PromptManager`](../../apps/desktop/src/main/chat/prompts.ts) keeps an in-memory promise and a
durable prompt record. Agents with pending prompts are exempt from idle termination. On shutdown,
restartable requests are detached. On startup, pending records are reconstructed with a callback.
When answered, [`services.ts`](../../apps/desktop/src/main/app/services.ts) sends a **new model
message**; it restores no JavaScript continuation.

[`promptSurvivesRestart`](../../apps/desktop/src/main/conversation/service.ts) preserves forms and
phone calls. Confirmations/manual actions are cancelled because their live browser context is
gone. Preserve that distinction unless a new recovery contract explicitly replaces it.

Partially typed form values currently live in `FormPromptCard`'s ordinary `useState`; the saved
prompt survives, but unsent draft edits do not. Values independently saved to the vault, such as
scanned identity data, may still survive.

### State reconstruction instead of stack preservation

The user's durability requirement strengthens React as a root lifecycle: load the same module,
restore state, mount the view, recreate callbacks, and continue on the next event. Ordinary React
does not persist this automatically. Its state identity depends on render-tree positions, and it
has no general public serialization API for fibers, hooks, or pending async handlers.
See [React state identity](https://react.dev/learn/preserving-and-resetting-state) and
[external store integration](https://react.dev/reference/react/useSyncExternalStore).

Distinguish:

- **Durable domain state:** answers, current step, selected office/slot, useful validation state.
- **Disposable UI state:** hover, open dropdown, animations, transient loading indicators.
- **Operation state:** accepted/dispatched/completed/failed/interrupted/unknown external actions.

A named durable hook/store makes the contract explicit; ordinary `useState` can remain for
disposable details. A hypothetical JavaScript module with JSX:

```jsx
export default function Procedure() {
  const [form, setForm] = useDurableState('appointment', {
    province: '',
    office: '',
    step: 'choose',
  });

  const offices = useQuery(
    ['offices', form.province],
    () => loadOffices(form.province),
    { enabled: Boolean(form.province) }
  );

  const findSlots = useDurableAction('find-slots', async choice => {
    const page = await api.browser.currentPage();
    return loadSlots(page, choice);
  });

  if (findSlots.result) return <SlotPicker slots={findSlots.result} />;

  return (
    <AppointmentForm
      value={form}
      onChange={setForm}
      offices={offices.data}
      onSubmit={findSlots.run}
      pending={findSlots.pending}
    />
  );
}
```

These hook names and semantics are proposals. Neither `useDurableState` nor `useDurableAction`
exists. `useQuery` here is conceptual, not a choice of library. A durable action must record its
accepted payload and execution state; merely renaming an async function does not make it durable.

[React useActionState](https://react.dev/reference/react/useActionState) provides a familiar
precedent: asynchronous previous-state/payload → next-state actions, pending status, and queued
dispatch. It does not supply crash persistence. We could borrow its shape for a durable facility.

A durable record should contain:

1. Immutable module source/hash, module inputs, and API version.
2. Serializable domain/form state and accepted UI event revisions.
3. Named action inputs and operation status/results.
4. Artifact references and semantic capability descriptors.
5. Recovery policy and relevant evidence/postconditions.

Do not attempt to persist live Playwright objects, DOM nodes, promises, closures, or credentials.
Callbacks are reconstructed from source and restored state. Pending UI drafts should be persisted
through main with clear event acknowledgement/flush semantics.

### Recovery of external work

| Recorded state | Candidate recovery |
| --- | --- |
| Not started | Execute |
| Completed | Reuse recorded result where still valid |
| Interrupted, safely repeatable read | Refresh/retry |
| External outcome unknown | Inspect postconditions or receipts before another attempt |

A browser storage export is not a live page, DOM, or server transaction. Reacquire handles,
reconnect/reopen, and revalidate. Replaying a recorded fill result does not refill a newly opened
page. An expired session may require login again; a previously available slot may have expired.
The same revalidation issue exists after a long uninterrupted user wait.

Exactly-once website effects generally cannot be guaranteed without idempotency or a reliable
outcome query. Record uncertainty rather than automatically resubmitting.

Alternative durable execution uses an operation journal and deterministic replay of an async
`run()`. This requires pinned source, stable call identities, recorded results and nondeterminism,
and completion ordering where races affect decisions. Stable IDs alone do not solve
`Promise.race`. [Temporal replay](https://docs.temporal.io/workflows) is a useful reference;
[XState persistence](https://stately.ai/docs/persistence) illustrates explicit persisted actor
state and restoration separately from live runtime behavior.

| Overall model | Main advantage | Main cost |
| --- | --- | --- |
| Async run awaiting declarative UI | Linear workflow source | Reconstructing arbitrary continuation through replay/checkpoints |
| React Procedure/Workflow with durable state and actions | Natural UI restoration and explicit transitions | Additional durable primitives and action recovery semantics |
| Explicit state-machine definition plus React view | Clear persistence and transition model | More authoring ceremony and a less familiar workflow abstraction |

Current recommendation, not a user decision: lean toward React Procedure/Workflow roots for
persistent procedures and ordinary async functions for browser/research units. Headless phases
can render status or `null`; the root need not be named Interface. Do not force consequential
actions into mount effects. Runtime and universal entrypoint remain open.

## 10. Recipes are feedback content

Current feedback is moderated prose. `FeedbackSubmission.body` is limited to 4,000 characters;
metadata includes procedure, administration, region, kind, tags, URLs, version, and author.
Device and server scrub content; only approved entries are searchable/votable. Votes govern
serving probability and decay, not code validity.

Sources: [`shared/services.ts`](../../packages/shared/src/services.ts),
[`desktop feedback`](../../apps/desktop/src/main/remote/feedback.ts),
[`server scrubbing`](../../services/feedback-server/src/feedback/scrub.ts), and
[`feedback server README`](../../services/feedback-server/README.md).

Extend feedback entries to carry reusable `.js` source and relevant typed metadata. Search,
submission, retrieval, moderation, and execution-outcome reporting stay under feedback. A source
attachment or dedicated field is a proposal; no schema or endpoint has been selected. A proposed
integration uses the normal codemode module runtime to load/execute source. Earlier suggestions
for `api.recipes` and an independent recipe catalog were explicitly rejected by the user.

Useful metadata considered:

- Immutable revision/content hash and API compatibility.
- Task and official origin/path applicability, locale where relevant.
- Input/output schemas and required capabilities.
- Preconditions, effect class, postconditions, and success evidence.
- Validation fixture and last successful execution.
- Author/moderation, failures, superseded revision, expiry/site-change status.

Prefer small reusable units: list offices, discover slots, fill one step, or obtain a document.
Keep runtime personal values in parameters, not captured literals. A recipe is code, not a cached
transcript containing snapshot refs or account-specific state. Successful exploration should
produce semantic locators and explicit evidence, with failure/repair when a site changes.

Do not silently apply prose PII replacement to executable source: replacement can corrupt
semantics while leaving valid syntax. Reject/regenerate candidates requiring sensitive-literal
redaction; scrub descriptive metadata separately. Moderation, API compatibility, and execution
validation are different checks. Local resume state and user data do not belong in shared feedback.

For known commits, consider binding host approval to target and payload. Generic clicks cannot be
perfectly classified by recipe metadata. A declined approval must not become an unchecked boolean
or a caught error followed by the same action. This is a design issue, not an implemented guarantee.

## 11. Observability and evaluation

One outer codemode call must not hide all underlying work. Preserve child operation spans with
parent IDs, timing, outcomes, resource identity, artifact metadata, and relevant provenance.
Keep implementation/code detail out of ordinary product messages while showing meaningful work.

Pi supplies nested events, but our [`RPC normalizer`](../../packages/agent/src/rpc/events.ts)
currently drops parent relationships, and the [`chat mapper`](../../apps/desktop/src/main/chat/mapper.ts)
would flatten activities. Screenshot UI depends on `details.imageId`. Existing context redaction
recognizes top-level `details.page`; explicit script emissions need a deliberate replacement or
typed provenance. The current redaction model set is empty, so historical pages remain in context.

Preserve [`HostHooks`](../../packages/agent/src/host/hooks.ts), operation wrappers, and offline
egress hooks. [`Eval observers`](../../tools/eval/src/run/app/observers.ts), loop tool budgets,
and fixture rules currently observe top-level tool events/session results and match existing tool
names. They need child operation telemetry without inflating the meaning of a model turn.

Crucially distinguish **script exposure** from **model exposure**. Injection rules currently infer
exposure from successful tool-result text. If codemode reads an attacker-controlled page and
filters it before output, child API telemetry must not be counted as text the model saw. Otherwise
the benchmark misrepresents both preconditions and context-filtering benefits. See
[`fixture rules`](../../tools/eval/src/fixtures/rules.ts) and the prompt-injection memo.

Evaluate old and proposed harnesses on identical offline scenarios using `apps/mock-sede`,
`tools/mock-llm`, headless app hooks, and fixture services. Tests must not contact real government
sites or paid APIs.

Useful measures: task success, inference turns, prompt/output tokens including declaration cost,
wall time, API calls, code errors, recovery success, interaction latency, and recipe replay success.
Do not assume public token or speed claims transfer here.

Meaningful scenarios include:

- Parallel independent reads and locally filtered large results.
- Ordered page mutations, independent card updates, and pending forms.
- Structured errors, image/document emission, and partial failures.
- Sequential forms without intermediate inference.
- Reactive local validation and browser-backed dependent choices.
- Stale async responses, user cancellation, and queued mutation cancellation.
- Quit/restart with form drafts, pending reads, and expired sessions.
- Unknown submission outcomes and renewed approvals.
- Feedback recipe reuse, incompatible APIs, changed sites, and repair reporting.
- Preservation of existing SSRF, redirects, memory, timeout, and injection regressions.

## 12. Proposed next planning experiment and open decisions

The discussion's initial implementation order was public contracts → codemode adapter → browser
facade → declarative UI → recipes/durability. The user correction supersedes deferring durability:
resumable state must shape the lifecycle from the outset. `.js` modules and feedback ownership
also supersede earlier TypeScript/standalone recipe API sketches.

Next planning experiment: describe the same mock appointment flow twice—linear async with replay,
and React with durable state/actions. Compare source, saved state, event boundaries, restart,
browser reconstruction, and uncertain-action recovery. It should extract offices, render a
reactive picker, fetch dependent slots, recover from an expired slot, and reuse extraction source
through feedback. This experiment itself has not yet been implemented.

Open decisions:

1. Persistent module entrypoint: async run/replay, React root, or explicit machine plus React.
2. QuickJS worker versus dedicated Electron renderer/worker, informed by UI compatibility,
   resource behavior, packaging, and headless testing.
3. Breadth of Playwright compatibility and where context, files, network, and CDP are mediated.
4. Exact evaluation/credential-confidentiality contract.
5. Durable state identity, module versioning/migration, event acknowledgement, and interrupted
   operation semantics.
6. Supported imports/JSX, module loading, and feedback source pinning.
7. Exact public method names, result/error/artifact contracts, and output emission behavior.
8. Feedback source representation, compatibility metadata, moderation, and validation workflow.

The accepted direction is a programmable JavaScript harness with compact documentation,
Playwright-oriented browser access, richer interaction, state resumption, and feedback-hosted
reusable source. The remaining proposals should be evaluated without treating illustrative APIs
or security/lifecycle tradeoffs as already agreed implementation decisions.
