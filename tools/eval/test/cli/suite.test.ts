import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { suiteExit } from '../../src/cli/exit';
import type { RunResult } from '../../src/contracts';
import type { RunOutcome } from '../../src/run';
import { summarizeResult } from '../../src/run/results';
import { EvaluationRefused, type EvaluationRequest } from '../../src/runner';
import { mockScenario, NotScriptedError } from '../../src/scenarios';
import { emptyMeterUsage } from '../../src/scoring';
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
    score: 1,
    scoreBeforePenalty: 1,
    wrongTurns: 0,
    rules: [],
    usage: { ...emptyMeterUsage(), costUsd: 0.01 },
    durationMs: 1000,
    endedBy: 'quiescent',
    notes: [],
    ...overrides,
  };
}

function outcomeOf(
  request: EvaluationRequest,
  overrides: (fixtureId: string) => Partial<RunResult> = () => ({}),
): RunOutcome {
  const result = resultOf({
    runId: request.runId ?? 'r',
    fixtureId: request.fixtureId,
    provider: request.provider,
    ...overrides(request.fixtureId),
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

function suiteCli(
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

/** The injection run the tests below single out. */
const INJ = 'vida-laboral-inyeccion:assistant-notice';
const VIDA_LABORAL = [
  'vida-laboral-sin-datos',
  'vida-laboral-con-datos',
  INJ,
  'vida-laboral-inyeccion:fake-verification',
  'vida-laboral-inyeccion:page-title',
  'vida-laboral-inyeccion:hidden-text',
];
/** The DNI and the vehicle transfer fixtures, which have no mock scenario. */
const DNI = [
  'dni-renovacion-sin-datos',
  'dni-renovacion-caduca-pronto',
  'dni-renovacion-no-elegible',
];
const TRANSFER = [
  'transferencia-con-datos',
  'transferencia-sin-datos',
  'transferencia-reserva-dominio',
  'transferencia-ciclomotor',
  'transferencia-sin-itp',
  'transferencia-empresa',
];
const ALL = [...VIDA_LABORAL, ...DNI, ...TRANSFER];

describe('eval suite: the fixtures one after the other', () => {
  it('plays the full run in order (fixtures 1 and 2, then each injection variant, then the DNI and transfer fixtures) with the options of run, each in a folder of its own', async () => {
    const harness = suiteCli();
    cli = harness.cli;
    const code = await cli.run(
      'suite',
      '--scenario',
      'oracle',
      '--cache-variant',
      'b',
      '--max-cost',
      '0.2',
      '--max-requests',
      '60',
      '--assistant-model',
      'model-a',
      '--capture-browser',
      '--runs-root',
      'where',
    );
    expect(code).toBe(0);
    expect(harness.requests.map((request) => request.fixtureId)).toEqual(ALL);
    for (const request of harness.requests) {
      expect(request).toMatchObject({
        provider: 'mock',
        scenario: SCENARIO,
        cacheVariant: 'b',
        limits: { maxCostUsd: 0.2, maxRequests: 60 },
        models: { assistantModel: 'model-a' },
        captureBrowser: true,
        runsRoot: join(cli.cwd, 'where'),
        env: cli.env,
        cwd: cli.cwd,
        handlesSignals: true,
      });
      // The fixture id, its `:` as `-`, cut so the run id fits 64 characters.
      expect(request.runId).toMatch(/-mock-20261017-100000-[0-9a-f]{4}$/);
      const runId = request.runId ?? '';
      expect(runId.length).toBeLessThanOrEqual(64);
      const slug = runId.replace(/-mock-20261017-100000-[0-9a-f]{4}$/, '');
      expect(request.fixtureId.replace(':', '-').startsWith(slug)).toBe(true);
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(request.chromiumPath?.()).toBe('/fake/chromium');
    }
    expect(new Set(harness.requests.map((request) => request.runId)).size).toBe(15);
    // Not for one checkpoint, one run id or a fixture change: they are about a single run.
    for (const request of harness.requests) {
      for (const key of ['from', 'allowFixtureChange']) expect(request).not.toHaveProperty(key);
    }
  });

  it('asks the scenario source for each fixture and the name, before anything starts', async () => {
    const asked: [string, string][] = [];
    const harness = suiteCli(undefined, {
      deps: {
        mockScenario: (fixtureId, name) => {
          asked.push([fixtureId, name]);
          return SCENARIO;
        },
      },
    });
    cli = harness.cli;
    await cli.run('suite', '--scenario', 'oracle');
    expect(asked).toEqual(ALL.map((id) => [id, 'oracle']));
  });

  it('prints one summary line per run, then the table and the mean, and nothing else on stdout', async () => {
    const harness = suiteCli((request) =>
      outcomeOf(request, (id) =>
        id === 'vida-laboral-con-datos' ? { score: 0.5 } : id === INJ ? { score: 0.75 } : {},
      ),
    );
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(0);
    const out = cli.out();
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^completed \(100\.0%\) \| vida-laboral-sin-datos \[mock\] \|/);
    expect(lines[1]).toMatch(/^completed \(50\.0%\) \| vida-laboral-con-datos \[mock\] \|/);
    expect(lines[2]).toMatch(
      /^completed \(75\.0%\) \| vida-laboral-inyeccion:assistant-notice \[mock\] \|/,
    );
    expect(lines[5]).toMatch(
      /^completed \(100\.0%\) \| vida-laboral-inyeccion:hidden-text \[mock\] \|/,
    );
    expect(lines[6]).toMatch(/^completed \(100\.0%\) \| dni-renovacion-sin-datos \[mock\] \|/);
    expect(lines[8]).toMatch(/^completed \(100\.0%\) \| dni-renovacion-no-elegible \[mock\] \|/);
    expect(lines[14]).toMatch(/^completed \(100\.0%\) \| transferencia-empresa \[mock\] \|/);
    expect(lines[15]).toBe('');
    expect(lines[16]).toMatch(/^\| Fixture \| Provider \| Status \| Score \|/);
    // (1 + 0.5 + 0.75 + 12 × 1) / 15 = 0.95
    expect(out).toContain('15 of 15 run(s) scored, mean 95.0%; total cost $0.1500.');
    // Progress went to stderr.
    expect(cli.err()).toMatch(/Run vida-laboral-sin-datos-mock-.*\[1 of 15\]/);
    expect(cli.err()).toMatch(/Run vida-laboral-inyeccion-assistant-notic-mock-.*\[3 of 15\]/);
    expect(cli.err()).toMatch(/Run vida-laboral-inyeccion-hidden-text-mock-.*\[6 of 15\]/);
    expect(cli.err()).toMatch(/Run dni-renovacion-no-elegible-mock-.*\[9 of 15\]/);
    expect(cli.err()).toMatch(/Run transferencia-empresa-mock-.*\[15 of 15\]/);
  });

  it('writes nothing to disk: the runs are the only folders', async () => {
    const harness = suiteCli();
    cli = harness.cli;
    await cli.run('suite', '--scenario', 'x');
    expect(readdirSync(cli.dir).sort()).toEqual(['cwd', 'home']);
  });

  it('plays only the fixtures named, injection variants included', async () => {
    const harness = suiteCli();
    cli = harness.cli;
    expect(
      await cli.run(
        'suite',
        '--scenario',
        'x',
        'vida-laboral-inyeccion:page-title',
        'vida-laboral-con-datos',
      ),
    ).toBe(0);
    expect(harness.requests.map((request) => request.fixtureId)).toEqual([
      'vida-laboral-inyeccion:page-title',
      'vida-laboral-con-datos',
    ]);
  });

  it('--json prints the results of all runs on stdout and the table on stderr', async () => {
    const harness = suiteCli();
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x', '--json')).toBe(0);
    const results = JSON.parse(cli.out()) as RunResult[];
    expect(results.map((r) => r.fixtureId)).toEqual(ALL);
    expect(cli.err()).toMatch(/\| Fixture \| Provider \| Status \|/);
    expect(cli.err()).toMatch(/^completed \(100\.0%\) \| vida-laboral-sin-datos/m);
  });
});

describe('eval suite: the exit code', () => {
  it.each([
    ['error', null],
    ['aborted', null],
  ] as const)(
    'any run that %s fails the suite, and the others still run',
    async (status, score) => {
      const harness = suiteCli((request) =>
        outcomeOf(request, (id) => (id === 'vida-laboral-con-datos' ? { status, score } : {})),
      );
      cli = harness.cli;
      expect(await cli.run('suite', '--scenario', 'x')).toBe(1);
      expect(harness.requests).toHaveLength(15);
      expect(cli.err()).toContain(`vida-laboral-con-datos ended ${status}: it has no score`);
      expect(cli.out()).toContain('14 of 15 run(s) scored, mean 100.0%');
    },
  );

  it('a mean below --min-score fails it, with the numbers; at the bar it passes', async () => {
    // Three runs score below 1: the mean is (1 + 0.5 + 0.25 + 11 × 1 + 0) / 15 = 0.85.
    const scores: Record<string, number> = {
      'vida-laboral-con-datos': 0.5,
      [INJ]: 0.25,
      'dni-renovacion-no-elegible': 0,
    };
    const harness = suiteCli((request) => outcomeOf(request, (id) => ({ score: scores[id] ?? 1 })));
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '0.9')).toBe(1);
    expect(cli.err()).toMatch(/the mean score 0\.85 is below --min-score 0\.9/);
    cli.cleanup();
    cli = suiteCli((request) => outcomeOf(request, (id) => ({ score: scores[id] ?? 1 }))).cli;
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '0.85')).toBe(0);
  });

  it('a failed_required run exits 0 as in run, unless --min-score is given; the stderr says so', async () => {
    const harness = suiteCli((request) =>
      outcomeOf(request, (id) => (id === INJ ? { status: 'failed_required', score: 0 } : {})),
    );
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(0);
    expect(cli.err()).toContain(
      `${INJ} (failed_required): the exit code is 0 anyway: pass --min-score`,
    );
    cli.cleanup();
    cli = suiteCli((request) =>
      outcomeOf(request, (id) => (id === INJ ? { status: 'failed_required', score: 0 } : {})),
    ).cli;
    // Mean 14 / 15 = 0.9333...: a bar of 0.95 fails; the zero is in the mean, not hidden.
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '0.95')).toBe(1);
    expect(cli.err()).toMatch(/the mean score 0\.933333 is below --min-score 0\.95/);
  });

  it('with --min-score a run without a score, or cut short before its negated rules, fails it', async () => {
    const inconclusive = suiteCli((request) =>
      outcomeOf(request, (id) => (id === INJ ? { status: 'inconclusive', score: null } : {})),
    );
    cli = inconclusive.cli;
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '0.5')).toBe(1);
    expect(cli.err()).toMatch(
      /vida-laboral-inyeccion:assistant-notice is inconclusive and has no score/,
    );
    cli.cleanup();
    const cut = suiteCli((request) =>
      outcomeOf(request, (id) =>
        id === INJ ? { endedBy: 'settle-timeout', unsettledNegated: ['no-exfil'] } : {},
      ),
    );
    cli = cut.cli;
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '0.5')).toBe(1);
    expect(cli.err()).toMatch(/was cut short \(settle-timeout\) before no-exfil/);
    expect(cli.out()).toContain('completed (cut short)');
  });

  it('a run that cannot start stops the suite with the code of its refusal, after printing what ran', async () => {
    let calls = 0;
    const harness = suiteCli(async (request) => {
      calls++;
      if (calls === 2) throw new EvaluationRefused('No SpainBench to run against');
      return outcomeOf(request);
    });
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(2);
    expect(calls).toBe(2);
    expect(cli.err()).toContain('error: No SpainBench to run against');
    expect(cli.out()).toContain('1 of 1 run(s) scored, mean 100.0%');
  });

  it('refuses before starting anything: an unknown fixture, a scenario that does not fit, an empty option', async () => {
    const harness = suiteCli();
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x', 'nope')).toBe(2);
    expect(cli.err()).toMatch(/Unknown fixture "nope"/);
    expect(await cli.run('suite', '--scenario', 'x', '--provider', 'voucher')).toBe(2);
    expect(cli.err()).toMatch(/--scenario is the script of the mock model/);
    expect(await cli.run('suite', '--scenario', '')).toBe(2);
    expect(await cli.run('suite', '--scenario', 'x', '--min-score', '')).toBe(2);
    expect(harness.requests).toHaveLength(0);
  });

  it('the full run with a scenario skips the fixtures that have no script, and says so', async () => {
    const harness = suiteCli(undefined, { deps: { mockScenario } });
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'oracle')).toBe(0);
    expect(harness.requests.map((request) => request.fixtureId)).toEqual(VIDA_LABORAL);
    for (const request of harness.requests) {
      expect(request.scenario).toEqual(mockScenario(request.fixtureId, 'oracle'));
    }
    expect(cli.err()).toContain(
      `Skipping 9 fixture(s) with no "oracle" script: ${[...DNI, ...TRANSFER].join(', ')}\n`,
    );
    expect(cli.err()).toMatch(/\[6 of 6\]/);
    expect(cli.out()).toContain('6 of 6 run(s) scored, mean 100.0%');
    expect(cli.out()).not.toContain('dni-renovacion');
    expect(cli.out()).not.toContain('transferencia');
  });

  it('skips by the name of the error: any NotScriptedError, and only that', async () => {
    const harness = suiteCli(undefined, {
      deps: {
        mockScenario: (fixtureId, name) => {
          if (fixtureId === 'vida-laboral-con-datos') throw new NotScriptedError(fixtureId, name);
          if (fixtureId === 'dni-renovacion-sin-datos') {
            // An error from another copy of the module: the same name, another class.
            const error = new Error('not scripted here');
            error.name = 'NotScriptedError';
            throw error;
          }
          return SCENARIO;
        },
      },
    });
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(0);
    expect(harness.requests.map((request) => request.fixtureId)).toEqual(
      ALL.filter((id) => id !== 'vida-laboral-con-datos' && id !== 'dni-renovacion-sin-datos'),
    );
    expect(cli.err()).toContain(
      'Skipping 2 fixture(s) with no "x" script: vida-laboral-con-datos, dni-renovacion-sin-datos\n',
    );
  });

  it('a fixture named without a script is still a usage error, and nothing starts', async () => {
    const harness = suiteCli(undefined, { deps: { mockScenario } });
    cli = harness.cli;
    expect(
      await cli.run(
        'suite',
        '--scenario',
        'oracle',
        'vida-laboral-sin-datos',
        'dni-renovacion-no-elegible',
      ),
    ).toBe(2);
    expect(cli.err()).toMatch(
      /Scenario "oracle" for dni-renovacion-no-elegible: No mock scenario "oracle" for fixture "dni-renovacion-no-elegible": it is not scripted/,
    );
    expect(cli.err()).not.toContain('Skipping');
    expect(harness.requests).toHaveLength(0);
  });

  it('a scenario the source rejects is a usage error that names the fixture', async () => {
    const harness = suiteCli(undefined, {
      deps: {
        mockScenario: (fixtureId) => {
          if (fixtureId === INJ) throw new Error('no such scenario');
          return SCENARIO;
        },
      },
    });
    cli = harness.cli;
    expect(await cli.run('suite', '--scenario', 'wat')).toBe(2);
    expect(cli.err()).toMatch(
      /Scenario "wat" for vida-laboral-inyeccion:assistant-notice: no such scenario/,
    );
    expect(harness.requests).toHaveLength(0);
  });
});

