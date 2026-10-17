/**
 * Stopping a run: whatever the app is doing, nothing may keep calling the meter afterwards, the
 * agent processes are gone, and closing still works.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRequest, ScenarioInput } from '@sa/mock-llm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  sleep,
  startStack,
  waitFor,
} from './support';

let host: Awaited<ReturnType<typeof prepareHostBundle>>;
beforeAll(async () => {
  host = await prepareHostBundle();
}, 180_000);
afterAll(() => host?.cleanup());

const SLOW_MS = 12_000;

/** Agent host processes of this test process (their command line names this process' bundle). */
function hostProcesses(): number[] {
  try {
    return execFileSync('pgrep', ['-f', host.bundle], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

const assistant = { hasTool: '^procedure_start$' };
const procedure = { hasTool: '^procedure_update$' };

/** The orchestrator starts a procedure at once; the model of the procedure agent takes its time. */
const slowProcedure: ScenarioInput = {
  rules: [
    {
      when: { ...assistant, lastUser: '^empieza', turn: 0 },
      reply: {
        toolCalls: [
          {
            id: 'call_start',
            name: 'procedure_start',
            arguments: { title: 'Lento', brief: 'Tarda.' },
          },
        ],
      },
    },
    { when: { ...assistant, lastTool: 'procedure_start' }, reply: { text: 'Empezado.' } },
    {
      when: { ...assistant, lastUser: 'Report from procedure' },
      reply: { text: 'No debería llegar.' },
    },
    { when: procedure, reply: { text: 'Tarde, pero hecho.', delayMs: SLOW_MS } },
  ],
  fallback: { text: 'Hecho.' },
};

const slowAssistant: ScenarioInput = {
  rules: [{ when: assistant, reply: { text: 'Tarde.', delayMs: SLOW_MS } }],
  fallback: { text: 'Hecho.' },
};

async function afterwards(stack: Stack, requestsBefore: number): Promise<void> {
  // Nothing may call the meter again, whatever the app wanted to do next (a report to the
  // orchestrator, a retry).
  await sleep(2000);
  expect(stack.llm.requests().length).toBe(requestsBefore);
  await waitFor(
    () => stack.run.summary().inflight === 0,
    'the meter to have no request in flight',
    10_000,
  );
  expect(hostProcesses()).toEqual([]);
}

describe('abort', () => {
  it('while the orchestrator waits for the model: no more meter requests, no process left', async () => {
    const stack = await startStack({ hostBundle: host.bundle, scenario: slowAssistant });
    try {
      await stack.app.send('hola');
      await waitFor(
        () => stack.llm.requests().length === 1 && stack.run.summary().inflight === 1,
        'the request in flight',
      );
      expect(hostProcesses().length).toBeGreaterThan(0);
      const requests = stack.llm.requests().length;

      const started = Date.now();
      await stack.app.abort('a test said so');
      // Long before the model would have answered.
      expect(Date.now() - started).toBeLessThan(SLOW_MS / 2);

      await afterwards(stack, requests);
      expect(stack.app.idle()).toBe(false);
      expect(await stack.app.untilIdle({ timeoutMs: 1000 })).toBe(false);
      await expect(stack.app.send('otra vez')).rejects.toThrow(/aborted/);
      await expect(
        stack.app.addClave({ username: '53918274H', password: 'x'.repeat(8) }),
      ).rejects.toThrow(/aborted/);
      // Aborting twice is the same abort.
      await stack.app.abort('again');

      const closing = Date.now();
      await stack.app.close();
      expect(Date.now() - closing).toBeLessThan(15_000);
      await stack.app.close();
      expect(existsSync(join(stack.runDir, 'transcripts', 'assistant'))).toBe(true);
    } finally {
      await stack.close();
      removeRunDir(stack.runDir);
    }
  }, 120_000);

  it('while a procedure agent waits: its death is not reported to the orchestrator', async () => {
    const stack = await startStack({ hostBundle: host.bundle, scenario: slowProcedure });
    try {
      await stack.app.send('empieza');
      // The orchestrator has answered and the procedure's first request is waiting.
      await waitFor(
        () =>
          stack.run.summary().inflight === 1 &&
          stack.llm
            .requests()
            .some((r) =>
              ((r.body as ChatRequest).tools ?? []).some(
                (t) => t.function?.name === 'procedure_update',
              ),
            ),
        'the procedure agent to wait for the model',
      );
      const assistantRequests = stack.run.agentUsage('assistant').requests;
      const requests = stack.llm.requests().length;

      await stack.app.abort('stop it');

      await afterwards(stack, requests);
      expect(stack.run.agentUsage('assistant').requests).toBe(assistantRequests);
      expect(stack.of('assistant_message').map((m) => m.text)).not.toContain('No debería llegar.');
    } finally {
      await stack.close();
      removeRunDir(stack.runDir);
    }
  }, 120_000);

  it('when the run aborts through its signal', async () => {
    const stack = await startStack({ hostBundle: host.bundle, scenario: slowAssistant });
    try {
      await stack.app.send('hola');
      await waitFor(
        () => stack.llm.requests().length === 1 && stack.run.summary().inflight === 1,
        'the request in flight',
      );
      const requests = stack.llm.requests().length;
      stack.abort.abort();
      await waitFor(() => hostProcesses().length === 0, 'the agent processes to be gone', 15_000);
      await afterwards(stack, requests);
      expect(await stack.app.untilIdle({ timeoutMs: 500 })).toBe(false);
    } finally {
      await stack.close();
      removeRunDir(stack.runDir);
    }
  }, 120_000);

  it('does not start when the signal already aborted', async () => {
    const { startWorld } = await import('./support');
    const { createEvalAppWith } = await import('../../../src/run/app');
    const world = await startWorld({ hostBundle: host.bundle });
    try {
      world.abort.abort();
      await expect(
        createEvalAppWith(world.spec, world.deps, {
          hostBundle: { bundle: host.bundle, sources: [] },
        }),
      ).rejects.toThrow(/aborted/);
      expect(existsSync(join(world.runDir, 'profile'))).toBe(false);
    } finally {
      world.run.close();
      await world.env.close();
      await world.bench.close();
      world.log.close();
      removeRunDir(world.runDir);
    }
  });
});

afterAll(expectNoEgress);
