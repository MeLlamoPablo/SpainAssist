/**
 * What each `eval` command is, in words: the option tables behind `parseCommandArgs` and `--help`.
 * Light on purpose (no imports from the rest of the suite): `eval --help` must answer at once.
 */
import type { CommandSpec, OptionSpec } from './args';

const RUNS_ROOT_OPTION: OptionSpec = {
  name: 'runs-root',
  type: 'string',
  arg: 'dir',
  description:
    'Where run folders live (default: spainbench/runs in the OS data folder, e.g. ' +
    '~/Library/Application Support/spainbench/runs on macOS).',
};

export const LIST_SPEC: CommandSpec = {
  name: 'list',
  summary: 'The fixtures and the injection variants that exist.',
  usage: 'list',
  description:
    'Lists the fixtures (id, what a run of each must and must not do) and the prompt-injection ' +
    'variants that "vida-laboral-inyeccion:<variant>" can plant. When SpainBench is configured ' +
    '(SPAINBENCH_DIR or SPAINBENCH_URL) it is asked for the variants it knows and for which ' +
    'fixtures it can run; otherwise the list says it was not asked.',
  options: [],
  examples: [
    { command: 'corepack pnpm eval list' },
    {
      command: 'SPAINBENCH_DIR=../../../SpainBench corepack pnpm eval list',
      comment: 'also ask SpainBench which fixtures it can run',
    },
  ],
};

/** The options `run` and `suite` share: who plays the model, the limits, the models, the exit bar. */
const PROVIDER_OPTION: OptionSpec = {
  name: 'provider',
  type: 'string',
  arg: 'name',
  description:
    'Who answers the agents: mock, voucher or codex. Default: mock when --scenario is given, ' +
    'otherwise voucher.',
};
const SCENARIO_OPTION: OptionSpec = {
  name: 'scenario',
  type: 'string',
  arg: 'name',
  description:
    'The script of the mock model, a name from src/scenarios (--provider mock needs one).',
};
const CACHE_OPTION: OptionSpec = {
  name: 'cache',
  type: 'string',
  arg: 'mode',
  description:
    'Record/replay of model calls: off, record, replay or auto. Default: auto for voucher ' +
    'and codex, off for mock. A replayed answer is a recording of an earlier run, not a ' +
    'new sample: repeated runs under auto or replay are copies, the report and the summary ' +
    'say "N of M requests replayed (K loose)", and a loose one answered a conversation ' +
    'whose pages or screenshots differed. replay needs no credential. For a fresh sample ' +
    'use --cache record --cache-variant <x> (a new x each time), or --cache off.',
};
const CACHE_VARIANT_OPTION: OptionSpec = {
  name: 'cache-variant',
  type: 'string',
  arg: 'x',
  description:
    'Keep independent samples of the same conversation apart in the cache: with --cache ' +
    'record, each x is a new sample of the model that replays only under the same x.',
};
const LIMIT_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'max-cost',
    type: 'string',
    arg: 'usd',
    description:
      "Cost limit of a run in dollars (default: the fixture's; eval budget shows it). A run that " +
      "reaches it ends as limit:cost and the rules judge what it did; the meter's per-agent cap " +
      'applies as well.',
  },
  {
    name: 'max-tool-calls',
    type: 'string',
    arg: 'n',
    description: "Limit of tool calls across all agents (default: the fixture's).",
  },
  {
    name: 'max-requests',
    type: 'string',
    arg: 'n',
    description:
      "Limit of model requests of a run, all agents and the answerer (default: the fixture's; " +
      "eval budget shows it). The meter's per-agent and per-run request caps apply as well.",
  },
  {
    name: 'wall-clock',
    type: 'string',
    arg: 'minutes',
    description: "Time limit of a run in minutes (default: the fixture's).",
  },
];
const MODEL_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'assistant-model',
    type: 'string',
    arg: 'id',
    description: "Model of the orchestrator (default: the product's).",
  },
  {
    name: 'procedure-model',
    type: 'string',
    arg: 'id',
    description: "Model of the procedure agents (default: the product's).",
  },
  {
    name: 'answerer-model',
    type: 'string',
    arg: 'id',
    description: 'Model that plays the user when no scripted answer applies.',
  },
];
const RUN_FLAG_OPTIONS: readonly OptionSpec[] = [
  {
    name: 'capture-browser',
    type: 'boolean',
    description:
      'Record HAR, trace and page HTML under <run>/browser. Typed secrets stay visible there: ' +
      'synthetic accounts only.',
  },
  {
    name: 'keep-world',
    type: 'boolean',
    description: "Leave the run's world on the SpainBench server (it is deleted by default).",
  },
  {
    name: 'codex-consent',
    type: 'boolean',
    description:
      'Consent to use the Codex login (development only; SA_EVAL_CODEX_CONSENT=1 does the same).',
  },
];

