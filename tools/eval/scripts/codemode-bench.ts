/**
 * The classic harness against codemode on the same task, with realistic latencies, in the real
 * app (docs/codemode.md, "Empirical verification"). Prints a markdown table of medians.
 *
 *   node --import tsx scripts/codemode-bench.ts [llmDelayMs=2500] [thinkMs=8000] [runs=3]
 *
 * Build the agent host first: corepack pnpm --filter @sa/agent build
 */
import { type BenchResult, benchTable, runRentaBenchmark } from '../src/codemode/bench';

const [llmDelayMs = 2500, thinkMs = 8000, runs = 3] = process.argv.slice(2).map(Number);
const options = { llmDelayMs, thinkMs };

function median(results: BenchResult[]): BenchResult {
  const pick = (f: (r: BenchResult) => number) => {
    const values = results.map(f).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)] as number;
  };
  return {
    harness: (results[0] as BenchResult).harness,
    modelCalls: pick((r) => r.modelCalls),
    callsAfterAnswer: pick((r) => r.callsAfterAnswer),
    timeToQuestionMs: pick((r) => r.timeToQuestionMs),
    answerToResultMs: pick((r) => r.answerToResultMs),
    totalMs: pick((r) => r.totalMs),
  };
}

const out: BenchResult[] = [];
for (const harness of ['classic', 'codemode'] as const) {
  const results: BenchResult[] = [];
  for (let i = 0; i < runs; i++) {
    const result = await runRentaBenchmark(harness, options);
    console.error(harness, i + 1, JSON.stringify(result));
    results.push(result);
  }
  out.push(median(results));
}
console.log(benchTable(out, options));
