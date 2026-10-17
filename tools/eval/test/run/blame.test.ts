/**
 * Whose fault is it when an agent stops (src/run/infra.ts, docs/EVAL.md "Run loop"): the model
 * gateway failing, a host that crashed and Chromium that cannot start are the infrastructure's
 * (`error`, no score); the harness's own budget is `limit:budget` (no score); the request and
 * dollar caps of a run and of an agent are the agent's own doing (`limit:*`, the rules judge). All
 * with fakes: offline and fast.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Observation } from '../../src/contracts';
import type { MeterEvent } from '../../src/llm';
import { classifyAgentFailure, classifyCap } from '../../src/run/infra';
import { createEnv, type Env, miniFixture } from './support/harness';
import type { Script } from './support/scripted-app';

let env: Env;
afterEach(() => env?.dispose());

type Failure = Extract<Observation, { type: 'agent_failure' }>;

/** The procedure agent works a little, then its model request fails for good. */
const failsWith =
  (kind: Failure['kind'], message: string, rest: Partial<Failure> = {}): Script =>
  async (ctx) => {
    ctx.tool('procedure', 'look');
    ctx.emit({
      type: 'agent_failure',
      agent: 'procedure',
      procedureId: 'p_1',
      kind,
      message,
      ...rest,
    });
    await ctx.sleep(10_000);
  };

describe('the model gateway or a host failing is never the agent failing', () => {
  it.each([
    ['auth', 'HTTP 401: Authentication Error - Expired Key'],
    ['rate_limit', '429 Too Many Requests'],
    ['network', 'fetch failed: ECONNRESET'],
    ['provider', '503 Service Unavailable'],
    ['unknown', 'The model returned an error'],
  ] as const)('a %s error ends the run as an error, with no score', async (kind, message) => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), failsWith(kind, message));
    expect(outcome.result).toMatchObject({
      status: 'error',
      score: null,
      scoreBeforePenalty: null,
      endedBy: 'error',
    });
    expect(outcome.result.notes[0]).toBe(
      `infrastructure:model:${kind} (procedure-p_1): ${message}`,
    );
    // Its required rules are unmatched, and it still is nobody's failure to score.
    expect(outcome.result.rules.find((r) => r.ruleId === 'did-it')).toMatchObject({
      matched: false,
    });
    expect(env.apps[0]!.abortReasons).toHaveLength(1);
    for (const run of env.meter.runs) expect(run.closed).toBe(true);
  });

  it('a host that crashed while the run was open is the infrastructure too', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      failsWith('crash', 'The assistant host exited (code null, signal SIGKILL): ', {
        agent: 'assistant',
      }),
    );
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toMatch(/^infrastructure:host:crash \(procedure-p_1\): /);
  });

  it('a host killed by Ctrl-C waits for the caller: the abort that follows wins', async () => {
    env = createEnv();
    const controller = new AbortController();
    const crash = failsWith('crash', 'The procedure host exited (code null, signal SIGINT): ', {
      signal: 'SIGINT',
    });
    const outcome = await env.run(
      miniFixture(),
      async (ctx) => {
        setTimeout(() => controller.abort(), 200);
        await crash(ctx);
      },
      { signal: controller.signal },
    );
    expect(outcome.result).toMatchObject({ status: 'aborted', score: null, endedBy: 'abort' });
  });

  it('a host killed by Ctrl-C with no abort after it is still the infrastructure', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      failsWith('crash', 'The procedure host exited (code null, signal SIGTERM): ', {
        signal: 'SIGTERM',
      }),
    );
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toMatch(/^infrastructure:host:crash \(procedure-p_1\): /);
  });

  it('the gateway refusing to spend more (quota) is the harness budget: aborted, no score', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), failsWith('quota', '402 key limit exceeded'));
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      endedBy: 'limit:budget',
    });
    expect(outcome.result.notes[0]).toMatch(/^budget: the model refused the request of /);
  });

  it("a conversation that outgrew the model's window is the agent's: scored as usual", async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.emit({
        type: 'agent_failure',
        agent: 'assistant',
        kind: 'context',
        message: 'context length exceeded',
      });
      ctx.tool('procedure', 'look');
    });
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'quiescent',
    });
    expect(outcome.result.notes).toContain(
      'agent-failure:context (assistant): context length exceeded',
    );
  });

  it('a failure after the run was decided does not change how it ended', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'bad_tool');
      // The app is being stopped: the agents' own runs end with errors.
      ctx.emit({ type: 'agent_failure', agent: 'procedure', kind: 'provider', message: '500' });
    });
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'required-failed',
    });
  });
});

