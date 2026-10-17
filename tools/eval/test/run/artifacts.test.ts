import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Fixture } from '../../src/contracts';
import { getFixture } from '../../src/fixtures';
import {
  createEnv,
  type Env,
  fileText,
  listFiles,
  MODEL_KEY,
  miniFixture,
  readEventsFile,
  readJson,
  readResultFile,
} from './support/harness';
import type { Script } from './support/scripted-app';
import { conDatosGolden } from './support/vida';

let env: Env;
afterEach(() => env?.dispose());

const doIt: Script = async (ctx) => {
  ctx.tool('procedure', 'do_it');
  ctx.say('assistant', 'Gracias');
};

const PASSWORD = 'S3cr3t-Passw0rd-XYZ';
const AWKWARD = 'pa"ss\\word-123';

function withSecrets(): Fixture {
  return miniFixture({
    seed: {
      claves: [
        { username: '53918274H', password: PASSWORD },
        { username: 'X1234567L', password: AWKWARD },
      ],
    },
  });
}

const posix = process.platform !== 'win32';

describe('layout and permissions', () => {
  it.runIf(posix)('folders are 0700 and files 0600', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt);
    const mode = (path: string) => statSync(path).mode & 0o777;
    const dir = outcome.runDir;
    for (const folder of [
      dir,
      join(dir, 'bench'),
      join(dir, 'llm'),
      join(dir, 'checkpoints'),
      join(dir, 'checkpoints', '1'),
    ]) {
      expect(mode(folder), folder).toBe(0o700);
    }
    for (const file of [
      'run.json',
      'events.jsonl',
      'result.json',
      'report.md',
      join('llm', 'meter.jsonl'),
      join('checkpoints', '1', 'manifest.json'),
      join('checkpoints', '1', 'bench-snapshot.json'),
    ]) {
      expect(mode(join(dir, file)), file).toBe(0o600);
    }
  });

  it('has the files docs/EVAL.md promises, in a folder named after the run', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      clock: () => new Date('2026-10-17T06:30:15Z'),
      ids: () => 'a1b2',
    });
    expect(outcome.runId).toBe('mini-mock-20261017-063015-a1b2');
    expect(outcome.runDir).toBe(join(env.runsRoot, 'mini-mock-20261017-063015-a1b2'));
    expect(listFiles(outcome.runDir)).toEqual([
      'bench/requests.jsonl',
      'bench/snapshot.json',
      'bench/state.json',
      'checkpoints/1/app/browser-state.json',
      'checkpoints/1/app/profile/state.json',
      'checkpoints/1/bench-snapshot.json',
      'checkpoints/1/manifest.json',
      'events.jsonl',
      'llm/meter.jsonl',
      'report.md',
      'result.json',
      'run.json',
    ]);
    expect(outcome.resultFile).toBe(join(outcome.runDir, 'result.json'));
    expect(outcome.reportFile).toBe(join(outcome.runDir, 'report.md'));
    expect(readResultFile(outcome.runDir)).toEqual(outcome.result);
    expect(outcome.summary).toContain('completed (100.0%)');
    expect(outcome.summary).toContain('mini [mock]');
    expect(outcome.summary).toContain(outcome.runDir);
  });

  it('copies the meter ledger lines of this run, and only those', async () => {
    env = createEnv();
    const line = (runId: string, agent: string) => ({
      runId,
      agent,
      provider: 'mock' as const,
      kind: 'forward' as const,
      path: '/v1/chat/completions',
      status: 200,
    });
    const outcome = await env.run(miniFixture(), async (ctx) => {
      env.meter.ledger.append(line(ctx.spec.runId, 'assistant'));
      env.meter.ledger.append(line('some-other-run', 'assistant'));
      env.meter.ledger.append(line(ctx.spec.runId, 'procedure-1'));
      await doIt(ctx);
    });
    const lines = fileText(join(outcome.runDir, 'llm', 'meter.jsonl'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { runId: string; agent: string });
    expect(lines.map((l) => [l.runId, l.agent])).toEqual([
      [outcome.runId, 'assistant'],
      [outcome.runId, 'procedure-1'],
    ]);
  });

  it('hands SpainBench the answer of the bench part to describe itself in run.json', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, {
      benchInfo: { version: '1.2.3', features: ['plants', 'collector'] },
      limits: { maxToolCalls: 7 },
      captureBrowser: true,
      cacheVariant: 'sample-2',
      clock: () => new Date('2026-10-17T06:30:15Z'),
    });
    const manifest = readJson<Record<string, unknown>>(join(outcome.runDir, 'run.json'));
    expect(manifest).toMatchObject({
      format: 'sa-eval-run/1',
      runId: outcome.runId,
      fixture: { id: 'mini', title: 'Mini fixture', hash: expect.stringMatching(/^[0-9a-f]{16}$/) },
      provider: 'mock',
      models: { answererModel: 'test-answerer', answererThinking: 'low' },
      cache: 'off',
      limits: {
        wallClockMs: 10_000,
        maxToolCalls: 7,
        maxRequests: 100,
        maxCostUsd: 1,
        maxPrompts: 10,
      },
      options: {
        captureBrowser: true,
        settleTimeoutMs: 3000,
        evaluateIntervalMs: 5,
        keepWorld: false,
      },
      bench: { version: '1.2.3', features: ['plants', 'collector'] },
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      startedAt: '2026-10-17T06:30:15.000Z',
    });
    expect(manifest.resume).toBeUndefined();
    expect(env.apps[0]!.spec.captureBrowser).toBe(true);
    expect(env.meter.last.options).toMatchObject({
      variant: 'sample-2',
      cache: 'off',
      provider: 'mock',
    });
    expect(readEventsFile(outcome.runDir)[0]!.t).toBe('2026-10-17T06:30:15.000Z');
  });

  it('opens the meter run with the fixture cost limit and what makes replays stable', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt);
    const options = env.meter.last.options;
    expect(options.runId).toBe(outcome.runId);
    expect(options.limits).toEqual({ perRunUsd: 1 });
    expect(options.baseline).toBeUndefined();
    expect(options.volatile).toEqual(
      expect.arrayContaining([
        { pattern: outcome.runDir, replacement: '<RUNDIR>' },
        { pattern: outcome.runId, replacement: '<RUNID>' },
        { pattern: '127.0.0.1:41003', replacement: '<METER>' },
        { pattern: '127.0.0.1:41001', replacement: '<BENCH>' },
      ]),
    );
    // The folder comes before the id it contains, so the whole path is replaced.
    const patterns = options.volatile!.map((p) => p.replacement);
    expect(patterns.indexOf('<RUNDIR>')).toBeLessThan(patterns.indexOf('<RUNID>'));
  });

  it('takes no checkpoint when told not to', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, { checkpoint: false });
    expect(outcome.checkpoints).toEqual([]);
    expect(existsSync(join(outcome.runDir, 'checkpoints'))).toBe(false);
    expect(env.apps[0]!.checkpointCalls).toBe(0);
    expect(
      readJson<{ options: { checkpoint: boolean } }>(join(outcome.runDir, 'run.json')).options
        .checkpoint,
    ).toBe(false);
  });

  it('keeps the world only when asked', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), doIt, { keepWorld: true });
    expect(env.bench.worlds.has(outcome.runId)).toBe(true);
    expect(existsSync(join(outcome.runDir, 'bench', 'snapshot.json'))).toBe(true);
    expect(
      readJson<{ options: { keepWorld: boolean } }>(join(outcome.runDir, 'run.json')).options
        .keepWorld,
    ).toBe(true);
  });

  it('plants the injection and routes the collector as the fixture says', async () => {
    env = createEnv();
    const outcome = await env.run(getFixture('vida-laboral-inyeccion:page-title'), conDatosGolden);
    expect(env.bench.specs.get(outcome.runId)).toMatchObject({
      injection: { variant: 'page-title', collectorHost: 'validacion-seguridad-social.com' },
    });
    // `:` is not a world id character.
    expect(outcome.runId).toMatch(
      /^vida-laboral-inyeccion-page-title-mock-\d{8}-\d{6}-[0-9a-f]{4}$/,
    );
  });
});

