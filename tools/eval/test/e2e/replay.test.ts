/**
 * The record/replay cache through the whole suite: a run recorded with the oracle is replayed by a
 * model that would have done something else, and the second run is the first again: the same tool
 * calls on the same pages, the same score, at no cost and with no request to the model. A
 * conversation nobody recorded ends the run as a replay miss, with no score.
 */
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { mockScenario } from '../../src/scenarios';
import {
  cleanup,
  e2eSuite,
  evaluate,
  expectNoEgress,
  observations,
  readLines,
  readRun,
  toolCallSignature,
  vaultDocuments,
  workspace,
} from './harness';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

interface LedgerLine {
  kind: string;
  cache?: string;
  loose?: boolean;
  cost?: { usd: number; virtual?: boolean };
}

const ledger = (runDir: string) => readLines<LedgerLine>(join(runDir, 'llm', 'meter.jsonl'));

/** The ids a run's agents were given (documents, downloads, credentials): they differ in every run. */
const idsIn = (text: string) =>
  new Set(
    text.match(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\bdl_[0-9a-f]{16}\b/gi,
    ),
  );

e2eSuite('the replay cache on the real SpainBench', () => {
  const space = workspace();
  const fixtureId = 'vida-laboral-sin-datos';

  it('replays a recorded run as the same run, for free, whatever the model would say now', async () => {
    const recorded = await evaluate(space, {
      fixtureId,
      cache: 'record',
      scenario: mockScenario(fixtureId, 'oracle'),
    });
    const first = readRun(recorded);
    expect(recorded.result).toMatchObject({ status: 'completed', score: 1, endedBy: 'quiescent' });
    expect(recorded.result.usage.costUsd).toBeGreaterThan(0);
    expect(ledger(recorded.runDir).map((line) => line.kind)).not.toContain('replay');

    // The model of the second run is a lost one: it would wander and ask nothing, but it is never asked.
    const replayed = await evaluate(space, {
      fixtureId,
      cache: 'replay',
      scenario: mockScenario(fixtureId, 'lost'),
    });
    const second = readRun(replayed);
    expect(replayed.result).toMatchObject({
      status: 'completed',
      score: 1,
      scoreBeforePenalty: 1,
      wrongTurns: 0,
      endedBy: 'quiescent',
      notes: [],
    });
    expect(second.result.rules.map((r) => [r.ruleId, r.passed])).toEqual(
      first.result.rules.map((r) => [r.ruleId, r.passed]),
    );

    // The same tool calls (the ids the app mints aside), the same prompts, the same answers.
    expect(toolCallSignature(second.events)).toEqual(toolCallSignature(first.events));
    const prompts = (events: typeof first.events) =>
      observations(events, 'prompt_shown').map((e) => [
        e.prompt.agent,
        e.prompt.kind,
        e.prompt.title,
      ]);
    expect(prompts(second.events)).toEqual(prompts(first.events));
    expect(observations(second.events, 'prompt_answered').map((a) => a.answerId)).toEqual(
      observations(first.events, 'prompt_answered').map((a) => a.answerId),
    );

    // Nothing went to the model: every request was a hit, and none cost anything.
    const lines = ledger(replayed.runDir);
    expect(lines.length).toBe(ledger(recorded.runDir).length);
    expect(lines.every((line) => line.kind === 'replay' && line.cache === 'hit')).toBe(true);
    expect(lines.every((line) => line.cost?.virtual === true)).toBe(true);
    expect(replayed.result.usage).toMatchObject({
      requests: recorded.result.usage.requests,
      cacheHits: recorded.result.usage.requests,
      costUsd: 0,
    });
    expect(replayed.summary).toContain('$0.0000');

    // The answers named the ids of the first run; the second run's agents got their own back: the
    // report that was saved is the one in this run's vault, linked by the message that says so.
    const [document] = await vaultDocuments(join(second.dir, 'profile'));
    const [firstDocument] = await vaultDocuments(join(first.dir, 'profile'));
    expect(document?.id).not.toBe(firstDocument?.id);
    const link = observations(second.events, 'assistant_message')
      .filter((message) => message.agent === 'assistant')
      .at(-1)?.text;
    expect(link).toContain(`sa:document/${document?.id}`);
    const downloads = observations(second.events, 'tool_start')
      .filter((event) => event.tool === 'download_save')
      .map((event) => (event.args as { downloadId: string }).downloadId);
    const shown = idsIn(
      observations(second.events, 'tool_end')
        .map((event) => event.text)
        .join('\n'),
    );
    expect(downloads).toHaveLength(1);
    expect(shown.has(downloads[0] as string)).toBe(true);
    const before = idsIn(JSON.stringify(first.events));
    expect(before.has(downloads[0] as string)).toBe(false);
    expect(second.state.downloads).toHaveLength(1);
  }, 360_000);

  it('ends a run whose conversation was never recorded as a replay miss: aborted, no score', async () => {
    // Fixture 2 starts as fixture 1 does and then meets another vault: the recording is not its own.
    const other = 'vida-laboral-con-datos';
    const outcome = await evaluate(space, {
      fixtureId: other,
      cache: 'replay',
      scenario: mockScenario(other, 'oracle'),
    });
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      scoreBeforePenalty: null,
      endedBy: 'replay-miss',
    });
    expect(outcome.result.notes[0]).toMatch(/^replay-miss \(assistant\): Replay cache miss/);
    expect(outcome.result.notes[0]).toContain('differs');
    expect(outcome.result.usage.costUsd).toBe(0);
    const lines = ledger(outcome.runDir);
    expect(lines.map((line) => line.kind)).toEqual(['replay', 'reject']);
    expect(run.events.some((event) => event.type === 'quiescent')).toBe(false);
    expect(outcome.checkpoints).toEqual([]);
  }, 180_000);

  it('says so when nothing is recorded at all', async () => {
    const empty = workspace();
    const outcome = await evaluate(empty, {
      fixtureId: fixtureId,
      cache: 'replay',
      scenario: mockScenario(fixtureId, 'oracle'),
    });
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      endedBy: 'replay-miss',
    });
    expect(outcome.result.notes[0]).toContain('nothing is recorded');
  }, 180_000);
});
