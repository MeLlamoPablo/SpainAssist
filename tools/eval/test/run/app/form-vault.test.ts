/**
 * The simulated user answers a form the way the UI does, through the app's own path: a field the
 * agent wants kept (`vaultKey`) ends up in the user's data. Fixture 1 depends on it: the agent asks
 * for the DNI in a form, and later types it from the vault.
 */
import { join } from 'node:path';
import type { ScenarioInput } from '@sa/mock-llm';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getFixture } from '../../../src/fixtures';
import { createUserSimulator } from '../../../src/run';
import { PROFILE_KEY_SEED } from '../../../src/run/app/eval-app';
import { assistantRules, step } from './scripts';
import {
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  type Stack,
  startStack,
  testFixture,
} from './support';

const DNI = '53918274H';

/** The procedure agent asks for the DNI and wants it kept in the user's data, then reads it back. */
function dniScenario(): ScenarioInput {
  return {
    rules: [
      ...assistantRules,
      step(
        null,
        [
          {
            id: 'call_ask_dni',
            name: 'ask_user',
            arguments: {
              title: 'Tu DNI',
              message: 'Necesito tu DNI para entrar.',
              fields: [
                {
                  key: 'dni',
                  label: 'DNI',
                  type: 'text',
                  required: true,
                  vaultKey: 'dniNumber',
                },
              ],
            },
          },
        ],
        1,
      ),
      step(1, [{ id: 'call_vault', name: 'vault_read', arguments: {} }], 2),
      step(
        2,
        [
          {
            id: 'call_done',
            name: 'procedure_update',
            arguments: { status: 'done', summary: 'Hecho' },
          },
        ],
        3,
      ),
      {
        id: 'procedure-ends',
        when: { hasTool: '^procedure_update$', state: { p: 3 } },
        reply: { text: 'Hecho.' },
      },
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

  it("leaves the DNI in the vault under the form's vaultKey, as the UI would", () => {
    expect(vault.listPersonal().find((item) => item.key === 'dniNumber')?.value).toBe(DNI);
  });

  it('tells the agent it was saved, and the agent can read it back', () => {
    const asked = stack.of('tool_end').find((o) => o.tool === 'ask_user');
    expect(asked?.text).toContain(DNI);
    // The product says which answers it kept, by the form's own keys.
    expect(asked?.text).toMatch(/Saved to their data: dni\./);
    const read = stack.of('tool_end').find((o) => o.tool === 'vault_read');
    expect(read?.text).toContain('dniNumber');
  });

  it('answers through the app once, as a structured answer', () => {
    const answered = stack.of('prompt_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ answerId: 'dni-form', by: 'structured' });
  });
});
