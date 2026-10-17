import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvalApp } from '../../src/contracts';
import { prompt } from '../rules/support/run';
import { fakeFollowBench } from './support/fake-bench';
import {
  createEnv,
  type Env,
  EXPECTED_ARTIFACTS,
  fileText,
  miniFixture,
  readEventsFile,
  readResultFile,
} from './support/harness';
import type { Script } from './support/scripted-app';

let env: Env;
afterEach(() => env?.dispose());

const doIt: Script = async (ctx) => {
  ctx.tool('procedure', 'do_it');
  ctx.say('assistant', 'Gracias');
};

/** A failed run still leaves its whole folder, and nothing that was started keeps running. */
function expectCompleteFolder(runDir: string): void {
  for (const name of EXPECTED_ARTIFACTS) {
    expect(existsSync(join(runDir, name)), `${name} is missing`).toBe(true);
  }
  expect(readResultFile(runDir).runId).toBeTruthy();
}

function expectNothingRunning(): void {
  for (const app of env.apps) {
    expect(app.closeCalls).toBeGreaterThanOrEqual(1);
    expect(app.aborted).toBe(true);
  }
  for (const run of env.meter.runs) expect(run.closed).toBe(true);
  for (const follower of env.bench.followers) expect(follower.stopped).toBe(true);
  expect(env.bench.worlds.size).toBe(0);
}

