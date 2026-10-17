import './llm/helpers/no-network';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BenchTargetError } from '../src/bench';
import { UnknownFixtureError } from '../src/fixtures';
import { DEFAULT_ANSWERER_MODEL, DEFAULT_CODEX_ANSWERER_MODEL } from '../src/llm';
import { CodexAuthError, CodexConsentError } from '../src/llm/codex-auth';
import { EvalHomeError } from '../src/llm/home';
import { CheckpointError } from '../src/run';
import { VOUCHER_FLOOR_USD } from '../src/run/caps';
import {
  defaultCache,
  defaultModels,
  EvaluationRefused,
  type EvaluationRequest,
  expiryRefusal,
  findBenchLog,
  floorRefusal,
  NO_BENCH_MESSAGE,
  pendingBenchLog,
  prepareEvaluation,
  runBenchLog,
  runEvaluation,
  settleBenchLog,
} from '../src/runner';
import { makeHome, type TestHome, writeLitellmFile } from './llm/helpers/tmp-home';

let home: TestHome;
let root: string;
beforeEach(() => {
  home = makeHome();
  root = mkdtempSync(join(tmpdir(), 'sa-runner-'));
});
afterEach(() => {
  home.cleanup();
  rmSync(root, { recursive: true, force: true });
});

const SCENARIO = { name: 'x', fallback: { text: 'hola' } };
/** A bench folder that is never started: `prepareEvaluation` starts nothing. */
const BENCH_ENV = { SPAINBENCH_DIR: '/never/started/SpainBench' };

function request(overrides: Partial<EvaluationRequest> = {}): EvaluationRequest {
  return {
    fixtureId: 'vida-laboral-sin-datos',
    provider: 'mock',
    scenario: SCENARIO,
    env: BENCH_ENV,
    home: home.home,
    runsRoot: join(root, 'runs'),
    // The browser is never started either: only whether it is installed is asked.
    chromiumPath: () => '/fake/chromium',
    ...overrides,
  };
}

