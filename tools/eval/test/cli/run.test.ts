import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/contracts';
import type { RunOutcome } from '../../src/run';
import { summarizeResult } from '../../src/run/results';
import { EvaluationRefused, type EvaluationRequest } from '../../src/runner';
import { emptyMeterUsage } from '../../src/scoring';
import { until } from '../bench/fake-server';
import { type Cli, ExitCalled, makeCli } from './support';

let cli: Cli;
afterEach(() => cli?.cleanup());

const SCENARIO = { name: 'fake-scenario', fallback: { text: 'hola' } };

function resultOf(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'r',
    fixtureId: 'vida-laboral-sin-datos',
    provider: 'mock',
    status: 'completed',
    score: 0.9,
    scoreBeforePenalty: 0.9,
    wrongTurns: 0,
    rules: [],
    usage: emptyMeterUsage(),
    durationMs: 1000,
    endedBy: 'quiescent',
    notes: [],
    ...overrides,
  };
}

function outcomeOf(request: EvaluationRequest, overrides: Partial<RunResult> = {}): RunOutcome {
  const result = resultOf({
    runId: request.runId ?? 'r',
    fixtureId: request.fixtureId,
    provider: request.provider,
    ...overrides,
  });
  const runDir = join(request.runsRoot ?? '/runs', request.runId ?? 'r');
  return {
    runId: result.runId,
    runDir,
    result,
    summary: summarizeResult(result, runDir),
    checkpoints: [],
    reportFile: join(runDir, 'report.md'),
    resultFile: join(runDir, 'result.json'),
  };
}

/** A CLI whose `runEvaluation` records its request and answers with `outcome`. */
function runCli(
  outcome: (request: EvaluationRequest) => RunOutcome | Promise<RunOutcome> = (request) =>
    outcomeOf(request),
  extra: Parameters<typeof makeCli>[0] = {},
) {
  const requests: EvaluationRequest[] = [];
  const made = makeCli({
    ...extra,
    deps: {
      mockScenario: () => SCENARIO,
      runEvaluation: async (request) => {
        requests.push(request);
        return outcome(request);
      },
      ...extra.deps,
    },
  });
  return { cli: made, requests };
}

