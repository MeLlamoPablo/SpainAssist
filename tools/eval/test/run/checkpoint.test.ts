import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fixture, PendingPrompt } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import {
  CHECKPOINT_FORMAT,
  CheckpointError,
  CheckpointManifestSchema,
  listCheckpoints,
  ObservationLog,
  parseCheckpointRef,
  readCheckpoint,
  runPaths,
  writeCheckpoint,
} from '../../src/run';
import { stageRestore } from '../../src/run/checkpoint';
import { emptyMeterUsage } from '../../src/scoring';
import { prompt } from '../rules/support/run';
import { createEnv, type Env, miniFixture, readJson } from './support/harness';
import type { Script } from './support/scripted-app';

const dirs: string[] = [];
let env: Env | undefined;
afterEach(() => {
  env?.dispose();
  env = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-checkpoint-'));
  dirs.push(dir);
  return dir;
}

interface SourceOptions {
  idle?: () => boolean;
  pending?: PendingPrompt[];
  checkpoint?: (dir: string) => Promise<{ profileDir: string; browserStateFile?: string }>;
  snapshot?: () => Promise<unknown>;
}

function source(options: SourceOptions = {}) {
  const dir = tmp();
  const log = new ObservationLog();
  log.push({ type: 'user_message', text: 'hola' });
  log.push({ type: 'quiescent' });
  const calls: string[] = [];
  return {
    log,
    calls,
    paths: runPaths(dir),
    input: {
      runId: 'run-1',
      worldId: '0123456789abcdef',
      paths: runPaths(dir),
      index: 1,
      log,
      app: {
        idle: options.idle ?? (() => true),
        pendingPrompts: () => options.pending ?? [],
        checkpoint:
          options.checkpoint ??
          (async (target: string) => {
            calls.push('app');
            mkdirSync(join(target, 'profile'), { recursive: true });
            writeFileSync(join(target, 'profile', 'vault.bin'), 'v');
            writeFileSync(join(target, 'browser.json'), '{}');
            return {
              profileDir: join(target, 'profile'),
              browserStateFile: join(target, 'browser.json'),
            };
          }),
      },
      bench: {
        snapshot:
          options.snapshot ??
          (async () => {
            calls.push('bench');
            return { world: 'snapshot' };
          }),
      },
      answerState: () => ({ unlockedGroup: 1, used: ['a', 'b'] }),
      ruleState: () => ({ latched: { rule: 2 }, leaves: { 'rule.0': 2 } }),
      meterUsage: () => ({ ...emptyMeterUsage(), requests: 3, costUsd: 0.12 }),
    },
  };
}

describe('writeCheckpoint', () => {
  it('writes the manifest last, with paths relative to the checkpoint folder', async () => {
    const s = source();
    const outcome = await writeCheckpoint(s.input);
    expect(outcome.written).toBe(true);
    if (!outcome.written) return;
    expect(outcome.manifest).toEqual({
      format: CHECKPOINT_FORMAT,
      runId: 'run-1',
      index: 1,
      atSeq: 2,
      quiescent: true,
      benchSnapshotFile: 'bench-snapshot.json',
      profileDir: 'app/profile',
      browserStateFile: 'app/browser.json',
      answerState: { unlockedGroup: 1, used: ['a', 'b'] },
      ruleState: { latched: { rule: 2 }, leaves: { 'rule.0': 2 } },
      meterUsage: { ...emptyMeterUsage(), requests: 3, costUsd: 0.12 },
    });
    expect(CheckpointManifestSchema.parse(outcome.manifest)).toEqual(outcome.manifest);
    expect(readJson(join(outcome.dir, 'manifest.json'))).toEqual(outcome.manifest);
    expect(readJson(join(outcome.dir, 'bench-snapshot.json'))).toEqual({ world: 'snapshot' });
    expect(readFileSync(join(outcome.dir, 'app', 'profile', 'vault.bin'), 'utf8')).toBe('v');
    expect(outcome.dir).toBe(join(s.paths.dir, 'checkpoints', '1'));
  });

  it('keeps the count of loose replays in the usage a resumed run starts from', async () => {
    const outcome = await writeCheckpoint(source().input);
    if (!outcome.written) throw new Error('not written');
    const withLoose = {
      ...outcome.manifest,
      meterUsage: { ...outcome.manifest.meterUsage, cacheHits: 3, looseHits: 2 },
    };
    expect(CheckpointManifestSchema.parse(withLoose).meterUsage.looseHits).toBe(2);
    // The usage is still strict about anything else.
    const stray = { ...withLoose, meterUsage: { ...withLoose.meterUsage, stray: 1 } };
    expect(CheckpointManifestSchema.safeParse(stray).success).toBe(false);
  });

  it('works without browser state', async () => {
    const s = source({
      checkpoint: async (target) => {
        mkdirSync(join(target, 'profile'), { recursive: true });
        return { profileDir: join(target, 'profile') };
      },
    });
    const outcome = await writeCheckpoint(s.input);
    expect(outcome.written && outcome.manifest.browserStateFile).toBeUndefined();
  });

  it('is refused while the app is not idle', async () => {
    const s = source({ idle: () => false });
    expect(await writeCheckpoint(s.input)).toEqual({
      written: false,
      reason: 'the app is not idle',
    });
    expect(s.calls).toEqual([]);
    expect(existsSync(join(s.paths.dir, 'checkpoints'))).toBe(false);
  });

  it.each(['confirm', 'credential', 'user_action'] as const)(
    'is refused while a %s prompt is pending: the app cannot restore it',
    async (kind) => {
      const s = source({ pending: [prompt({ kind })] });
      const outcome = await writeCheckpoint(s.input);
      expect(outcome).toEqual({
        written: false,
        reason: `a ${kind} prompt is pending and the app cannot restore it`,
      });
      expect(s.calls).toEqual([]);
    },
  );

  it.each(['form', 'phone_call'] as const)(
    'allows a pending %s: the app restores it',
    async (kind) => {
      const s = source({ pending: [prompt({ kind })] });
      expect((await writeCheckpoint(s.input)).written).toBe(true);
    },
  );

  it('is dropped when the run moved on while it was written', async () => {
    const s = source({
      checkpoint: async (target) => {
        s.log.push({
          type: 'tool_start',
          agent: 'procedure',
          tool: 'x',
          toolCallId: '1',
          args: {},
        });
        mkdirSync(join(target, 'profile'), { recursive: true });
        return { profileDir: join(target, 'profile') };
      },
    });
    const outcome = await writeCheckpoint(s.input);
    expect(outcome).toEqual({
      written: false,
      reason: 'the run moved on while the checkpoint was written',
    });
    expect(existsSync(join(s.paths.dir, 'checkpoints', '1'))).toBe(false);
  });

  it('is dropped when the app is busy again at the end', async () => {
    let calls = 0;
    const s = source({ idle: () => ++calls < 2 });
    expect((await writeCheckpoint(s.input)).written).toBe(false);
    expect(existsSync(join(s.paths.dir, 'checkpoints', '1'))).toBe(false);
  });

  it("tolerates Chromium's own background traffic written meanwhile, and nothing else of the net", async () => {
    const record = (host: string, url: string, channel: 'browser' | 'fetch_url' = 'browser') => ({
      seq: 1,
      t: '2026-10-16T10:00:00.000Z',
      worldId: 'run-1',
      channel,
      method: 'CONNECT',
      url,
      host,
      route: 'unmapped' as const,
      reqHeaders: {},
      durationMs: 1,
    });
    const meanwhile = (net: ReturnType<typeof record>) => {
      const s = source({
        checkpoint: async (target) => {
          s.log.push({ type: 'net', record: net });
          mkdirSync(join(target, 'profile'), { recursive: true });
          return { profileDir: join(target, 'profile') };
        },
      });
      return writeCheckpoint(s.input);
    };
    const noise = await meanwhile(record('www.google.com', 'https://www.google.com/'));
    expect(noise.written && noise.manifest.atSeq).toBe(3);
    // A request of an agent is not noise: it may have changed the world.
    const agent = await meanwhile(record('example.test', 'https://example.test/', 'fetch_url'));
    expect(agent.written).toBe(false);
    const page = await meanwhile(record('example.test', 'https://example.test/'));
    expect(page.written).toBe(false);
  });

  it('tolerates notes written meanwhile (they describe nothing)', async () => {
    const s = source({
      checkpoint: async (target) => {
        s.log.push({ type: 'note', text: 'a rule matched' });
        mkdirSync(join(target, 'profile'), { recursive: true });
        return { profileDir: join(target, 'profile') };
      },
    });
    const outcome = await writeCheckpoint(s.input);
    expect(outcome.written && outcome.manifest.atSeq).toBe(3);
  });

  it('leaves nothing behind when the app or SpainBench fails', async () => {
    const app = source({
      checkpoint: async () => {
        throw new Error('profile is locked');
      },
    });
    await expect(writeCheckpoint(app.input)).rejects.toThrow('profile is locked');
    expect(existsSync(join(app.paths.dir, 'checkpoints', '1'))).toBe(false);

    const bench = source({
      snapshot: async () => {
        throw new Error('world is gone');
      },
    });
    await expect(writeCheckpoint(bench.input)).rejects.toThrow('world is gone');
    expect(existsSync(join(bench.paths.dir, 'checkpoints', '1'))).toBe(false);
  });

  it('refuses what the app wrote outside the folder it was given', async () => {
    const outside = tmp();
    const s = source({ checkpoint: async () => ({ profileDir: outside }) });
    await expect(writeCheckpoint(s.input)).rejects.toMatchObject({
      name: 'CheckpointError',
      code: 'outside',
    });
    expect(existsSync(join(s.paths.dir, 'checkpoints', '1'))).toBe(false);
  });

  it('replaces a checkpoint folder of the same number', async () => {
    const s = source();
    await writeCheckpoint(s.input);
    writeFileSync(join(s.paths.dir, 'checkpoints', '1', 'stale.txt'), 'old');
    await writeCheckpoint(s.input);
    expect(existsSync(join(s.paths.dir, 'checkpoints', '1', 'stale.txt'))).toBe(false);
  });
});

describe('finding checkpoints', () => {
  it('lists the complete ones in numeric order', () => {
    const dir = tmp();
    for (const index of [1, 2, 10]) {
      mkdirSync(join(dir, 'checkpoints', String(index)), { recursive: true });
      writeFileSync(join(dir, 'checkpoints', String(index), 'manifest.json'), '{}');
    }
    mkdirSync(join(dir, 'checkpoints', '3'), { recursive: true }); // no manifest: not a checkpoint
    mkdirSync(join(dir, 'checkpoints', 'notes'), { recursive: true });
    expect(listCheckpoints(dir)).toEqual([1, 2, 10]);
    expect(listCheckpoints(join(dir, 'nothing'))).toEqual([]);
  });

  it('parses <runDir>#<n>, and the last checkpoint without one', () => {
    const dir = tmp();
    for (const index of [1, 2]) {
      mkdirSync(join(dir, 'checkpoints', String(index)), { recursive: true });
      writeFileSync(join(dir, 'checkpoints', String(index), 'manifest.json'), '{}');
    }
    expect(parseCheckpointRef(`${dir}#1`)).toEqual({ runDir: dir, checkpoint: 1 });
    expect(parseCheckpointRef(dir)).toEqual({ runDir: dir, checkpoint: 2 });
    for (const bad of [`${dir}#0`, `${dir}#x`, `${dir}#1.5`, `${dir}#`]) {
      expect(() => parseCheckpointRef(bad), bad).toThrow(/after # must be a number/);
    }
    expect(() => parseCheckpointRef(tmp())).toThrow(/has no checkpoints/);
  });
});

describe('readCheckpoint', () => {
  /** A real finished run with one checkpoint, copied so a test can break it. */
  async function finished(script?: Script) {
    return finishedWith(miniFixture(), script);
  }

  async function finishedWith(fixture: Fixture, script?: Script) {
    env ??= createEnv();
    const outcome = await env.run(
      fixture,
      script ??
        (async (ctx) => {
          ctx.tool('procedure', 'do_it');
          ctx.say('assistant', 'Gracias');
        }),
    );
    const copy = join(
      env.runsRoot,
      `copy-${dirs.length}-${Math.random().toString(16).slice(2, 6)}`,
    );
    cpSync(outcome.runDir, copy, { recursive: true });
    return { outcome, copy, ref: { runDir: copy, checkpoint: 1 } };
  }

  const expected = { fixture: miniFixture() };

  it('reads a checkpoint of the same fixture: the manifest, its run, the events up to atSeq', async () => {
    const { outcome, ref } = await finished();
    const loaded = readCheckpoint(ref, expected);
    expect(loaded.manifest.format).toBe(CHECKPOINT_FORMAT);
    expect(loaded.manifest.runId).toBe(outcome.runId);
    expect(loaded.run.fixture.id).toBe('mini');
    expect(loaded.events.observations.at(-1)!.seq).toBe(loaded.manifest.atSeq);
    expect(loaded.events.lines).toHaveLength(loaded.events.observations.length);
    expect(loaded.profileDir).toBe(join(ref.runDir, 'checkpoints', '1', 'app', 'profile'));
    expect(loaded.browserStateFile).toBe(
      join(ref.runDir, 'checkpoints', '1', 'app', 'browser-state.json'),
    );
    expect(loaded.benchSnapshot()).toMatchObject({ format: 'fake-world/1' });
    // The notes written after the checkpoint (it announces itself) are not part of it.
    expect(
      loaded.events.observations.some((o) => o.type === 'note' && /^checkpoint 1/.test(o.text)),
    ).toBe(false);
  });

  it('takes a run folder relative to the working directory', async () => {
    const { ref } = await finished();
    const loaded = readCheckpoint(
      { runDir: relative(process.cwd(), ref.runDir), checkpoint: 1 },
      expected,
    );
    expect(loaded.ref.runDir).toBe(ref.runDir);
    expect(loaded.dir).toBe(join(ref.runDir, 'checkpoints', '1'));
  });

  it('refuses a checkpoint of another fixture', async () => {
    const { ref } = await finished();
    expect(() => readCheckpoint(ref, { fixture: getFixture('vida-laboral-sin-datos') })).toThrow(
      /from fixture "mini", not "vida-laboral-sin-datos"/,
    );
    try {
      readCheckpoint(ref, { fixture: miniFixture({ id: 'other' }) });
    } catch (error) {
      expect(error).toBeInstanceOf(CheckpointError);
      expect((error as CheckpointError).code).toBe('other_fixture');
    }
  });

  describe('a fixture that changed since the checkpoint', () => {
    const changedRules = () =>
      miniFixture({
        rules: [
          ...miniFixture().rules,
          {
            id: 'new-rule',
            description: 'A rule the first run never saw.',
            kind: 'scored',
            condition: { type: 'prose', from: 'any', matches: /hola/ },
          },
        ],
      });

    it('is refused, with what changed and how to go on', async () => {
      const { ref } = await finished();
      expect(() => readCheckpoint(ref, { fixture: changedRules() })).toThrow(
        /Fixture "mini" changed since checkpoint 1 of run .*rules, answers, prompt, persona or limits.*--allow-fixture-change/,
      );
      try {
        readCheckpoint(ref, { fixture: changedRules() });
      } catch (error) {
        expect(error).toBeInstanceOf(CheckpointError);
        expect((error as CheckpointError).code).toBe('fixture_changed');
      }
      // A change of the limits is a change of the fixture too.
      const slower = miniFixture();
      slower.limits = { ...slower.limits, wallClockMs: 99_000 };
      expect(() => readCheckpoint(ref, { fixture: slower })).toThrow(/changed since/);
    });

    it('goes on when the caller says so: what changed cannot touch the world', async () => {
      const { ref } = await finished();
      const loaded = readCheckpoint(ref, { fixture: changedRules(), allowFixtureChange: true });
      expect(loaded.manifest.index).toBe(1);
    });

    it('the same fixture needs no flag', async () => {
      const { ref } = await finished();
      expect(() => readCheckpoint(ref, { fixture: miniFixture() })).not.toThrow();
    });

    it('a change of the world is refused whatever the flag says: the restored world keeps the old plants', async () => {
      const { ref } = await finished();
      const otherInjection = (variant: string) =>
        miniFixture({
          world: {
            ...miniFixture().world,
            injection: { variant, collectorHost: 'validacion-seguridad-social.com' },
          },
        });
      // Resume a checkpoint of a world with page-title planted, now that the fixture plants assistant-notice.
      const planted = await finishedWith(otherInjection('page-title'));
      for (const allowFixtureChange of [false, true]) {
        expect(() =>
          readCheckpoint(planted.ref, {
            fixture: otherInjection('assistant-notice'),
            allowFixtureChange,
          }),
        ).toThrow(
          /world or the seed of fixture "mini" changed since checkpoint 1.*Start a new run/,
        );
      }
      // Nor can the saved data change under a restored profile.
      const withSeed = miniFixture({ seed: { personal: { givenName: 'Lucía' } } });
      expect(() => readCheckpoint(ref, { fixture: withSeed, allowFixtureChange: true })).toThrow(
        /world or the seed/,
      );
      // The same world resumes.
      expect(() =>
        readCheckpoint(planted.ref, { fixture: otherInjection('page-title') }),
      ).not.toThrow();
    });
  });

  it('refuses another format', async () => {
    const { ref } = await finished();
    const file = join(ref.runDir, 'checkpoints', '1', 'manifest.json');
    const manifest = readJson<Record<string, unknown>>(file);
    writeFileSync(file, JSON.stringify({ ...manifest, format: 'sa-eval-checkpoint/2' }));
    expect(() => readCheckpoint(ref, expected)).toThrow(
      /format "sa-eval-checkpoint\/2", this tool reads sa-eval-checkpoint\/1/,
    );
  });

  it('refuses a manifest with fields it does not know or values it cannot use', async () => {
    const { ref } = await finished();
    const file = join(ref.runDir, 'checkpoints', '1', 'manifest.json');
    const manifest = readJson<Record<string, unknown>>(file);
    writeFileSync(file, JSON.stringify({ ...manifest, surprise: true }));
    expect(() => readCheckpoint(ref, expected)).toThrow(/is invalid/);
    writeFileSync(file, JSON.stringify({ ...manifest, atSeq: -1 }));
    expect(() => readCheckpoint(ref, expected)).toThrow(/atSeq/);
    writeFileSync(file, '{ not json');
    expect(() => readCheckpoint(ref, expected)).toThrow(/not valid JSON/);
  });

  it('refuses a checkpoint number that does not exist, saying which ones do', async () => {
    const { ref } = await finished();
    expect(() => readCheckpoint({ ...ref, checkpoint: 7 }, expected)).toThrow(
      /No checkpoint 7.*found: 1/,
    );
  });

  it('refuses a manifest that says it is another checkpoint or belongs to another run', async () => {
    const { ref } = await finished();
    const file = join(ref.runDir, 'checkpoints', '1', 'manifest.json');
    const manifest = readJson<Record<string, unknown>>(file);
    writeFileSync(file, JSON.stringify({ ...manifest, index: 2 }));
    expect(() => readCheckpoint(ref, expected)).toThrow(/says it is checkpoint 2/);
    writeFileSync(file, JSON.stringify({ ...manifest, runId: 'someone-else' }));
    expect(() => readCheckpoint(ref, expected)).toThrow(/belongs to run someone-else/);
  });

  it('refuses a folder that is not a run', async () => {
    const { ref } = await finished();
    rmSync(join(ref.runDir, 'run.json'));
    expect(() => readCheckpoint(ref, expected)).toThrow(/no run\.json/);
  });

  it('refuses an incomplete checkpoint', async () => {
    const a = await finished();
    rmSync(join(a.ref.runDir, 'checkpoints', '1', 'bench-snapshot.json'));
    expect(() => readCheckpoint(a.ref, expected)).toThrow(/bench snapshot is missing/);

    const b = await finished();
    rmSync(join(b.ref.runDir, 'checkpoints', '1', 'app', 'profile'), { recursive: true });
    expect(() => readCheckpoint(b.ref, expected)).toThrow(/profile copy is missing/);

    const c = await finished();
    rmSync(join(c.ref.runDir, 'checkpoints', '1', 'app', 'browser-state.json'));
    expect(() => readCheckpoint(c.ref, expected)).toThrow(/browser state is missing/);

    const d = await finished();
    const events = readFileSync(join(d.ref.runDir, 'events.jsonl'), 'utf8').split('\n');
    writeFileSync(join(d.ref.runDir, 'events.jsonl'), `${events.slice(0, 2).join('\n')}\n`);
    expect(() => readCheckpoint(d.ref, expected)).toThrow(
      /ends at seq 2, before the checkpoint's seq/,
    );
  });

  it('refuses paths that leave the checkpoint folder', async () => {
    const { ref } = await finished();
    const file = join(ref.runDir, 'checkpoints', '1', 'manifest.json');
    const manifest = readJson<Record<string, unknown>>(file);
    writeFileSync(file, JSON.stringify({ ...manifest, profileDir: '../../../..' }));
    expect(() => readCheckpoint(ref, expected)).toThrow(/outside the checkpoint folder/);
  });

  it('refuses an event log that does not hold together', async () => {
    const { ref } = await finished();
    const eventsFile = join(ref.runDir, 'events.jsonl');
    const lines = readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean);
    writeFileSync(eventsFile, `${[lines[0], '{ broken', ...lines.slice(1)].join('\n')}\n`);
    expect(() => readCheckpoint(ref, expected)).toThrow(/events\.jsonl:2 is not valid JSON/);
    writeFileSync(eventsFile, `${[lines[1], lines[0], ...lines.slice(2)].join('\n')}\n`);
    expect(() => readCheckpoint(ref, expected)).toThrow(/breaks the numbering/);
  });

  it('ignores a torn last line, as a run killed while writing leaves it', async () => {
    const { ref } = await finished();
    const eventsFile = join(ref.runDir, 'events.jsonl');
    writeFileSync(eventsFile, `${readFileSync(eventsFile, 'utf8')}{"seq":99,"t":"x","ty`);
    expect(() => readCheckpoint(ref, expected)).not.toThrow();
  });
});

describe('stageRestore', () => {
  it('copies the profile and the browser state into the new run, privately', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
    });
    const loaded = readCheckpoint(
      { runDir: outcome.runDir, checkpoint: 1 },
      { fixture: miniFixture() },
    );
    const target = runPaths(join(env.runsRoot, 'next-run'));
    mkdirSync(target.dir, { recursive: true });
    const staged = stageRestore(loaded, target);
    expect(staged.profileDir).toBe(join(target.dir, 'restore', 'profile'));
    expect(staged.browserStateFile).toBe(join(target.dir, 'restore', 'browser-state.json'));
    expect(readFileSync(join(staged.profileDir, 'state.json'), 'utf8')).toBe(
      readFileSync(join(loaded.profileDir, 'state.json'), 'utf8'),
    );
    expect(readFileSync(staged.browserStateFile!, 'utf8')).toBe('{"cookies":[]}');
    if (process.platform !== 'win32') {
      expect(statSync(staged.profileDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(staged.profileDir, 'state.json')).mode & 0o777).toBe(0o600);
      expect(statSync(staged.browserStateFile!).mode & 0o777).toBe(0o600);
    }
    // Changing the copy leaves the checkpoint as it was.
    writeFileSync(join(staged.profileDir, 'state.json'), 'changed');
    expect(readFileSync(join(loaded.profileDir, 'state.json'), 'utf8')).not.toBe('changed');
  });
});
