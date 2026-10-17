import { afterEach, describe, expect, it } from 'vitest';
import {
  choiceOption,
  fractionOption,
  parseCommandArgs,
  positiveIntegerOption,
  positiveNumberOption,
  UsageError,
  wantsHelp,
} from '../../src/cli/args';
import { renderCommandHelp, renderGeneralHelp } from '../../src/cli/help';
import { COMMANDS, RUN_SPEC, SUITE_SPEC } from '../../src/cli/specs';
import { type Cli, makeCli } from './support';

describe('parseCommandArgs', () => {
  const parse = (args: string[], positionals = { min: 1, max: 1, names: '<fixture>' }) =>
    parseCommandArgs(RUN_SPEC, args, positionals);

  it('reads values, flags and positionals', () => {
    const parsed = parse(['vida-laboral-sin-datos', '--cache', 'off', '--json', '--max-cost=0.5']);
    expect(parsed.positionals).toEqual(['vida-laboral-sin-datos']);
    expect(parsed.values).toMatchObject({ cache: 'off', json: true, 'max-cost': '0.5' });
  });

  it('refuses an unknown option, naming it', () => {
    expect(() => parse(['x', '--bogus'])).toThrow(UsageError);
    expect(() => parse(['x', '--bogus'])).toThrow(/Unknown option '--bogus'/);
    expect(() => parse(['x', '-z'])).toThrow(/Unknown option '-z'/);
  });

  it('refuses an option that lacks its value, and a flag given a value', () => {
    expect(() => parse(['x', '--cache'])).toThrow(/--cache/);
    expect(() => parse(['x', '--json=yes'])).toThrow(UsageError);
  });

  it.each([
    ['--from', ''],
    ['--min-score', ''],
    ['--max-cost', ''],
    ['--max-tool-calls', ''],
    ['--max-requests', ''],
    ['--wall-clock', ''],
    ['--cache', ''],
    ['--cache-variant', ''],
    ['--provider', ''],
    ['--scenario', ''],
    ['--assistant-model', ''],
    ['--procedure-model', ''],
    ['--answerer-model', ''],
    ['--runs-root', ''],
    ['--run-id', ''],
    ['--min-score', '   '],
    ['--from', '\t'],
  ])('refuses %s given as %j: empty is never "not given"', (option, value) => {
    expect(() => parse(['x', option, value])).toThrow(UsageError);
    expect(() => parse(['x', option, value])).toThrow(
      new RegExp(`${option} needs a value.*given empty`),
    );
    expect(() => parse(['x', `${option}=${value}`])).toThrow(/needs a value/);
  });

  it('names the value the option takes, and the command whose help explains it', () => {
    try {
      parse(['x', '--max-cost', '']);
      expect.unreachable();
    } catch (error) {
      expect((error as UsageError).message).toBe(
        '--max-cost needs a value (<usd>): it was given empty.',
      );
      expect((error as UsageError).command).toBe('run');
    }
  });

  it('a flag and a good value are unaffected', () => {
    const parsed = parse(['x', '--json', '--cache', 'off', '--max-cost', '0']);
    expect(parsed.values).toMatchObject({ json: true, cache: 'off', 'max-cost': '0' });
  });

  it('counts positionals: missing and extra ones are usage errors that say which', () => {
    expect(() => parse([])).toThrow(/Missing <fixture>/);
    expect(() => parse(['a', 'b'])).toThrow(/Too many arguments: "b"/);
    expect(() => parseCommandArgs(RUN_SPEC, ['stray'], { min: 0, max: 0, names: '' })).toThrow(
      /takes no arguments \(got "stray"\)/,
    );
  });

  it('points at the command whose help explains it', () => {
    try {
      parse(['x', '--bogus']);
      expect.unreachable();
    } catch (error) {
      expect((error as UsageError).command).toBe('run');
    }
  });

  it('does not tell people about parseArgs internals', () => {
    try {
      parse(['x', '--max-cost', '-1']);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toMatch(
        /To specify an option argument starting with a dash/,
      );
    }
  });
});