describe('eval run: arguments become the request', () => {
  it('maps every option', async () => {
    const harness = runCli();
    cli = harness.cli;
    const code = await cli.run(
      'run',
      'vida-laboral-inyeccion:page-title',
      '--scenario',
      'susceptible',
      '--cache',
      'replay',
      '--cache-variant',
      'b',
      '--max-cost',
      '0.2',
      '--max-tool-calls',
      '50',
      '--max-requests',
      '90',
      '--wall-clock',
      '2.5',
      '--assistant-model',
      'model-a',
      '--procedure-model',
      'model-p',
      '--answerer-model',
      'model-u',
      '--capture-browser',
      '--keep-world',
      '--codex-consent',
      '--run-id',
      'my-run',
      '--runs-root',
      'where',
    );
    expect(code).toBe(0);
    expect(harness.requests).toHaveLength(1);
    const request = harness.requests[0] as EvaluationRequest;
    expect(request).toMatchObject({
      fixtureId: 'vida-laboral-inyeccion:page-title',
      provider: 'mock',
      scenario: SCENARIO,
      cache: 'replay',
      cacheVariant: 'b',
      limits: { maxCostUsd: 0.2, maxToolCalls: 50, maxRequests: 90, wallClockMs: 150_000 },
      models: { assistantModel: 'model-a', procedureModel: 'model-p', answererModel: 'model-u' },
      captureBrowser: true,
      keepWorld: true,
      codexConsent: true,
      runId: 'my-run',
      runsRoot: join(cli.cwd, 'where'),
      env: cli.env,
      cwd: cli.cwd,
      handlesSignals: true,
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(typeof request.log).toBe('function');
    expect(request.home).toBeUndefined();
    // Where the browser is looked for is the CLI's, as `doctor` looks for it.
    expect(request.chromiumPath?.()).toBe('/fake/chromium');
  });

  it('--allow-fixture-change reaches the request next to --from, and only then', async () => {
    const harness = runCli();
    cli = harness.cli;
    mkdirSync(join(cli.runsRoot, 'old-run'), { recursive: true });
    await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--runs-root',
      cli.runsRoot,
      '--from',
      'old-run#1',
      '--allow-fixture-change',
    );
    await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--runs-root',
      cli.runsRoot,
      '--from',
      'old-run#1',
    );
    expect(harness.requests.map((request) => request.allowFixtureChange)).toEqual([
      true,
      undefined,
    ]);
  });

  it('asks the scenario source for the fixture and the name', async () => {
    const asked: [string, string][] = [];
    const harness = runCli(undefined, {
      deps: {
        mockScenario: (fixtureId, name) => {
          asked.push([fixtureId, name]);
          return SCENARIO;
        },
      },
    });
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-con-datos', '--scenario', 'oracle');
    expect(asked).toEqual([['vida-laboral-con-datos', 'oracle']]);
  });

  it('leaves out what was not asked for, so the run applies its own defaults', async () => {
    const harness = runCli();
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-sin-datos');
    const request = harness.requests[0] as EvaluationRequest;
    expect(request.provider).toBe('voucher');
    for (const key of [
      'cache',
      'cacheVariant',
      'from',
      'limits',
      'models',
      'captureBrowser',
      'keepWorld',
      'codexConsent',
      'scenario',
    ]) {
      expect(request).not.toHaveProperty(key);
    }
    // The data folder of the test (`SPAINBENCH_DATA_DIR`), never the real one.
    expect(request.runsRoot).toBe(join(cli.home, 'runs'));
    expect(request.runId).toMatch(/^vida-laboral-sin-datos-voucher-20261017-100000-[0-9a-f]{4}$/);
  });

  it('defaults the provider to mock when a scenario is given and to voucher otherwise', async () => {
    const harness = runCli();
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'oracle');
    await cli.run('run', 'vida-laboral-sin-datos');
    await cli.run('run', 'vida-laboral-sin-datos', '--provider', 'codex');
    await cli.run('run', 'vida-laboral-sin-datos', '--provider', 'mock', '--scenario', 'oracle');
    expect(harness.requests.map((request) => request.provider)).toEqual([
      'mock',
      'voucher',
      'codex',
      'mock',
    ]);
  });

  it('turns --from <runId>#<n> and <runDir>#<n> into a checkpoint of that run folder', async () => {
    const harness = runCli();
    cli = harness.cli;
    const root = join(cli.dir, 'runs');
    mkdirSync(join(root, 'old-run'), { recursive: true });
    await cli.run('run', 'vida-laboral-sin-datos', '--runs-root', root, '--from', 'old-run#2');
    await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--runs-root',
      root,
      '--from',
      `${root}/old-run#3`,
    );
    expect(harness.requests.map((request) => request.from)).toEqual([
      { runDir: join(root, 'old-run'), checkpoint: 2 },
      { runDir: join(root, 'old-run'), checkpoint: 3 },
    ]);
  });

  it('takes the last checkpoint of the run when --from has no #<n>', async () => {
    const harness = runCli();
    cli = harness.cli;
    const root = join(cli.dir, 'runs');
    for (const n of [1, 2]) {
      mkdirSync(join(root, 'old-run', 'checkpoints', String(n)), { recursive: true });
      writeFileSync(join(root, 'old-run', 'checkpoints', String(n), 'manifest.json'), '{}');
    }
    await cli.run('run', 'vida-laboral-sin-datos', '--runs-root', root, '--from', 'old-run');
    expect(harness.requests[0]?.from).toEqual({ runDir: join(root, 'old-run'), checkpoint: 2 });
  });

  it('says so when --from names a run without checkpoints', async () => {
    const harness = runCli();
    cli = harness.cli;
    mkdirSync(join(cli.runsRoot, 'bare'), { recursive: true });
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--runs-root', cli.runsRoot, '--from', 'bare'),
    ).toBe(2);
    expect(cli.err()).toMatch(/has no checkpoints/);
    expect(harness.requests).toHaveLength(0);
  });
});

describe('eval run: an empty option value is a usage error, never "not given"', () => {
  it.each([
    ['--from', ''],
    ['--min-score', ''],
    ['--max-cost', ''],
    ['--max-requests', ''],
    ['--cache', ''],
    ['--scenario', ''],
    ['--provider', ''],
    ['--run-id', ''],
    ['--runs-root', ''],
    ['--assistant-model', '  '],
  ])('%s %j exits 2 before anything starts', async (option, value) => {
    const harness = runCli();
    cli = harness.cli;
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'oracle', option, value),
    ).toBe(2);
    expect(cli.err()).toMatch(new RegExp(`${option} needs a value`));
    expect(cli.err()).toContain('See "eval run --help"');
    expect(harness.requests).toHaveLength(0);
    // The CI gate is not silently dropped: the run never starts, whatever its result would be.
    expect(cli.out()).toBe('');
  });

  it('an unset shell variable in --scenario does not turn a free run into a paid one', async () => {
    const harness = runCli();
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', '')).toBe(2);
    expect(harness.requests).toHaveLength(0);
  });
});

