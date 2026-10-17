/**
 * CLI: corepack pnpm --filter @sa/mock-llm start -- --port 8789 [--scenario file.json|demo|echo]
 *      [--chunk-delay 15] [--chunk-size 16] [--host 127.0.0.1] [--verbose]
 *      [--litellm] [--litellm-budget <usd>]   emulate a LiteLLM gateway (headers, spend, 422 over budget)
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { builtinScenario } from './scenarios';
import { createMockLlm } from './server';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    port: { type: 'string', default: process.env.MOCK_LLM_PORT ?? '8789' },
    host: { type: 'string', default: '127.0.0.1' },
    scenario: { type: 'string', default: 'demo' },
    'chunk-delay': { type: 'string', default: '15' },
    'chunk-size': { type: 'string', default: '16' },
    verbose: { type: 'boolean', default: false },
    litellm: { type: 'boolean', default: false },
    'litellm-budget': { type: 'string' },
  },
});

const scenarioArg = values.scenario ?? 'demo';
const scenario = builtinScenario(scenarioArg)
  ? scenarioArg
  : (JSON.parse(readFileSync(scenarioArg, 'utf8')) as object);

const llm = await createMockLlm({
  port: Number(values.port),
  host: values.host,
  scenario,
  chunkDelayMs: Number(values['chunk-delay']),
  chunkSize: Number(values['chunk-size']),
  verbose: values.verbose,
  ...(values.litellm || values['litellm-budget']
    ? {
        litellm: values['litellm-budget'] ? { maxBudgetUsd: Number(values['litellm-budget']) } : {},
      }
    : {}),
});

process.stderr.write(
  `mock-llm listening on ${llm.url} (scenario "${llm.getScenario().name}", base URL ${llm.baseUrl})\n`,
);

const shutdown = () => {
  void llm.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
