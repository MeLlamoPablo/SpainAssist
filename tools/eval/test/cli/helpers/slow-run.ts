/**
 * `eval` with a scripted model that takes a minute to answer: the stand-in for a long run that
 * `real-run.test.ts` interrupts. Run through tsx like the real entry (`src/cli.ts`); the scenario
 * source is the only difference. With `SA_EVAL_TEST_SLOW=browser` the agent's workflow opens the
 * mock's page in Chromium first and then the agent waits: a run interrupted while the browser is up.
 */
import { main } from '../../../src/cli/main';
import { AGENT, COORDINATOR, INFO_URL, workflow } from '../../../src/scenarios';

const slow = { name: 'slow', fallback: { text: 'Un momento...', delayMs: 60_000 } };

const browserThenWait = {
  name: 'browser-then-wait',
  rules: [
    {
      id: 'coordinator-starts',
      when: { ...COORDINATOR, lastUser: 'sácame', toolCalled: { name: 'agent_start', atMost: 0 } },
      reply: {
        toolCalls: [
          {
            id: 'call_start',
            name: 'agent_start',
            arguments: {
              status: 'Sacando tu vida laboral…',
              brief: 'Saca la vida laboral del usuario.',
            },
          },
        ],
      },
    },
    {
      id: 'coordinator-says',
      when: { ...COORDINATOR, lastTool: 'agent_start' },
      reply: { text: 'Empiezo con tu vida laboral.' },
    },
    {
      id: 'agent-opens',
      when: { ...AGENT, state: { p: null } },
      set: { p: 1 },
      reply: {
        toolCalls: [
          workflow(
            'vida-laboral',
            `  await api.procedures.getOrCreate({ id: 'vida-laboral', title: 'Vida laboral' });
  const page = await api.browser.currentPage();
  await page.goto('${INFO_URL}');
  return 'abierta';`,
          ),
        ],
      },
    },
    {
      id: 'agent-waits',
      when: { ...AGENT, state: { p: 1 } },
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
