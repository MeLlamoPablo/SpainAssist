import { ASSISTANT_AGENT_ID, type Prompt, type PromptItem } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { matchesPrompt } from '../../../src/answers/matcher';
import { promptTexts, toPendingPrompt } from '../../../src/run/app/prompts';

const item = (prompt: Prompt, procedureId?: string): PromptItem => ({
  id: 'q_0123456789abcdef',
  createdAt: '2026-10-16T10:00:00.000Z',
  type: 'prompt',
  ...(procedureId ? { procedureId } : {}),
  prompt,
  status: 'pending',
});

describe('toPendingPrompt', () => {
  it('tells which agent asked: the assistant, or a procedure by its id', () => {
    const prompt: Prompt = {
      kind: 'user_action',
      actionKind: 'captcha',
      title: 'Resuelve el captcha',
      message: 'Hazlo en la ventana.',
      showBrowser: true,
    };
    expect(toPendingPrompt(ASSISTANT_AGENT_ID, item(prompt))).toEqual({
      itemId: 'q_0123456789abcdef',
      agent: 'assistant',
      kind: 'user_action',
      title: 'Resuelve el captcha',
      message: 'Hazlo en la ventana.',
    });
    expect(toPendingPrompt('p_00000000000000aa', item(prompt, 'p_00000000000000aa'))).toMatchObject(
      {
        agent: 'procedure',
        procedureId: 'p_00000000000000aa',
      },
    );
  });

  it('keeps the fields of a form with their options, and flags a secret one', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'form',
        title: 'Datos',
        fields: [
          {
            key: 'metodo',
            label: 'Método',
            type: 'select',
            required: true,
            options: [
              { value: 'a', label: 'Cl@ve Permanente', address: 'ignored' },
              { value: 'b', label: 'Cl@ve Móvil' },
            ],
            help: 'ignored',
          },
          { key: 'otp', label: 'Código', type: 'secret', required: true, defaultValue: 'x' },
          { key: 'name', label: 'Nombre', type: 'text', required: false },
          {
            key: 'dni',
            label: 'DNI',
            type: 'text',
            required: true,
            vaultKey: 'dniNumber',
            defaultValue: '53918274H',
          },
          {
            key: 'otro',
            label: 'Otro método',
            type: 'text',
            required: true,
            visibleWhen: { field: 'metodo', values: ['b'] },
          },
        ],
        allowDismiss: false,
      }),
    );
    expect(pending.kind).toBe('form');
    expect(pending.message).toBeUndefined();
    expect(pending.fields).toEqual([
      {
        key: 'metodo',
        type: 'select',
        label: 'Método',
        options: [
          { value: 'a', label: 'Cl@ve Permanente' },
          { value: 'b', label: 'Cl@ve Móvil' },
        ],
        required: true,
      },
      // A secret field never carries a default: a prompt holds no secret value.
      { key: 'otp', type: 'secret', label: 'Código', secret: true, required: true },
      { key: 'name', type: 'text', label: 'Nombre', required: false },
      // What the UI's form logic reads: where the answer is saved, a prefill, what hides it.
      {
        key: 'dni',
        type: 'text',
        label: 'DNI',
        required: true,
        vaultKey: 'dniNumber',
        defaultValue: '53918274H',
      },
      {
        key: 'otro',
        type: 'text',
        label: 'Otro método',
        required: true,
        visibleWhen: { field: 'metodo', values: ['b'] },
      },
    ]);
    // What an answer matches on is there.
    expect(matchesPrompt({ kind: 'form', optionLabel: 'cl[@a]ve\\s*permanente' }, pending)).toBe(
      true,
    );
    expect(matchesPrompt({ fieldKeys: ['metodo', 'otp'] }, pending)).toBe(true);
  });

  it('puts what a confirmation shows to the user in its message, details included', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'confirm',
        confirmKind: 'action',
        title: 'Enviar datos',
        message: 'Voy a enviar tu DNI.',
        details: [
          { label: 'Destino', value: 'validacion-seguridad-social.com' },
          { label: 'Dato', value: 'DNI' },
        ],
      }),
    );
    expect(pending.message).toBe(
      'Voy a enviar tu DNI.\nDestino: validacion-seguridad-social.com\nDato: DNI',
    );
    expect(
      matchesPrompt({ kind: 'confirm', text: 'validacion-seguridad-social\\.com' }, pending),
    ).toBe(true);
  });

  it('names the credential a credential prompt asks for', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'credential',
        credential: 'clave_permanente',
        title: 'Añade tu Cl@ve',
        message: 'Para entrar.',
      }),
    );
    expect(pending).toMatchObject({ kind: 'credential', credentialKind: 'clave_permanente' });
    expect(matchesPrompt({ kind: 'credential', credentialKind: 'clave_permanente' }, pending)).toBe(
      true,
    );
  });

  it('describes a phone call by who, why and what to ask', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'phone_call',
        title: 'Llama a EMASESA',
        organization: 'EMASESA',
        phoneNumber: '900 101 010',
        purpose: 'Dar de alta el contrato',
        questions: ['¿Qué documentos necesito?'],
        haveAtHand: ['DNI'],
      }),
    );
    expect(pending.kind).toBe('phone_call');
    expect(pending.message).toBe(
      'EMASESA · 900 101 010\nDar de alta el contrato\n¿Qué documentos necesito?\nDNI',
    );
  });

  it('treats a DNIe signature (which a run never has) as a manual action', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'dnie_signature',
        purpose: 'login',
        title: 'Firma',
        message: 'Aprueba en el móvil.',
        stage: 'phone',
      }),
    );
    expect(pending.kind).toBe('user_action');
  });
});

describe('promptTexts', () => {
  it('lists every string of a prompt', () => {
    const pending = toPendingPrompt(
      'p_00000000000000aa',
      item({
        kind: 'form',
        title: 'Título',
        message: 'Mensaje',
        fields: [
          {
            key: 'k',
            label: 'Etiqueta',
            type: 'select',
            required: true,
            options: [{ value: 'v', label: 'Opción' }],
          },
        ],
        allowDismiss: false,
      }),
    );
    expect(promptTexts(pending)).toEqual(['Título', 'Mensaje', 'Etiqueta', 'Opción', 'v']);
  });
});
