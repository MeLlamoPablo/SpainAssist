/**
 * The documented replay flow with the CLI's default provider: `eval run <fixture> --provider
 * voucher --cache replay` needs no key file, no key server and no gateway. A recording made with
 * the mock model is copied into the voucher's cache scope (the voucher and the mock send the same
 * requests: the same product prompt, tools and model id), and a voucher run in an empty home
 * replays it: every request is a hit, nothing is spent and nothing leaves the machine.
 */
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import type { RunResult } from '../../src/contracts';
import { runEvaluation } from '../../src/runner';
import { mockScenario } from '../../src/scenarios';
import { cleanup, e2eSuite, evaluate, expectNoEgress, readLines, workspace } from './harness';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

e2eSuite('replaying a recording with the voucher provider', () => {
  it('needs no credential, no key server and no gateway', async () => {
    const fixtureId = 'vida-laboral-sin-datos';
    const space = workspace();
    const recorded = await evaluate(space, {
      fixtureId,
      cache: 'record',
      scenario: mockScenario(fixtureId, 'oracle'),
    });
    expect(recorded.result).toMatchObject({ status: 'completed', score: 1 });

    const cache = join(space.home, 'llm-cache');
    cpSync(join(cache, 'mock'), join(cache, 'voucher'), { recursive: true });
    expect(existsSync(join(space.home, 'litellm.json'))).toBe(false);

    const replayed = await runEvaluation({
      fixtureId,
      provider: 'voucher',
      cache: 'replay',
      runsRoot: space.runsRoot,
      home: space.home,
      env: { SPAINBENCH_DIR: process.env.SPAINBENCH_DIR },
      // The key server is not asked in a replay: a refusal here would be the old behaviour.
      offlineBudget: true,
      shutdownTimeoutMs: 90_000,
    });
    expect(replayed.result).toMatchObject({
      status: 'completed',
      score: 1,
      endedBy: 'quiescent',
      notes: [],
      provider: 'voucher',
    });
    expect(replayed.result.usage).toMatchObject({
      requests: recorded.result.usage.requests,
      cacheHits: recorded.result.usage.requests,
      costUsd: 0,
    });
    const lines = readLines<{ kind: string; provider: string; loose?: boolean }>(
      join(replayed.runDir, 'llm', 'meter.jsonl'),
    );
    expect(lines.every((line) => line.kind === 'replay' && line.provider === 'voucher')).toBe(true);

    // A replay says how much of it was not an exact replay of the recording (the browser caught a
    // redirect at another hop in some runs): in the result, the report and the summary line.
    const loose = lines.filter((line) => line.loose).length;
    const { requests } = replayed.result.usage;
    expect(replayed.result.usage.looseHits).toBe(loose);
    const replayLine = `${requests} of ${requests} requests replayed (${loose} loose)`;
    expect(replayed.summary).toContain(replayLine);
    expect(readFileSync(join(replayed.runDir, 'report.md'), 'utf8')).toContain(
      `**${replayLine}.**`,
    );
    expect(
      (JSON.parse(readFileSync(join(replayed.runDir, 'result.json'), 'utf8')) as RunResult).usage
        .looseHits,
    ).toBe(loose);
  }, 360_000);
});
