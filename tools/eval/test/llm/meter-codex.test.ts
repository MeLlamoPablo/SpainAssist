import './helpers/no-network';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexConsentError } from '../../src/llm/codex-auth';
import { Ledger } from '../../src/llm/ledger';
import { createMeter, type MeterEvent, type MeterRun } from '../../src/llm/meter';
import { buffered, type MeterEnv, startEnv } from './helpers/meter-env';
import { makeHome } from './helpers/tmp-home';

let env: MeterEnv;
afterEach(() => env.close());

const ACCOUNT = 'acct-test-0001';
const TOKEN = 'codex-access-token-abcdef123456';

const input = (text: string) => [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
];

const responsesBody = (text: string, extra: Record<string, unknown> = {}) => ({
  model: 'gpt-6.1-sol',
  store: false,
  stream: true,
  instructions: 'You are a procedure agent.\nToday is Saturday 2026-10-17 (Europe/Madrid).',
  input: input(text),
  tools: [],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'medium', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
  prompt_cache_key: 'session-1',
  ...extra,
});

async function codexPost(
  run: MeterRun,
  agent: string,
  body: Record<string, unknown>,
  options: { zstd?: boolean; headers?: Record<string, string>; path?: string } = {},
): Promise<Response> {
  const json = JSON.stringify(body);
  return buffered(
    await fetch(`${run.agentBaseUrl(agent)}${options.path ?? '/codex/responses'}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'chatgpt-account-id': ACCOUNT,
        originator: 'pi',
        'openai-beta': 'responses=experimental',
        ...(options.zstd ? { 'content-encoding': 'zstd' } : {}),
        ...options.headers,
      },
      body: options.zstd ? zstdCompressSync(Buffer.from(json)) : json,
    }),
  );
}

const startCodex = (options: Parameters<typeof startEnv>[0] = {}) =>
  startEnv({
    provider: 'codex',
    upstreamPath: '/backend-api',
    meter: { codexConsent: true },
    ...options,
    mock: {
      scenario: {
        rules: [],
        fallback: {
          text: 'Hola desde Codex',
          usage: {
            promptTokens: 2000,
            completionTokens: 100,
            cachedTokens: 1500,
            reasoningTokens: 20,
          },
        },
      },
      chunkSize: 5,
      ...options.mock,
    },
  });

async function drain(res: Response): Promise<string> {
  return res.text();
}

describe('meter: Codex (ChatGPT plan)', () => {
  describe('consent', () => {
    it('is needed to spend plan usage, not to replay', async () => {
      env = await startCodex({ meter: { codexConsent: false, env: {} } });
      expect(() => env.meter.openRun({ runId: 'x', provider: 'codex' })).toThrow(CodexConsentError);
      expect(() => env.meter.openRun({ runId: 'x', provider: 'codex', cache: 'record' })).toThrow(
        CodexConsentError,
      );
      expect(() => env.meter.openRun({ runId: 'x', provider: 'codex', cache: 'auto' })).toThrow(
        CodexConsentError,
      );
      expect(env.meter.openRun({ runId: 'x', provider: 'codex', cache: 'replay' }).provider).toBe(
        'codex',
      );
    });

    it('accepts the environment variable', async () => {
      env = await startCodex({
        meter: { codexConsent: undefined, env: { SA_EVAL_CODEX_CONSENT: '1' } },
      });
      expect(env.meter.openRun({ runId: 'x', provider: 'codex' }).provider).toBe('codex');
    });
  });

  it('gives hosts a base URL with the backend path, and also serves a bare one', async () => {
    env = await startCodex();
    const run = env.openRun();
    expect(run.agentBaseUrl('procedure-1')).toBe(
      `${env.meter.url}/r/${run.token}/a/procedure-1/backend-api`,
    );
    const bare = `${env.meter.url}/r/${run.token}/a/procedure-1/codex/responses`;
    const res = await fetch(bare, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN}`,
        'chatgpt-account-id': ACCOUNT,
      },
      body: JSON.stringify(responsesBody('x')),
    });
    expect(res.status).toBe(200);
    await drain(res);
    expect(env.llm.requests().at(-1)?.path).toBe('/backend-api/codex/responses');
  });

  it('forwards zstd bodies untouched and meters by request, with the API-equivalent cost only informational', async () => {
    env = await startCodex({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: 'Hola desde Codex',
            usage: {
              promptTokens: 2000,
              completionTokens: 100,
              cachedTokens: 1500,
              reasoningTokens: 20,
            },
            headers: {
              'x-codex-primary-used-percent': '42',
              'x-ratelimit-remaining-requests': '99',
              'x-unrelated': 'no',
            },
          },
        },
      },
    });
    const run = env.openRun();
    const res = await codexPost(run, 'procedure-1', responsesBody('Sácame la vida laboral'), {
      zstd: true,
    });
    expect(res.status).toBe(200);
    const text = await drain(res);
    expect(text).toContain('response.completed');
    expect(res.headers.get('x-codex-primary-used-percent')).toBe('42');

    const seen = env.llm.requests().at(-1)!;
    expect(seen.path).toBe('/backend-api/codex/responses');
    expect(seen.headers['content-encoding']).toBe('zstd');
    expect(seen.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen.headers['chatgpt-account-id']).toBe(ACCOUNT);
    expect(seen.headers.originator).toBe('pi');
    expect((seen.body as { instructions: string }).instructions).toContain('Today is');

    expect(run.usage()).toEqual({
      requests: 1,
      inputTokens: 500,
      cachedInputTokens: 1500,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      costUsd: 0, // a plan has no price per call
      cacheHits: 0,
      looseHits: 0,
    });
    // gpt-6.1-sol: 500 * 2 + 1500 * 0.1 + 100 * 10 per million.
    expect(run.summary().apiEquivalentUsd).toBeCloseTo((500 * 2 + 1500 * 0.1 + 100 * 10) / 1e6, 12);
    expect(env.ledgerLines().at(-1)).toMatchObject({
      provider: 'codex',
      kind: 'forward',
      status: 200,
      stream: true,
      model: 'gpt-6.1-sol',
      usage: { prompt: 2000, cacheRead: 1500, completion: 100, reasoning: 20 },
      cost: { usd: 0 },
      limitHeaders: {
        'x-codex-primary-used-percent': '42',
        'x-ratelimit-remaining-requests': '99',
      },
    });
    expect(env.ledgerLines().at(-1)?.limitHeaders).not.toHaveProperty('x-unrelated');
    expect(env.meter.ledger.summary().codex.total).toBe(1);
    // Codex spend is never dollars of the voucher key.
    expect(env.meter.ledger.summary().sinceEpochUsd).toBe(0);
  });

  it('hashes the decompressed body: a recording made with zstd replays for a plain request, and back', async () => {
    env = await startCodex();
    await drain(
      await codexPost(
        env.openRun({ cache: 'record' }),
        'p',
        responsesBody('hola', { prompt_cache_key: 'a' }),
        { zstd: true },
      ),
    );
    const plain = await codexPost(
      env.openRun({ cache: 'replay' }),
      'p',
      responsesBody('hola', { prompt_cache_key: 'b' }),
      {
        headers: { authorization: 'Bearer anything', 'chatgpt-account-id': 'acct-replay' },
      },
    );
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-sa-eval-cache')).toBe('hit');
    expect(await drain(plain)).toContain('Hola desde Codex');
    const requestsBefore = env.llm.requests().length;
    // The other way round: recorded plain, replayed compressed, another day in the instructions.
    await drain(await codexPost(env.openRun({ cache: 'record' }), 'p', responsesBody('adiós'), {}));
    const zstd = await codexPost(
      env.openRun({ cache: 'replay' }),
      'p',
      responsesBody('adiós', {
        instructions: 'You are a procedure agent.\nToday is Monday 2027-01-04 (Europe/Madrid).',
      }),
      { zstd: true },
    );
    expect(zstd.status).toBe(200);
    await drain(zstd);
    expect(env.llm.requests().length).toBe(requestsBefore + 1);
  });

  it('a replay needs no consent, credentials or upstream', async () => {
    env = await startCodex();
    await drain(await codexPost(env.openRun({ cache: 'record' }), 'p', responsesBody('hola')));
    const replayMeter = await createMeter({
      home: env.t.home,
      upstreams: { codex: 'http://127.0.0.1:9/backend-api' },
      codexConsent: false,
      env: {},
    });
    try {
      const run = replayMeter.openRun({ runId: 'replay', provider: 'codex', cache: 'replay' });
      const res = await fetch(`${run.agentBaseUrl('p')}/codex/responses`, {
        method: 'POST',
        body: JSON.stringify(responsesBody('hola')),
      });
      expect(res.status).toBe(200);
      expect(await drain(res)).toContain('Hola desde Codex');
      expect(run.usage()).toMatchObject({ cacheHits: 1, costUsd: 0, cachedInputTokens: 1500 });
      expect(run.summary().apiEquivalentUsd).toBeGreaterThan(0);
    } finally {
      await replayMeter.close();
    }
  });

  describe('caps by request count (the plan has no dollars)', () => {
    it('stops a run at its request cap with the non-retryable "quota exceeded (out of budget)" wording', async () => {
      env = await startCodex();
      const run = env.openRun({ limits: { perRunRequests: 3 } });
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await codexPost(run, 'p', responsesBody(`step ${i}`));
        statuses.push(res.status);
        if (res.status === 402) {
          const body = (await res.json()) as { error: { message: string; eval_reason: string } };
          expect(body.error.message).toBe(
            'Eval cap reached: quota exceeded (out of budget): this run used 3 of 3 allowed Codex requests',
          );
          expect(body.error.eval_reason).toBe('requests_cap');
          expect(res.headers.get('x-should-retry')).toBe('false');
        } else await drain(res);
      }
      expect(statuses).toEqual([200, 200, 200, 402]);
      expect(env.llm.requests()).toHaveLength(3);
    });

    it('never blocks a Codex run on dollars or on the requests of other runs', async () => {
      env = await startCodex();
      // Codex requests of other runs and processes, however many, do not count against this one.
      const ledger = new Ledger(env.t.paths.ledgerDir);
      for (let i = 0; i < 500; i++) {
        ledger.append({
          runId: 'other-process',
          agent: 'p',
          provider: 'codex',
          kind: 'forward',
          path: '/backend-api/codex/responses',
          status: 200,
        });
      }
      // Dollar limits that would stop any voucher run mean nothing for a plan.
      const run = env.openRun({ limits: { perRunUsd: 0, dailyUsd: 0, reserveUsd: 1000 } });
      for (let i = 0; i < 3; i++) {
        const res = await codexPost(run, 'p', responsesBody(`request ${i}`));
        expect(res.status).toBe(200);
        await drain(res);
      }
      expect(new Ledger(env.t.paths.ledgerDir).summary().codex).toEqual({ total: 503 });
    });
  });

  describe('usage limits and the cooldown', () => {
    const T0 = Date.parse('2026-10-17T10:00:00.000Z');
    const resetsAt = Math.floor(T0 / 1000) + 3 * 3600;
    const limited = {
      scenario: {
        rules: [],
        fallback: {
          error: {
            status: 429,
            message: 'The usage limit has been reached',
            type: 'usage_limit_reached',
            fields: { plan_type: 'plus', resets_at: resetsAt },
          },
        },
      },
    };

    it('remembers a usage limit for every process and answers the same 429 locally until it resets', async () => {
      let nowMs = T0;
      env = await startCodex({
        mock: limited,
        meter: { codexConsent: true, now: () => new Date(nowMs) },
      });
      const run = env.openRun();
      const events: MeterEvent[] = [];
      run.on((e) => events.push(e));
      const first = await codexPost(run, 'p', responsesBody('x'));
      expect(first.status).toBe(429);
      expect(((await first.json()) as { error: { type: string } }).error.type).toBe(
        'usage_limit_reached',
      );
      expect(env.llm.requests()).toHaveLength(1);
      const cooldown = JSON.parse(readFileSync(env.t.paths.codexCooldown, 'utf8')) as {
        untilMs: number;
        planType: string;
      };
      expect(cooldown).toMatchObject({ untilMs: resetsAt * 1000, planType: 'plus' });
      expect(events.find((e) => e.type === 'gateway_limit')).toMatchObject({
        kind: 'usage_limit',
        status: 429,
        resetsAt: new Date(resetsAt * 1000).toISOString(),
      });
      expect(env.ledgerLines().at(-1)).toMatchObject({ gatewayLimit: true, status: 429 });

      // The next request, from this or another run, is answered without calling OpenAI.
      const second = await codexPost(env.openRun(), 'p', responsesBody('y'));
      expect(second.status).toBe(429);
      expect(second.headers.get('x-sa-eval')).toBe('codex-cooldown');
      expect(await second.json()).toEqual({
        error: {
          type: 'usage_limit_reached',
          message: 'The usage limit has been reached',
          plan_type: 'plus',
          resets_at: resetsAt,
        },
      });
      expect(env.llm.requests()).toHaveLength(1);
      // ... and by another meter process sharing the home.
      const other = await createMeter({
        home: env.t.home,
        upstreams: { codex: `${env.llm.url}/backend-api` },
        codexConsent: true,
        now: () => new Date(nowMs),
      });
      try {
        const third = await codexPost(
          other.openRun({ runId: 'other', provider: 'codex' }),
          'p',
          responsesBody('z'),
        );
        expect(third.status).toBe(429);
      } finally {
        await other.close();
      }
      expect(env.llm.requests()).toHaveLength(1);
      expect(events.filter((e) => e.type === 'cap')).toEqual([]); // `cap` is for the second run
      // Once the window has reset, requests go out again.
      nowMs = (resetsAt + 1) * 1000;
      env.llm.setScenario({ rules: [], fallback: { text: 'back' } });
      const after = await codexPost(run, 'p', responsesBody('later'));
      expect(after.status).toBe(200);
      await drain(after);
    });

    it('emits a cap event for a request refused by the cooldown', async () => {
      env = await startCodex({
        mock: limited,
        meter: { codexConsent: true, now: () => new Date(T0) },
      });
      const run = env.openRun();
      await drain(await codexPost(run, 'p', responsesBody('x')));
      const events: MeterEvent[] = [];
      run.on((e) => events.push(e));
      await drain(await codexPost(run, 'p', responsesBody('y')));
      expect(events).toEqual([
        expect.objectContaining({
          type: 'cap',
          reason: 'codex_cooldown',
          message: expect.stringContaining('usage limit active until'),
        }),
      ]);
    });

    // A broken cooldown file counts as a limit (fail closed): meter-cooldown-broken.test.ts.
    it('uses a default pause when the limit carries no reset time', async () => {
      env = await startCodex({
        mock: {
          scenario: {
            rules: [],
            fallback: { error: { status: 429, message: 'x', type: 'usage_limit_reached' } },
          },
        },
        meter: { codexConsent: true, now: () => new Date(T0) },
      });
      await drain(await codexPost(env.openRun(), 'p', responsesBody('x')));
      const cooldown = JSON.parse(readFileSync(env.t.paths.codexCooldown, 'utf8')) as {
        untilMs: number;
      };
      expect(cooldown.untilMs).toBe(T0 + 30 * 60_000);
    });

    it('notices a usage limit that arrives inside a 200 stream and does not cache it', async () => {
      const t = makeHome();
      const upstream: Server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'r' } })}\n\n`,
        );
        res.end(
          `event: response.failed\ndata: ${JSON.stringify({
            type: 'response.failed',
            response: {
              error: {
                code: 'usage_limit_reached',
                message: 'limit',
                plan_type: 'pro',
                resets_at: resetsAt,
              },
            },
          })}\n\n`,
        );
      });
      await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
      const meter = await createMeter({
        home: t.home,
        upstreams: {
          codex: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/backend-api`,
        },
        codexConsent: true,
        now: () => new Date(T0),
      });
      try {
        const run = meter.openRun({ runId: 'mid', provider: 'codex', cache: 'record' });
        const events: MeterEvent[] = [];
        run.on((e) => events.push(e));
        await drain(await codexPost(run, 'p', responsesBody('x')));
        expect(existsSync(t.paths.codexCooldown)).toBe(true);
        expect(events.find((e) => e.type === 'gateway_limit')).toMatchObject({
          kind: 'usage_limit',
          status: 200,
        });
        expect(existsSync(t.paths.cacheDir)).toBe(false);
      } finally {
        await meter.close();
        upstream.closeAllConnections();
        upstream.close();
        t.cleanup();
      }
    });
  });
});
