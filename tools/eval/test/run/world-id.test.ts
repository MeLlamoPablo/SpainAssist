/**
 * The id of the SpainBench world is something the agent can read: SpainBench puts it in the URL of
 * its planted notices (`...&sesion=<id>`). So it is an id of its own, opaque, and never the run id
 * (fixture, provider, variant, date): the run id names the run's folder and the ledger, nothing the
 * agent sees. These tests run the loop with the default world id (the others address the fake
 * bench's worlds by run id).
 */
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BENCH_WORLD_ID_PATTERN, newWorldId } from '../../src/bench';
import { getFixture } from '../../src/fixtures';
import { createEnv, type Env, miniFixture, readEventsFile, readJson } from './support/harness';
import type { Script } from './support/scripted-app';

let env: Env;
afterEach(() => env?.dispose());

const doIt: Script = async (ctx) => {
  ctx.tool('procedure', 'do_it');
  ctx.say('assistant', 'Gracias');
  ctx.bench.wrongTurn(ctx.spec.bench.worldId);
  ctx.bench.emit(ctx.spec.bench.worldId, 'wrong_turn', { path: '/missing' });
};

/** Runs with the default world id. */
const run = (fixture = miniFixture(), extra: Record<string, unknown> = {}) =>
  env.run(fixture, doIt, { worldId: undefined, ...extra });

const manifest = (dir: string) =>
  readJson<{ runId: string; worldId?: string; inheritedWorldIds?: string[] }>(
    join(dir, 'run.json'),
  );

describe('newWorldId', () => {
  it('is 16 random hex characters the server accepts, and different every time', () => {
    const ids = Array.from({ length: 50 }, () => newWorldId());
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(BENCH_WORLD_ID_PATTERN.test(id)).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the world of a run', () => {
  it('has an opaque id that is not the run id, in every place the bench or the app is told', async () => {
    env = createEnv();
    const outcome = await run(getFixture('vida-laboral-inyeccion'), { provider: 'voucher' });
    const { worldId } = manifest(outcome.runDir);
    expect(worldId).toMatch(/^[0-9a-f]{16}$/);
    expect(worldId).not.toBe(outcome.runId);
    // No run metadata in it, and none of the run id's words.
    for (const part of ['inyeccion', 'voucher', 'vida', outcome.runId]) {
      expect(worldId).not.toContain(part);
    }
    expect(manifest(outcome.runDir).runId).toBe(outcome.runId);
    expect(outcome.result.wrongTurns).toBe(1);
    expect(readEventsFile(outcome.runDir).some((o) => o.type === 'bench')).toBe(true);

    // The world SpainBench creates, reads, snapshots, saves and deletes is that one...
    expect(env.bench.calls.filter((c) => c.includes(outcome.runId))).toEqual([]);
    expect(env.bench.calls).toEqual(
      expect.arrayContaining([
        `createWorld:${worldId}`,
        `saveArtifacts:${worldId}`,
        `deleteWorld:${worldId}`,
      ]),
    );
    expect([...env.bench.specs.keys()]).toEqual([worldId]);
    // ...the app (its net log and the header of every request to the mock) is told that one...
    expect(env.apps[0]?.spec.bench.worldId).toBe(worldId);
    expect(env.apps[0]?.spec.runId).toBe(outcome.runId);
    // ...the event follower reads it (an event of that world reaches the run's log), and the
    // meter normalises it out of the cache key.
    const volatile = env.meter.last.options.volatile ?? [];
    expect(volatile).toEqual(
      expect.arrayContaining([
        { pattern: outcome.runId, replacement: '<RUNID>' },
        { pattern: worldId, replacement: '<WORLD>' },
      ]),
    );
    // The ledger keeps the run id: that is what the run folder and the ledger are keyed by.
    expect(env.meter.last.runId).toBe(outcome.runId);
  });

  it('is not the one of another run, even of the same fixture, and not the one a caller names for the run', async () => {
    env = createEnv();
    const a = await run(miniFixture(), { runId: 'my-descriptive-run-1' });
    const b = await run(miniFixture(), { runId: 'my-descriptive-run-2' });
    const ids = [a, b].map((o) => manifest(o.runDir).worldId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).not.toMatch(/descriptive/);
  });

  it('takes the id from the generator of a test, given the run id', async () => {
    env = createEnv();
    const outcome = await run(miniFixture(), { worldId: (runId: string) => `w-${runId.length}` });
    expect(manifest(outcome.runDir).worldId).toBe(`w-${outcome.runId.length}`);
  });
});

describe('a resumed run', () => {
  const phase1: Script = async (ctx) => {
    ctx.tool('procedure', 'look');
    ctx.state.phase1 = true;
  };

  it('gets a world of its own (several runs may continue one checkpoint at once) and remembers the ids its conversation holds', async () => {
    env = createEnv();
    const fixture = miniFixture();
    const first = await env.run(fixture, phase1, { worldId: undefined });
    const second = await env.run(fixture, phase1, {
      worldId: undefined,
      from: { runDir: first.runDir, checkpoint: 1 },
    });
    const third = await env.run(fixture, phase1, {
      worldId: undefined,
      from: { runDir: second.runDir, checkpoint: 1 },
    });
    const [one, two, three] = [first, second, third].map((o) => manifest(o.runDir));
    expect(new Set([one?.worldId, two?.worldId, three?.worldId]).size).toBe(3);
    expect(one?.inheritedWorldIds).toBeUndefined();
    expect(two?.inheritedWorldIds).toEqual([one?.worldId]);
    expect(three?.inheritedWorldIds).toEqual([two?.worldId, one?.worldId]);

    // The snapshot of the old world is restored under the new id.
    expect(env.bench.calls).toContain(`createWorld:${two?.worldId}:snapshot`);
    expect(env.bench.calls).toContain(`createWorld:${three?.worldId}:snapshot`);

    // Every id the restored conversation can hold is normalised out of the cache key, as the new one.
    const volatile = env.meter.last.options.volatile ?? [];
    const worlds = volatile.filter((v) => v.replacement === '<WORLD>').map((v) => v.pattern);
    expect(worlds).toEqual([three?.worldId, two?.worldId, one?.worldId]);
  });
});