describe('failures leave a complete folder and no running resources', () => {
  it('createApp throws', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      createApp: async () => {
        throw new Error('Chromium would not start');
      },
    });
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('createApp: Chromium would not start');
    expectCompleteFolder(outcome.runDir);
    expect(env.apps).toEqual([]);
    expect(env.meter.last.closed).toBe(true);
    expect(env.bench.worlds.size).toBe(0);
    // The world existed, so it was saved before it was deleted.
    expect(existsSync(join(outcome.runDir, 'bench', 'state.json'))).toBe(true);
    expect(env.bench.calls).toEqual(
      expect.arrayContaining([`saveArtifacts:${outcome.runId}`, `deleteWorld:${outcome.runId}`]),
    );
  });

  it('the follower cannot even start', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      followBench: fakeFollowBench({ throwOnStart: new Error('cannot follow the world') }),
    });
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('followBench: cannot follow the world');
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
    expect(env.apps[0]!.sent).toEqual([]);
  });

  it('the follower loses the event stream mid-run', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
      await ctx.sleep(5);
      env.bench.followers[0]!.onError?.(new Error('the server stopped answering'));
      await ctx.sleep(10_000);
    });
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('bench follower: the server stopped answering');
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
  });

  it('the follower hangs when asked to deliver what is left: the run still ends', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      async (ctx) => {
        env.bench.followers[0]!.hangDrain = true;
        await doIt(ctx);
      },
      { shutdownTimeoutMs: 20 },
    );
    expect(outcome.result.endedBy).toBe('quiescent');
    expect(outcome.result.notes).toEqual(
      expect.arrayContaining([expect.stringMatching(/^bench drain: timed out after 20 ms/)]),
    );
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
  });

  it('the simulator hits a problem: the app refuses an answer for a prompt that is still pending', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture({ unexpectedPrompt: 'dismiss' }),
      async (ctx) => {
        await ctx.ask(prompt({ itemId: 'c1', kind: 'confirm', title: 'Ok?' }));
        ctx.mark('answered');
      },
      {},
      { respondError: new Error('chat.respond: bad request') },
    );
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toMatch(/user simulator \(respond_failed\).*bad request/);
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
  });

  it('the simulator cannot create the Cl@ve credential', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture({
        answerGroups: [
          {
            id: 'g',
            answers: [
              {
                id: 'clave',
                match: { kind: 'credential' },
                action: { type: 'credential', username: '53918274H', password: 'Pa55word-test' },
              },
            ],
          },
        ],
      }),
      async (ctx) => {
        await ctx.ask(prompt({ itemId: 'cred', kind: 'credential', title: 'Clave' }));
      },
      {},
      { addClaveError: new Error('the vault is locked') },
    );
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toMatch(/user simulator.*the vault is locked/);
    expectNothingRunning();
  });

  it('saveBenchArtifacts throws: the result stands and says so', async () => {
    env = createEnv();
    env.bench.fail('saveArtifacts', new Error('disk full'));
    const outcome = await env.run(miniFixture(), doIt);
    expect(outcome.result).toMatchObject({ status: 'completed', score: 1, endedBy: 'quiescent' });
    expect(outcome.result.notes).toContain('bench artifacts: disk full');
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
  });

  it('SpainBench cannot list its hosts', async () => {
    env = createEnv();
    env.bench.fail('hosts', new Error('connection refused'));
    const outcome = await env.run(miniFixture(), doIt);
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('bench.hosts: connection refused');
    expectCompleteFolder(outcome.runDir);
    // No world was created: nothing to save or delete, no meter run, no app.
    expect(env.bench.calls).toEqual([]);
    expect(env.meter.runs).toEqual([]);
    expect(env.apps).toEqual([]);
  });

  it('the world cannot be created', async () => {
    env = createEnv();
    env.bench.fail('createWorld', new Error('unknown site "seg-social-es"'));
    const outcome = await env.run(miniFixture(), doIt);
    expect(outcome.result.notes[0]).toBe('bench.createWorld: unknown site "seg-social-es"');
    expect(outcome.result.status).toBe('error');
    expectCompleteFolder(outcome.runDir);
    expect(env.meter.runs).toEqual([]);
    expect(env.apps).toEqual([]);
    expect(env.bench.calls).not.toContain(`deleteWorld:${outcome.runId}`);
  });

  it('the meter cannot open the run (a cache in replay mode without recordings, say)', async () => {
    env = createEnv();
    env.meter.openError = new Error('replay needs a recorded cache');
    const outcome = await env.run(miniFixture(), doIt);
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('meter.openRun: replay needs a recorded cache');
    expectCompleteFolder(outcome.runDir);
    expect(env.bench.worlds.size).toBe(0);
    expect(env.apps).toEqual([]);
  });

  it('chat.send is refused', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      createApp: async (spec, deps) => {
        const app = await env.options(miniFixture(), doIt).createApp(spec, deps);
        app.send = async () => {
          throw new Error('The assistant is not configured');
        };
        return app;
      },
    });
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('chat.send: The assistant is not configured');
    expectCompleteFolder(outcome.runDir);
    expectNothingRunning();
  });

  it('the idle watcher fails', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      createApp: async (spec, deps) => {
        const app: EvalApp = await env.options(miniFixture(), doIt).createApp(spec, deps);
        app.untilIdle = async () => {
          throw new Error('idle check exploded');
        };
        return app;
      },
    });
    expect(outcome.result).toMatchObject({ status: 'error', endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('idle watcher: idle check exploded');
    expectNothingRunning();
  });

  it('the final state of the world cannot be read: a result that would be scored is an error', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      await doIt(ctx);
      env.bench.fail('state', new Error('world is gone'));
    });
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^bench state: world is gone/),
        'the final SpainBench state could not be read: the result is unreliable',
      ]),
    );
    expectCompleteFolder(outcome.runDir);
  });

  it('an instant failure does not depend on the final state: the score is 0 either way', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'bad_tool');
      env.bench.fail('state', new Error('world is gone'));
      await ctx.sleep(10_000);
    });
    expect(outcome.result).toMatchObject({ status: 'failed_required', endedBy: 'required-failed' });
  });

  it('a failure to delete the world is a note, never a change of the result', async () => {
    env = createEnv();
    env.bench.fail('deleteWorld', new Error('world already expired'));
    const outcome = await env.run(miniFixture(), doIt);
    expect(outcome.result).toMatchObject({ status: 'completed', score: 1 });
    const written = readResultFile(outcome.runDir);
    expect(written.status).toBe('completed');
    expect(written.notes).toContain('bench deleteWorld: world already expired');
    expect(outcome.result.notes).toContain('bench deleteWorld: world already expired');
    expect(fileText(join(outcome.runDir, 'report.md'))).toContain(
      'bench deleteWorld: world already expired',
    );
  });

  it('app.abort throws: the run is still cut off and closed', async () => {
    env = createEnv();
    const violation: Script = async (ctx) => {
      ctx.tool('procedure', 'bad_tool');
      await ctx.sleep(10_000);
    };
    const outcome = await env.run(miniFixture(), violation, {
      createApp: async (spec, deps) => {
        const app = await env.options(miniFixture(), violation).createApp(spec, deps);
        const abort = app.abort.bind(app);
        app.abort = async (reason) => {
          await abort(reason);
          throw new Error('the browser did not close');
        };
        return app;
      },
    });
    expect(outcome.result.endedBy).toBe('required-failed');
    expect(outcome.result.notes).toContain('app.abort: the browser did not close');
    expect(env.apps[0]!.closeCalls).toBe(1);
  });

  it('counts a request that was still being answered when the run was cut off', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      async (ctx) => {
        ctx.model(0.01);
        ctx.meterRun.inflight = 1;
        setTimeout(() => ctx.meterRun.finish(0.05), 40);
        ctx.tool('procedure', 'bad_tool');
        await ctx.sleep(10_000);
      },
      { shutdownTimeoutMs: 2000 },
    );
    expect(outcome.result.endedBy).toBe('required-failed');
    expect(outcome.result.usage.requests).toBe(2);
    expect(outcome.result.usage.costUsd).toBeCloseTo(0.06);
    expect(outcome.result.notes.filter((n) => n.startsWith('meter in-flight'))).toEqual([]);
  });

  it('does not wait for ever for a request that never finishes', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      async (ctx) => {
        ctx.model(0.01);
        ctx.meterRun.inflight = 1;
        ctx.tool('procedure', 'bad_tool');
        await ctx.sleep(10_000);
      },
      { shutdownTimeoutMs: 30 },
    );
    expect(outcome.result.usage.requests).toBe(1);
    expect(outcome.result.notes).toContain('meter in-flight requests: timed out after 30 ms');
  });

  it('a checkpoint that cannot be written is a warning: the run still finishes', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      doIt,
      {},
      { checkpointError: new Error('profile too big') },
    );
    expect(outcome.result).toMatchObject({ status: 'completed', score: 1 });
    expect(outcome.result.notes).toContain('checkpoint-failed: profile too big');
    expect(outcome.checkpoints).toEqual([]);
    expect(existsSync(join(outcome.runDir, 'checkpoints', '1'))).toBe(false);
  });

  it('a model credential that cannot be read early is noted, and the app reports the real problem', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      credentials: {
        providerId: 'litellm',
        credential: async () => {
          throw new Error('litellm.json is missing');
        },
        refreshCredential: async () => null,
      },
    });
    expect(outcome.result.notes).toContain(
      'credentials: could not read the model credential early: litellm.json is missing',
    );
    expect(outcome.result.status).toBe('completed');
  });
});

describe('what the log says when it goes wrong', () => {
  it('ends with the reason, after the rest', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'bad_tool');
      await ctx.sleep(10_000);
    });
    const events = readEventsFile(outcome.runDir);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: 'note' });
    expect(last.type === 'note' && last.text).toMatch(
      /^run ended: required-failed \(required-failed:no-bad/,
    );
  });
});
