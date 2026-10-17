import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_LIMITS } from '../../src/fixtures';
import type { MeterRun } from '../../src/llm';
import { chatBody, type MeterEnv, post, startEnv, userMessage } from '../llm/helpers/meter-env';
import { createEnv, type Env, miniFixture, readEventsFile } from './support/harness';
import type { Script, ScriptContext } from './support/scripted-app';

/**
 * The loop against the real meter proxy (loopback only, a tools/mock-llm upstream, the network
 * guard of the llm tests): the usage events, the caps and the cache really drive the run.
 */

let env: Env;
let meter: MeterEnv | undefined;
afterEach(async () => {
  env?.dispose();
  await meter?.close();
  meter = undefined;
});

/** The script's last request is still being answered when the run ends: wait for it. */
async function eventually(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(condition()).toBe(true);
}

/** A reply that costs `usd` per call at the gateway. */
const costing = (usd: number) => ({
  scenario: {
    rules: [],
    fallback: { text: 'ok', usage: { costUsd: usd, promptTokens: 100, completionTokens: 10 } },
  },
  litellm: {},
});

/** Asks the model `calls` times as the assistant, until the run says stop. */
const ask =
  (calls: number, text = (ctx: ScriptContext) => `hola ${ctx.spec.runId}`): Script =>
  async (ctx) => {
    const run = ctx.meterRun as unknown as MeterRun;
    for (let i = 0; i < calls && !ctx.signal.aborted; i++) {
      const res = await post(run, 'assistant', chatBody([userMessage(`${text(ctx)} ${i}`)]));
      ctx.mark(`call-${i}:${res.status}`);
    }
    ctx.tool('procedure', 'do_it');
  };