describe('eval run: usage errors (exit 2, nothing started)', () => {
  const refused = async (args: string[], message: RegExp) => {
    const harness = runCli();
    cli = harness.cli;
    expect(await cli.run('run', ...args)).toBe(2);
    expect(cli.err()).toMatch(message);
    expect(harness.requests).toHaveLength(0);
    expect(cli.out()).toBe('');
    cli.cleanup();
  };

  it('needs a fixture', () => refused([], /Missing <fixture>/));
  it('refuses two fixtures', () => refused(['a', 'b'], /Too many arguments/));
  it('refuses an unknown fixture, listing the known ones', () =>
    refused(['nope'], /Unknown fixture "nope"\. Known: vida-laboral-sin-datos/));
  it('refuses the mock provider without a scenario', () =>
    refused(
      ['vida-laboral-sin-datos', '--provider', 'mock'],
      /--provider mock needs --scenario <name>/,
    ));
  it('refuses a scenario for a real provider', () =>
    refused(
      ['vida-laboral-sin-datos', '--provider', 'voucher', '--scenario', 'oracle'],
      /--scenario is the script of the mock model: it cannot be used with --provider voucher/,
    ));
  it('refuses an unknown provider', () =>
    refused(
      ['vida-laboral-sin-datos', '--provider', 'gpt'],
      /--provider must be one of mock, voucher, codex/,
    ));
  it('refuses an unknown cache mode', () =>
    refused(
      ['vida-laboral-sin-datos', '--cache', 'sometimes'],
      /--cache must be one of off, record, replay, auto/,
    ));
  it('refuses numbers that are not positive numbers', async () => {
    await refused(['vida-laboral-sin-datos', '--max-cost', '-1'], /--max-cost/);
    await refused(
      ['vida-laboral-sin-datos', '--max-cost=0'],
      /--max-cost must be a positive number/,
    );
    await refused(
      ['vida-laboral-sin-datos', '--max-tool-calls', '2.5'],
      /--max-tool-calls must be a whole number from 1/,
    );
    await refused(
      ['vida-laboral-sin-datos', '--wall-clock', 'soon'],
      /--wall-clock must be a positive number/,
    );
    await refused(
      ['vida-laboral-sin-datos', '--min-score', '2'],
      /--min-score must be a number from 0 to 1/,
    );
  });
  it('refuses an unknown option', () =>
    refused(['vida-laboral-sin-datos', '--scenaro', 'oracle'], /Unknown option '--scenaro'/));
  it('says what a scenario source that rejects the name said', async () => {
    const harness = runCli(undefined, {
      deps: {
        mockScenario: () => {
          throw new Error(
            'No mock scenario "wat" for vida-laboral-sin-datos (known: oracle, lost)',
          );
        },
      },
    });
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'wat')).toBe(2);
    expect(cli.err()).toMatch(
      /Scenario "wat" for vida-laboral-sin-datos: No mock scenario "wat" for vida-laboral-sin-datos \(known: oracle, lost\)/,
    );
    expect(harness.requests).toHaveLength(0);
  });
});

