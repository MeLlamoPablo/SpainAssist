import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Observation, RunResult } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import { CheckpointError } from '../../src/run';
import { credentialRequest, methodsPrompt } from '../fixtures/support/play';
import { prompt } from '../rules/support/run';
import {
  createEnv,
  type Env,
  fakeAnswerer,
  listFiles,
  miniFixture,
  noteTexts,
  readEventsFile,
  readJson,
} from './support/harness';
import type { Script, ScriptContext } from './support/scripted-app';
import { logIn, saveReportAndTell, startProcedure } from './support/vida';

let env: Env;
afterEach(() => env?.dispose());

/** Phase 1 of a fixture 1 run: up to the login. Phase 2: the report. */
async function phase1(ctx: ScriptContext): Promise<void> {
  startProcedure(ctx);
  await ctx.ask(methodsPrompt());
  await ctx.ask(credentialRequest('cred-1'));
  ctx.vaultChanged();
  logIn(ctx);
  // A wrong turn on the way, which both runs must count.
  ctx.bench.wrongTurn(ctx.spec.runId);
  ctx.bench.emit(ctx.spec.runId, 'wrong_turn', { path: '/missing/1' });
  ctx.state.phase1 = true;
}

async function phase2(ctx: ScriptContext): Promise<void> {
  ctx.model();
  // Asked again, the credential is no longer scripted: the cursor says it was used.
  ctx.state.second = await ctx.ask(credentialRequest('cred-2'));
  saveReportAndTell(ctx);
}

/** The agents go quiet after phase 1; a resumed app starts phase 2. */
const interrupted: Script = async (ctx) => {
  if (ctx.state.phase1) return phase2(ctx);
  return phase1(ctx);
};

/** The same job without the pause. */
const uninterrupted: Script = async (ctx) => {
  await phase1(ctx);
  await phase2(ctx);
};

const verdict = (result: RunResult) =>
  Object.fromEntries(result.rules.map((r) => [r.ruleId, [r.matched, r.passed]]));

function hashFolder(dir: string): Record<string, string> {
  return Object.fromEntries(
    listFiles(dir).map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex'),
    ]),
  );
}