describe('wantsHelp', () => {
  it('sees --help and -h, but not after a --', () => {
    expect(wantsHelp(['run', '--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['--', '--help'])).toBe(false);
    expect(wantsHelp(['run', 'fixture'])).toBe(false);
  });
});

describe('numeric options', () => {
  it('accept what they say and refuse the rest, naming the option', () => {
    expect(positiveNumberOption('max-cost', '0.25')).toBe(0.25);
    expect(() => positiveNumberOption('max-cost', '0')).toThrow(
      /--max-cost must be a positive number/,
    );
    expect(() => positiveNumberOption('max-cost', 'abc')).toThrow(/--max-cost/);
    expect(() => positiveNumberOption('max-cost', '')).toThrow(/--max-cost/);
    expect(() => positiveNumberOption('max-cost', 'Infinity')).toThrow(/--max-cost/);
    expect(positiveIntegerOption('limit', '5')).toBe(5);
    expect(() => positiveIntegerOption('limit', '1.5')).toThrow(/whole number/);
    expect(() => positiveIntegerOption('limit', '0')).toThrow(/whole number/);
    expect(fractionOption('min-score', '0.8')).toBe(0.8);
    expect(fractionOption('min-score', '0')).toBe(0);
    expect(fractionOption('min-score', '1')).toBe(1);
    expect(() => fractionOption('min-score', '1.2')).toThrow(/from 0 to 1/);
    expect(() => fractionOption('min-score', '-0.1')).toThrow(/from 0 to 1/);
    expect(choiceOption('provider', 'mock', ['mock', 'codex'])).toBe('mock');
    expect(() => choiceOption('provider', 'gpt', ['mock', 'codex'])).toThrow(
      /--provider must be one of mock, codex \(got "gpt"\)/,
    );
  });
});

describe('help texts', () => {
  it('the general help lists every command, the environment and the exit codes', () => {
    const help = renderGeneralHelp();
    for (const command of COMMANDS) expect(help).toContain(command.name);
    for (const name of [
      'SPAINBENCH_DIR',
      'SPAINBENCH_URL',
      'SPAINBENCH_TOKEN',
      'SPAINBENCH_DATA_DIR',
      'SA_EVAL_CODEX_CONSENT',
    ]) {
      expect(help).toContain(name);
    }
    expect(help).toMatch(/Exit codes:/);
    expect(help).toMatch(/stdout is for results, stderr for progress/i);
  });

  it.each(COMMANDS.map((command) => [command.name, command] as const))(
    'the help of "%s" has its usage, every option and an example that names it',
    (name, spec) => {
      const help = renderCommandHelp(spec);
      expect(help).toContain(`Usage: corepack pnpm eval ${spec.usage}`);
      expect(help).toContain('--help');
      for (const option of spec.options) expect(help).toContain(`--${option.name}`);
      expect(help).toMatch(/Examples:\n {2}\S/);
      expect(spec.examples.some((example) => example.command.includes(`eval ${name}`))).toBe(true);
    },
  );

  it('the help of "run" says what the provider default is, the exit codes and Ctrl-C', () => {
    const help = renderCommandHelp(RUN_SPEC).replace(/\s+/g, ' ');
    expect(help).toMatch(/Default: mock when --scenario is given, otherwise voucher/);
    expect(help).toMatch(/Exit codes: 0 the run produced a result/);
    expect(help).toMatch(/Ctrl-C ends the run as "abort"/);
    expect(help).toContain('--min-score');
    expect(help).toContain('--from <runDir#n>');
  });

  it('the help of "run" says a failed_required run exits 0, and what makes CI fail', () => {
    const help = renderCommandHelp(RUN_SPEC).replace(/\s+/g, ' ');
    expect(help).toMatch(
      /A failed_required run exits 0 \(so does an inconclusive one\): use --min-score/,
    );
    expect(help).toMatch(/failed_required \(a failed required rule, an exfiltration included\)/);
    expect(help).toMatch(/error \(the model gateway, a host or SpainBench failing is an error/);
    const general = renderGeneralHelp().replace(/\s+/g, ' ');
    expect(general).toMatch(/a failed_required one exits 0 too: --min-score is the bar for CI/);
    expect(general).toMatch(/an empty option value too/);
  });

  it('the help of "suite" says what it plays, prints and exits with', () => {
    const help = renderCommandHelp(SUITE_SPEC).replace(/\s+/g, ' ');
    for (const id of [
      'vida-laboral-sin-datos',
      'vida-laboral-con-datos',
      'vida-laboral-inyeccion',
    ]) {
      expect(help).toContain(id);
    }
    expect(help).toMatch(/one summary line per run, a table and the mean score/);
    expect(help).toMatch(
      /Exit 1 when any run errored or was aborted, or the mean is below --min-score/,
    );
    expect(help).not.toContain('--from');
    expect(help).not.toContain('--run-id');
  });

  it('the help of "login" says it is development only and needs consent', () => {
    const spec = COMMANDS.find((command) => command.name === 'login');
    const help = renderCommandHelp(spec!);
    expect(help).toMatch(/DEVELOPMENT ONLY/);
    expect(help).toContain('--codex-consent');
    expect(help).toContain('SA_EVAL_CODEX_CONSENT=1');
  });
});

describe('help through main', () => {
  let cli: Cli;
  afterEach(() => cli?.cleanup());

  it('prints a command help on stdout and exits 0, whatever else was typed', async () => {
    cli = makeCli();
    expect(await cli.run('run', 'x', '--help')).toBe(0);
    expect(cli.out()).toContain('Usage: corepack pnpm eval run');
    expect(cli.err()).toBe('');
    expect(await cli.run('report', '-h')).toBe(0);
  });

  it('says in `run --help` that replayed answers are copies and how to take a fresh sample', async () => {
    cli = makeCli();
    expect(await cli.run('help', 'run')).toBe(0);
    const help = cli.out().replace(/\s+/g, ' ');
    expect(help).toContain('repeated runs under auto or replay are copies');
    expect(help).toContain('"N of M requests replayed (K loose)"');
    expect(help).toContain('--cache record --cache-variant <x>');
    expect(help).toContain('or --cache off');
    expect(help).toContain('Default: auto for voucher and codex, off for mock.');
  });

  it('answers "help" and "help <command>"', async () => {
    cli = makeCli();
    expect(await cli.run('help')).toBe(0);
    expect(cli.out()).toContain('Commands:');
    expect(await cli.run('help', 'budget')).toBe(0);
    expect(cli.out()).toContain('Usage: corepack pnpm eval budget');
    expect(await cli.run('help', 'nope')).toBe(2);
    expect(cli.err()).toMatch(/Unknown command "nope"/);
  });
});
