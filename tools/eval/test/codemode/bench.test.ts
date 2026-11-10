/**
 * The harness benchmark as a test (src/codemode/bench.ts): the same task in the classic harness
 * and in codemode, in the real app with the real agent hosts and a scripted model. Run
 * `node --import tsx scripts/codemode-bench.ts` for the numbers with realistic latencies.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runRentaBenchmark } from '../../src/codemode/bench';

beforeAll(() => {
  const agentRoot = dirname(createRequire(import.meta.url).resolve('@sa/agent/package.json'));
  execFileSync(process.execPath, [join(agentRoot, 'scripts', 'build-host.mjs')], { stdio: 'pipe' });
}, 120_000);

describe('classic harness vs codemode on "¿tengo que hacer la renta?"', () => {
  it('shows the question sooner, and answers as soon after the user does', async () => {
    const options = { llmDelayMs: 300, thinkMs: 200 };
    const classic = await runRentaBenchmark('classic', options);
    const codemode = await runRentaBenchmark('codemode', options);
    // The scripted sequences: classic 9 calls (assistant 3, procedure agent 6); codemode 8
    // (coordinator 3, agent 3, classifier 1 and the agent's report).
    expect(classic.modelCalls).toBe(9);
    expect(codemode.modelCalls).toBe(8);
    expect(codemode.timeToQuestionMs).toBeLessThan(classic.timeToQuestionMs);
    // Both wait for three model calls after the answer (the coordinator only relays).
    expect(codemode.answerToResultMs).toBeLessThan(classic.answerToResultMs + options.llmDelayMs);
  }, 180_000);
});
