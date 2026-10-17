# Scanner model eval

Replays saved scanner frames through the real scanner agent (`runScanAgent`, its prompt, tool
declarations and validation in `apps/desktop/src/main/scanner/agent.ts`) and scores the fields
each model extracts against hand-checked ground truth. A wrong value counts much more than a
missing one: the scanner saves values without a review form.

## Fixtures

`fixtures/` holds real ID document photos, the recorded scan sessions and their ground truth
(`docs.json`). They are personal data, so `.gitattributes` encrypts them with git-crypt: run
`git-crypt unlock` first. Each document has a folder with its frames (in the order the scan
saw them) and `session.jsonl`; `docs.json` lists, per document, the frames, the true values,
`missingIsFine` (fields a frame does not show, where leaving the field out is the right answer)
and `expect`, how a careful scan ends:

- `finish`: every expected field is readable, so the model should call `finish_scan`.
- `keep_asking`: a field is unreadable or a side is missing, so the model should keep asking for
  frames until the replay runs out. Finishing would save a guess or leave a gap, since the
  scanner saves without a review form.

| Document | Expect | What it tests |
| --- | --- | --- |
| `dni-blurry` | `keep_asking` | DNI in dim light: blurred front dates and back address |
| `dni-team-small` | `finish` | DNI in good light: the sideways EQUIPO code is tiny until the last frame |
| `dni-team-closeup` | `finish` | DNI back brought close: EQUIPO is readable, so refusing to record it is over-caution |
| `licence` | `keep_asking` | Licence front and back in dim light, blurred expiry |
| `licence-glare` | `keep_asking` | Licence front with glare over the issue date and authority |
| `licence-sharp` | `keep_asking` | Licence front, sharp: every front field reads, but the back is missing |

To add a document, copy its frames and `session.jsonl` from a dev profile's
`scanner/conversations/<session>/` into a new folder and add an entry to `docs.json`.

## Run

From the repo root (the script finds the repo from its own path):

```sh
node tools/scan-eval/run.mjs --runs 3
```

Every model goes through our LiteLLM gateway. The script gets a gateway key in this order:

1. `SA_GATEWAY_URL` + `SA_GATEWAY_KEY` (a LiteLLM virtual key, `sk-…`).
2. `SA_VOUCHER_CODE`: the script redeems it at the key server, as the app does.
3. Otherwise it creates a one-day voucher (`--budget`, default $5) with the key server's admin
   token (`key_server_admin_token` in `infra/terraform/terraform.tfvars`) and redeems it.

Keys, tokens and voucher codes stay in memory; the script never prints or writes them. The key
server is `https://keys.<domain>` (`SA_KEY_SERVER_URL` overrides it), with the domain from the
same tfvars (default `spainassist.es`). Each run without a key creates a new voucher.

Options:

- `--models a,b,c`: default `claude-haiku-5-5,claude-sonnet-5-5,google/gemini-3.6-flash,google/gemini-3.5-flash-lite`.
  Spec: `id[@reasoning]`. Short ids get the gateway's vendor prefix (`claude-haiku-5-5` →
  `anthropic/claude-haiku-5.5`, `gpt-6-luna` → `openai/gpt-6-luna`).
- Reasoning: without `@level`, the production rule. Flash Lite uses `minimal`; other models use
  off (an explicit `none` effort, like the app) when pi's catalog allows it, else the lowest level it supports (the console says so: the
  app would refuse such a model today, `no_fast_mode`).
- `--runs 3`, `--docs a,b` (default: every document), `--out file.json`, `--budget 5`.
- `--repo <checkout>`, `--data <fixtures dir>`.
- `--rescore a.json,b.json`: scores the fields saved in earlier result files again, with the
  current ground truth and scoring rules, and prints one combined report. It calls no model.

Scoring ignores case, extra spaces and formatting that names the same value: accents in names,
spaces, dots and dashes in codes (the licence authority `41-00` also matches `41.00` and
`41·00`), and the street type (`C.`, `C/` and `Calle`). Any other difference counts as wrong.

Costs are LiteLLM's charge for each call (the `x-litellm-response-cost` header). When a call has
none, the script estimates the cost from pi's catalog and marks it "(estimate)". Results go to
the gitignored `results/` folder: they contain personal data too.

## Offline checks

- `--dry-run`: builds every request with fetch disabled and drives the loop with the replies
  recorded in `session.jsonl`. It prints request sizes and counts only.
- `--mock`: sends the full HTTP requests to an in-process `tools/mock-llm` that replays the
  recorded replies, with a 1×1 placeholder image instead of the frames.

The replay gives the same frames again when a model asks for more (up to three rounds), so a
model that keeps asking for a field the frames do not show ends with `frames_exhausted`. With a
live camera the user would show new frames instead. Seeing a blurred frame again is part of the
test: production once saved wrong values on its fourth read of the same blur.

The report scores each scan's ending against `expect`: `ok`, `finished_early` (it finished a
`keep_asking` document), `stalled` (it ran out of frames on a `finish` document) or `error`. An
unfinished scan's fields come from its last `record_fields`. A summary table at the end adds up
every document per model, with the cost of one pass (one scan of each document).
