/**
 * The simulated user answers an agent's interface the way the UI does, through the app's own path,
 * and the agent keeps the answer in the user's data (`api.vault.save`). Fixture 1 depends on it:
 * the agent asks for the DNI, and later the app types it from the vault.
 */
import { join } from 'node:path';
import type { ScenarioInput } from '@sa/mock-llm';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFixture } from '../../../src/fixtures';
import { createUserSimulator } from '../../../src/run';
import { PROFILE_KEY_SEED } from '../../../src/run/app/eval-app';
import { AGENT, sequence, workflow } from '../../../src/scenarios/kit';
import { coordinatorRules } from './scripts';
import {
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  startStack,
  testFixture,
} from './support';

const DNI = '53918274H';

const DNI_FORM = `function DniForm({ api }) {
  const [dni, setDni] = api.ui.useDurableState('dni', '');
  return (
    <Form title="Tu DNI">
      <Text>Necesito tu DNI para entrar.</Text>
      <TextField label="DNI" value={dni} onChange={setDni} />
      <Actions>
        <Button type="primary" disabled={!dni} onClick={() => api.ui.close(dni)}>Seguir</Button>
      </Actions>
    </Form>
  );
}`;

/** The agent asks for the DNI in an interface, keeps it in the user's data and reads it back. */
function dniScenario(): ScenarioInput {
  return {
    rules: [
      ...coordinatorRules,
      ...sequence(AGENT, 'p', [
        {
          id: 'workflow',
          call: workflow(
            'dni',
            `const procedure = await api.procedures.getOrCreate({ id: 'vida-laboral', title: 'Vida laboral' });
  const dni = await api.ui.present('dni', () => <DniForm api={api} />);
  const saved = await api.vault.save([{ key: 'dniNumber', value: dni }]);
  const read = await api.vault.read({ keys: ['dniNumber'] });
  await procedure.update({ status: 'done', summary: 'Hecho' });
  return { dni, saved, read: read.personal };`,
            { callId: 'call_dni', components: DNI_FORM },
          ),
        },
        { id: 'ends', text: 'Hecho.' },
      ]),
    ],
    fallback: { text: 'Hecho.' },
  };
}

describe('a form answered by the simulated user', () => {
  let host: Awaited<ReturnType<typeof prepareHostBundle>>;
  let stack: Stack;
  let vault: Vault;

  beforeAll(async () => {
    host = await prepareHostBundle();
    stack = await startStack({
      hostBundle: host.bundle,
      scenario: dniScenario(),
      fixture: testFixture('vida-laboral-sin-datos'),
    });
    const fixture = getFixture('vida-laboral-sin-datos');
    const { app, log } = stack;
    const failures: Error[] = [];
    const simulator = createUserSimulator({
      // The DNI answer of the real fixture 1 is a credential; this one is a form of the DNI alone.
      fixture: {
        persona: fixture.persona,
        language: 'es',
        answerGroups: [
          {
            id: 'dni',
            answers: [
              {
                id: 'dni-form',
                match: { kind: 'form', fieldKeys: ['dni'] },
                action: { type: 'values', values: { dni: DNI } },
              },
            ],
          },
        ],
        unexpectedPrompt: 'fail',
      },
      app,
      log,
      secrets: (value) => app.addSecret(value),
      onUnexpected: (prompt, reason) => failures.push(new Error(`${prompt.title}: ${reason}`)),
      onFatal: (error) => failures.push(error),
    });
    simulator.start();
    await app.send('sácame la vida laboral');
    const idle = await app.untilIdle({ holdMs: 400, timeoutMs: 120_000 });
    expect(idle).toBe(true);
    expect(failures).toEqual([]);
    const taken = await app.checkpoint(join(stack.runDir, 'cp'));
    // The copy is a closed vault of its own: safe to open next to the live one.
    vault = await Vault.open(
      join(taken.profileDir, 'vault'),
      createTestKeyProvider(PROFILE_KEY_SEED),
    );
  }, 240_000);

  afterAll(async () => {
    await stack?.close();
    if (stack) removeRunDir(stack.runDir);
    host?.cleanup();
    expectNoEgress();
  });

  it('leaves the DNI in the vault under the key the agent saved it with', () => {
    expect(vault.listPersonal().find((item) => item.key === 'dniNumber')?.value).toBe(DNI);
  });

  it('gives the workflow the answer, and the agent can read it back', () => {
    const result = stack.of('tool_end').find((o) => o.toolCallId.startsWith('workflow-result-'));
    expect(result?.text).toMatch(/^\[Workflow "dni" succeeded\]/);
    expect(result?.text).toContain(`"dni":"${DNI}"`);
    expect(result?.text).toContain('"saved":["dniNumber"]');
    expect(result?.text).toMatch(/"key":"dniNumber"[^}]*"value":"53918274H"/);
  });

  it('answers through the app once, as a structured answer', () => {
    const answered = stack.of('prompt_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ answerId: 'dni-form', by: 'structured' });
  });
});