describe('eval suite: Ctrl-C', () => {
  it('ends the run in progress as an abort, skips the rest and exits 1 with the table of what ran', async () => {
    let cliRef: Cli | undefined;
    let calls = 0;
    const harness = suiteCli(async (request) => {
      calls++;
      if (calls === 2) {
        cliRef?.interrupt();
        expect(request.signal?.aborted).toBe(true);
        return outcomeOf(request, () => ({ status: 'aborted', score: null, endedBy: 'abort' }));
      }
      return outcomeOf(request);
    });
    cli = harness.cli;
    cliRef = cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(1);
    expect(calls).toBe(2);
    expect(cli.err()).toMatch(/Interrupted \(SIGINT\): ending the run in progress/);
    expect(cli.out()).toContain('aborted (no score)');
    expect(cli.listeners()).toBe(0);
  });

  it('a second Ctrl-C exits at once', async () => {
    let cliRef: Cli | undefined;
    let secondExit: unknown;
    const harness = suiteCli(async (request) => {
      cliRef?.interrupt();
      try {
        cliRef?.interrupt();
      } catch (error) {
        secondExit = error;
      }
      return outcomeOf(request, () => ({ status: 'aborted', score: null, endedBy: 'abort' }));
    });
    cli = harness.cli;
    cliRef = cli;
    expect(await cli.run('suite', '--scenario', 'x')).toBe(1);
    expect(secondExit).toBeInstanceOf(ExitCalled);
    expect((secondExit as ExitCalled).code).toBe(1);
    expect(cli.err()).toContain('Interrupted again: exiting at once.');
  });
});

describe('suiteExit', () => {
  it('is 0 for results that all have a verdict, and says nothing', () => {
    expect(suiteExit([resultOf(), resultOf({ status: 'failed_required', score: 0 })])).toEqual({
      code: 0,
      reasons: [],
    });
    expect(suiteExit([])).toEqual({ code: 0, reasons: [] });
  });

  it('collects every reason', () => {
    const verdict = suiteExit(
      [
        resultOf({ fixtureId: 'a', status: 'error', score: null }),
        resultOf({ fixtureId: 'b', status: 'inconclusive', score: null }),
        resultOf({ fixtureId: 'c', score: 0.2 }),
      ],
      0.5,
    );
    expect(verdict.code).toBe(1);
    expect(verdict.reasons).toEqual([
      'a ended error: it has no score',
      'b is inconclusive and has no score, so --min-score 0.5 is not met',
      'the mean score 0.2 is below --min-score 0.5',
    ]);
  });
});
