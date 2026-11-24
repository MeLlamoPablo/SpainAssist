# `@sa/trace-viewer`

A waterfall of what SpainAssist's agents did and when: the coordinator, each background agent,
their model calls, tool calls, codemode runs and every `api.*` call, the time each interface
waited for the user, and the browser underneath, with its screenshots. One click opens a browser
capture in Playwright's own trace viewer (DOM snapshots, network, console), served locally.

```sh
corepack pnpm traces                     # your development profile (SA_USER_DATA_DIR, else the app's)
corepack pnpm traces <path>              # a profile, an export, a capture or a single file
corepack pnpm traces <runId|runDir>      # an eval run: its profile/ and browser/ (tools/eval)
corepack pnpm traces --demo              # a demo: the mock sede in Chromium, and its agents
```

It opens `http://127.0.0.1:5190/` (loopback only). Files can also be dropped on the page.

## What it reads

The layout of the app's `userData` folder, which the transcripts export keeps
(Ajustes → Exportar historial, `apps/desktop/src/main/export/transcripts.ts`):

| Path | What it shows |
| --- | --- |
| `assistant/session-v2.jsonl` | The coordinator: one row per turn, model calls, its `agent_*` tools (each links to the agent's trace) |
| `agents/<id>/session.jsonl`, `agent.json` | A background agent: turns, model calls (tokens, cost, thinking), `codemode` calls (the module), runs |
| `procedures/<id>/capture/<run>/trace.zip` | A browser capture (`SA_BROWSER_CAPTURE=1`, development builds): its Playwright calls and screenshots |
| `<eval run>/profile/…`, `browser/<id>/<run>/trace.zip` | An eval run (`tools/eval`): the same layout under `profile/`, and the capture every run makes. Its other copies of the sessions (`transcripts/`, `checkpoints/`) are left out |
| any `*.jsonl` / `*.zip` | A pi session / a Playwright trace (e2e `test-results`, `playwright show-trace` files) |

A run's calls come from the `spainassist.run_trace` custom entry the agent host writes into the
session when the run ends (`RunEngine.onRunTrace`, `packages/agent/src/host/session.ts`): op names,
start, duration, error, what each call gave the module (cut), and the URL of
`browser.goto`/`fetchUrl`. Nothing of it reaches the model. Runs from before it existed show as their `codemode` call alone.

A capture's Playwright calls are also drawn under the `browser.*` call of the run that made them
(by time, among the agents that served the capture's procedure), and its screenshots run along the
top of the agent's timeline.

### An eval run's checks

An eval run also shows its checks: the fixture's rules, as `result.json` judged them. Each check
that held at some point goes on the call that was in flight then (the rule's `firstSeenAtSeq` in
`events.jsonl`): the innermost `api.*` call of the tool call in progress, else the call in flight
at that time, else the model call or tool call that ended just before. A green badge is a check
that passed, a red one a check that failed; a folded span shows its children's badges, dimmed.
Hover a badge for what the rule asks, the event at which it first held, how the eval judged it
and what it does to the score (a failed required check, a scored check's share of the points, a
harm). The sidebar lists all the checks; one tied to a call opens it. Checks that never held
(a required rule never met, a scored rule not earned) have no call.

What each rule asks, the weights and the harms come from the fixture as `@sa/eval` has it now
(`src/server/eval.ts`), so they can differ from the version that ran.

## Using it

- The sidebar lists traces; a selected agent lists its turns. A turn is what one message set off.
- Drag the time axis, double-click a span or press <kbd>Z</kbd> to zoom; <kbd>Esc</kbd> goes back.
- <kbd>↑</kbd><kbd>↓</kbd> move, <kbd>←</kbd><kbd>→</kbd> fold and unfold, <kbd>Enter</kbd> opens a
  span's details: timing, tokens, cost, the error, the module, the output, the page before and after.
- "Open in Playwright Trace Viewer" serves the capture's `trace.zip` to Playwright's viewer from
  `playwright-core` (`/playwright/`). A dropped file is first kept in the server's memory.

## Privacy

Sessions and captures hold personal data: what the user said, names, DNI numbers, pages of
government sites and, in captures, the sites' session cookies. The server answers on loopback only
and lists nothing outside sessions, agent and procedure records and zips (no vault, media, work
folders or logs). Don't commit or share a real profile's files.

## Code

| File | What |
| --- | --- |
| `src/lib/pi.ts` | A pi session as spans (the active branch; turns, `llm`, `tool`, `run`, `op`, `wait`) |
| `src/lib/playwright.ts` | A trace.zip: calls, their logs and errors, screencast frames, on the wall clock |
| `src/lib/load.ts` | Files → traces, and browser calls placed under the run calls that made them |
| `src/lib/zip.ts` | A zip reader for the browser and Node (`DecompressionStream`, lazy) |
| `src/server/api.ts` | The Vite plugin: the opened files, uploads, Playwright's viewer |
| `src/server/eval.ts` | An eval run's checks (`eval.json`): outcomes, their moment, the fixture's facts |
| `src/lib/checks.ts` | Checks placed on spans, and what each does to the score |
| `src/ui/` | The waterfall (virtualized rows, keyboard tree), filmstrip, details |
| `src/ui/highlight.ts` | Syntax colors for codemode modules and tools' JSON input (Shiki: the JavaScript and JSON grammars, GitHub's light and dark themes) |
| `src/demo.ts` | The `--demo` profile |

The demo launches the Chromium playwright-core expects (`corepack pnpm --filter @sa/desktop
install:chromium`), or `SA_BROWSER_EXECUTABLE`.