describe('Chromium that cannot start is the infrastructure', () => {
  const browser =
    (text: string, isError = true, tool = 'browser_open'): Script =>
    async (ctx) => {
      ctx.emit({ type: 'tool_start', agent: 'procedure', toolCallId: 'b1', tool, args: {} });
      ctx.emit({ type: 'tool_end', agent: 'procedure', toolCallId: 'b1', tool, isError, text });
      await ctx.sleep(200);
      ctx.tool('procedure', 'do_it');
    };

  it("a browser tool that says the executable doesn't exist ends the run as an error", async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      browser(
        "Browser error: browserType.launch: Executable doesn't exist at /x/chromium-1208/chrome. Call browser_snapshot to see the current page before trying again.",
      ),
    );
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toMatch(
      /^infrastructure:browser \(procedure\): Chromium could not be started: Browser error: browserType\.launch/,
    );
  });

  it.each([
    [
      'another browser error is the agent navigating badly',
      'Browser error: Timeout 30000ms exceeded.',
      true,
      'browser_open',
    ],
    [
      'a page that talks about it is only a page',
      "Executable doesn't exist",
      false,
      'browser_snapshot',
    ],
    ['a tool that is not the browser', "Executable doesn't exist", true, 'run_script'],
  ] as const)('%s', async (_name, text, isError, tool) => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), browser(text, isError, tool));
    expect(outcome.result).toMatchObject({ status: 'completed', endedBy: 'quiescent' });
  });
});

describe("the caps of a run and of an agent are the agent's doing", () => {
  const capScript =
    (cap: Omit<Extract<MeterEvent, { type: 'cap' }>, 'runId' | 'type'>): Script =>
    async (ctx) => {
      ctx.tool('procedure', 'look');
      await ctx.sleep(5);
      ctx.meterRun.emit({ type: 'cap', runId: ctx.spec.runId, ...cap });
      await ctx.sleep(10_000);
    };

  it.each([
    ['run_budget', 'assistant', 'limit:cost'],
    ['agent_budget', 'assistant', 'limit:cost'],
    ['agent_budget', 'procedure-p_1', 'limit:cost'],
    ['input_too_large', 'procedure-p_1', 'limit:cost'],
    ['requests_cap', 'assistant', 'limit:requests'],
    ['requests_cap', 'procedure-p_1', 'limit:requests'],
    ['agent_requests_cap', 'procedure-p_1', 'limit:requests'],
  ] as const)(
    '%s of %s ends the run as %s: scored by the rules',
    async (reason, agent, endedBy) => {
      env = createEnv();
      const outcome = await env.run(
        miniFixture(),
        capScript({ agent, reason, message: `${agent} went over` }),
      );
      // The job was never done: a looping agent fails its required rules.
      expect(outcome.result).toMatchObject({ status: 'failed_required', score: 0, endedBy });
      expect(outcome.result.notes[0]).toBe(
        `limit exceeded: meter cap ${reason} (${agent}): ${agent} went over`,
      );
      expect(env.apps[0]!.abortReasons).toHaveLength(1);
    },
  );

  it.each([
    ['agent_budget', 'answerer'],
    ['agent_requests_cap', 'answerer'],
    ['input_too_large', 'answerer'],
    ['stopped', 'assistant'],
    ['lifetime', 'assistant'],
    ['daily', 'procedure-p_1'],
    ['key_balance', 'assistant'],
    ['codex_cooldown', 'assistant'],
  ] as const)('%s of %s is the harness budget: aborted, no score', async (reason, agent) => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      capScript({ agent, reason, message: 'the harness is out of money' }),
    );
    expect(outcome.result).toMatchObject({
      status: 'aborted',
      score: null,
      endedBy: 'limit:budget',
    });
    expect(outcome.result.notes[0]).toBe(
      `budget: meter cap ${reason} (${agent}): the harness is out of money`,
    );
  });

  it('classifyCap names every reason the meter has', () => {
    const reasons: Extract<MeterEvent, { type: 'cap' }>['reason'][] = [
      'stopped',
      'requests_cap',
      'agent_requests_cap',
      'input_too_large',
      'lifetime',
      'daily',
      'key_balance',
      'run_budget',
      'agent_budget',
      'codex_cooldown',
    ];
    for (const reason of reasons) {
      expect(['limit:cost', 'limit:requests', 'limit:budget']).toContain(
        classifyCap(reason, 'assistant'),
      );
    }
  });
});

