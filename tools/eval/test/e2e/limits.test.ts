/**
 * How a run ends when it is cut off: a limit of the fixture, or the caller's signal. Each ends
 * cleanly: the result and the artifacts are written, and nothing is left running (no agent host,
 * no Chromium, no SpainBench server) or listening (the meter proxy, SpainBench's two ports).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioInput } from '@sa/mock-llm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { RUN_LIMITS } from '../../src/fixtures';
import { ensureEvalHostBundle } from '../../src/run/app';
import { mockScenario } from '../../src/scenarios';
import {
  cleanup,
  descendants,
  e2eSuite,
  evaluate,
  expectNoEgress,
  leftovers,
  listening,
  observations,
  portsOf,
  readLines,
  readRun,
  until,
  workspace,
} from './harness';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

const FIXTURE = 'vida-laboral-con-datos';

/** A model that never stops asking for the saved data. */
const LOOP: ScenarioInput = {
  name: 'loop',
  rules: [],
  fallback: { toolCalls: [{ id: 'again', name: 'vault_read', arguments: {} }] },
};

/** The files every run leaves, however it ended. */
const ALWAYS = [
  'run.json',
  'result.json',
  'report.md',
  'events.jsonl',
  'bench/state.json',
  'bench/requests.jsonl',
  'llm/meter.jsonl',
  'net/browser.jsonl',
  'logs/main.log',
  'transcripts/assistant/session.jsonl',
];