/** A `fetch` that plays the key server's `GET /v1/vouchers/credit`. */
function keyServer(
  credit:
    | { limitUsd: number; spendUsd: number; maxBudgetUsd: number; expiresAt?: string | null }
    | 'down',
) {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    });
    if (credit === 'down') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ expiresAt: null, ...credit }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('the browser the agents need', () => {
  it('a run without Chromium is refused before anything starts, saying how to get one', async () => {
    const error = await prepareEvaluation(request({ chromiumPath: () => undefined })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EvaluationRefused);
    expect((error as Error).message).toMatch(/Chromium is not in Playwright's cache/);
    expect((error as Error).message).toMatch(/playwright-core install chromium/);
    expect((error as Error).message).toContain('never downloads');
    expect(existsSync(join(root, 'runs'))).toBe(false);
  });
});

describe('small decisions', () => {
  it('caches nothing for the mock and records and replays for real providers', () => {
    expect(defaultCache('mock')).toBe('off');
    expect(defaultCache('voucher')).toBe('auto');
    expect(defaultCache('codex')).toBe('auto');
  });

  it('picks the answerer model of the provider, and lets the caller choose every model', () => {
    expect(defaultModels('voucher')).toEqual({
      answererModel: DEFAULT_ANSWERER_MODEL,
      answererThinking: 'low',
    });
    expect(defaultModels('mock').answererModel).toBe(DEFAULT_ANSWERER_MODEL);
    expect(defaultModels('codex').answererModel).toBe(DEFAULT_CODEX_ANSWERER_MODEL);
    expect(DEFAULT_CODEX_ANSWERER_MODEL).not.toBe(DEFAULT_ANSWERER_MODEL);
    expect(
      defaultModels('voucher', { assistantModel: 'a', procedureModel: 'p', answererModel: 'u' }),
    ).toEqual({
      assistantModel: 'a',
      procedureModel: 'p',
      answererModel: 'u',
      answererThinking: 'low',
    });
  });

  it('refuses real calls under the voucher floor, in a message that says what to do', () => {
    expect(VOUCHER_FLOOR_USD).toBe(1);
    expect(floorRefusal(0.4, 1)).toBe(
      'The voucher key has $0.40 left, under the $1.00 floor: real calls are stopped (replay a recorded run with --cache replay, or use another provider)',
    );
    expect(floorRefusal(0.999, 1)).toMatch(/\$1\.00 left, under the \$1\.00 floor/);
    expect(floorRefusal(1, 1)).toBeUndefined();
    expect(floorRefusal(3.2, 1)).toBeUndefined();
    expect(floorRefusal(0.1, 0.05)).toBeUndefined();
  });

  it('refuses a voucher key whose expiry date has passed', () => {
    const now = new Date('2026-10-17T10:00:00Z');
    expect(expiryRefusal('2026-10-01T00:00:00Z', now)).toMatch(
      /The voucher key expired on 2026-10-01T00:00:00Z: redeem a new voucher/,
    );
    expect(expiryRefusal('2026-10-17T10:00:00Z', now)).toMatch(/expired/);
    expect(expiryRefusal('2026-10-18T00:00:00Z', now)).toBeUndefined();
    expect(expiryRefusal(null, now)).toBeUndefined();
    expect(expiryRefusal(undefined, now)).toBeUndefined();
    expect(expiryRefusal('someday', now)).toBeUndefined();
  });
});

describe('prepareEvaluation refuses before anything starts', () => {
  const none = () => expect(existsSync(join(root, 'runs'))).toBe(false);

  it('an unknown fixture', async () => {
    await expect(prepareEvaluation(request({ fixtureId: 'nope' }))).rejects.toBeInstanceOf(
      UnknownFixtureError,
    );
    await expect(
      prepareEvaluation(request({ fixtureId: 'vida-laboral-inyeccion:' })),
    ).rejects.toBeInstanceOf(UnknownFixtureError);
    none();
  });

  it('the mock provider without a scenario, and a scenario for a real provider', async () => {
    const { scenario: _scenario, ...bare } = request();
    await expect(prepareEvaluation(bare)).rejects.toThrow(
      new EvaluationRefused(
        'The mock provider needs a scenario: the script the model follows (see --scenario)',
      ),
    );
    await expect(prepareEvaluation(request({ provider: 'voucher' }))).rejects.toThrow(
      /A scenario is the script of the mock model: it does not apply to the voucher provider/,
    );
    none();
  });

  it('a run id that is not one, and a run id that is already used', async () => {
    await expect(prepareEvaluation(request({ runId: 'has space' }))).rejects.toThrow(
      EvaluationRefused,
    );
    await expect(prepareEvaluation(request({ runId: 'has space' }))).rejects.toThrow(
      /Invalid run id/,
    );
    mkdirSync(join(root, 'runs', 'taken'), { recursive: true });
    await expect(prepareEvaluation(request({ runId: 'taken' }))).rejects.toThrow(
      /The run directory already exists: .*taken \(a run id is used once: pick another --run-id\)/,
    );
  });

  it('a checkpoint that does not exist', async () => {
    await expect(
      prepareEvaluation(request({ from: { runDir: join(root, 'nowhere'), checkpoint: 1 } })),
    ).rejects.toBeInstanceOf(CheckpointError);
    none();
  });

  it('a voucher run without a key file', async () => {
    const error = await prepareEvaluation(
      request({ provider: 'voucher', scenario: undefined }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalHomeError);
    expect((error as EvalHomeError).code).toBe('missing');
    expect((error as EvalHomeError).message).toMatch(
      /No voucher key: .*litellm\.json does not exist/,
    );
    none();
  });

  it('a voucher key that other users can read', async () => {
    writeLitellmFile(home.home, {}, 0o644);
    const error = await prepareEvaluation(
      request({ provider: 'voucher', scenario: undefined }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvalHomeError);
    expect((error as EvalHomeError).code).toBe('unsafe_permissions');
  });

  it('Codex without consent, even with a login stored, and Codex without a login', async () => {
    const codex = request({ provider: 'codex', scenario: undefined });
    await expect(prepareEvaluation(codex)).rejects.toBeInstanceOf(CodexConsentError);
    await expect(
      prepareEvaluation({ ...codex, env: { ...BENCH_ENV, SA_EVAL_CODEX_CONSENT: '0' } }),
    ).rejects.toBeInstanceOf(CodexConsentError);
    const error = await prepareEvaluation({ ...codex, codexConsent: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CodexAuthError);
    expect((error as CodexAuthError).code).toBe('missing');
    const viaEnv = await prepareEvaluation({
      ...codex,
      env: { ...BENCH_ENV, SA_EVAL_CODEX_CONSENT: '1' },
    }).catch((e: unknown) => e);
    expect(viaEnv).toBeInstanceOf(CodexAuthError);
    none();
  });

  it('no SpainBench to run against, and SPAINBENCH_* settings that cannot be used', async () => {
    await expect(prepareEvaluation(request({ env: {} }))).rejects.toThrow(
      new EvaluationRefused(NO_BENCH_MESSAGE),
    );
    await expect(prepareEvaluation(request({ env: { SPAINBENCH_DIR: '  ' } }))).rejects.toThrow(
      /No SpainBench to run against: set SPAINBENCH_DIR/,
    );
    await expect(
      prepareEvaluation(request({ env: { SPAINBENCH_URL: 'http://10.1.2.3:3010' } })),
    ).rejects.toBeInstanceOf(BenchTargetError);
    none();
  });

  it('a voucher key with less than the floor left, as the key server says', async () => {
    writeLitellmFile(home.home, { keyServerUrl: 'http://127.0.0.1:1' });
    const server = keyServer({ limitUsd: 5, spendUsd: 4.6, maxBudgetUsd: 5 });
    await expect(
      prepareEvaluation(
        request({ provider: 'voucher', scenario: undefined, keyServerFetch: server.fetchImpl }),
      ),
    ).rejects.toThrow(
      /The voucher key has \$0\.40 left, under the \$1\.00 floor: real calls are stopped \(replay a recorded run with --cache replay, or use another provider\)/,
    );
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.url).toBe('http://127.0.0.1:1/v1/vouchers/credit');
    none();
  });

  it('a voucher key that expired, without asking the key server', async () => {
    writeLitellmFile(home.home, { expiresAt: '2026-01-01T00:00:00Z' });
    const server = keyServer({ limitUsd: 5, spendUsd: 0, maxBudgetUsd: 5 });
    await expect(
      prepareEvaluation(
        request({ provider: 'voucher', scenario: undefined, keyServerFetch: server.fetchImpl }),
      ),
    ).rejects.toThrow(/The voucher key expired on 2026-01-01T00:00:00Z/);
    expect(server.calls).toHaveLength(0);
  });

  it('a voucher key that the key server says has expired, even if litellm.json does not record it', async () => {
    writeLitellmFile(home.home, { keyServerUrl: 'http://127.0.0.1:1' });
    const server = keyServer({
      limitUsd: 5,
      spendUsd: 0,
      maxBudgetUsd: 5,
      expiresAt: '2026-01-01T00:00:00Z',
    });
    await expect(
      prepareEvaluation(
        request({ provider: 'voucher', scenario: undefined, keyServerFetch: server.fetchImpl }),
      ),
    ).rejects.toThrow(/The voucher key expired on 2026-01-01T00:00:00Z/);
    expect(server.calls).toHaveLength(1);
    none();
  });

  it('starts nothing: a refused runEvaluation leaves no folder and no log', async () => {
    await expect(runEvaluation(request({ fixtureId: 'nope' }))).rejects.toBeInstanceOf(
      UnknownFixtureError,
    );
    await expect(runEvaluation(request({ env: {} }))).rejects.toBeInstanceOf(EvaluationRefused);
    expect(existsSync(join(root, 'runs'))).toBe(false);
    expect(readdirSync(home.home)).toEqual([]);
  });
});

describe('prepareEvaluation decides what the run starts with', () => {
  it('for the mock: no cache, a generated run id, the target and the paths resolved against the cwd', async () => {
    const plan = await prepareEvaluation(
      request({
        env: { SPAINBENCH_DIR: 'bench/repo' },
        cwd: root,
        runsRoot: 'my-runs',
      }),
    );
    expect(plan.provider).toBe('mock');
    expect(plan.cache).toBe('off');
    expect(plan.fixture.id).toBe('vida-laboral-sin-datos');
    expect(plan.runId).toMatch(/^vida-laboral-sin-datos-mock-\d{8}-\d{6}-[0-9a-f]{4}$/);
    expect(plan.runsRoot).toBe(join(root, 'my-runs'));
    expect(plan.target).toEqual({ mode: 'launch', dir: join(root, 'bench/repo') });
    expect(plan.home).toBe(home.home);
    expect(plan.voucherFloorUsd).toBe(1);
    expect(plan.keyRemainingUsd).toBeUndefined();
    expect(plan.voucherBaseUrl).toBeUndefined();
    expect(await plan.credentials.credential('litellm')).toMatchObject({ type: 'api_key' });
  });

  it('takes the credentials home from SPAINBENCH_DATA_DIR of the environment it was given', async () => {
    const plan = await prepareEvaluation(
      request({
        home: undefined,
        env: { ...BENCH_ENV, SPAINBENCH_DATA_DIR: join(root, 'elsewhere') },
      }),
    );
    expect(plan.home).toBe(join(root, 'elsewhere'));
  });

  it('connects to a running SpainBench when only a URL is set', async () => {
    const plan = await prepareEvaluation(
      request({ env: { SPAINBENCH_URL: 'http://127.0.0.1:3010' } }),
    );
    expect(plan.target).toMatchObject({
      mode: 'connect',
      publicUrl: 'http://127.0.0.1:3010',
      scoringUrl: 'http://127.0.0.1:3020',
    });
  });

  it('for a voucher run with enough left: the balance, the gateway and the floor', async () => {
    writeLitellmFile(home.home, {
      baseUrl: 'https://gateway.example.test/v1/',
      keyServerUrl: 'http://127.0.0.1:1',
    });
    const server = keyServer({ limitUsd: 5, spendUsd: 1, maxBudgetUsd: 5 });
    const plan = await prepareEvaluation(
      request({ provider: 'voucher', scenario: undefined, keyServerFetch: server.fetchImpl }),
    );
    expect(plan.cache).toBe('auto');
    expect(plan.keyRemainingUsd).toBe(4);
    expect(plan.voucherBaseUrl).toBe('https://gateway.example.test/v1');
    expect(plan.voucherFloorUsd).toBe(1);
    expect(await plan.credentials.credential('litellm')).toMatchObject({ type: 'api_key' });
    expect(server.calls[0]?.authorization).toMatch(/^Bearer sk-test-voucher/);
  });

  it('lets the caller move the floor', async () => {
    writeLitellmFile(home.home, { keyServerUrl: 'http://127.0.0.1:1' });
    const server = keyServer({ limitUsd: 5, spendUsd: 4.6, maxBudgetUsd: 5 });
    const plan = await prepareEvaluation(
      request({
        provider: 'voucher',
        scenario: undefined,
        keyServerFetch: server.fetchImpl,
        voucherFloorUsd: 0.25,
      }),
    );
    expect(plan.keyRemainingUsd).toBeCloseTo(0.4, 10);
    expect(plan.voucherFloorUsd).toBe(0.25);
  });

  it('goes on without a balance when the key server cannot be reached (the meter learns it from the gateway)', async () => {
    writeLitellmFile(home.home, { keyServerUrl: 'http://127.0.0.1:1' });
    const server = keyServer('down');
    const plan = await prepareEvaluation(
      request({ provider: 'voucher', scenario: undefined, keyServerFetch: server.fetchImpl }),
    );
    expect(plan.keyRemainingUsd).toBeUndefined();
    expect(plan.voucherBaseUrl).toBeDefined();
  });

  it('does not ask the key server when told to stay offline, nor for a replay run', async () => {
    writeLitellmFile(home.home);
    const server = keyServer({ limitUsd: 5, spendUsd: 5, maxBudgetUsd: 5 });
    const offline = await prepareEvaluation(
      request({
        provider: 'voucher',
        scenario: undefined,
        keyServerFetch: server.fetchImpl,
        offlineBudget: true,
      }),
    );
    expect(offline.keyRemainingUsd).toBeUndefined();
    rmSync(join(home.home, 'litellm.json'));
    // A replay never goes upstream: no key file, no key server.
    const replay = await prepareEvaluation(
      request({
        provider: 'voucher',
        scenario: undefined,
        cache: 'replay',
        keyServerFetch: server.fetchImpl,
      }),
    );
    expect(replay.cache).toBe('replay');
    expect(replay.voucherBaseUrl).toBeUndefined();
    expect(server.calls).toHaveLength(0);
  });

  it('a Codex replay needs neither consent nor a login', async () => {
    const plan = await prepareEvaluation(
      request({ provider: 'codex', scenario: undefined, cache: 'replay' }),
    );
    expect(plan.provider).toBe('codex');
    expect(plan.credentials.providerId).toBe('openai-codex');
  });
});

describe('the log of a launched SpainBench', () => {
  const runs = () => join(root, 'runs');
  const write = (file: string, text = 'SpainBench: public port 1') => {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text, { mode: 0o600 });
  };

  it('is written under _bench while the run is set up, and kept in the run folder afterwards', () => {
    expect(pendingBenchLog(runs(), 'r1')).toBe(join(runs(), '_bench', 'r1.log'));
    expect(runBenchLog(join(runs(), 'r1'))).toBe(join(runs(), 'r1', 'logs', 'bench-server.log'));
  });

  it('moves into <run>/logs/bench-server.log, private, and removes an empty _bench', () => {
    write(pendingBenchLog(runs(), 'r1'), 'the server said hi');
    mkdirSync(join(runs(), 'r1'), { recursive: true });
    const where = settleBenchLog(runs(), 'r1');
    expect(where).toBe(join(runs(), 'r1', 'logs', 'bench-server.log'));
    expect(readFileSync(where as string, 'utf8')).toBe('the server said hi');
    expect(statSync(where as string).mode & 0o777).toBe(0o600);
    expect(existsSync(join(runs(), '_bench'))).toBe(false);
    expect(findBenchLog(runs(), 'r1')).toBe(where);
  });

  it('moves it next to the logs the app already wrote', () => {
    write(pendingBenchLog(runs(), 'r1'));
    write(join(runs(), 'r1', 'logs', 'main.log'), 'app');
    settleBenchLog(runs(), 'r1');
    expect(readdirSync(join(runs(), 'r1', 'logs')).sort()).toEqual([
      'bench-server.log',
      'main.log',
    ]);
  });

  it("leaves other runs' logs where they are", () => {
    write(pendingBenchLog(runs(), 'r1'));
    write(pendingBenchLog(runs(), 'r2'));
    mkdirSync(join(runs(), 'r1'), { recursive: true });
    settleBenchLog(runs(), 'r1');
    expect(existsSync(pendingBenchLog(runs(), 'r2'))).toBe(true);
    expect(existsSync(join(runs(), '_bench'))).toBe(true);
  });

  it('leaves the log where it can be found when the run never got a folder, and says where', () => {
    write(pendingBenchLog(runs(), 'early'));
    expect(settleBenchLog(runs(), 'early')).toBe(pendingBenchLog(runs(), 'early'));
    expect(existsSync(pendingBenchLog(runs(), 'early'))).toBe(true);
    expect(findBenchLog(runs(), 'early')).toBe(pendingBenchLog(runs(), 'early'));
  });

  it('has nothing to move for a server that was connected, not launched', () => {
    mkdirSync(join(runs(), 'r1'), { recursive: true });
    expect(settleBenchLog(runs(), 'r1')).toBeUndefined();
    expect(findBenchLog(runs(), 'r1')).toBeUndefined();
    expect(existsSync(join(runs(), 'r1', 'logs'))).toBe(false);
  });

  it('works when the folders cannot be listed by others (0700 runs root)', () => {
    write(pendingBenchLog(runs(), 'r1'));
    mkdirSync(join(runs(), 'r1'), { recursive: true });
    chmodSync(runs(), 0o700);
    expect(settleBenchLog(runs(), 'r1')).toBe(runBenchLog(join(runs(), 'r1')));
  });
});
