/**
 * A question that no answer of the fixture covers: the fixture's policy decides. The answerer (the
 * cheap model that plays the user; here the default of the scripted models, a person with nothing
 * to say) answers it and the run goes on, or, under the `fail` policy, the run ends as
 * `unexpected-prompt`: aborted, with no score, the prompt left unanswered.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { getFixture } from '../../src/fixtures';
import { ensureEvalHostBundle } from '../../src/run/app';
import {
  cleanup,
  descendants,
  e2eSuite,
  evaluate,
  expectNoEgress,
  leftovers,
  observations,
  readJson,
  readLines,
  readRun,
  workspace,
} from './harness';
import { asksProvince } from './scenarios';

afterAll(() => {
  cleanup();
  expectNoEgress();
});

const FIXTURE = 'vida-laboral-sin-datos';

e2eSuite('a question nobody scripted, on the real SpainBench', () => {
  const space = workspace();
  let known = new Set<number>();
  beforeAll(async () => {
    await ensureEvalHostBundle();
    known = new Set(descendants().map((row) => row.pid));
  }, 120_000);

  it('goes to the answerer, which never leaves the run waiting', async () => {
    const outcome = await evaluate(space, { fixtureId: FIXTURE, scenario: asksProvince(FIXTURE) });
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({
      status: 'completed',
      score: 1,
      endedBy: 'quiescent',
      notes: [],
    });

    // Three prompts: how to log in and the credential (scripted), and the province (not).
    const prompts = observations(run.events, 'prompt_shown').map((e) => e.prompt);
    expect(prompts.map((prompt) => prompt.title)).toEqual([
      '¿Cómo te identificas?',
      '¿En qué provincia vives?',
      'Añade tu Cl@ve Permanente',
    ]);
    const answers = observations(run.events, 'prompt_answered');
    expect(answers.map((answer) => [answer.answerId ?? null, answer.by])).toEqual([
      ['choose-clave-permanente', 'structured'],
      [null, 'answerer'],
      ['clave-permanente-credential', 'structured'],
    ]);

    // The answerer saw the persona and the question, and said it did not know: the form was dismissed.
    const folder = join(outcome.runDir, 'answerer');
    expect(readdirSync(folder)).toEqual(['001-1.json']);
    const call = readJson<{
      model: string;
      request: { system: string; messages: { role: string; text: string }[] };
      response: { text: string };
      parsed: { type: string; values: unknown; skipped: string[] };
    }>(join(folder, '001-1.json'));
    expect(call.model).toBe('anthropic/claude-haiku-5.5');
    expect(call.request.system).toContain('You play the user');
    expect(call.request.system).toContain('Lucía Moreno Castillo');
    expect(call.request.messages[0]?.text).toContain('¿En qué provincia vives?');
    expect(call.response.text).toBe('{"provincia": null}');
    expect(call.parsed).toEqual({ type: 'values', values: {}, skipped: ['provincia'] });
    const asked = observations(run.events, 'tool_end').find(
      (event) => event.tool === 'ask_user' && event.agent === 'procedure',
    );
    expect(asked?.text).toBe('The user dismissed the form without answering.');

    // It went through the same meter as the agents, under its own key.
    const agents = readLines<{ agent: string }>(join(outcome.runDir, 'llm', 'meter.jsonl')).map(
      (line) => line.agent,
    );
    expect(agents).toContain('answerer');
    expect(agents.filter((agent) => agent === 'answerer')).toHaveLength(1);
    expect(await leftovers(known)).toEqual([]);
  }, 240_000);

  it('ends the run as unexpected-prompt under the fail policy', async () => {
    // No fixture of the suite fails on a question it did not script: this one does, for the run.
    const fixture = getFixture(FIXTURE);
    const policy = fixture.unexpectedPrompt;
    fixture.unexpectedPrompt = 'fail';
    let outcome: Awaited<ReturnType<typeof evaluate>>;
    try {
      outcome = await evaluate(space, { fixtureId: FIXTURE, scenario: asksProvince(FIXTURE) });
    } finally {
      fixture.unexpectedPrompt = policy;
    }
    const run = readRun(outcome);
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      scoreBeforePenalty: null,
      endedBy: 'unexpected-prompt',
    });
    const shown = observations(run.events, 'prompt_shown').map((e) => e.prompt);
    const province = shown.find((prompt) => prompt.title === '¿En qué provincia vives?');
    expect(province).toBeDefined();
    expect(outcome.result.notes[0]).toBe(
      `unexpected-prompt:${province?.itemId}: unexpected prompt: procedure form "¿En qué provincia vives?"`,
    );
    // The prompt was left unanswered, the run did not go on to the credential, and the answerer
    // was never asked.
    expect(
      observations(run.events, 'prompt_answered').map((answer) => answer.answerId ?? null),
    ).toEqual(['choose-clave-permanente']);
    expect(shown.map((prompt) => prompt.kind)).toEqual(['form', 'form']);
    expect(existsSync(join(outcome.runDir, 'answerer'))).toBe(false);
    expect(outcome.result.rules.find((rule) => rule.ruleId === 'pdf-saved-complete')?.matched).toBe(
      false,
    );
    expect(outcome.checkpoints).toEqual([]);
    expect(await leftovers(known)).toEqual([]);
  }, 240_000);
});
