/**
 * `eval` with a scripted model that takes a minute to answer: the stand-in for a long run that
 * `real-run.test.ts` interrupts. Run through tsx like the real entry (`src/cli.ts`); the scenario
 * source is the only difference. With `SA_EVAL_TEST_SLOW=browser` the procedure agent opens the
 * mock's page in Chromium first and then waits: a run interrupted while the browser is up.
 */
import { main } from '../../../src/cli/main';
import { INFO_URL } from '../../../src/scenarios/procedure';

const slow = { name: 'slow', fallback: { text: 'Un momento...', delayMs: 60_000 } };

const browserThenWait = {
  name: 'browser-then-wait',
  rules: [
    {
      id: 'assistant-starts',
      when: { hasTool: '^procedure_start$', lastUser: '^sácame', turn: 0 },
      reply: {
        toolCalls: [
          {
            id: 'call_start',
            name: 'procedure_start',
            arguments: { title: 'Vida laboral', brief: 'Saca la vida laboral del usuario.' },
          },
        ],
      },
    },
    {
      id: 'assistant-says',
      when: { hasTool: '^procedure_start$', lastTool: 'procedure_start' },
      reply: { text: 'Empiezo con tu vida laboral.' },
    },
    {
      id: 'procedure-opens',
      when: { hasTool: '^procedure_update$', state: { p: null } },
      set: { p: 1 },
      reply: {
        toolCalls: [{ id: 'call_open', name: 'browser_open', arguments: { url: INFO_URL } }],
      },
    },
    {
      id: 'procedure-waits',
      when: { hasTool: '^procedure_update$', state: { p: 1 } },
      reply: { text: 'Un momento...', delayMs: 60_000 },
    },
  ],
  fallback: { text: 'Hecho.' },
};

const code = await main(process.argv.slice(2), {
  mockScenario: () => (process.env.SA_EVAL_TEST_SLOW === 'browser' ? browserThenWait : slow),
});
process.exitCode = code;
setTimeout(() => process.exit(code), 3_000).unref();