const EXIT_NOTES =
  'Exit codes: 0 the run produced a result: completed, failed_required (a failed required rule, ' +
  'an exfiltration included) or inconclusive, all of them 0 unless --min-score is given; 1 error ' +
  '(the model gateway, a host or SpainBench failing is an error, never a failed run), aborted ' +
  '(Ctrl-C, or no score because the harness ran out of budget: limit:budget, replay-miss), or ' +
  'below --min-score; 2 usage error or refused to start (unknown fixture, no SpainBench, no ' +
  'Chromium, no credential, voucher under its floor, Codex without consent, an unusable ' +
  'checkpoint, an empty option value).';

export const RUN_SPEC: CommandSpec = {
  name: 'run',
  summary: 'Play one fixture against SpainBench and score it.',
  usage: 'run <fixture> [options]',
  description:
    'Starts (or connects to) SpainBench, plays the fixture with the real agents and the simulated ' +
    'user, judges the rules and writes the run folder. Progress goes to stderr; stdout gets the ' +
    'one-line summary and the path of report.md (or, with --json, the whole result.json). ' +
    'Ctrl-C ends the run as "abort" and still writes its artifacts (a second Ctrl-C exits at once). ' +
    'A failed_required run exits 0 (so does an inconclusive one): use --min-score where a run ' +
    'must pass.',
  options: [
    PROVIDER_OPTION,
    SCENARIO_OPTION,
    CACHE_OPTION,
    CACHE_VARIANT_OPTION,
    {
      name: 'from',
      type: 'string',
      arg: 'runDir#n',
      description:
        'Continue checkpoint n of an earlier run of the same fixture (without #n: its last one). ' +
        'The run folder may be a bare run id. A checkpoint of a fixture that changed since is refused.',
    },
    {
      name: 'allow-fixture-change',
      type: 'boolean',
      description:
        "With --from: continue a checkpoint although the fixture's rules, answers or limits " +
        'changed since (what was latched stays latched). A changed world or seed is always refused.',
    },
    RUNS_ROOT_OPTION,
    {
      name: 'run-id',
      type: 'string',
      arg: 'id',
      description:
        'Name of the run (1 to 64 letters, digits, - or _; also SpainBench world id). Default: ' +
        '<fixture>-<provider>-<yyyymmdd-hhmmss>-<4 hex>.',
    },
    ...LIMIT_OPTIONS,
    ...MODEL_OPTIONS,
    ...RUN_FLAG_OPTIONS,
    {
      name: 'min-score',
      type: 'string',
      arg: '0..1',
      description:
        'For CI: exit 1 unless the run scored at least this (a run without a score fails too, ' +
        'and so does one that was cut short before its negated rules could be judged).',
    },
    {
      name: 'json',
      type: 'boolean',
      description: 'Print the whole result.json on stdout instead of the summary line.',
    },
  ],
  examples: [
    {
      command: 'corepack pnpm eval run vida-laboral-sin-datos --scenario oracle',
      comment: 'free and offline: a scripted model',
    },
    {
      command: 'corepack pnpm eval run vida-laboral-con-datos --provider voucher --cache auto',
      comment: 'a real model, capped by the voucher budget',
    },
    {
      command:
        'corepack pnpm eval run vida-laboral-inyeccion:page-title --scenario susceptible --json',
    },
    {
      command: 'corepack pnpm eval run vida-laboral-sin-datos --from <runId>#1 --cache replay',
      comment: 'continue a checkpoint with recorded model calls',
    },
  ],
  notes: [
    EXIT_NOTES,
    'SpainBench is chosen by SPAINBENCH_DIR (start it here) or SPAINBENCH_URL (connect to it). ' +
      'The credentials home is SPAINBENCH_DATA_DIR (default spainbench in the OS data folder).',
  ],
};

export const SUITE_SPEC: CommandSpec = {
  name: 'suite',
  summary: 'Play the full run (every fixture, each injection variant) and print the table.',
  usage: 'suite [fixture...] [options]',
  description:
    'Plays the full run (vida-laboral-sin-datos, vida-laboral-con-datos and ' +
    'vida-laboral-inyeccion once per injection variant: :assistant-notice, :fake-verification, ' +
    ':page-title, :hidden-text), or the fixtures named, one after the other with the options of "run", then prints one summary ' +
    'line per run, a table and the mean score of the scored runs. Nothing is written beyond the ' +
    'run folders. Exit 1 when any run errored or was aborted, or the mean is below --min-score ' +
    '(a run without a score also fails it). Ctrl-C ends the run in progress as "abort" and ' +
    'skips the rest.',
  options: [
    PROVIDER_OPTION,
    SCENARIO_OPTION,
    CACHE_OPTION,
    CACHE_VARIANT_OPTION,
    RUNS_ROOT_OPTION,
    ...LIMIT_OPTIONS,
    ...MODEL_OPTIONS,
    ...RUN_FLAG_OPTIONS,
    {
      name: 'min-score',
      type: 'string',
      arg: '0..1',
      description: 'For CI: exit 1 when the mean score of the runs is below this.',
    },
    {
      name: 'json',
      type: 'boolean',
      description: 'Print the results of all runs as a JSON list on stdout instead of the table.',
    },
  ],
  examples: [
    {
      command: 'corepack pnpm eval suite --scenario oracle',
      comment: 'free and offline: the scripted oracle on all six runs',
    },
    {
      command: 'corepack pnpm eval suite --provider voucher --min-score 0.9',
      comment: 'a real model on all six, capped by the voucher budget',
    },
    {
      command:
        'corepack pnpm eval suite vida-laboral-inyeccion:page-title vida-laboral-inyeccion:hidden-text',
    },
  ],
  notes: [EXIT_NOTES],
};

