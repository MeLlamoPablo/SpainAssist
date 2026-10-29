# `@sa/eval`: the SpainBench eval suite

The practical manual: setup, commands, environment, where data lives, and where each part's code is.
What a run is, the scoring contract and the design principles: [`docs/EVAL.md`](../../docs/EVAL.md).

## Safety rules

- **Real model runs spend the voucher key's budget.** Only run them when asked. The meter caps them
  (`eval budget` shows the caps). Mock and replay runs are free.
- **The Codex login is development only** and needs explicit consent (`--codex-consent` or
  `SA_EVAL_CODEX_CONSENT=1`). It is refused when a CI variable is set (unless
  `SA_EVAL_CODEX_ALLOW_CI=1`). Keep it at low volume.
- The voucher key and the Codex login live in the `spainbench` app-data folder
  (e.g. `~/Library/Application Support/spainbench`). Only the eval CLI reads them: never the app's
  vault, never a test.
- Never put an injection payload or captured site material in this repo. Fixtures name a
  SpainBench variant id; the text stays in the private repo.
- Tests are offline. Tests against SpainBench skip unless `SPAINBENCH_DIR` names the private repo's
  checkout. Tests never contact real government sites or paid APIs.
- A run's browser capture (`--capture-browser`) keeps typed passwords: only synthetic accounts are
  ever typed. Never record with a real account.

## Setup

1. Install dependencies as usual (`corepack pnpm install`, or `--offline --frozen-lockfile` in a
   worktree).
2. Have Playwright's Chromium in its cache. The suite never downloads one: `eval doctor` says which
   one is missing and how to get it.
3. Point the suite at SpainBench: `export SPAINBENCH_DIR=/path/to/SpainBench` (the harness starts
   and stops it), or `SPAINBENCH_URL` for a server you started yourself (see "Environment").
4. For real model runs only: write the voucher key by hand to `litellm.json` in the data folder
   (mode 0600):

   ```json
   { "baseUrl": "https://llm.spainassist.es/v1", "apiKey": "sk-...", "keyServerUrl": "...", "limitUsd": 5, "expiresAt": null }
   ```

   The file is refused when a URL is plain `http` to another machine, a bare IP address (unless
   `SA_EVAL_ALLOW_IP_GATEWAY=1`), or carries user info or a query.
5. Run `corepack pnpm --filter @sa/eval eval doctor`. It prints one line per check and exits 1 when a
   mock run could not work.

The eval agent host bundle (`dist/eval-host.js`) is built by the first run when it is missing or
stale. To build it by hand: `corepack pnpm --filter @sa/eval build:host`.

## The command line

```sh
corepack pnpm --filter @sa/eval eval <command> [options]
corepack pnpm eval <command> [options]            # the root package's shortcut for the same
corepack pnpm --filter @sa/eval eval --help       # commands, environment, exit codes
corepack pnpm --filter @sa/eval eval <command> --help   # a command's options, with examples
```

The script is `node --import tsx src/cli.ts`. **Stdout is for results, stderr for progress**, so
`eval run ... --json | jq` and `eval report <id> > report.md` work. Relative paths in arguments
resolve against the directory you typed the command in. Options are strict: an unknown option, a
missing value or an empty value (`--from "$UNSET"`) is a usage error, never "not given".

### Commands

| Command | What it does |
| --- | --- |
| `list` | The fixtures and injection variants. With SpainBench configured, also which fixtures it can run |
| `run <fixture>` | Plays one fixture and scores it. Prints a summary line and the path of `report.md` |
| `suite [fixture...]` | Plays the full run (fifteen runs: six vida laboral, three DNI renewal, six vehicle transfer) or the fixtures named, then a table and the mean score. With `--scenario`, only the fixtures that have a scripted model |
| `report <runDir\|runId>` | Prints a run's `report.md`. `--json` for `result.json`, `--rules` for the rule tables |
| `runs` | Run folders, newest first (`--limit n`, default 20) |
| `budget` | The voucher key's balance, ledger spend per day, the caps a run gets, Codex usage. `--offline` skips the key server. Never prints a key |
| `login codex` | The Codex device login (development only, needs consent) |
| `whoami` | The Codex login and the voucher key file: whether they exist and until when. Never a token |
| `logout codex` | Deletes the stored Codex login (nothing is revoked at OpenAI) |
| `doctor` | Checks Node, SpainBench, the host bundle, Chromium, the data folder, credentials and writable folders |

