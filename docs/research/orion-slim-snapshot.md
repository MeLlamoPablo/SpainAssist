# Orion slim snapshot pilot

The experiment changes what an explicit `page.snapshot()` returns inside SpainBench.
In the treatment arm, Playwright includes CSS-pixel bounding boxes in the accessibility
tree. Pages of 16 lines or fewer pass through. For longer snapshots the harness sends
a secret-masked viewport JPEG of the local fixture to the
[Orion Gaze API](https://app.paradigmmachines.ai/docs/api). Each visible ref is ranked by
the predicted attention in the grid cell containing its box centre. The tool returns the
12 highest-ranked lines plus headings, alerts, dialogs and common form controls, in page
order with their original refs. If no ref centre maps into the viewport it returns the
ordinary snapshot. Semantic locators and page queries are available in both arms.

A static first-look gaze map is a proxy for relevance. Below-fold links, surrounding
instructions and text inside a selected container can drop out. The model can compensate
by reading the page through other tools. A smaller tool return therefore need not reduce
model input across the whole task.

## Design

SpainAssistant base `3707ba92`, SpainBench `e26dcc8`. Rank all 17 fixtures by mean
occurrences of `.snapshot(` in generated codemode tool-call source across the five
historical `codemode-<fixture>-<n>` GPT-6.1-sol runs. This estimates exposure to the
tool, including calls in code that may never execute. The five highest means were DNI
without saved data (25.4), ILP signing (25.0), expiring DNI (22.4), vehicle transfer
without saved data (21.4), and vehicle transfer without ITP (20.4).

Run each fixture once per arm with the same world, seed, prompts, fixture limits and
model for all roles. Use a fresh model response for every request. Baseline uses the
existing browser. Treatment substitutes the slim result for the same tool, avoiding a
prompt or tool-selection difference. Both use locally served SpainBench pages.
From the repo root, with `SPAINBENCH_DIR` set:

```sh
corepack pnpm eval run "$fixture" --provider codex --codex-consent --model gpt-6.1-sol \
  --cache off --run-id "orion-base-$fixture"
SA_EVAL_ORION_KEY_FILE=/path/to/key corepack pnpm eval run "$fixture" \
  --provider codex --codex-consent --model gpt-6.1-sol --cache off \
  --run-id "orion-slim-$fixture"
```

Individual run folders are under the eval data directory in `runs/`. Each contains the
scored rules, events and request meter. The treatment CLI also writes input/output
character counts and elapsed milliseconds for each ranked snapshot to stderr.

## Results

Each cell lists baseline then slim. Agent input counts every forwarded agent prompt,
including cached tokens, and excludes the simulated user.

| Fixture | Score | Agent input (k tokens) | Wall time (s) | Ranked snapshots |
| --- | ---: | ---: | ---: | ---: |
| DNI without saved data | 70% → 90% | 594 → 555 | 276 → 392 | 11 |
| ILP signing | 95% → 85% | 715 → 638 | 202 → 315 | 13 |
| Expiring DNI | 95% → 90% | 584 → 429 | 204 → 276 | 9 |
| Transfer without saved data | 0% → 21.7% | 2,161 → 2,499 | 420 → 645 | 19 |
| Transfer without ITP | 0% → 0% | 1,041 → 1,166 | 242 → 421 | 12 |

The mean score rose from 52.0% to 57.3%. Three baseline runs and all five slim runs
passed all required rules. The slim transfer without saved data attached the contract
and ITP, obtained approval, submitted, and saved the receipt. The slim transfer without
ITP explained the tax, but eight wrong turns erased its 25% pre-penalty score.
The DNI run without saved data avoided asking twice. On ILP and expiring DNI the
two arms passed identical rules and extra wrong turns accounted for the score differences.

Across 64 ranked snapshots the text fell from 649,143 to 91,188 characters (86.0%).
Producing them took 455 s in total (median 4.6 s). The five runs took 2,049 s summed,
up from 1,344 s (+52%). Agent input rose from 5.09M to 5.29M tokens (+3.8%).
Agent inference at the meter's API-equivalent prices rose from $1.55 to $1.67,
excluding Orion and the simulated user. Wrong turns rose from 15 to 24.

Two scores improved, two declined and one tied. One independent sample per arm per
fixture supports a pilot observation only. In particular this comparison cannot
attribute gains specifically to the gaze map versus the shorter snapshot or sampling
variation. Keep this as an opt-in eval experiment.