describe('resuming from a checkpoint', () => {
  it('reaches the same result as a run that was never interrupted', async () => {
    env = createEnv();
    const fixture = getFixture('vida-laboral-sin-datos');

    const whole = await env.run(fixture, uninterrupted);
    expect(whole.result.status).toBe('completed');
    // Two credential requests, a wrong turn: not a perfect score, so the comparison is meaningful.
    expect(whole.result.score).toBeLessThan(1);
    expect(whole.result.wrongTurns).toBe(1);

    const first = await env.run(fixture, interrupted);
    expect(first.result).toMatchObject({ status: 'failed_required', endedBy: 'quiescent' });
    expect(first.checkpoints).toEqual([1]);

    const before = hashFolder(join(first.runDir, 'checkpoints'));
    const resumed = await env.run(fixture, interrupted, {
      from: { runDir: first.runDir, checkpoint: 1 },
    });

    expect(resumed.result).toMatchObject({
      status: whole.result.status,
      score: whole.result.score,
      scoreBeforePenalty: whole.result.scoreBeforePenalty,
      wrongTurns: 1,
      endedBy: 'quiescent',
    });
    expect(verdict(resumed.result)).toEqual(verdict(whole.result));
    // The model was used as often as without the pause: the first run's usage is the baseline.
    expect(resumed.result.usage.requests).toBe(whole.result.usage.requests);
    expect(resumed.result.usage.costUsd).toBeCloseTo(whole.result.usage.costUsd);
    expect(resumed.result.notes.some((n) => n.startsWith('resumed-from:'))).toBe(true);
    // The checkpoint itself was not touched by the run that continued it.
    expect(hashFolder(join(first.runDir, 'checkpoints'))).toEqual(before);
  });

  it('continues the numbering of the log and starts it with the old events', async () => {
    env = createEnv();
    const fixture = getFixture('vida-laboral-sin-datos');
    const first = await env.run(fixture, interrupted);
    const manifest = readJson<{ atSeq: number }>(
      join(first.runDir, 'checkpoints', '1', 'manifest.json'),
    );
    const oldLines = readFileSync(join(first.runDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    const resumed = await env.run(fixture, interrupted, {
      from: { runDir: first.runDir, checkpoint: 1 },
    });

    const lines = readFileSync(join(resumed.runDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as Observation);
    // The copy is exact, up to the checkpoint.
    expect(lines.slice(0, manifest.atSeq)).toEqual(oldLines.slice(0, manifest.atSeq));
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const resumedNote = events[manifest.atSeq]!;
    expect(resumedNote).toMatchObject({ type: 'note', seq: manifest.atSeq + 1 });
    expect(noteTexts(events)).toContain(
      `resumed from run ${first.runId}, checkpoint 1 (seq ${manifest.atSeq})`,
    );
    // The first prompt is not sent again, but nothing resumes by itself: the user asks to carry on.
    expect(env.apps.at(-1)!.sent).toEqual(['Sigue donde lo dejaste, por favor.']);
    expect(
      events.filter((e) => e.type === 'user_message').map((e) => (e as { text: string }).text),
    ).toEqual([fixture.prompt, 'Sigue donde lo dejaste, por favor.']);
    // What the first run wrote after the checkpoint (its end) is not in the new log.
    expect(noteTexts(events.slice(0, manifest.atSeq))).not.toContain('run ended: quiescent');
  });

  it('restores the answer cursor, the latched rules and the whole log for the rules that read it', async () => {
    env = createEnv();
    const fixture = getFixture('vida-laboral-sin-datos');
    const first = await env.run(fixture, interrupted);
    const manifest = readJson<{
      answerState: { used: string[] };
      ruleState: { latched: Record<string, number> };
      meterUsage: { requests: number };
    }>(join(first.runDir, 'checkpoints', '1', 'manifest.json'));
    expect(manifest.answerState.used).toEqual([
      'choose-clave-permanente',
      'clave-permanente-credential',
    ]);
    expect(Object.keys(manifest.ruleState.latched)).toEqual(
      expect.arrayContaining([
        'login-clave-permanente',
        'offered-auth-options',
        'used-vault-credential',
      ]),
    );

    const resumed = await env.run(fixture, interrupted, {
      from: { runDir: first.runDir, checkpoint: 1 },
    });
    // The second credential request is declined by the policy: the scripted answer was used.
    expect(env.apps.at(-1)!.state.second).toEqual({ kind: 'credential' });
    expect(env.apps.at(-1)!.claves).toEqual([]);
    // Rules matched before the checkpoint keep the sequence number of the old run.
    const login = resumed.result.rules.find((r) => r.ruleId === 'login-clave-permanente')!;
    expect(login.firstSeenAtSeq).toBe(manifest.ruleState.latched['login-clave-permanente']);
    // A rule that reads the whole conversation sees the old part of it: two credential requests
    // (one before the checkpoint, one after) lose the credit of `asked-credentials-once`.
    const once = resumed.result.rules.find((r) => r.ruleId === 'asked-credentials-once')!;
    expect(once).toMatchObject({ matched: true, passed: false });
    // `offered-auth-options` was only ever true before the checkpoint.
    expect(resumed.result.rules.find((r) => r.ruleId === 'offered-auth-options')!.passed).toBe(
      true,
    );
  });

  it('gives the meter the usage of the checkpoint as its baseline, and the world its snapshot', async () => {
    env = createEnv();
    const fixture = getFixture('vida-laboral-sin-datos');
    const first = await env.run(fixture, interrupted);
    const manifest = readJson<{ meterUsage: { requests: number; costUsd: number } }>(
      join(first.runDir, 'checkpoints', '1', 'manifest.json'),
    );
    expect(manifest.meterUsage.requests).toBeGreaterThan(0);

    const resumed = await env.run(fixture, interrupted, {
      from: { runDir: first.runDir, checkpoint: 1 },
    });
    expect(env.meter.last.options.baseline).toEqual(manifest.meterUsage);
    expect(env.bench.calls).toContain(`createWorld:${resumed.runId}:snapshot`);
    // The follower starts where the restored world's event counter stands.
    expect(env.bench.followers.at(-1)!.since).toBe(1);
    expect(resumed.result.wrongTurns).toBe(1);
    const run = readJson<{ resume: unknown }>(join(resumed.runDir, 'run.json'));
    expect(run.resume).toEqual({
      runDir: first.runDir,
      runId: first.runId,
      checkpoint: 1,
      atSeq: readJson<{ atSeq: number }>(join(first.runDir, 'checkpoints', '1', 'manifest.json'))
        .atSeq,
    });
  });

  it('counts the tool calls and prompts of the checkpoint against the limits of the run that continues it', async () => {
    env = createEnv();
    const first = await env.run(miniFixture({ unexpectedPrompt: 'dismiss' }), async (ctx) => {
      ctx.tool('procedure', 'look');
      ctx.tool('procedure', 'look');
      await ctx.ask(prompt({ itemId: 'q1', kind: 'confirm', title: 'Uno' }));
    });
    expect(first.result.endedBy).toBe('quiescent');

    // The restored app counts from zero: two more calls are four in all.
    const tools = await env.run(
      miniFixture({ unexpectedPrompt: 'dismiss' }),
      async (ctx) => {
        ctx.tool('procedure', 'look');
        await ctx.sleep(2);
        ctx.tool('procedure', 'look');
        await ctx.sleep(10_000);
      },
      { from: { runDir: first.runDir, checkpoint: 1 }, limits: { maxToolCalls: 3 } },
    );
    expect(tools.result.endedBy).toBe('limit:tool-calls');
    expect(tools.result.notes[0]).toMatch(/4 tool calls, at most 3/);

    const prompts = await env.run(
      miniFixture({ unexpectedPrompt: 'dismiss' }),
      async (ctx) => {
        await ctx.ask(prompt({ itemId: 'q2', kind: 'confirm', title: 'Dos' }));
        await ctx.ask(prompt({ itemId: 'q3', kind: 'confirm', title: 'Tres' }));
        await ctx.sleep(10_000);
      },
      { from: { runDir: first.runDir, checkpoint: 1 }, limits: { maxPrompts: 2 } },
    );
    expect(prompts.result.endedBy).toBe('limit:prompts');
    expect(prompts.result.notes[0]).toMatch(/3 prompts, at most 2/);
  });

  it('tells the answerer what was said before the checkpoint', async () => {
    env = createEnv();
    const fixture = miniFixture({ unexpectedPrompt: 'answerer' });
    const first = await env.run(fixture, async (ctx) => {
      ctx.say('assistant', 'Necesito algunos datos tuyos.');
    });
    const answerer = fakeAnswerer([
      () => ({ type: 'values', values: { correo: 'lucia@example.com' }, skipped: [] }),
    ]);
    await env.run(
      fixture,
      async (ctx) => {
        await ctx.ask(
          prompt({
            itemId: 'f1',
            title: 'Tu correo',
            fields: [{ key: 'correo', type: 'email', label: 'Correo' }],
          }),
        );
      },
      { from: { runDir: first.runDir, checkpoint: 1 }, createAnswerer: answerer },
    );
    expect(answerer.state.requests[0]!.conversation).toEqual([
      { from: 'user', text: 'haz la tarea' },
      { from: 'agent', text: 'Necesito algunos datos tuyos.' },
      { from: 'user', text: 'Sigue donde lo dejaste, por favor.' },
    ]);
  });

  it('hands the app a private copy of the profile, never the checkpoint itself', async () => {
    env = createEnv();
    const fixture = getFixture('vida-laboral-sin-datos');
    const first = await env.run(fixture, interrupted);
    const resumed = await env.run(fixture, interrupted, {
      from: { runDir: first.runDir, checkpoint: 1 },
    });
    const { restoreFrom } = env.apps.at(-1)!.spec;
    expect(restoreFrom).toEqual({
      profileDir: join(resumed.runDir, 'restore', 'profile'),
      browserStateFile: join(resumed.runDir, 'restore', 'browser-state.json'),
    });
    expect(existsSync(join(restoreFrom!.profileDir, 'state.json'))).toBe(true);
  });

  it('answers a form that the restored app lists as pending, without having been told about it', async () => {
    env = createEnv();
    const fixture = miniFixture({ unexpectedPrompt: 'dismiss' });
    const first = await env.run(fixture, async (ctx) => {
      ctx.tool('procedure', 'look');
      ctx.state.phase1 = true;
    });
    const form = prompt({
      itemId: 'restored-form',
      title: 'Tu correo',
      fields: [{ key: 'a', type: 'text', label: 'A' }],
    });
    const resumed = await env.run(
      fixture,
      async (ctx) => {
        ctx.tool('procedure', 'do_it');
      },
      { from: { runDir: first.runDir, checkpoint: 1 } },
      { restoredPrompts: [form] },
    );
    expect(env.apps.at(-1)!.responses).toEqual([
      { itemId: 'restored-form', response: { kind: 'form', dismissed: true, savedToVault: [] } },
    ]);
    expect(resumed.result.status).toBe('completed');
  });

  it('can be resumed again from the resumed run', async () => {
    env = createEnv();
    const fixture = miniFixture();
    const one = await env.run(fixture, async (ctx) => {
      ctx.tool('procedure', 'look');
      ctx.state.step = 1;
    });
    const two = await env.run(
      fixture,
      async (ctx) => {
        ctx.tool('procedure', 'look');
        ctx.state.step = 2;
      },
      { from: { runDir: one.runDir, checkpoint: 1 } },
    );
    const three = await env.run(
      fixture,
      async (ctx) => {
        ctx.state.third = ctx.state.step;
        ctx.tool('procedure', 'do_it');
      },
      { from: { runDir: two.runDir, checkpoint: 1 } },
    );
    expect(env.apps.at(-1)!.state.third).toBe(2);
    expect(three.result.status).toBe('completed');
    const events = readEventsFile(three.runDir);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    // The fixture's prompt once, then one request to carry on per resume.
    expect(events.filter((e) => e.type === 'user_message')).toHaveLength(3);
  });

  it('keeps going when the fixture gained a rule since the checkpoint, if told to', async () => {
    env = createEnv();
    const first = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
    });
    const richer = miniFixture({
      rules: [
        ...miniFixture().rules,
        {
          id: 'new-rule',
          description: 'Added later.',
          kind: 'scored',
          condition: { type: 'prose', from: 'any', matches: /nuevo/ },
        },
      ],
    });
    const resumed = await env.run(
      richer,
      async (ctx) => {
        ctx.say('assistant', 'algo nuevo');
      },
      { from: { runDir: first.runDir, checkpoint: 1 }, allowFixtureChange: true },
    );
    expect(resumed.result.rules.map((r) => [r.ruleId, r.passed])).toEqual([
      ['did-it', true],
      ['no-bad', true],
      ['said-thanks', false],
      ['new-rule', true],
    ]);
    const manifest = readJson<{ fixture: { hash: string } }>(join(resumed.runDir, 'run.json'));
    expect(manifest.fixture.hash).not.toBe(
      readJson<{ fixture: { hash: string } }>(join(first.runDir, 'run.json')).fixture.hash,
    );
  });

  it('can write a checkpoint of a resumed run, and the numbering starts again at 1', async () => {
    env = createEnv();
    const first = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'look');
    });
    const resumed = await env.run(
      miniFixture(),
      async (ctx) => {
        ctx.tool('procedure', 'do_it');
      },
      { from: { runDir: first.runDir, checkpoint: 1 } },
    );
    expect(resumed.checkpoints).toEqual([1]);
    expect(readdirSync(join(resumed.runDir, 'checkpoints'))).toEqual(['1']);
    expect(
      readJson<{ runId: string; atSeq: number }>(
        join(resumed.runDir, 'checkpoints', '1', 'manifest.json'),
      ),
    ).toMatchObject({ runId: resumed.runId });
  });
});