e2eSuite('runs that are cut off, on the real SpainBench', () => {
  const space = workspace();
  let known = new Set<number>();
  beforeAll(async () => {
    // The host bundle is built once per process by a tool that stays around: not a leftover.
    await ensureEvalHostBundle();
    known = new Set(descendants().map((row) => row.pid));
  }, 120_000);

  /** Nothing of the run is running or listening. */
  async function expectNothingLeft(runDir: string, runId: string) {
    expect(await leftovers(known)).toEqual([]);
    const run = { events: readLines(join(runDir, 'events.jsonl')), result: { runId } } as never;
    const ports = portsOf(space.runsRoot, run);
    expect(ports.bench).toHaveLength(2);
    expect(ports.meter.length).toBeGreaterThan(0);
    for (const port of [...ports.bench, ...ports.meter]) {
      expect(await listening(port), `port ${port}`).toBe(false);
    }
  }

  function expectComplete(runDir: string) {
    for (const file of ALWAYS) expect(existsSync(join(runDir, file)), file).toBe(true);
  }

  it('a model that never stops hits the limit of tool calls and ends cleanly', async () => {
    const outcome = await evaluate(space, {
      fixtureId: FIXTURE,
      scenario: LOOP,
      limits: { maxToolCalls: 6 },
    });
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'limit:tool-calls',
    });
    expect(outcome.result.notes[0]).toBe('limit exceeded: 7 tool calls, at most 6');
    // A job not done before the limit fails its required rules; nothing else is lost.
    expect(
      run.result.rules.filter((r) => !r.passed && r.kind === 'required').map((r) => r.ruleId),
    ).toEqual(['pdf-saved-complete', 'login-clave-permanente']);
    expect(observations(run.events, 'tool_start').length).toBeGreaterThanOrEqual(7);
    expect(observations(run.events, 'tool_start').length).toBeLessThan(20);
    expectComplete(outcome.runDir);
    expect(outcome.checkpoints).toEqual([]);
    await expectNothingLeft(outcome.runDir, outcome.runId);
  }, 180_000);

  it("a model that never stops, under the fixture's own limits and the meter's default caps, is scored: its job was not done", async () => {
    // What a run gets when nothing is raised (as `eval run` does): 150 requests and $0.30 for the
    // run, against the meter's 200 per agent and 250 per run. The agent's looping is the agent's.
    const outcome = await evaluate(space, {
      fixtureId: FIXTURE,
      scenario: LOOP,
      meterLimits: {},
      limits: { ...RUN_LIMITS },
    });
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'limit:requests',
    });
    expect(outcome.result.notes[0]).toMatch(/^limit exceeded: 151 model requests, at most 150$/);
    expect(outcome.result.usage.requests).toBeLessThan(160);
    // Not the harness running out of money: no `limit:budget`, a score, a verdict on the rules.
    expect(run.result.rules.filter((r) => !r.passed && r.kind === 'required')).not.toEqual([]);
    expectComplete(outcome.runDir);
    await expectNothingLeft(outcome.runDir, outcome.runId);
  }, 180_000);

  it('a slow model hits the wall clock and the request in flight is cut', async () => {
    const outcome = await evaluate(space, {
      fixtureId: FIXTURE,
      scenario: {
        name: 'slow',
        rules: [],
        fallback: {
          delayMs: 1500,
          toolCalls: [{ id: 'again', name: 'vault_read', arguments: {} }],
        },
      },
      limits: { wallClockMs: 4000 },
    });
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'limit:wall-clock',
    });
    expect(outcome.result.notes[0]).toBe('limit exceeded: 4000 ms of wall-clock time');
    expect(outcome.result.durationMs).toBeGreaterThanOrEqual(3900);
    expect(outcome.result.durationMs).toBeLessThan(15_000);
    expectComplete(outcome.runDir);
    await expectNothingLeft(outcome.runDir, outcome.runId);
  }, 180_000);

  it('a run over its cost limit ends as limit:cost and no more is spent', async () => {
    const limit = 0.01;
    const outcome = await evaluate(space, {
      fixtureId: FIXTURE,
      scenario: LOOP,
      limits: { maxCostUsd: limit },
    });
    expect(outcome.result).toMatchObject({ status: 'failed_required', endedBy: 'limit:cost' });
    // Either the usage went over the limit, or the meter refused the next request for the
    // worst it could cost: both are this limit.
    expect(outcome.result.notes[0]).toMatch(/^limit exceeded: .*\$0\.\d+/);
    expectComplete(outcome.runDir);
    expect(outcome.result.usage.costUsd).toBeGreaterThan(0);
    expect(outcome.result.usage.costUsd).toBeLessThan(limit * 2);
    expect(outcome.result.usage.requests).toBeLessThan(40);
    await expectNothingLeft(outcome.runDir, outcome.runId);
  }, 180_000);

  it('a run that asks the user too much ends as limit:prompts', async () => {
    const fixtureId = 'vida-laboral-sin-datos';
    const outcome = await evaluate(space, {
      fixtureId,
      scenario: mockScenario(fixtureId, 'oracle'),
      limits: { maxPrompts: 1 },
    });
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({ status: 'failed_required', endedBy: 'limit:prompts' });
    expect(outcome.result.notes[0]).toBe('limit exceeded: 2 prompts, at most 1');
    expect(observations(run.events, 'prompt_shown')).toHaveLength(2);
    expectComplete(outcome.runDir);
    await expectNothingLeft(outcome.runDir, outcome.runId);
  }, 180_000);

  it('the signal of the caller ends a run in progress as abort, with nothing left behind', async () => {
    const controller = new AbortController();
    const runId = 'e2e-abort-mid-run';
    const eventsFile = join(space.runsRoot, runId, 'events.jsonl');
    const running = evaluate(space, {
      fixtureId: FIXTURE,
      scenario: mockScenario(FIXTURE, 'oracle'),
      runId,
      signal: controller.signal,
    });
    // Wait until the procedure's agent is in the browser: everything is up and running.
    await until(
      () =>
        existsSync(eventsFile) &&
        readFileSync(eventsFile, 'utf8').includes('"tool":"browser_click"'),
      'the agent to be in the browser',
    );
    controller.abort();
    const outcome = await running;
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      scoreBeforePenalty: null,
      endedBy: 'abort',
    });
    expect(outcome.result.notes[0]).toBe('aborted by the caller');
    expectComplete(outcome.runDir);
    // No score, but the rules judged nothing and no checkpoint pretends the run was finished.
    expect(outcome.checkpoints).toEqual([]);
    await expectNothingLeft(outcome.runDir, outcome.runId);

    // The model is not called after the run: the ledger does not grow.
    const lines = () => readLines(join(outcome.runDir, 'llm', 'meter.jsonl')).length;
    const before = lines();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(lines()).toBe(before);
  }, 180_000);

  it('a signal that is already aborted ends the run before anything starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await evaluate(space, {
      fixtureId: FIXTURE,
      scenario: mockScenario(FIXTURE, 'oracle'),
      signal: controller.signal,
    });
    expect(outcome.result).toMatchObject({ status: 'aborted', score: null, endedBy: 'abort' });
    expect(outcome.result.usage.requests).toBe(0);
    expect(await leftovers(known)).toEqual([]);
  }, 120_000);
});