describe('eval run: output and exit code', () => {
  it('prints the summary line and the path of report.md on stdout, progress on stderr', async () => {
    const harness = runCli();
    cli = harness.cli;
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x', '--run-id', 'r1'),
    ).toBe(0);
    const lines = cli.out().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^completed \(90\.0%\) \| vida-laboral-sin-datos \[mock\] \|/);
    expect(lines[1]).toBe(`report: ${join(cli.home, 'runs')}/r1/report.md`);
    expect(cli.err()).toMatch(/^Run r1: vida-laboral-sin-datos with mock \(scenario x\)\n/);
  });

  it('forwards the progress lines of the run to stderr', async () => {
    const harness = runCli(async (request) => {
      request.log?.('SpainBench 0.3.0 (started here)');
      return outcomeOf(request);
    });
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    expect(cli.err()).toContain('SpainBench 0.3.0 (started here)\n');
    expect(cli.out()).not.toContain('SpainBench 0.3.0');
  });

  it('--json prints the whole result on stdout and only that', async () => {
    const harness = runCli();
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x', '--json')).toBe(0);
    const result = JSON.parse(cli.out());
    expect(result).toMatchObject({
      status: 'completed',
      score: 0.9,
      fixtureId: 'vida-laboral-sin-datos',
    });
    expect(cli.err()).toMatch(/completed \(90\.0%\)/);
    expect(cli.err()).toMatch(/report: /);
  });

  it.each([
    ['completed', 0.9, 0],
    ['failed_required', 0, 0],
    ['inconclusive', null, 0],
    ['error', null, 1],
    ['aborted', null, 1],
  ] as const)('a run that is %s exits %s', async (status, score, code) => {
    const harness = runCli((request) => outcomeOf(request, { status, score }));
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x')).toBe(code);
    expect(cli.out()).toContain(`${status} (`);
  });

  it.each(['failed_required', 'inconclusive'] as const)(
    'a %s run says on stderr that it exits 0 anyway and what to pass for CI',
    async (status) => {
      const harness = runCli((request) =>
        outcomeOf(request, { status, score: status === 'failed_required' ? 0 : null }),
      );
      cli = harness.cli;
      expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x')).toBe(0);
      expect(cli.err()).toContain(
        `The run is ${status}, and the exit code is 0 anyway: pass --min-score <0..1>`,
      );
    },
  );

  it('with --min-score it says why it failed instead, and a pass says nothing of the kind', async () => {
    const failing = runCli((request) =>
      outcomeOf(request, { status: 'failed_required', score: 0 }),
    );
    cli = failing.cli;
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x', '--min-score', '0.5'),
    ).toBe(1);
    expect(cli.err()).toMatch(/score 0 is below --min-score 0\.5/);
    expect(cli.err()).not.toContain('exit code is 0 anyway');
    cli.cleanup();
    const passing = runCli();
    cli = passing.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x')).toBe(0);
    expect(cli.err()).not.toContain('exit code is 0 anyway');
  });

  it('a run cut short before its negated rules were judged does not pass --min-score', async () => {
    const harness = runCli((request) =>
      outcomeOf(request, {
        score: 1,
        endedBy: 'limit:requests',
        unsettledNegated: ['no-exfil'],
      }),
    );
    cli = harness.cli;
    expect(
      await cli.run('run', 'vida-laboral-inyeccion', '--scenario', 'x', '--min-score', '0.5'),
    ).toBe(1);
    expect(cli.err()).toMatch(/cut short \(limit:requests\) before no-exfil/);
    expect(cli.out()).toContain('cut short: no-exfil not tested to the end');
  });

  it('a run that ended by the harness budget (aborted, limit:budget) exits 1', async () => {
    const harness = runCli((request) =>
      outcomeOf(request, { status: 'aborted', score: null, endedBy: 'limit:budget' }),
    );
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x')).toBe(1);
    expect(cli.err()).toMatch(/the run ended aborted: it has no score/);
  });

  it('a run that ended by one of its own limits still has a verdict: exit 0', async () => {
    const harness = runCli((request) =>
      outcomeOf(request, { status: 'failed_required', score: 0, endedBy: 'limit:cost' }),
    );
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x')).toBe(0);
  });

  it('--min-score makes a run below it exit 1, and says why on stderr', async () => {
    const harness = runCli((request) => outcomeOf(request, { score: 0.7 }));
    cli = harness.cli;
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x', '--min-score', '0.8'),
    ).toBe(1);
    expect(cli.err()).toMatch(/score 0\.7 is below --min-score 0\.8/);
    expect(cli.out()).toContain('completed (70.0%)');
    expect(
      await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x', '--min-score', '0.7'),
    ).toBe(0);
  });
});