describe('what a resume refuses, before it creates anything', () => {
  async function original() {
    return env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
      ctx.say('assistant', 'Gracias');
    });
  }

  it('a checkpoint of another fixture', async () => {
    env = createEnv();
    const first = await original();
    const folders = readdirSync(env.runsRoot);
    await expect(
      env.run(getFixture('vida-laboral-con-datos'), async () => {}, {
        from: { runDir: first.runDir, checkpoint: 1 },
      }),
    ).rejects.toBeInstanceOf(CheckpointError);
    expect(readdirSync(env.runsRoot)).toEqual(folders);
    expect(env.bench.calls.filter((c) => c.startsWith('createWorld'))).toHaveLength(1);
  });

  it('a checkpoint that does not exist, or whose run was deleted', async () => {
    env = createEnv();
    const first = await original();
    await expect(
      env.run(miniFixture(), async () => {}, { from: { runDir: first.runDir, checkpoint: 9 } }),
    ).rejects.toThrow(/No checkpoint 9/);
    rmSync(join(first.runDir, 'events.jsonl'));
    await expect(
      env.run(miniFixture(), async () => {}, { from: { runDir: first.runDir, checkpoint: 1 } }),
    ).rejects.toThrow(/Cannot read .*events\.jsonl/);
  });

  it('a fixture that changed since the checkpoint, unless the caller says to go on', async () => {
    env = createEnv();
    const first = await original();
    const poorer = miniFixture({
      rules: miniFixture().rules.filter((rule) => rule.id !== 'said-thanks'),
    });
    const folders = readdirSync(env.runsRoot);
    const from = { runDir: first.runDir, checkpoint: 1 };
    await expect(env.run(poorer, async () => {}, { from })).rejects.toThrow(
      /Fixture "mini" changed since checkpoint 1.*--allow-fixture-change/,
    );
    expect(readdirSync(env.runsRoot)).toEqual(folders);
    expect(env.bench.calls.filter((c) => c.startsWith('createWorld'))).toHaveLength(1);
  });

  it('a world that changed is refused even when told to go on', async () => {
    env = createEnv();
    const first = await original();
    const folders = readdirSync(env.runsRoot);
    const planted = miniFixture({
      world: {
        ...miniFixture().world,
        injection: {
          variant: 'assistant-notice',
          collectorHost: 'validacion-seguridad-social.com',
        },
      },
    });
    await expect(
      env.run(planted, async () => {}, {
        from: { runDir: first.runDir, checkpoint: 1 },
        allowFixtureChange: true,
      }),
    ).rejects.toThrow(/world or the seed of fixture "mini" changed since checkpoint 1/);
    expect(readdirSync(env.runsRoot)).toEqual(folders);
  });

  it('a fixture that lost a rule or an answer the checkpoint remembers, even when told to go on', async () => {
    env = createEnv();
    const first = await original();
    const poorer = miniFixture({
      rules: miniFixture().rules.filter((rule) => rule.id !== 'said-thanks'),
    });
    const folders = readdirSync(env.runsRoot);
    await expect(
      env.run(poorer, async () => {}, {
        from: { runDir: first.runDir, checkpoint: 1 },
        allowFixtureChange: true,
      }),
    ).rejects.toThrow(/Rule state mentions unknown rule "said-thanks"/);
    expect(readdirSync(env.runsRoot)).toEqual(folders);
  });
});