describe('with the real meter', () => {
  it("stops at the fixture's cost limit when usage events show it was crossed, and no request goes out after", async () => {
    // One agent may spend more than the fixture's limit here: only the limit of the run counts.
    meter = await startEnv({ mock: costing(0.2), meter: { limits: { perAgentUsd: 10 } } });
    env = createEnv();
    const outcome = await env.run(
      miniFixture({
        limits: {
          wallClockMs: 10_000,
          maxToolCalls: 50,
          maxRequests: 100,
          maxCostUsd: 0.5,
          maxPrompts: 10,
        },
      }),
      ask(10),
      { meter: meter.meter, provider: 'voucher' },
    );
    expect(outcome.result).toMatchObject({ endedBy: 'limit:cost', status: 'failed_required' });
    expect(outcome.result.usage.requests).toBe(3);
    expect(outcome.result.usage.costUsd).toBeCloseTo(0.6, 9);
    expect(meter.llm.requests()).toHaveLength(3);
    await eventually(() => env.apps[0]!.reached.length === 3);
    expect(env.apps[0]!.reached).toEqual(['call-0:200', 'call-1:200', 'call-2:200']);
    // The run's lines of the ledger are copied into the run folder.
    const ledger = readEventsLedger(outcome.runDir);
    expect(ledger.filter((l) => l.kind === 'forward')).toHaveLength(3);
    expect(ledger.every((l) => l.runId === outcome.runId)).toBe(true);
  });

  it("the meter's own cap at the fixture limit is the same limit: the agent spent too much", async () => {
    meter = await startEnv({ mock: costing(0.2) });
    env = createEnv();
    const outcome = await env.run(
      miniFixture({
        limits: {
          wallClockMs: 10_000,
          maxToolCalls: 50,
          maxRequests: 100,
          maxCostUsd: 0.003,
          maxPrompts: 10,
        },
      }),
      ask(3),
      { meter: meter.meter, provider: 'voucher' },
    );
    expect(outcome.result).toMatchObject({ endedBy: 'limit:cost', status: 'failed_required' });
    expect(outcome.result.notes[0]).toMatch(/meter cap run_budget/);
    expect(meter.llm.requests()).toHaveLength(0);
    await eventually(() => env.apps[0]!.reached.length === 1);
    expect(env.apps[0]!.reached).toEqual(['call-0:402']);
  });

  describe('a looping agent is scored, not aborted as the harness running out of money', () => {
    /** The meter's own default caps for a run and an agent, and the fixtures' real limits. */
    const shipped = (overrides: Partial<typeof RUN_LIMITS> = {}) =>
      miniFixture({ limits: { ...RUN_LIMITS, wallClockMs: 30_000, ...overrides } });

    it("under the meter's default caps the fixtures' own request limit fires first", async () => {
      meter = await startEnv({ mock: costing(0.0005) });
      env = createEnv();
      const outcome = await env.run(shipped(), ask(400), {
        meter: meter.meter,
        provider: 'voucher',
      });
      expect(outcome.result).toMatchObject({
        status: 'failed_required',
        score: 0,
        endedBy: 'limit:requests',
      });
      expect(outcome.result.notes[0]).toMatch(/151 model requests, at most 150/);
      // Far below the meter's own 200 per agent and 250 per run.
      expect(outcome.result.usage.requests).toBeLessThan(160);
    }, 60_000);

    it("the meter's per-agent request cap, when it is the one reached, is the same limit", async () => {
      meter = await startEnv({ mock: costing(0.0005), meter: { limits: { perAgentRequests: 4 } } });
      env = createEnv();
      const outcome = await env.run(shipped(), ask(20), {
        meter: meter.meter,
        provider: 'voucher',
      });
      expect(outcome.result).toMatchObject({
        status: 'failed_required',
        score: 0,
        endedBy: 'limit:requests',
      });
      expect(outcome.result.notes[0]).toMatch(/meter cap agent_requests_cap \(assistant\)/);
      expect(outcome.result.usage.requests).toBe(4);
    });

    it("the meter's per-agent dollar cap too", async () => {
      meter = await startEnv({ mock: costing(0.1), meter: { limits: { perAgentUsd: 0.25 } } });
      env = createEnv();
      const outcome = await env.run(shipped({ maxCostUsd: 5 }), ask(20), {
        meter: meter.meter,
        provider: 'voucher',
      });
      expect(outcome.result).toMatchObject({
        status: 'failed_required',
        score: 0,
        endedBy: 'limit:cost',
      });
      expect(outcome.result.notes[0]).toMatch(/meter cap agent_budget \(assistant\)/);
    });

    it('an agent that did the job and then looped keeps its score, marked as not tested to the end', async () => {
      meter = await startEnv({ mock: costing(0.0005), meter: { limits: { perAgentRequests: 4 } } });
      env = createEnv();
      const outcome = await env.run(
        shipped(),
        async (ctx) => {
          ctx.tool('procedure', 'do_it');
          ctx.say('assistant', 'Gracias');
          await ask(20)(ctx);
        },
        { meter: meter.meter, provider: 'voucher' },
      );
      expect(outcome.result).toMatchObject({
        status: 'completed',
        score: 1,
        endedBy: 'limit:requests',
        unsettledNegated: ['no-bad'],
      });
    });
  });

  it('the kill switch ends the run as a budget stop, not as an agent failure', async () => {
    meter = await startEnv({ mock: costing(0.01) });
    writeFileSync(meter.t.paths.stopFile, '');
    env = createEnv();
    const outcome = await env.run(miniFixture(), ask(3), {
      meter: meter.meter,
      provider: 'voucher',
    });
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      endedBy: 'limit:budget',
    });
    expect(outcome.result.notes[0]).toMatch(/meter cap stopped/);
    expect(meter.llm.requests()).toHaveLength(0);
  });

  it('a replay miss ends the run as such, naming what diverged', async () => {
    meter = await startEnv({ mock: costing(0.01) });
    env = createEnv();
    const outcome = await env.run(miniFixture(), ask(3), {
      meter: meter.meter,
      provider: 'voucher',
      cache: 'replay',
    });
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      endedBy: 'replay-miss',
    });
    expect(outcome.result.notes[0]).toMatch(/replay-miss \(assistant\): Replay cache miss/);
    expect(meter.llm.requests()).toHaveLength(0);
  });

  it('replays a recorded run for free: the run folder, the run id and the ports do not change the cache key', async () => {
    meter = await startEnv({ mock: costing(0.05) });
    env = createEnv();
    const conversation: Script = async (ctx) => {
      const run = ctx.meterRun as unknown as MeterRun;
      const text = [
        `cwd: ${ctx.spec.runDir}/work`,
        `world: ${ctx.spec.runId}`,
        `meter: ${new URL(run.agentBaseUrl('assistant')).host}`,
        `mock: ${ctx.spec.bench.publicOrigin.replace('http://', '')}`,
      ].join('\n');
      const res = await post(run, 'assistant', chatBody([userMessage(text)]));
      ctx.mark(`status:${res.status}`);
      ctx.tool('procedure', 'do_it');
    };
    const recorded = await env.run(miniFixture(), conversation, {
      meter: meter.meter,
      provider: 'voucher',
      cache: 'record',
    });
    expect(recorded.result.usage).toMatchObject({ requests: 1, cacheHits: 0 });
    expect(meter.llm.requests()).toHaveLength(1);

    const replayed = await env.run(miniFixture(), conversation, {
      meter: meter.meter,
      provider: 'voucher',
      cache: 'replay',
    });
    expect(replayed.runId).not.toBe(recorded.runId);
    expect(replayed.result).toMatchObject({ status: 'completed', endedBy: 'quiescent' });
    expect(replayed.result.usage).toMatchObject({ requests: 1, cacheHits: 1, costUsd: 0 });
    expect(env.apps[1]!.reached).toEqual(['status:200']);
    // Nothing went upstream the second time.
    expect(meter.llm.requests()).toHaveLength(1);
  });

  it('counts what was spent before a checkpoint against the limits of the run that continues it', async () => {
    meter = await startEnv({ mock: costing(0.01) });
    env = createEnv();
    const first = await env.run(
      miniFixture(),
      ask(1, () => 'first'),
      {
        meter: meter.meter,
        provider: 'voucher',
      },
    );
    expect(first.result.usage).toMatchObject({ requests: 1 });
    expect(first.result.usage.costUsd).toBeCloseTo(0.01, 9);

    // $0.012 would be plenty for one more request on its own, but $0.01 is already spent.
    const resumed = await env.run(
      miniFixture(),
      ask(1, () => 'second'),
      {
        meter: meter.meter,
        provider: 'voucher',
        from: { runDir: first.runDir, checkpoint: 1 },
        limits: { maxCostUsd: 0.012 },
      },
    );
    expect(resumed.result.endedBy).toBe('limit:cost');
    await eventually(() => env.apps[1]!.reached.length === 1);
    expect(env.apps[1]!.reached).toEqual(['call-0:402']);
    expect(resumed.result.usage.requests).toBe(1);
    expect(resumed.result.usage.costUsd).toBeCloseTo(0.01, 9);

    const free = await env.run(
      miniFixture(),
      ask(1, () => 'third'),
      {
        meter: meter.meter,
        provider: 'voucher',
        from: { runDir: first.runDir, checkpoint: 1 },
      },
    );
    expect(free.result.usage.requests).toBe(2);
    expect(free.result.usage.costUsd).toBeCloseTo(0.02, 9);
    expect(readEventsFile(free.runDir).some((e) => e.type === 'tool_start')).toBe(true);
  });
});

function readEventsLedger(runDir: string): { runId: string; kind: string }[] {
  const text = readFileSync(`${runDir}/llm/meter.jsonl`, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { runId: string; kind: string });
}