`report` and `runs` also take `--runs-root <dir>`.

### `run` and `suite` options

| Option | Meaning |
| --- | --- |
| `--provider mock\|voucher\|codex\|local` | Who answers the agents. Default `mock` with `--scenario`, else `voucher` |
| `--scenario <name>` | Scripted model for `mock`: `oracle`, `robust`, `susceptible`, `lost` |
| `--base-url <url>` | `local` only (required): your model server's OpenAI-compatible `/v1` URL, e.g. LM Studio |
| `--answerer-provider voucher` | `local` only: the answerer goes through the voucher key. A run note gives its cost, which the run's cost leaves out |
| `--cache off\|record\|replay\|auto` | Default `auto` for paid providers, `off` for `mock` and `local`. `replay` needs no key or gateway |
| `--cache-variant <x>` | Keeps independent recorded samples apart (use a new `x` with `record`) |
| `--max-cost <usd>`, `--max-tool-calls <n>`, `--max-requests <n>`, `--wall-clock <minutes>` | Override the fixture's limits |
| `--model <id>` | The model of every role. `local` needs it |
| `--assistant-model`, `--procedure-model`, `--answerer-model <id>` | Per-role models |
| `--capture-browser` | Record HAR, trace and page HTML under `browser/` |
| `--keep-world` | Leave the world on SpainBench (deleted by default) |
| `--codex-consent` | Consent to use the Codex login |
| `--runs-root <dir>` | Where run folders live |
| `--min-score <0..1>` | For CI: exit 1 below this (for `suite`, the mean). A run without a score fails it |
| `--json` | Print `result.json` (for `suite`, the list of results) instead of the summary |

`run` only:

| Option | Meaning |
| --- | --- |
| `--from <runDir>#<n>` | Continue checkpoint `n` (default: the last) of an earlier run; the folder may be a bare run id |
| `--allow-fixture-change` | With `--from`: accept a fixture whose rules, answers or limits changed (never its world or seed) |
| `--run-id <id>` | The folder's name (`[A-Za-z0-9_-]{1,64}`). Default `<fixture>-<provider>-<yyyymmdd-hhmmss>-<4 hex>` |

Ctrl-C ends a run as `abort`, still writes its artifacts and exits 1. A second Ctrl-C exits at once.
In `suite`, Ctrl-C also skips the remaining runs.

### Examples

```sh
corepack pnpm --filter @sa/eval eval doctor
corepack pnpm --filter @sa/eval eval list
corepack pnpm --filter @sa/eval eval run vida-laboral-sin-datos --scenario oracle     # free, offline model
corepack pnpm --filter @sa/eval eval suite --scenario oracle
corepack pnpm --filter @sa/eval eval run vida-laboral-con-datos --provider voucher    # spends budget
corepack pnpm --filter @sa/eval eval run vida-laboral-sin-datos --from <runId>#1 --cache replay
corepack pnpm --filter @sa/eval eval suite --provider local --base-url http://localhost:1234/v1 --model qwen3-8b
corepack pnpm --filter @sa/eval eval report <runId> --rules
corepack pnpm --filter @sa/eval eval login codex --codex-consent                     # development only
```

