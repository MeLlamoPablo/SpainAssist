import { describe, expect, it } from 'vitest';
import {
  credentialPromptsAtLeast,
  offersAuthenticationOptions,
  orchestratorLinksSavedDocument,
} from '../../src/rules/helpers';
import { FakeRun, promptShown, say } from './support/run';

const methodsForm = (labels: string[]) =>
  promptShown({
    kind: 'form',
    title: '¿Cómo quieres identificarte?',
    fields: [
      {
        key: 'metodo',
        type: 'select',
        label: 'Método',
        options: labels.map((label, i) => ({ value: `m${i}`, label })),
      },
    ],
  });

describe('offersAuthenticationOptions', () => {
  it('accepts a form whose options include Cl@ve Permanente and another method', () => {
    const run = new FakeRun();
    run.push(methodsForm(['Cl@ve Permanente (usuario y contraseña)', 'Cl@ve Móvil (app)']));
    expect(offersAuthenticationOptions(run.view())).toBe(true);
  });

  it('accepts other methods named in any label spelling', () => {
    for (const other of [
      'Certificado digital',
      'DNIe',
      'DNI electrónico',
      'Vía SMS',
      'Cl@ve PIN',
    ]) {
      const run = new FakeRun();
      run.push(methodsForm(['cl@ve permanente', other]));
      expect(offersAuthenticationOptions(run.view()), other).toBe(true);
    }
  });

  it('refuses a form with only Cl@ve Permanente, or only other methods', () => {
    const only = new FakeRun();
    only.push(methodsForm(['Cl@ve Permanente', 'Otro tramite']));
    expect(offersAuthenticationOptions(only.view())).toBe(false);
    const without = new FakeRun();
    without.push(methodsForm(['Cl@ve Móvil', 'Certificado digital']));
    expect(offersAuthenticationOptions(without.view())).toBe(false);
  });

  it('does not combine options of different fields', () => {
    const run = new FakeRun();
    run.push(
      promptShown({
        kind: 'form',
        title: 'Dos preguntas',
        fields: [
          {
            key: 'a',
            type: 'select',
            label: 'A',
            options: [{ value: '1', label: 'Cl@ve Permanente' }],
          },
          { key: 'b', type: 'select', label: 'B', options: [{ value: '2', label: 'Cl@ve Móvil' }] },
        ],
      }),
    );
    expect(offersAuthenticationOptions(run.view())).toBe(false);
  });

  it('accepts prose of either agent that names Cl@ve Permanente and another method', () => {
    for (const agent of ['assistant', 'procedure'] as const) {
      const run = new FakeRun();
      run.push(
        say(agent, 'Puedes entrar con Cl@ve Permanente, Cl@ve Móvil o certificado digital.'),
      );
      expect(offersAuthenticationOptions(run.view()), agent).toBe(true);
    }
  });

  it('refuses prose that names one method only', () => {
    const run = new FakeRun();
    run.push(say('assistant', 'Entro con Cl@ve Permanente.'));
    run.push(say('procedure', 'Necesito tu Cl@ve Móvil.'));
    expect(offersAuthenticationOptions(run.view())).toBe(false);
  });

  it('also reads the question of a form that offers the methods in its own words', () => {
    const run = new FakeRun();
    run.push(
      promptShown({
        kind: 'form',
        title: 'Identificación',
        message: 'Se puede usar Cl@ve Permanente o Cl@ve Móvil. ¿Cuál prefieres?',
        fields: [{ key: 'metodo', type: 'text', label: 'Tu elección' }],
      }),
    );
    expect(offersAuthenticationOptions(run.view())).toBe(true);
  });

  describe('is not earned by what only mentions the methods', () => {
    const offered = (run: FakeRun) => offersAuthenticationOptions(run.view());

    it('a confirmation or another prompt that names them is no choice', () => {
      const run = new FakeRun();
      run.push(
        promptShown({
          kind: 'confirm',
          title: 'Identificación',
          message: 'Se puede usar Cl@ve Permanente o Cl@ve Móvil. ¿Seguimos?',
        }),
      );
      run.push(
        promptShown({
          kind: 'user_action',
          title: 'Entra con Cl@ve Permanente (no con certificado digital)',
        }),
      );
      expect(offered(run)).toBe(false);
    });

    it('a bare SMS is not an authentication method', () => {
      const run = new FakeRun();
      run.push(say('procedure', 'Voy a usar Cl@ve Permanente; el SMS no hace falta.'));
      expect(offered(run)).toBe(false);
      run.push(say('assistant', 'Cl@ve Permanente, y te llegará un SMS'));
      expect(offered(run)).toBe(false);
      run.push(say('assistant', 'Cl@ve Permanente o por vía SMS'));
      expect(offered(run)).toBe(true);
    });

    it('a message after the user was asked for the credential is a report, not an offer', () => {
      const run = new FakeRun();
      run.push(promptShown({ kind: 'credential', itemId: 'c1' }));
      run.push(say('assistant', 'Entré con Cl@ve Permanente (no con certificado digital).'));
      run.push(say('procedure', 'Con Cl@ve Permanente o Cl@ve Móvil se puede, usé la primera.'));
      expect(offered(run)).toBe(false);
    });

    it('a message before that is an offer, and a form still is one afterwards', () => {
      const before = new FakeRun();
      before.push(say('assistant', 'Puedo usar Cl@ve Permanente o certificado digital: ¿cuál?'));
      before.push(promptShown({ kind: 'credential', itemId: 'c1' }));
      expect(offered(before)).toBe(true);

      const after = new FakeRun();
      after.push(promptShown({ kind: 'credential', itemId: 'c1' }));
      after.push(methodsForm(['Cl@ve Permanente', 'Cl@ve Móvil']));
      expect(offered(after)).toBe(true);
    });
  });
});

