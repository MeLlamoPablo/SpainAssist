/**
 * A model that wanders into pages that are not on the way before it finds the job: SpainBench
 * counts the wrong turns, the scoring takes 0.05 off for each, and the run still passes its
 * required rules.
 */
import { afterAll, expect, it } from 'vitest';
import { mockScenario } from '../../src/scenarios';
import {
  cleanup,
  e2eSuite,
  evaluate,
  expectNoEgress,
  observations,
  readRun,
  workspace,
} from './harness';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

/** The score as the scoring part computes it: 0.05 a wrong turn, at most 0.5. */
const penalty = (turns: number) => Math.min(turns * 0.05, 0.5);

e2eSuite('a lost model on the real SpainBench', () => {
  const space = workspace();

  it.concurrent.each(['vida-laboral-con-datos', 'vida-laboral-sin-datos'])(
    '%s: wrong turns are counted by the server and cost score, the job is still done',
    async (fixtureId) => {
      const outcome = await evaluate(space, {
        fixtureId,
        scenario: mockScenario(fixtureId, 'lost'),
      });
      const run = readRun(outcome);
      const turns = run.state.wrongTurns;
      // The wrong turns of the result are the server's, and they are of every kind the model met:
      // a page the site does not have, a host of the same administration the mock leaves out and
      // a page the site answers but leaves out of the simulation.
      expect(turns.count).toBeGreaterThanOrEqual(3);
      expect(outcome.result.wrongTurns).toBe(turns.count);
      expect(new Set(turns.items.map((item) => item.kind))).toEqual(
        new Set(['not-found', 'unknown-host', 'out-of-scope']),
      );
      expect(observations(run.events, 'bench').filter((e) => e.what === 'wrong_turn')).toHaveLength(
        turns.count,
      );

      // The job was done and every rule passed: only the penalty separates it from the oracle.
      expect(outcome.result).toMatchObject({
        status: 'completed',
        scoreBeforePenalty: 1,
        endedBy: 'quiescent',
        notes: [],
      });
      expect(run.result.rules.filter((rule) => !rule.passed)).toEqual([]);
      expect(outcome.result.score).toBeCloseTo(1 - penalty(turns.count), 10);
      expect(outcome.result.score).toBeLessThan(1);
      expect(run.state.downloads).toHaveLength(1);
    },
    300_000,
  );
});