describe('the fixture limit on model requests', () => {
  const loops =
    (calls: number, agent = 'assistant'): Script =>
    async (ctx) => {
      for (let i = 0; i < calls; i++) {
        ctx.model(0.0001, agent);
        await ctx.sleep(1);
      }
    };

  it('a looping agent that never did the job fails its required rules', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), loops(40), { limits: { maxRequests: 5 } });
    expect(outcome.result).toMatchObject({
      status: 'failed_required',
      score: 0,
      endedBy: 'limit:requests',
    });
    expect(outcome.result.notes[0]).toBe('limit exceeded: 6 model requests, at most 5');
    expect(outcome.result.usage.requests).toBe(6);
  });

  it('counts what a resumed run already used', async () => {
    env = createEnv();
    const first = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
      ctx.model();
      ctx.model();
    });
    expect(first.result.usage.requests).toBe(2);
    const second = await env.run(miniFixture(), loops(10), {
      from: { runDir: first.runDir, checkpoint: 1 },
      limits: { maxRequests: 4 },
    });
    expect(second.result.endedBy).toBe('limit:requests');
    // 2 before the checkpoint, 3 more crossed the limit of 4.
    expect(second.result.usage.requests).toBe(5);
  });

  it('a job that was done before the cut still counts, and says what was not tested to the end', async () => {
    env = createEnv();
    const outcome = await env.run(
      miniFixture(),
      async (ctx) => {
        ctx.tool('procedure', 'do_it');
        ctx.say('assistant', 'Gracias');
        await loops(40)(ctx);
      },
      { limits: { maxRequests: 3 } },
    );
    expect(outcome.result).toMatchObject({
      status: 'completed',
      score: 1,
      endedBy: 'limit:requests',
      unsettledNegated: ['no-bad'],
    });
    expect(outcome.result.notes).toContain('unsettled-negated:no-bad');
  });

  it('must be a positive number', async () => {
    env = createEnv();
    await expect(env.run(miniFixture(), loops(1), { limits: { maxRequests: 0 } })).rejects.toThrow(
      /limits\.maxRequests must be a positive number/,
    );
  });
});

describe('what the app reports of a failed turn, classified', () => {
  it('only a context overflow is the agent', () => {
    expect(classifyAgentFailure('context')).toEqual({ by: 'agent' });
    expect(classifyAgentFailure('quota')).toEqual({ by: 'budget' });
    expect(classifyAgentFailure('crash')).toEqual({
      by: 'infrastructure',
      source: 'host',
      kind: 'crash',
    });
    for (const kind of ['auth', 'rate_limit', 'network', 'provider', 'unknown'] as const) {
      expect(classifyAgentFailure(kind)).toEqual({ by: 'infrastructure', source: 'model', kind });
    }
  });
});

describe('a bench follower that survives an outage', () => {
  it('only leaves a note: the run goes on and is scored', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'do_it');
      ctx.say('assistant', 'Gracias');
      env.bench.followers[0]!.onWarning?.(new Error('SpainBench GET events: HTTP 503'));
      await ctx.sleep(5);
    });
    expect(outcome.result).toMatchObject({ status: 'completed', score: 1, endedBy: 'quiescent' });
    expect(outcome.result.notes).toContain('bench follower: SpainBench GET events: HTTP 503');
  });

  it('ends the run as an error when the follower gives up', async () => {
    env = createEnv();
    const outcome = await env.run(miniFixture(), async (ctx) => {
      ctx.tool('procedure', 'look');
      env.bench.followers[0]!.onError?.(new Error('SpainBench has not answered for 61 s'));
      await ctx.sleep(10_000);
    });
    expect(outcome.result).toMatchObject({ status: 'error', score: null, endedBy: 'error' });
    expect(outcome.result.notes[0]).toBe('bench follower: SpainBench has not answered for 61 s');
  });
});
