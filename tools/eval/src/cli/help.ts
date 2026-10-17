/** The `--help` texts of `eval` and of each command (built from `specs.ts`). */
import { type CommandSpec, HELP_OPTION } from './args';
import { columns, wrap } from './format';
import { COMMANDS } from './specs';

const WIDTH = 96;

const EXIT_CODES_HELP = [
  '0  success; for "run" and "suite": the run produced a result (completed, failed_required,',
  '   inconclusive), and a failed_required one exits 0 too: --min-score is the bar for CI',
  '1  an error; for "run" and "suite": error (the model gateway or a host failing is one),',
  '   aborted, no score because the harness ran out of budget, Ctrl-C, or below --min-score;',
  '   for "doctor": a check a mock run needs failed',
  '2  usage error (an empty option value too), or the command refused to start (unknown',
  '   fixture, no SpainBench, no Chromium, no credential, an expired voucher, Codex',
  '   without consent)',
];

const ENVIRONMENT_HELP: [name: string, text: string][] = [
  ['SPAINBENCH_DIR', 'The private SpainBench repo: the suite starts it on free loopback ports.'],
  ['SPAINBENCH_URL', 'A SpainBench that already runs (public listener); wins less than _DIR.'],
  ['SPAINBENCH_SCORING_URL', 'Its scoring listener (optional only when the public port is 3010).'],
  ['SPAINBENCH_TOKEN', 'Its scoring token (optional for a server on this machine).'],
  [
    'SPAINBENCH_DATA_DIR',
    'Credentials, ledger, cache and runs (default spainbench in the OS data folder).',
  ],
  ['SA_EVAL_CODEX_CONSENT', '1 consents to the Codex login (development only).'],
  ['SA_EVAL_CODEX_ALLOW_CI', '1 lets a CI job use the Codex login (refused there otherwise).'],
  ['SA_EVAL_ALLOW_IP_GATEWAY', '1 accepts a bare IP address as the gateway in litellm.json.'],
  ['SA_EVAL_DEBUG', '1 prints the stack of an unexpected error.'],
];

export function renderGeneralHelp(): string {
  const lines = [
    'eval: the SpainBench eval suite',
    '',
    'Usage: corepack pnpm eval <command> [options]      (from the repo root or from tools/eval)',
    '',
    'Commands:',
    ...columns(COMMANDS.map((command) => [`  ${command.name}`, command.summary])),
    '',
    'Run "eval <command> --help" for the options of a command, with an example.',
    '',
    'Environment:',
    ...columns(ENVIRONMENT_HELP.map(([name, text]) => [`  ${name}`, text])),
    '',
    'Exit codes:',
    ...EXIT_CODES_HELP.map((line) => `  ${line}`),
    '',
    'Stdout is for results, stderr for progress.',
  ];
  return `${lines.join('\n')}\n`;
}

export function renderCommandHelp(spec: CommandSpec): string {
  const lines = [`Usage: corepack pnpm eval ${spec.usage}`, '', wrap(spec.description, WIDTH), ''];
  const options = [HELP_OPTION, ...spec.options];
  lines.push('Options:');
  for (const option of options) {
    const names = `${option.short ? `-${option.short}, ` : ''}--${option.name}${
      option.type === 'string' ? ` <${option.arg ?? 'value'}>` : ''
    }`;
    const head = `  ${names}`;
    const body = wrap(option.description, WIDTH - 30, ' '.repeat(30));
    if (head.length <= 28) lines.push(`${head.padEnd(30)}${body}`);
    else lines.push(head, `${' '.repeat(30)}${body}`);
  }
  lines.push('', 'Examples:');
  for (const example of spec.examples) {
    lines.push(`  ${example.command}${example.comment ? `    # ${example.comment}` : ''}`);
  }
  for (const note of spec.notes ?? []) lines.push('', wrap(note, WIDTH));
  return `${lines.join('\n')}\n`;
}