describe('eval run: a run that cannot start', () => {
  it('exits 2 with the refusal, and 1 for an unexpected error', async () => {
    const harness = runCli(() => {
      throw new EvaluationRefused('The voucher key has $0.40 left, under the $1.00 floor');
    });
    cli = harness.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos')).toBe(2);
    expect(cli.err()).toContain('error: The voucher key has $0.40 left, under the $1.00 floor');
    expect(cli.out()).toBe('');
    cli.cleanup();

    const crash = runCli(() => {
      throw new Error('the meter fell over');
    });
    cli = crash.cli;
    expect(await cli.run('run', 'vida-laboral-sin-datos')).toBe(1);
    expect(cli.err()).toContain('error: the meter fell over');
  });

  it('prints where the SpainBench log is when the run failed before its folder existed', async () => {
    const root = () => cli.runsRoot;
    const harness = runCli(
      (request) => {
        const log = join(root(), '_bench', `${request.runId}.log`);
        mkdirSync(join(root(), '_bench'), { recursive: true });
        writeFileSync(log, 'SpainBench: public port 1');
        throw new EvaluationRefused('vida-laboral-inyeccion: the server does not list variant v99');
      },
      { start: new Date('2026-10-17T10:00:00Z') },
    );
    cli = harness.cli;
    expect(
      await cli.run(
        'run',
        'vida-laboral-inyeccion',
        '--runs-root',
        cli.runsRoot,
        '--run-id',
        'early',
      ),
    ).toBe(2);
    expect(cli.err()).toContain(
      `SpainBench server log: ${join(cli.runsRoot, '_bench', 'early.log')}`,
    );
  });

  it('prints the log inside the run folder when there is one', async () => {
    const harness = runCli((request) => {
      const logs = join(request.runsRoot as string, request.runId as string, 'logs');
      mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'bench-server.log'), 'x');
      throw new Error('crashed after the folder existed');
    });
    cli = harness.cli;
    expect(
      await cli.run(
        'run',
        'vida-laboral-sin-datos',
        '--runs-root',
        cli.runsRoot,
        '--run-id',
        'late',
      ),
    ).toBe(1);
    expect(cli.err()).toContain(
      `SpainBench server log: ${join(cli.runsRoot, 'late', 'logs', 'bench-server.log')}`,
    );
  });

  it('does not mention a log when there is none (a connected server)', async () => {
    const harness = runCli(() => {
      throw new EvaluationRefused('no SpainBench');
    });
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-sin-datos', '--runs-root', cli.runsRoot);
    expect(cli.err()).not.toContain('SpainBench server log');
  });
});

describe('eval run: Ctrl-C', () => {
  /** A `runEvaluation` that waits for its signal and then ends the run as `abort`. */
  function interruptible() {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const seen: { signal?: AbortSignal; reason?: unknown } = {};
    const evaluate = (request: EvaluationRequest) =>
      new Promise<RunOutcome>((resolve) => {
        seen.signal = request.signal;
        request.signal?.addEventListener('abort', () => {
          seen.reason = request.signal?.reason;
          resolve(outcomeOf(request, { status: 'aborted', score: null, endedBy: 'abort' }));
        });
        started();
      });
    return { evaluate, running, seen };
  }

  it('aborts the run through its signal, lets it write its artifacts and exits 1', async () => {
    const fake = interruptible();
    const harness = runCli(fake.evaluate);
    cli = harness.cli;
    const done = cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    await fake.running;
    expect(cli.listeners()).toBe(1);
    expect(fake.seen.signal?.aborted).toBe(false);

    cli.interrupt('SIGINT');
    const code = await done;
    expect(code).toBe(1);
    expect(fake.seen.signal?.aborted).toBe(true);
    expect(String((fake.seen.reason as Error).message)).toMatch(/interrupted by SIGINT/);
    expect(cli.err()).toMatch(/Interrupted \(SIGINT\): ending the run and saving what exists/);
    // The summary of the aborted run is still printed, and the listener is gone.
    expect(cli.out()).toMatch(/^aborted \(no score\) \| vida-laboral-sin-datos \[mock\]/);
    expect(cli.out()).toContain('report: ');
    expect(cli.listeners()).toBe(0);
  });

  it('treats SIGTERM like Ctrl-C', async () => {
    const fake = interruptible();
    const harness = runCli(fake.evaluate);
    cli = harness.cli;
    const done = cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    await fake.running;
    cli.interrupt('SIGTERM');
    expect(await done).toBe(1);
    expect(cli.err()).toContain('Interrupted (SIGTERM)');
  });

  it('exits at once on the second Ctrl-C, without aborting twice', async () => {
    let signal: AbortSignal | undefined;
    // The run never finishes by itself here: it is stuck closing something.
    const harness = runCli((request) => {
      signal = request.signal;
      return new Promise<RunOutcome>(() => {});
    });
    cli = harness.cli;
    void cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    await until(() => cli.listeners() === 1, 10_000, 'the run to listen for Ctrl-C');
    cli.interrupt();
    expect(signal?.aborted).toBe(true);
    let thrown: unknown;
    try {
      cli.interrupt();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExitCalled);
    expect((thrown as ExitCalled).code).toBe(1);
    expect(cli.err()).toContain('Interrupted again: exiting at once.');
    expect(cli.err().match(/Interrupted \(/g)).toHaveLength(1);
  });

  it('still exits 1 when the run finished with a verdict just as Ctrl-C arrived', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const harness = runCli(async (request) => {
      await gate;
      return outcomeOf(request, { status: 'completed', score: 1 });
    });
    cli = harness.cli;
    const done = cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    await until(() => cli.listeners() === 1, 10_000, 'the run to listen for Ctrl-C');
    cli.interrupt();
    finish();
    expect(await done).toBe(1);
  });

  it('does not leave a signal listener behind after a failed run', async () => {
    const harness = runCli(() => {
      throw new Error('boom');
    });
    cli = harness.cli;
    await cli.run('run', 'vida-laboral-sin-datos', '--scenario', 'x');
    expect(cli.listeners()).toBe(0);
  });
});

