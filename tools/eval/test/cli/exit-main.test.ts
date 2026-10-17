import { afterEach, describe, expect, it } from 'vitest';
import { BenchError, BenchLaunchError, BenchTargetError, BenchVersionError } from '../../src/bench';
import { UsageError } from '../../src/cli/args';
import { classifyError, resultExit } from '../../src/cli/exit';
import { UnknownFixtureError } from '../../src/fixtures';
import { CodexAuthError, CodexConsentError } from '../../src/llm/codex-auth';
import { EvalHomeError } from '../../src/llm/home';
import { CheckpointError } from '../../src/run';
import { EvaluationRefused } from '../../src/runner';
import { type Cli, makeCli } from './support';

describe('classifyError: what a command that threw exits with', () => {
  it.each([
    ['a usage error', new UsageError('bad')],
    ['a refusal of runEvaluation', new EvaluationRefused('no')],
    ['an unknown fixture', new UnknownFixtureError('x')],
    ['SpainBench settings that cannot be used', new BenchTargetError('bad url')],
    ['a SpainBench that cannot start', new BenchLaunchError('cannot start')],
    [
      'a SpainBench of another scoring API',
      new BenchVersionError({ serverApi: 2, supportedApi: 1, message: 'older' }),
    ],
    ['a SpainBench that cannot be reached', new BenchError('unreachable', 'GET /version', 'down')],
    ['a missing credential', new EvalHomeError('missing', '/x/litellm.json', 'no key')],
    ['Codex without consent', new CodexConsentError()],
    ['Codex without a login', new CodexAuthError('missing', 'no login')],
    ['an unusable checkpoint', new CheckpointError('invalid', 'bad manifest')],
  ])('%s is 2: nothing was started', (_name, error) => {
    expect(classifyError(error).code).toBe(2);
  });

  it.each([
    ['an unexpected error', new Error('boom')],
    ['a type error', new TypeError('x is not a function')],
    ['a thrown string', 'oops'],
  ])('%s is 1', (_name, error) => {
    expect(classifyError(error).code).toBe(1);
  });

  it('keeps the message, and adds the stack only when asked', () => {
    const error = new Error('boom');
    expect(classifyError(error).message).toContain('boom');
    expect(classifyError(error).message).toContain('SA_EVAL_DEBUG=1');
    expect(classifyError(error, true).message).toContain('at ');
    expect(classifyError(new EvaluationRefused('one line')).message).toBe('one line');
  });
});

describe('resultExit: the exit code of a run that produced a result', () => {
  it.each([
    ['completed', 0.9],
    ['completed', 0],
    ['failed_required', 0],
    ['inconclusive', null],
  ] as const)('%s with score %s is 0', (status, score) => {
    expect(resultExit({ status, score })).toEqual({ code: 0 });
  });

  it.each([
    ['error', null],
    ['aborted', null],
  ] as const)('%s is 1: no score', (status, score) => {
    const verdict = resultExit({ status, score });
    expect(verdict.code).toBe(1);
    expect(verdict.reason).toMatch(/no score/);
  });

  it('--min-score fails a run below it, with the numbers in the reason', () => {
    expect(resultExit({ status: 'completed', score: 0.79 }, 0.8)).toMatchObject({
      code: 1,
      reason: expect.stringMatching(/0\.79.*--min-score 0\.8/),
    });
    expect(resultExit({ status: 'completed', score: 0.8 }, 0.8)).toEqual({ code: 0 });
    expect(resultExit({ status: 'failed_required', score: 0 }, 0.5).code).toBe(1);
    expect(resultExit({ status: 'failed_required', score: 0 }, 0).code).toBe(0);
  });

  it('--min-score fails a run that was cut short before its negated rules could be judged', () => {
    const cut = {
      status: 'completed' as const,
      score: 1,
      endedBy: 'limit:tool-calls',
      unsettledNegated: ['no-exfil'],
    };
    expect(resultExit(cut, 0.8)).toMatchObject({
      code: 1,
      reason: expect.stringMatching(/cut short \(limit:tool-calls\).*no-exfil.*--min-score 0\.8/),
    });
    // Without a bar it is a result like any other.
    expect(resultExit(cut)).toEqual({ code: 0 });
  });

  it('--min-score also fails a run that has no score (it cannot show the bar was met)', () => {
    expect(resultExit({ status: 'inconclusive', score: null }, 0.5)).toMatchObject({
      code: 1,
      reason: expect.stringMatching(/inconclusive and has no score/),
    });
  });
});

describe('main: dispatch and usage errors', () => {
  let cli: Cli;
  afterEach(() => cli?.cleanup());

  it('without a command prints the help on stderr and exits 2', async () => {
    cli = makeCli();
    expect(await cli.run()).toBe(2);
    expect(cli.err()).toMatch(/missing command/);
    expect(cli.err()).toContain('Commands:');
    expect(cli.out()).toBe('');
  });

  it('prints the general help for --help and -h on stdout and exits 0', async () => {
    cli = makeCli();
    expect(await cli.run('--help')).toBe(0);
    expect(cli.out()).toContain('Commands:');
    expect(await cli.run('-h')).toBe(0);
  });

  it('refuses an unknown command, listing the known ones', async () => {
    cli = makeCli();
    expect(await cli.run('frobnicate')).toBe(2);
    expect(cli.err()).toMatch(
      /Unknown command "frobnicate" \(commands: list, run, suite, report, runs/,
    );
    expect(cli.err()).toContain('See "eval --help"');
    expect(cli.out()).toBe('');
  });

  it('turns a usage error into one line, a pointer to the command help and exit 2', async () => {
    cli = makeCli();
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--bogus')).toBe(2);
    expect(cli.err()).toMatch(/^error: Unknown option '--bogus'\.\nSee "eval run --help"\.\n$/);
    expect(cli.out()).toBe('');
    expect(await cli.run('runs', 'stray')).toBe(2);
    expect(cli.err()).toContain('"runs" takes no arguments');
  });

  it('maps an unexpected error to exit 1 with its message, and a refusal to exit 2', async () => {
    cli = makeCli({
      deps: {
        budgetStatus: async () => {
          throw new Error('the ledger exploded');
        },
      },
    });
    expect(await cli.run('budget')).toBe(1);
    expect(cli.err()).toContain('error: the ledger exploded');

    cli.cleanup();
    cli = makeCli({
      deps: {
        budgetStatus: async () => {
          throw new EvalHomeError('unsafe_permissions', '/x', '/x is readable by other users');
        },
      },
    });
    expect(await cli.run('budget')).toBe(2);
    expect(cli.err()).toContain('/x is readable by other users');
  });
});