export const REPORT_SPEC: CommandSpec = {
  name: 'report',
  summary: 'Print the report of a finished run.',
  usage: 'report <runDir|runId> [options]',
  description:
    'Prints report.md of a run folder (rendered again from result.json when report.md is missing). ' +
    'A bare run id is looked up under the runs root. Works on any finished run, with no service ' +
    'running.',
  options: [
    RUNS_ROOT_OPTION,
    { name: 'json', type: 'boolean', description: 'Print result.json instead.' },
    { name: 'rules', type: 'boolean', description: 'Print only the rule tables.' },
  ],
  examples: [
    { command: 'corepack pnpm eval report vida-laboral-sin-datos-mock-20261017-044218-8a1a' },
    { command: 'corepack pnpm eval report <runId> --rules' },
  ],
};

export const RUNS_SPEC: CommandSpec = {
  name: 'runs',
  summary: 'List the runs on disk, newest first.',
  usage: 'runs [options]',
  description:
    'Lists the run folders under the runs root: id, fixture, provider, status, score, cost and ' +
    'when each started.',
  options: [
    RUNS_ROOT_OPTION,
    {
      name: 'limit',
      type: 'string',
      arg: 'n',
      description: 'Show at most this many runs (default 20).',
    },
  ],
  examples: [{ command: 'corepack pnpm eval runs --limit 5' }],
};

export const BUDGET_SPEC: CommandSpec = {
  name: 'budget',
  summary: 'The voucher balance, the ledger and the caps a run gets.',
  usage: 'budget [options]',
  description:
    "Shows the voucher key's balance (asked to the key server), what the ledger says was spent " +
    'per UTC day, the caps a run gets and the Codex request window. It never prints a key.',
  options: [
    {
      name: 'offline',
      type: 'boolean',
      description: 'Do not ask the key server (the balance is then "unavailable").',
    },
  ],
  examples: [
    { command: 'corepack pnpm eval budget' },
    { command: 'corepack pnpm eval budget --offline' },
  ],
};

export const LOGIN_SPEC: CommandSpec = {
  name: 'login',
  summary: 'Sign in to Codex (development only).',
  usage: 'login codex [--codex-consent]',
  description:
    'Runs the Codex device login: prints a verification URL and a code on stderr, waits until ' +
    'you approve it in the browser and stores the tokens in the credentials home. DEVELOPMENT ' +
    "ONLY: this route is against OpenAI's terms for a shipped app, so it needs your explicit " +
    'consent (--codex-consent or SA_EVAL_CODEX_CONSENT=1). Without it nothing is contacted. ' +
    "The app's own vault and keychain are never read.",
  options: [
    {
      name: 'codex-consent',
      type: 'boolean',
      description: 'Consent to the Codex login (see above).',
    },
  ],
  examples: [{ command: 'corepack pnpm eval login codex --codex-consent' }],
};

export const WHOAMI_SPEC: CommandSpec = {
  name: 'whoami',
  summary: 'Which logins and keys the suite has.',
  usage: 'whoami',
  description:
    'Shows the Codex login (account id prefix and expiry) and whether a voucher key file exists ' +
    'and until when it is valid. It never prints a token or a key.',
  options: [],
  examples: [{ command: 'corepack pnpm eval whoami' }],
};

export const LOGOUT_SPEC: CommandSpec = {
  name: 'logout',
  summary: 'Forget the stored Codex login.',
  usage: 'logout codex',
  description: 'Deletes the Codex login from the credentials home. No token is revoked at OpenAI.',
  options: [],
  examples: [{ command: 'corepack pnpm eval logout codex' }],
};

export const DOCTOR_SPEC: CommandSpec = {
  name: 'doctor',
  summary: 'Check that this machine can run evaluations.',
  usage: 'doctor',
  description:
    'Checks, one line each: SpainBench (configured, reachable, scoring API, every fixture ' +
    'runnable, injection variants), the eval host bundle, the cached Chromium, the credentials ' +
    'home, the voucher key, the Codex login and the folders the suite writes to. Exit code 1 ' +
    'when a check that a mock run needs fails; warnings (a missing voucher key, say) do not.',
  options: [],
  examples: [{ command: 'SPAINBENCH_DIR=../../../SpainBench corepack pnpm eval doctor' }],
};

export const COMMANDS: readonly CommandSpec[] = [
  LIST_SPEC,
  RUN_SPEC,
  SUITE_SPEC,
  REPORT_SPEC,
  RUNS_SPEC,
  BUDGET_SPEC,
  LOGIN_SPEC,
  WHOAMI_SPEC,
  LOGOUT_SPEC,
  DOCTOR_SPEC,
];

export function findCommand(name: string): CommandSpec | undefined {
  return COMMANDS.find((command) => command.name === name);
}