describe('requests that cannot start', () => {
  it('refuses an invalid run id, a used run id and an invalid fixture before creating anything', async () => {
    env = createEnv();
    await expect(env.run(miniFixture(), doIt, { runId: 'has space' })).rejects.toThrow(
      /Invalid run id/,
    );
    await expect(env.run(miniFixture(), doIt, { runId: 'a'.repeat(65) })).rejects.toThrow(
      /Invalid run id/,
    );
    const first = await env.run(miniFixture(), doIt, { runId: 'fixed-id' });
    expect(first.runId).toBe('fixed-id');
    await expect(env.run(miniFixture(), doIt, { runId: 'fixed-id' })).rejects.toThrow(
      /run directory already exists/,
    );
    const broken = miniFixture({ rules: [] });
    await expect(env.run(broken, doIt)).rejects.toThrow(/Invalid fixture/);
    await expect(env.run(miniFixture(), doIt, { settleTimeoutMs: 0 })).rejects.toThrow(
      /settleTimeoutMs must be a positive number/,
    );
    await expect(env.run(miniFixture(), doIt, { limits: { maxCostUsd: -1 } })).rejects.toThrow(
      /limits\.maxCostUsd must be a positive number/,
    );
    expect(readdirSync(env.runsRoot)).toEqual(['fixed-id']);
    expect(env.bench.calls.filter((c) => c.startsWith('createWorld'))).toEqual([
      'createWorld:fixed-id',
    ]);
  });
});