describe('credentialPromptsAtLeast', () => {
  it('counts distinct credential prompts', () => {
    const run = new FakeRun();
    const test = credentialPromptsAtLeast(2);
    run.push(promptShown({ kind: 'credential', itemId: 'a' }));
    run.push(promptShown({ kind: 'credential', itemId: 'a' }));
    run.push(promptShown({ kind: 'form', itemId: 'b' }));
    expect(test(run.view())).toBe(false);
    run.push(promptShown({ kind: 'credential', itemId: 'c' }));
    expect(test(run.view())).toBe(true);
  });
});

describe('orchestratorLinksSavedDocument', () => {
  const link = (id: string) => `Listo. Aquí tienes tu informe.\n[Vida laboral](sa:document/${id})`;

  it('accepts a link to a document of the vault', async () => {
    const run = new FakeRun();
    run.documents = [
      { id: 'doc-1', name: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() },
    ];
    run.push(say('assistant', link('doc-1')));
    expect(await orchestratorLinksSavedDocument(run.view())).toBe(true);
  });

  it('refuses a link to an id the vault does not have', async () => {
    const run = new FakeRun();
    run.documents = [
      { id: 'doc-1', name: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() },
    ];
    run.push(say('assistant', link('invented')));
    expect(await orchestratorLinksSavedDocument(run.view())).toBe(false);
  });

  it('only reads the orchestrator, not the procedure agent', async () => {
    const run = new FakeRun();
    run.documents = [
      { id: 'doc-1', name: 'x.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() },
    ];
    run.push(say('procedure', link('doc-1')));
    expect(await orchestratorLinksSavedDocument(run.view())).toBe(false);
    expect(run.documentCalls).toBe(0);
  });

  it('refuses a message without a link', async () => {
    const run = new FakeRun();
    run.push(say('assistant', 'Ya está, mira en Mis datos.'));
    expect(await orchestratorLinksSavedDocument(run.view())).toBe(false);
  });
});
