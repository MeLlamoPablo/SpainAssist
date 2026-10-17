import './helpers/no-network';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../../src/llm/ledger';
import { createMeter, type MeterEvent, type MeterRun } from '../../src/llm/meter';
import { chatBody, type MeterEnv, post, startEnv, userMessage } from './helpers/meter-env';

let env: MeterEnv;
afterEach(() => env.close());

/** A reply that costs `usd` per call at the gateway. */
const costing = (usd: number, extra: Record<string, unknown> = {}) => ({
  scenario: {
    rules: [],
    fallback: {
      text: 'ok',
      usage: { costUsd: usd, promptTokens: 100, completionTokens: 10 },
      ...extra,
    },
  },
  litellm: {},
});

interface Refusal {
  status: number;
  type: string;
  message: string;
  reason: string;
  headers: Headers;
}

async function refusal(res: Response): Promise<Refusal> {
  const body = (await res.json()) as {
    error: { type: string; message: string; eval_reason: string };
  };
  return {
    status: res.status,
    type: body.error.type,
    message: body.error.message,
    reason: body.error.eval_reason,
    headers: res.headers,
  };
}

const call = (
  run: MeterRun,
  agent = 'procedure-1',
  text = 'x',
  extra: Record<string, unknown> = {},
) => post(run, agent, chatBody([userMessage(text)], extra));