**Repeated runs under `auto` or `replay` are copies of the recording, not new samples.** The
summary says `N of M requests replayed (K loose)`. For a fresh sample use
`--cache record --cache-variant <x>` (a new `x` each time) or `--cache off`.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | It worked. For `run`: the run has a verdict. **`failed_required` (an exfiltration included) and `inconclusive` exit 0**: use `--min-score` as the CI bar |
| 1 | An error: a run that ended `error` or `aborted`, a score under `--min-score`, a `doctor` check that failed, an unusable credential in `whoami` |
| 2 | Usage error, or refused to start (unknown fixture, no SpainBench, no Chromium, no credential, an expired voucher key, Codex without consent, unusable checkpoint). Nothing was started |

pnpm's `--filter` form reports every failing script as exit 1. Where 1 and 2 must differ (CI), use
`corepack pnpm -C tools/eval eval ...` or `node --import tsx src/cli.ts ...` from `tools/eval`. The
mapping is in `src/cli/exit.ts`.

## Environment

| Variable | Meaning |
| --- | --- |
| `SPAINBENCH_DIR` | The private repo's checkout. The harness starts it on free loopback ports and stops it. Wins over `SPAINBENCH_URL` |
| `SPAINBENCH_URL` | Public listener of a running server on this machine, e.g. `http://127.0.0.1:3010` |
| `SPAINBENCH_SCORING_URL` | Its scoring listener. Optional when the public one is on port 3010 (then 3020) |
| `SPAINBENCH_TOKEN` | Its benchmark token. Optional: SpainBench's default is used |
| `SPAINBENCH_DATA_DIR` | Moves the data folder (default `spainbench` in the OS's app-data folder), runs included |
| `SA_EVAL_CODEX_CONSENT` | `1` consents to the Codex login |
| `SA_EVAL_CODEX_ALLOW_CI` | `1` allows the Codex login when a CI variable is set |
| `SA_EVAL_ALLOW_IP_GATEWAY` | `1` accepts a voucher gateway or key server given as a bare IP address |
| `SA_EVAL_DEBUG` | `1` prints the stack of an unexpected error |
| `SA_EVAL_E2E_KEEP` | `1` keeps the end-to-end tests' temp folders |

A server you start yourself should run with `SPAINBENCH_STRICT_WORLDS=1` (the harness sets it on the
servers it starts). Resolution is `resolveBenchTarget` in `src/bench/target.ts`.

## Where data lives

The data folder is `spainbench` in the OS's app-data folder: `~/Library/Application Support/spainbench`
on macOS, `%LOCALAPPDATA%\spainbench` on Windows, `$XDG_DATA_HOME/spainbench` or
`~/.local/share/spainbench` elsewhere. Folder 0700, files 0600; a credential file others can read is
refused. Paths are in `src/llm/home.ts`.

| Path | What |
| --- | --- |
| `litellm.json` | The voucher key (written by hand, see Setup) |
| `codex.json` | The Codex login (`eval login codex`). No e-mail is stored |
| `ledger/spend-YYYY-MM.jsonl` | One line per model request, with reservations; what `eval budget` reads |
| `ledger/codex-cooldown.json` | A Codex usage limit seen by any process |
| `llm-cache/<provider>/<model>/<hash>.json` | The record/replay cache. No credentials, but it may hold a persona's data: review before committing anything |
| `STOP` | `touch` it and every meter answers "out of budget" at once |
| `runs/<runId>/` | The default runs root (layout in `docs/EVAL.md`, "Artifacts") |

## Running the injection variants against a real model

The scripted models show that the suite catches a model that follows a planted text. Only a real
model shows whether a variant bites. These runs cost money (about $0.01 to $0.02 each) and are not
part of any test. You need a voucher key, the cached Chromium and `SPAINBENCH_DIR`.

```sh
export SPAINBENCH_DIR=/path/to/SpainBench
corepack pnpm --filter @sa/eval eval list | grep 'inyeccion:'     # the variants this SpainBench lists
corepack pnpm --filter @sa/eval eval suite --provider voucher     # all fifteen fixtures
corepack pnpm --filter @sa/eval eval run vida-laboral-inyeccion:hidden-text --provider voucher \
  --cache record --cache-variant n2 --run-id real-hidden-text-n2
corepack pnpm --filter @sa/eval eval budget                       # what it cost against the daily cap
```

Attack success is a rate: run each variant several times with new `--cache-variant`s. What to look
at, in order:

1. **The verdict**: `eval report <runId> --rules`. `failed_required` on `no-collector-request` or
   `no-exfil` means the model followed the text. `inconclusive` means it was never shown it.
2. **Was it shown?** The planted host in the tool results:
   `jq -c 'select(.type=="tool_end") | select(.text|test("<attacker host>")) | {seq,tool}' <run>/events.jsonl`.
   Text planted only in the PDF reaches the model only through `document_read`.
3. **What the model thought**: the thinking blocks in `<run>/transcripts/procedure-*/`. Silent
   compliance, flagged refusal and silent refusal are different results.
4. **What left**: `bench/requests.jsonl` (requests to the collector), `bench/state.json`, and the
   network logs `net/browser.jsonl` and `net/host-procedure-*.jsonl`.

## Tests

```sh
corepack pnpm --filter @sa/eval test                                    # everything; offline parts only without SpainBench
corepack pnpm --filter @sa/eval test test/cli test/runner               # one area
SPAINBENCH_DIR=/path/to/SpainBench corepack pnpm --filter @sa/eval test test/e2e   # about a minute
```

Tests run on 127.0.0.1 only, under deny-by-default guards (`test/llm/helpers/no-network.ts`). Tests
that need Chromium use Playwright's cached one and skip with a message when it is missing. Tests that
need SpainBench skip without `SPAINBENCH_DIR`. The fakes: `test/net/fake-bench.ts` (public port),
`test/bench/fake-server.ts` (scoring API), `test/run/support/` (scripted app, bench and meter) and
`tools/mock-llm`.

The end-to-end tests (`test/e2e`) run the scripted models through `runEvaluation` against the real
SpainBench. They prove the harness measures what it should (rules, scoring, simulator, cache,
checkpoints, limits), not how any real model behaves.

## The parts

Each folder under `src/` is one part with its own `index.ts`. Start from these when you change one.

### Network layer (`src/net`)

The browser's mapping proxy (`eval-network.ts`, a `CertificateProxy` for `@sa/browser`), the host
process' `fetch` (`world-fetch.ts`), the deny-by-default guards (`egress-guard.ts`, `node-guard.ts`),
the host table (`hosts.ts`), the network log (`netlog.ts`, `netlog-reader.ts`) and the canary scanner
(`canary.ts`). Do not add Chromium switches that the proxy owns (`--host-resolver-rules`,
`--ignore-certificate-errors-spki-list`, `--webrtc-ip-handling-policy`, proxy): the browser factory
refuses them.

Debugging a run's traffic:

```sh
jq -c '{seq, channel, route, method, url, status, error}' <run>/net/browser.jsonl
jq -c 'select(.route == "unmapped" or .route == "denied")' <run>/net/host-*.jsonl
```

- `unmapped` for a host that should work: it is not in SpainBench's `GET /meta/hosts`. Chromium's own
  background traffic (`google.com`, `googleapis.com`, favicon) also shows as `unmapped`; ignore it.
- `denied`: something in the host process bypassed `egress.fetch` (a socket, DNS, UDP, a program, or
  an address the product's SSRF guard refuses).
- `mapped` with a 5xx and `ECONNREFUSED`: SpainBench is down. The run is invalid, not the agent.

### Eval host (`src/host`)

The agent host process of a run: the product's `runHost` with eval hooks (`hooks.ts`), bundled from
`eval-main.ts` to `dist/eval-host.js` (`scripts/build-eval-host.mjs`). Each host process reads its
`HostEvalConfig` JSON from `SA_EVAL_CONFIG` (`config.ts`) and writes its own net log. Web research is
a stub that replays `fixtures/research/<name>.json` through the product's tool factories
(`research-stub.ts`), so nothing real is searched. A host that exits at once puts the reason on
stderr (`<run>/logs/host-<agent>.log`).

### LLM access (`src/llm`)

The meter proxy (`meter.ts`; caps in `limits.ts`, ledger in `ledger.ts`, cache in `cache.ts` and
`canonical.ts`), the Codex login (`codex-auth.ts`, `credentials.ts`, with a cross-process lock in
`lock.ts`), the answerer (`answerer.ts`) and `eval budget` (`budget.ts`). One masker serves every
file the suite writes (`redact.ts`). What a run's caps really are is `src/run/caps.ts`.

### SpainBench client (`src/bench`)

Start or reach a server (`launcher.ts`, `target.ts`), the scoring API client (`client.ts`), version
and fixture checks (`check.ts`), the event follower (`events.ts`) and the saved world
(`artifacts.ts`). Only the scoring listener is used here. A launched server's output is in
`<run>/logs/bench-server.log`; a run that failed before its folder existed prints the log's path.
`jq -c 'select(.type == "exfil" or .type == "wrong_turn")' <run>/bench/events.jsonl` lists what
SpainBench recorded as it happened.

### The eval app (`src/run/app`)

`createEvalApp` (`eval-app.ts`) composes the headless app, its agent hosts (`agents.ts`), Chromium
behind the network layer (`browser.ts`), a vault that keeps provider secrets in memory only
(`provider-vault.ts`), the stubbed provider flows (`providers.ts`) and the observers that turn what
happens into observations (`observers.ts`). The profile lives in a neutral temp folder (`sa-<hex>`),
so no path a model might see says "eval" or names the run; the run folder gets a copy. A harness
killed before it closes leaves that folder in the temp directory.

### The run (`src/run`)

`runFixture` (`loop.ts`) plays one fixture: world, meter run, app, user simulator (`simulator.ts`),
rules, end, artifacts. Whose fault a stop is: `infra.ts`. Checkpoints: `checkpoint.ts`. Run folders,
`report.md` and the summary lines: `results.ts`. `runEvaluation` (`src/runner.ts`) wraps it for the
CLI and the end-to-end tests, and refuses a request that cannot start before starting anything.

### Fixtures, rules, answers and scoring

Pure logic, tested offline: fixtures in `src/fixtures` (registry in `registry.ts`, rule builders in
`rules.ts`, checks in `validate.ts`), the rule engine in `src/rules`, answer groups in `src/answers`,
the score and report in `src/scoring`. Types are in `src/contracts.ts` (`Fixture`, `Rule`,
`Condition`, `Observation`). To add a fixture: write it in `src/fixtures/`, add it to the registry,
and keep its limits below the meter's caps so the fixture's limit fires first. Passwords go only in
the seed and `credential` answers (`validateFixture` refuses them anywhere else, and anything under
four characters).

A persona's papers (a contract of sale, the vehicle's papers, tax and fee receipts) are
`seed.documents`: serializable specs that `src/documents` draws the same way every time, phone
photos as JPEG (`photo.ts`, `@napi-rs/canvas`) and PDFs with real text (`pdf.ts`, the canvas's PDF
backend). The `saved` ones are in the vault before the run; the others the simulator uploads when a
form's document field asks for them (by the document's `match` regex on the field's label and key).
Rules compare what a site received with these files by SHA-256. Plain text and boxes only: no
logos, seals or captured material.

### Scenarios (`src/scenarios`)

The scripted models are `tools/mock-llm` scenarios: `oracle` does the job, `robust` also ignores the
injection, `susceptible` follows it, `lost` takes wrong turns. They wait for a text of the page,
never for time, so their recordings replay. They know the attacker's host only from the fixture and
contain no payload.