describe('secrets never reach the artifacts', () => {
  const artifacts = (runDir: string) =>
    ['events.jsonl', 'result.json', 'report.md', 'run.json'].map(
      (name) => [name, readFileSync(join(runDir, name), 'utf8')] as const,
    );

  it('masks the fixture passwords, the model key and their JSON-escaped forms everywhere', async () => {
    env = createEnv();
    const outcome = await env.run(
      withSecrets(),
      async (ctx) => {
        ctx.tool('procedure', 'do_it', { note: `typed ${PASSWORD}` });
        ctx.say('assistant', `Gracias. Tu clave es ${AWKWARD} y la key ${MODEL_KEY}`);
        ctx.emit({
          type: 'tool_end',
          agent: 'procedure',
          tool: 'x',
          toolCallId: 'x',
          isError: true,
          text: `failed with ${PASSWORD}`,
        });
        ctx.bench.emit(ctx.spec.runId, 'wrong_turn', { path: `/login?p=${AWKWARD}` });
      },
      { benchInfo: { note: `the server said ${PASSWORD}` } },
    );
    for (const [name, text] of artifacts(outcome.runDir)) {
      expect(text, name).not.toContain(PASSWORD);
      expect(text, name).not.toContain(AWKWARD);
      expect(text, name).not.toContain(JSON.stringify(AWKWARD).slice(1, -1));
      expect(text, name).not.toContain(MODEL_KEY);
    }
    const events = fileText(join(outcome.runDir, 'events.jsonl'));
    expect(events).toContain('[redacted]');
    // The rules still saw the real text: the run scored.
    expect(outcome.result.status).toBe('completed');
  });

  it("masks them in the files of the world that SpainBench's account state carries", async () => {
    env = createEnv();
    const outcome = await env.run(withSecrets(), async (ctx) => {
      ctx.bench.world(ctx.spec.runId).sites['mini-site'] = {
        user: { document: '53918274H', password: PASSWORD },
      };
      ctx.tool('procedure', 'do_it');
    });
    for (const name of ['state.json', 'snapshot.json']) {
      const text = fileText(join(outcome.runDir, 'bench', name));
      expect(text, name).not.toContain(PASSWORD);
      expect(text, name).toContain('[redacted]');
      expect(text, name).toContain('53918274H');
    }
  });

  it('masks them in the notes of a failure too', async () => {
    env = createEnv();
    env.bench.fail('createWorld', new Error(`refused for ${PASSWORD} (key ${MODEL_KEY})`));
    const outcome = await env.run(withSecrets(), doIt);
    expect(outcome.result.notes[0]).toBe(
      'bench.createWorld: refused for [redacted] (key [redacted])',
    );
    for (const [name, text] of artifacts(outcome.runDir)) {
      expect(text, name).not.toContain(PASSWORD);
      expect(text, name).not.toContain(MODEL_KEY);
    }
    // The summary line for the terminal is built from the same result.
    expect(outcome.summary).not.toContain(PASSWORD);
  });

  it('masks the password of a credential answer that the app learned only from the fixture answers', async () => {
    env = createEnv();
    const fixture = miniFixture({
      unexpectedPrompt: 'dismiss',
      answerGroups: [
        {
          id: 'g',
          answers: [
            {
              id: 'clave',
              match: { kind: 'credential' },
              action: { type: 'credential', username: '53918274H', password: 'Answer-Only-Pw-77' },
            },
          ],
        },
      ],
    });
    const outcome = await env.run(fixture, async (ctx) => {
      await ctx.ask({ itemId: 'cred', agent: 'procedure', kind: 'credential', title: 'Clave' });
      ctx.say('assistant', 'Gracias, la clave es Answer-Only-Pw-77');
      ctx.tool('procedure', 'do_it');
    });
    expect(env.apps[0]!.claves[0]!.password).toBe('Answer-Only-Pw-77');
    for (const [name, text] of artifacts(outcome.runDir))
      expect(text, name).not.toContain('Answer-Only-Pw-77');
  });
});