describe('meter budget', () => {
  it('refuses with a non-retryable 402 "out of budget" before anything reaches the upstream', async () => {
    env = await startEnv({ mock: costing(0.01) });
    const run = env.openRun({ limits: { perRunUsd: 0.003 } }); // below one request's reservation
    const events: MeterEvent[] = [];
    run.on((e) => events.push(e));
    const res = await call(run);
    const r = await refusal(res);
    expect(r).toMatchObject({ status: 402, type: 'budget_exceeded', reason: 'run_budget' });
    expect(r.message).toMatch(
      /^Eval budget exceeded: out of budget \(this run spent \$0\.0000 of \$0\.0030\)$/,
    );
    expect(r.headers.get('x-should-retry')).toBe('false');
    expect(r.headers.get('x-sa-eval')).toBe('budget');
    expect(env.llm.requests()).toHaveLength(0);
    expect(events).toEqual([
      {
        type: 'cap',
        runId: run.runId,
        agent: 'procedure-1',
        reason: 'run_budget',
        message: 'this run spent $0.0000 of $0.0030',
      },
    ]);
    expect(env.ledgerLines()).toEqual([
      expect.objectContaining({
        kind: 'reject',
        reason: 'run_budget',
        status: 402,
        agent: 'procedure-1',
      }),
    ]);
    expect(run.summary().rejects).toEqual({ run_budget: 1 });
    expect(run.usage().requests).toBe(0);
  });

  it('stops a run at its USD cap (the next request would cross it), per run not per meter', async () => {
    env = await startEnv({ mock: costing(0.2) });
    const run = env.openRun({ limits: { perRunUsd: 0.5, perAgentUsd: 10 } });
    const other = env.openRun({ limits: { perRunUsd: 0.5, perAgentUsd: 10 } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await call(run, 'procedure-1', `step ${i}`);
      statuses.push(res.status);
      await res.text();
    }
    // 0.2, 0.4 and 0.6 are spent after three calls (the third was admitted at 0.4 + a reservation).
    expect(statuses).toEqual([200, 200, 200, 402, 402]);
    expect(run.usage().costUsd).toBeCloseTo(0.6, 12);
    expect((await call(other)).status).toBe(200);
    expect(env.llm.requests()).toHaveLength(4);
  });

  it('caps each agent, with a tight cap for the answerer by default', async () => {
    env = await startEnv({ mock: costing(0.03) });
    const run = env.openRun();
    const results: Record<string, number[]> = { answerer: [], 'procedure-1': [] };
    for (let i = 0; i < 3; i++) {
      for (const agent of ['answerer', 'procedure-1']) {
        const res = await call(run, agent, `${agent} ${i}`);
        results[agent]!.push(res.status);
        await res.text();
      }
    }
    // The answerer's cap is $0.05: admitted at 0, 0.03; refused once 0.06 is spent. A procedure agent has $0.35.
    expect(results.answerer).toEqual([200, 200, 402]);
    expect(results['procedure-1']).toEqual([200, 200, 200]);
    const agentRefusal = env.ledgerLines().find((l) => l.reason === 'agent_budget');
    expect(agentRefusal).toMatchObject({
      agent: 'answerer',
      error: 'agent answerer spent $0.0600 of $0.0500',
    });
  });

  it('takes per-agent caps from the options, by agent role', async () => {
    env = await startEnv({
      mock: costing(0.03),
      meter: { limits: { perAgentUsd: 0.04, perAgentUsdByRole: { assistant: 0.2 } } },
    });
    const run = env.openRun();
    const procedure: number[] = [];
    const assistant: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await call(run, 'procedure-1', `p${i}`);
      procedure.push(a.status);
      await a.text();
      const b = await call(run, 'assistant', `a${i}`);
      assistant.push(b.status);
      await b.text();
    }
    expect(procedure).toEqual([200, 200, 402]);
    expect(assistant).toEqual([200, 200, 200]);
  });

  it('caps requests per run and per agent (loop guards)', async () => {
    env = await startEnv();
    const run = env.openRun({ limits: { perRunRequests: 3, perAgentRequests: 2 } });
    const statuses: [string, number][] = [];
    for (const agent of ['a', 'a', 'a', 'b', 'c', 'd']) {
      const res = await call(run, agent, `${agent}${statuses.length}`);
      statuses.push([agent, res.status]);
      await res.text();
    }
    // a: 2 allowed; b: ok (3rd request of the run); c and d: run cap.
    expect(statuses).toEqual([
      ['a', 200],
      ['a', 200],
      ['a', 402],
      ['b', 200],
      ['c', 402],
      ['d', 402],
    ]);
    const reasons = env
      .ledgerLines()
      .filter((l) => l.kind === 'reject')
      .map((l) => l.reason);
    expect(reasons).toEqual(['agent_requests_cap', 'requests_cap', 'requests_cap']);
  });

  it('refuses a request estimated above the input-token limit', async () => {
    env = await startEnv();
    const run = env.openRun({ limits: { maxInputTokensPerRequest: 1000 } });
    const res = await call(run, 'procedure-1', 'x'.repeat(10_000));
    const r = await refusal(res);
    expect(r).toMatchObject({ status: 402, reason: 'input_too_large' });
    expect(r.message).toContain('out of budget');
    expect(env.llm.requests()).toHaveLength(0);
    expect((await call(run, 'procedure-1', 'short')).status).toBe(200);
  });

  it('never lets parallel requests overshoot: reservations count while requests are in flight', async () => {
    env = await startEnv({
      mock: {
        scenario: {
          rules: [],
          fallback: {
            text: 'ok',
            delayMs: 200,
            usage: { costUsd: 0.0001, promptTokens: 100, completionTokens: 10 },
          },
        },
        litellm: {},
      },
    });
    // One request reserves about $0.0041: the cap fits two of them at once, not three.
    const run = env.openRun({ limits: { perRunUsd: 0.009, perAgentUsd: 1 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => call(run, `procedure-${i}`, `parallel ${i}`)),
    );
    const statuses = results.map((r) => r.status).sort();
    await Promise.all(results.map((r) => r.text()));
    expect(statuses).toEqual([200, 200, 402, 402, 402, 402]);
    expect(env.llm.requests()).toHaveLength(2);
    expect(run.summary().inflight).toBe(0);
    // The reservations are released: the run can go on afterwards.
    expect((await call(run, 'procedure-9', 'after')).status).toBe(200);
  });

  it("shares in-flight reservations across runs for the key's balance", async () => {
    env = await startEnv({
      mock: { scenario: { rules: [], fallback: { text: 'ok', delayMs: 150 } }, litellm: {} },
      meter: { keyRemainingUsd: 0.0051 },
    });
    const a = env.openRun();
    const b = env.openRun();
    // 0.0051 - 0.0041 leaves 0.001 for the first; the second reservation would go below zero.
    const [ra, rb] = await Promise.all([call(a), call(b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 402]);
    await Promise.all([ra.text(), rb.text()]);
  });

  describe("the key's balance", () => {
    it('refuses a request the key could not pay', async () => {
      env = await startEnv({
        mock: costing(0.01),
        meter: { keyRemainingUsd: 0.011 },
      });
      const run = env.openRun();
      const first = await call(run);
      expect(first.status).toBe(200);
      await first.text();
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.001, 12);
      const second = await refusal(await call(run, 'procedure-1', 'again'));
      expect(second).toMatchObject({ status: 402, reason: 'key_balance' });
      expect(second.message).toContain('out of budget');
      expect(second.message).toContain('$0.0010 left');
      expect(env.llm.requests()).toHaveLength(1);
    });

    it('learns the balance from the gateway headers, which only ever lower it', async () => {
      env = await startEnv({
        mock: { ...costing(0.001), litellm: { maxBudgetUsd: 1, spendUsd: 0.998 } },
      });
      const run = env.openRun();
      expect(env.meter.keyRemainingUsd()).toBeUndefined();
      await (await call(run)).text();
      // The key had 1 - 0.998 = 0.002 before this call and the call cost 0.001 more: too little
      // for the worst case of another request, so no further real call.
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.001, 12);
      const r = await refusal(await call(run, 'procedure-1', 'again'));
      expect(r.reason).toBe('key_balance');
      env.llm.litellm?.set({ spendUsd: 0.5 });
      expect(await refusal(await call(run, 'procedure-1', 'again 2'))).toMatchObject({
        reason: 'key_balance',
      });
      // The estimate only ever goes down: a header that claims more is left (the gateway's spend is
      // one call behind) is not believed, and no real call was sent.
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.001, 12);
      expect(env.llm.requests()).toHaveLength(1);
    });

    it('adopts a lower balance than its own accounting (another machine spending)', async () => {
      env = await startEnv({
        mock: { ...costing(0.001), litellm: { maxBudgetUsd: 1, spendUsd: 0.5 } },
      });
      const run = env.openRun();
      await (await call(run)).text();
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.499, 12);
      env.llm.litellm?.set({ spendUsd: 0.95 });
      await (await call(run, 'procedure-1', 'again')).text();
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.049, 12);
      await (await call(run, 'procedure-1', 'again 2')).text();
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(0.048, 12);
    });

    it('counts what the meter spent since the balance was set', async () => {
      env = await startEnv({ mock: costing(0.05), meter: { keyRemainingUsd: 2 } });
      const run = env.openRun();
      await (await call(run)).text();
      await (await call(run, 'procedure-1', 'two')).text();
      expect(env.meter.keyRemainingUsd()).toBeCloseTo(1.9, 12);
    });
  });

  describe('reservations in the ledger', () => {
    const slow = {
      scenario: {
        rules: [],
        fallback: {
          text: 'ok',
          delayMs: 250,
          usage: { costUsd: 0.0001, promptTokens: 100, completionTokens: 10 },
        },
      },
      litellm: {},
    };

    it('puts a request on the books while it is in flight and settles it with the same rid', async () => {
      env = await startEnv({ mock: slow });
      const run = env.openRun();
      const pending = call(run);
      const other = new Ledger(env.t.paths.ledgerDir);
      let seen = 0;
      for (let i = 0; i < 100 && seen === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        other.refresh();
        seen = other.summary().pending.requests;
      }
      // Another process sees the request, with its worst case, before it ends.
      expect(seen).toBe(1);
      expect(other.pendingUsd()).toBeGreaterThan(0.004);
      await (await pending).text();
      other.refresh();
      expect(other.summary().pending).toEqual({ requests: 0, usd: 0 });
      const raw = env.rawLedgerLines();
      const reserve = raw.find((line) => line.type === 'reserve');
      const settled = env.ledgerLines().find((line) => line.kind === 'forward');
      expect(reserve).toMatchObject({
        type: 'reserve',
        run: run.runId,
        agent: 'procedure-1',
        provider: 'voucher',
        path: '/v1/chat/completions',
      });
      expect(settled?.rid).toBe(reserve?.rid);
      // The lines of a run are one per request: the reservation is not one.
      expect(env.ledgerLines().map((line) => line.kind)).toEqual(['forward']);
    });

    it('does not let several processes spend the same headroom: the daily cap holds across meters', async () => {
      env = await startEnv({ mock: slow, meter: { limits: { dailyUsd: 0.009 } } });
      // Two more "processes" on the same home and the same upstream. One request reserves about
      // $0.0041: the day has room for two of them, not three.
      const others = await Promise.all(
        [1, 2].map(() =>
          createMeter({
            home: env.t.home,
            upstreams: { voucher: `${env.llm.url}/v1` },
            limits: { dailyUsd: 0.009 },
          }),
        ),
      );
      try {
        const runs = [
          env.openRun(),
          ...others.map((meter, i) =>
            meter.openRun({ runId: `other-${i}`, provider: 'voucher', cache: 'off' }),
          ),
        ];
        const results = await Promise.all(
          runs.flatMap((run, i) =>
            [0, 1].map((n) => call(run, `procedure-${n}`, `parallel ${i}-${n}`)),
          ),
        );
        const statuses = results.map((res) => res.status).sort();
        await Promise.all(results.map((res) => res.text()));
        expect(statuses.filter((status) => status === 200)).toHaveLength(2);
        expect(statuses.filter((status) => status === 402)).toHaveLength(4);
        expect(env.llm.requests()).toHaveLength(2);
      } finally {
        await Promise.all(others.map((meter) => meter.close()));
      }
    });

    it('does not let several processes take the key below zero', async () => {
      env = await startEnv({
        mock: slow,
        meter: { keyRemainingUsd: 0.0051 },
      });
      const other = await createMeter({
        home: env.t.home,
        upstreams: { voucher: `${env.llm.url}/v1` },
        keyRemainingUsd: 0.0051,
      });
      try {
        const [a, b] = await Promise.all([
          call(env.openRun()),
          call(other.openRun({ runId: 'other', provider: 'voucher' })),
        ]);
        expect([a.status, b.status].sort()).toEqual([200, 402]);
        await Promise.all([a.text(), b.text()]);
      } finally {
        await other.close();
      }
    });

    it('refuses and releases when another process reserved the headroom just before this one did', async () => {
      env = await startEnv({ meter: { limits: { dailyUsd: 0.005 } } });
      const competitor = new Ledger(env.t.paths.ledgerDir);
      // Between this meter's check and its reservation another process reserves the same room:
      // simulated by writing the competitor's line right before the meter's own.
      const reserve = env.meter.ledger.reserve.bind(env.meter.ledger);
      env.meter.ledger.reserve = (input) => {
        competitor.reserve({ ...input, rid: 'competitor', run: 'other-process' });
        reserve(input);
      };
      const r = await refusal(await call(env.openRun()));
      expect(r.reason).toBe('daily');
      expect(env.llm.requests()).toHaveLength(0);
      // The meter's own reservation was released; the competitor's stays on the books.
      competitor.refresh();
      expect(competitor.summary().pending.requests).toBe(1);
      expect(env.rawLedgerLines().map((line) => [line.type, line.rid ?? null])).toEqual([
        ['reserve', 'competitor'],
        ['reserve', expect.any(String)],
        ['release', expect.any(String)],
        ['request', null],
      ]);
    });

    it('leaves nothing pending when the request cannot be sent', async () => {
      env = await startEnv();
      const down = await createMeter({
        home: env.t.home,
        upstreams: { voucher: 'http://127.0.0.1:1/v1' },
      });
      try {
        const res = await call(down.openRun({ runId: 'down', provider: 'voucher' }));
        expect(res.status).toBe(502);
        await res.text();
        const ledger = new Ledger(env.t.paths.ledgerDir);
        expect(ledger.summary().pending).toEqual({ requests: 0, usd: 0 });
        expect(ledger.summary().requests.forward).toBe(1);
      } finally {
        await down.close();
      }
    });

    it('counts what a dead process left in flight against the day, but not against the key balance', async () => {
      env = await startEnv({ meter: { limits: { dailyUsd: 0.005 } } });
      // A process that was killed with a request in flight: its reservation has no settle line.
      new Ledger(env.t.paths.ledgerDir).reserve({
        rid: 'dead',
        run: 'killed',
        agent: 'procedure-1',
        provider: 'voucher',
        path: '/v1/chat/completions',
        usd: 0.004,
      });
      const r = await refusal(await call(env.openRun()));
      expect(r.reason).toBe('daily');
      expect(r.message).toContain('spent $0.0040 of $0.0050 today');
    });
  });

  describe('the ledger across runs and processes', () => {
    const seed = (usd: number, at = new Date()) =>
      new Ledger(env.t.paths.ledgerDir).append({
        runId: 'earlier-process',
        agent: 'procedure-1',
        provider: 'voucher',
        kind: 'forward',
        path: '/v1/chat/completions',
        status: 200,
        cost: { usd, source: 'header' },
        ts: at.toISOString(),
      });

    it('stops at the daily ceiling, counting what other processes spent today', async () => {
      env = await startEnv();
      const run = env.openRun();
      seed(0.998);
      const r = await refusal(await call(run));
      expect(r).toMatchObject({ status: 402, reason: 'daily' });
      expect(r.message).toContain('out of budget');
      // Spend from another day does not count.
      env.t.cleanup();
    });

    it("ignores yesterday's spend and replayed or mock spend", async () => {
      env = await startEnv();
      const run = env.openRun();
      seed(50, new Date(Date.now() - 36 * 3_600_000));
      expect((await call(run)).status).toBe(200);
    });

    it('stops at a lifetime ceiling until the ledger epoch is reset', async () => {
      env = await startEnv({ meter: { limits: { lifetimeUsd: 1 } } });
      const run = env.openRun();
      seed(0.999, new Date(Date.now() - 40 * 24 * 3_600_000));
      const r = await refusal(await call(run));
      expect(r).toMatchObject({ status: 402, reason: 'lifetime' });
      env.meter.ledger.epoch('new voucher');
      expect((await call(run, 'procedure-1', 'again')).status).toBe(200);
    });

    it("does not count the mock provider's simulated cost against the real ceilings", async () => {
      env = await startEnv({
        provider: 'mock',
        mock: costing(0.4),
        meter: { limits: { dailyUsd: 0.5 } },
      });
      const run = env.openRun({ limits: { perRunUsd: 10, perAgentUsd: 10 } });
      for (let i = 0; i < 3; i++) {
        const res = await call(run, 'procedure-1', `x${i}`);
        expect(res.status).toBe(200);
        await res.text();
      }
      // The simulated cost counts for the run (so cost limits can be exercised), not for the day.
      expect(run.usage().costUsd).toBeCloseTo(1.2, 12);
      expect(env.meter.ledger.spentTodayUsd()).toBe(0);
    });
  });

  describe('kill switch', () => {
    it('answers "out of budget" to everything while the STOP file exists', async () => {
      env = await startEnv();
      const run = env.openRun();
      expect((await call(run)).status).toBe(200);
      writeFileSync(env.t.paths.stopFile, '');
      const res = await call(run, 'procedure-1', 'again');
      const r = await refusal(res);
      expect(r).toMatchObject({ status: 402, reason: 'stopped' });
      expect(r.message).toContain('out of budget');
      expect(r.message).toContain('kill switch');
      expect(res.headers.get('x-sa-eval')).toBe('stopped');
      const models = await fetch(`${run.agentBaseUrl('procedure-1')}/models`);
      expect(models.status).toBe(402);
      await models.text();
      expect(env.llm.requests()).toHaveLength(1);
    });

    it('resumes when the file is removed', async () => {
      env = await startEnv();
      const run = env.openRun();
      writeFileSync(env.t.paths.stopFile, '');
      expect((await call(run)).status).toBe(402);
      const { rmSync } = await import('node:fs');
      rmSync(env.t.paths.stopFile);
      expect((await call(run, 'procedure-1', 'again')).status).toBe(200);
    });
  });

  describe("the gateway's own budget", () => {
    it("passes LiteLLM's 422 through verbatim, flags it in the ledger and emits an event", async () => {
      env = await startEnv({
        mock: { ...costing(0.01), litellm: { maxBudgetUsd: 1 } },
      });
      const run = env.openRun();
      const events: MeterEvent[] = [];
      run.on((e) => events.push(e));
      await (await call(run, 'procedure-1', 'fine')).text();
      // Somebody else (another machine) spends the key meanwhile: the meter cannot know.
      env.llm.litellm?.set({ spendUsd: 5 });
      const res = await call(run, 'procedure-1', 'over');
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('budget_exceeded');
      expect(body.error.message).toMatch(
        /^Budget has been exceeded! Current cost: 5, Max budget: 1$/,
      );
      const line = env.ledgerLines().at(-1)!;
      expect(line).toMatchObject({ kind: 'forward', status: 422, gatewayLimit: true });
      expect(line).not.toHaveProperty('cost');
      const gateway = events.find((e) => e.type === 'gateway_limit');
      expect(gateway).toMatchObject({ kind: 'budget', status: 422, agent: 'procedure-1' });
      // A refused call costs nothing.
      expect(run.usage().costUsd).toBeCloseTo(0.01, 12);
    });
  });

  it('reserves generously for an unknown model, so a small cap stops it', async () => {
    env = await startEnv();
    const run = env.openRun({ limits: { perRunUsd: 0.05 } });
    // 8192 output tokens at the fallback price ($15/M) alone reserve $0.12.
    const unknown = await call(run, 'procedure-1', 'x', { model: 'vendor/unknown-9' });
    expect((await refusal(unknown)).reason).toBe('run_budget');
    expect((await call(run, 'procedure-1', 'x')).status).toBe(200);
  });

  it('words every refusal so pi and the app treat it as a non-retryable quota stop', async () => {
    env = await startEnv({ mock: costing(0.01) });
    writeFileSync(env.t.paths.stopFile, '');
    const stopped = await refusal(await call(env.openRun()));
    const { rmSync } = await import('node:fs');
    rmSync(env.t.paths.stopFile);
    const refusals: Refusal[] = [stopped];
    refusals.push(await refusal(await call(env.openRun({ limits: { perRunUsd: 0.001 } }))));
    refusals.push(await refusal(await call(env.openRun({ limits: { perRunRequests: 0 } }))));
    refusals.push(await refusal(await call(env.openRun({ limits: { perAgentRequests: 0 } }))));
    refusals.push(
      await refusal(await call(env.openRun({ limits: { maxInputTokensPerRequest: 1 } }))),
    );
    refusals.push(await refusal(await call(env.openRun({ limits: { perAgentUsd: 0.001 } }))));
    refusals.push(await refusal(await call(env.openRun({ limits: { dailyUsd: 0.001 } }))));
    refusals.push(await refusal(await call(env.openRun({ limits: { lifetimeUsd: 0.001 } }))));
    expect(new Set(refusals.map((r) => r.reason)).size).toBe(8);
    for (const r of refusals) {
      expect(r.status).toBe(402);
      expect(r.type).toBe('budget_exceeded');
      expect(r.message).toMatch(/out of budget/);
      expect(r.message).not.toMatch(/\b(429|5\d\d)\b|timeout|network|overloaded|rate limit/i);
      expect(r.headers.get('x-should-retry')).toBe('false');
    }
  });
});
