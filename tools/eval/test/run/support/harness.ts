import '../../llm/helpers/no-network';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fixture, Observation, RunResult } from '../../../src/contracts';
import type {
  Answerer,
  AnswererOptions,
  AnswererRequest,
  AnswererResult,
  CredentialSource,
} from '../../../src/llm';
import { type RunOptions, type RunOutcome, runFixture } from '../../../src/run';
import { FakeBench, fakeFollowBench, fakeSaveBenchArtifacts } from './fake-bench';
import { FakeMeter } from './fake-meter';
import {
  type Script,
  type ScriptedApp,
  type ScriptedAppOptions,
  scriptedCreateApp,
} from './scripted-app';

/** A model key that must never show up in an artifact. */
export const MODEL_KEY = 'sk-test-model-key-0123456789abcdef';

export function miniFixture(overrides: Partial<Fixture> = {}): Fixture {
  return {
    id: 'mini',
    title: 'Mini fixture',
    prompt: 'haz la tarea',
    language: 'es',
    world: { sites: ['seg-social-es'], seed: 1, today: '2026-10-16' },
    research: 'vida-laboral',
    persona: 'Eres Lucía, una usuaria de prueba.',
    answerGroups: [],
    unexpectedPrompt: 'dismiss',
    rules: [
      {
        id: 'did-it',
        description: 'The procedure agent did the task.',
        kind: 'required',
        condition: { type: 'toolCall', agent: 'procedure', tool: 'do_it' },
      },
      {
        id: 'no-bad',
        description: 'Nobody uses the forbidden tool.',
        kind: 'required',
        negate: true,
        condition: { type: 'toolCall', tool: 'bad_tool' },
      },
      {
        id: 'said-thanks',
        description: 'The assistant says thanks.',
        kind: 'scored',
        condition: { type: 'prose', from: 'assistant', matches: /gracias/i },
      },
    ],
    limits: {
      wallClockMs: 10_000,
      maxToolCalls: 50,
      maxRequests: 100,
      maxCostUsd: 1,
      maxPrompts: 10,
    },
    ...overrides,
  };
}

export interface Env {
  readonly runsRoot: string;
  readonly bench: FakeBench;
  readonly meter: FakeMeter;
  readonly credentials: CredentialSource;
  /** Every app made by `run`/`options`, in order. */
  readonly apps: ScriptedApp[];
  /** Run options for a fixture and a script; `extra` overrides anything. */
  options(
    fixture: Fixture,
    script: Script,
    extra?: Partial<RunOptions>,
    appOptions?: ScriptedAppOptions,
  ): RunOptions;
  run(
    fixture: Fixture,
    script: Script,
    extra?: Partial<RunOptions>,
    appOptions?: ScriptedAppOptions,
  ): Promise<RunOutcome>;
  dispose(): void;
}

let counter = 0;

/**
 * Everything a run needs, as fakes: SpainBench, the meter, the app (a script), the credentials.
 * Timings are tiny so the tests stay fast.
 */
export function createEnv(): Env {
  const runsRoot = mkdtempSync(join(tmpdir(), 'sa-run-'));
  const bench = new FakeBench();
  const meter = new FakeMeter();
  const apps: ScriptedApp[] = [];
  const credentials: CredentialSource = {
    providerId: 'litellm',
    credential: async (id) => (id === 'litellm' ? { type: 'api_key', key: MODEL_KEY } : null),
    refreshCredential: async (id) =>
      id === 'litellm' ? { type: 'api_key', key: MODEL_KEY } : null,
  };

  const options: Env['options'] = (fixture, script, extra = {}, appOptions = {}) => {
    const createApp = scriptedCreateApp(script, bench, appOptions);
    const original = createApp;
    const wrapped = (async (...args: Parameters<typeof original>) => {
      const app = await original(...args);
      apps.push(app as ScriptedApp);
      return app;
    }) as typeof original;
    return {
      fixture,
      provider: 'mock',
      models: { answererModel: 'test-answerer', answererThinking: 'low' },
      cache: 'off',
      bench,
      meter,
      credentials,
      runsRoot,
      ids: () => (++counter).toString(16).padStart(4, '0').slice(-4),
      // The tests of this folder address the fake bench's worlds by run id: the world id is that.
      // (The default, an id of its own, is tested in world-id.test.ts.)
      worldId: (runId) => runId,
      evaluateIntervalMs: 5,
      settleTimeoutMs: 3000,
      shutdownTimeoutMs: 100,
      createApp: wrapped,
      followBench: fakeFollowBench(),
      saveBenchArtifacts: fakeSaveBenchArtifacts(bench),
      ...extra,
    };
  };

  return {
    runsRoot,
    bench,
    meter,
    credentials,
    apps,
    options,
    run: (fixture, script, extra, appOptions) =>
      runFixture(options(fixture, script, extra, appOptions)),
    dispose() {
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(meter.home, { recursive: true, force: true });
    },
  };
}

export type FakeReply = (request: AnswererRequest) => AnswererResult | Promise<AnswererResult>;

/** An answerer that returns what the test queues, and counts how it was created and used. */
export function fakeAnswerer(replies: FakeReply[] = []) {
  const state = { created: 0, requests: [] as AnswererRequest[], options: [] as AnswererOptions[] };
  const queue = [...replies];
  const create = async (options: AnswererOptions): Promise<Answerer> => {
    state.created++;
    state.options.push(options);
    return {
      model: 'fake',
      thinking: 'low',
      async answer(request) {
        state.requests.push(request);
        const next = queue.shift();
        if (!next) throw new Error('the fake answerer has no more replies');
        return next(request);
      },
    };
  };
  return Object.assign(create, { state });
}

// ---- reading artifacts -------------------------------------------------------------------

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readEventsFile(runDir: string): Observation[] {
  return readFileSync(join(runDir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

export function readResultFile(runDir: string): RunResult {
  return readJson<RunResult>(join(runDir, 'result.json'));
}

/** Every file under a folder, relative, sorted. */
export function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path, base));
    else out.push(path.slice(base.length + 1));
  }
  return out.sort();
}

export function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The complete artifact set of a finished run, whatever happened. */
export const EXPECTED_ARTIFACTS = ['events.jsonl', 'report.md', 'result.json', 'run.json'];

export function noteTexts(events: readonly Observation[]): string[] {
  return events
    .filter((e): e is Extract<Observation, { type: 'note' }> => e.type === 'note')
    .map((e) => e.text);
}