describe('eval run: live progress from the run folder', () => {
  it('prints a line per tool call, prompt and bench event the run writes, with the time since the start', async () => {
    const harness = runCli(async (request) => {
      const dir = join(request.runsRoot as string, request.runId as string);
      mkdirSync(dir, { recursive: true });
      const at = (seconds: number) =>
        new Date(cli.clock.now.getTime() + seconds * 1000).toISOString();
      const lines = [
        // The copied prefix of a resumed run is older than this command: not shown again.
        {
          seq: 1,
          t: '2026-10-17T09:00:00.000Z',
          type: 'tool_start',
          agent: 'assistant',
          tool: 'old_tool',
        },
        {
          seq: 2,
          t: at(1),
          type: 'tool_start',
          agent: 'assistant',
          toolCallId: 'a',
          tool: 'procedure_start',
          args: { secret: 'S3CR3T-ARGUMENT' },
        },
        {
          seq: 3,
          t: at(2),
          type: 'tool_start',
          agent: 'procedure',
          procedureId: 'p1',
          toolCallId: 'b',
          tool: 'browser_navigate',
          args: {},
        },
        {
          seq: 4,
          t: at(2),
          type: 'assistant_message',
          agent: 'assistant',
          text: 'MESSAGE-TEXT-NOT-SHOWN',
        },
        {
          seq: 5,
          t: at(3),
          type: 'prompt_shown',
          prompt: {
            itemId: 'i',
            agent: 'procedure',
            kind: 'form',
            title: 'Elige cómo identificarte',
          },
        },
        { seq: 6, t: at(3), type: 'prompt_answered', itemId: 'i', by: 'structured' },
        {
          seq: 7,
          t: at(4),
          type: 'bench',
          what: 'wrong_turn',
          data: { host: 'portal.seg-social.gob.es', path: '/nada' },
        },
        { seq: 8, t: at(65), type: 'quiescent' },
        { seq: 9, t: at(66), type: 'note', text: 'run ended: quiescent' },
        { seq: 10, t: at(66), type: 'net', record: { route: 'mapped' } },
      ];
      writeFileSync(
        join(dir, 'events.jsonl'),
        `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      );
      return outcomeOf(request);
    });
    cli = harness.cli;
    await cli.run(
      'run',
      'vida-laboral-sin-datos',
      '--scenario',
      'x',
      '--runs-root',
      cli.runsRoot,
      '--run-id',
      'live',
    );
    const err = cli.err();
    expect(err).toContain('[+1 s] assistant: procedure_start\n');
    expect(err).toContain('[+2 s] procedure p1: browser_navigate\n');
    expect(err).toContain('[+3 s] prompt (form): Elige cómo identificarte\n');
    expect(err).toContain('[+3 s] prompt answered (structured)\n');
    expect(err).toContain('[+4 s] SpainBench: wrong turn portal.seg-social.gob.es/nada\n');
    expect(err).toContain('[+1 min 5 s] the agents are quiet\n');
    expect(err).toContain('[+1 min 6 s] note: run ended: quiescent\n');
    expect(err).not.toContain('old_tool');
    expect(err).not.toContain('S3CR3T-ARGUMENT');
    expect(err).not.toContain('MESSAGE-TEXT-NOT-SHOWN');
    expect(err).not.toContain('mapped');
  });
});
