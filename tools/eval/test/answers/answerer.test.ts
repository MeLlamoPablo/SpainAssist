import { describe, expect, it } from 'vitest';
import {
  buildAnswererMessages,
  extractJsonObject,
  parseAnswererReply,
} from '../../src/answers/answerer';
import type { PendingPrompt } from '../../src/contracts';

const PERSONA = 'You are Lucía Moreno Castillo, born 23 May 1991. You live in Málaga.';
const INSTRUCTIONS = 'I have Cl@ve Permanente; answer briefly in Spanish; do not invent data.';

const form: PendingPrompt = {
  itemId: 'i1',
  agent: 'procedure',
  procedureId: 'p_1',
  kind: 'form',
  title: 'Tus datos',
  message: 'Necesito algunos datos para seguir.',
  fields: [
    { key: 'nombre', type: 'text', label: 'Nombre completo' },
    { key: 'nacimiento', type: 'date', label: 'Fecha de nacimiento' },
    {
      key: 'metodo',
      type: 'select',
      label: 'Método',
      options: [
        { value: 'cp', label: 'Cl@ve Permanente' },
        { value: 'cm', label: 'Cl@ve Móvil' },
      ],
    },
    { key: 'pin', type: 'secret', label: 'PIN', secret: true },
  ],
};

describe('buildAnswererMessages', () => {
  it('builds a system message with the persona, instructions and rules, and a user message with the question', () => {
    const [system, user, ...rest] = buildAnswererMessages({
      persona: PERSONA,
      instructions: INSTRUCTIONS,
      prompt: form,
      dialogue: [
        { from: 'user', text: 'sácame la vida laboral' },
        { from: 'assistant', text: 'Voy a empezar el trámite.' },
      ],
    });
    expect(rest).toEqual([]);
    expect(system!.role).toBe('system');
    expect(system!.content).toContain(PERSONA);
    expect(system!.content).toContain(INSTRUCTIONS);
    expect(system!.content).toMatch(/Never invent data/);
    expect(system!.content).toMatch(/Never give passwords/);
    expect(user!.role).toBe('user');
    expect(user!.content).toContain('[you] sácame la vida laboral');
    expect(user!.content).toContain('[assistant] Voy a empezar el trámite.');
    expect(user!.content).toContain('Title: Tus datos');
    expect(user!.content).toContain('Message: Necesito algunos datos para seguir.');
    expect(user!.content).toContain('- nombre (text): "Nombre completo"');
    expect(user!.content).toContain('options: cp = "Cl@ve Permanente"; cm = "Cl@ve Móvil"');
    expect(user!.content).toContain('- pin (secret, skip this field)');
    expect(user!.content).toContain('asked by the procedure agent');
  });

  it('keeps the last turns, each cut to a bounded size', () => {
    const dialogue = Array.from({ length: 30 }, (_, i) => ({
      from: 'assistant' as const,
      text: `turn ${i} ${'x'.repeat(5000)}`,
    }));
    const [, user] = buildAnswererMessages({
      persona: PERSONA,
      instructions: INSTRUCTIONS,
      prompt: form,
      dialogue,
    });
    expect(user!.content).not.toContain('turn 17 ');
    expect(user!.content).toContain('turn 18 ');
    expect(user!.content).toContain('turn 29 ');
    expect(user!.content.length).toBeLessThan(12 * 1300 + 3000);
  });

  it('says so when there is no dialogue yet', () => {
    const [, user] = buildAnswererMessages({
      persona: PERSONA,
      instructions: INSTRUCTIONS,
      prompt: form,
    });
    expect(user!.content).toContain('(nothing yet)');
  });

  it('masks registered secrets in the dialogue and the prompt', () => {
    const [system, user] = buildAnswererMessages({
      persona: PERSONA,
      instructions: INSTRUCTIONS,
      prompt: { ...form, message: 'Tu clave es hunter2-secret' },
      dialogue: [{ from: 'procedure', text: 'He usado hunter2-secret para entrar' }],
      redact: ['hunter2-secret'],
    });
    expect(`${system!.content}\n${user!.content}`).not.toContain('hunter2-secret');
    expect(user!.content).toContain('He usado •••• para entrar');
  });

  it('refuses a persona or instructions that contain a registered secret', () => {
    expect(() =>
      buildAnswererMessages({
        persona: `${PERSONA} Su clave es hunter2-secret.`,
        instructions: INSTRUCTIONS,
        prompt: form,
        redact: ['hunter2-secret'],
      }),
    ).toThrow(/registered secret/);
    expect(() =>
      buildAnswererMessages({
        persona: PERSONA,
        instructions: 'say hunter2-secret',
        prompt: form,
        redact: ['hunter2-secret'],
      }),
    ).toThrow(/registered secret/);
  });

  it('adds the refused reply and the reasons when retrying', () => {
    const messages = buildAnswererMessages({
      persona: PERSONA,
      instructions: INSTRUCTIONS,
      prompt: form,
      retry: {
        reply: '{"values":{"metodo":"x"}}',
        issues: ['metodo: "x" is not one of the options'],
      },
    });
    expect(messages).toHaveLength(4);
    expect(messages[2]).toEqual({ role: 'assistant', content: '{"values":{"metodo":"x"}}' });
    expect(messages[3]!.role).toBe('user');
    expect(messages[3]!.content).toContain('is not one of the options');
  });

  it('only answers forms', () => {
    expect(() =>
      buildAnswererMessages({
        persona: PERSONA,
        instructions: INSTRUCTIONS,
        prompt: { itemId: 'c', agent: 'procedure', kind: 'credential', title: 'Cl@ve' },
      }),
    ).toThrow(/only answers forms/);
  });
});

describe('extractJsonObject', () => {
  it('finds the object in prose and code fences', () => {
    expect(extractJsonObject('Claro:\n```json\n{"a": 1}\n```\nListo')).toEqual({ a: 1 });
    expect(extractJsonObject('{"a":{"b":"}"}} trailing {x}')).toEqual({ a: { b: '}' } });
    expect(extractJsonObject('{"q": "he said \\"hi\\""}')).toEqual({ q: 'he said "hi"' });
  });

  it('skips a broken first candidate', () => {
    expect(extractJsonObject('{not json} {"ok": true}')).toEqual({ ok: true });
  });

  it('is undefined without an object', () => {
    expect(extractJsonObject('no json here')).toBeUndefined();
    expect(extractJsonObject('{"unclosed": ')).toBeUndefined();
  });
});

describe('parseAnswererReply', () => {
  it('accepts values for known fields, mapping labels and formats', () => {
    const reply = parseAnswererReply(
      '```json\n{"values": {"nombre": "Lucía Moreno Castillo", "nacimiento": "23/05/1991", "metodo": "Cl@ve Permanente"}, "dismiss": false}\n```',
      form,
    );
    expect(reply).toEqual({
      ok: true,
      dismiss: false,
      values: { nombre: 'Lucía Moreno Castillo', nacimiento: '1991-05-23', metodo: 'cp' },
      ignored: [],
    });
  });

  it('accepts a flat object of field values', () => {
    expect(parseAnswererReply('{"metodo": "cp"}', form)).toMatchObject({
      ok: true,
      dismiss: false,
      values: { metodo: 'cp' },
    });
  });

  it('drops secrets, documents and unknown keys without failing', () => {
    const reply = parseAnswererReply(
      '{"values": {"nombre": "Lucía", "pin": "1234", "extra": "x"}}',
      form,
    );
    expect(reply).toMatchObject({ ok: true, values: { nombre: 'Lucía' } });
    expect(reply.ok && reply.ignored.sort()).toEqual(['extra', 'pin']);
  });

  it('honours a dismissal', () => {
    expect(parseAnswererReply('{"values": {}, "dismiss": true}', form)).toEqual({
      ok: true,
      dismiss: true,
      values: {},
      ignored: [],
    });
  });

  it('treats an answer without usable values as a dismissal', () => {
    expect(parseAnswererReply('{"values": {"pin": "1234"}}', form)).toMatchObject({
      ok: true,
      dismiss: true,
      values: {},
    });
    expect(parseAnswererReply('{"values": {"nombre": ""}}', form)).toMatchObject({ dismiss: true });
  });

  it('refuses invalid values and lists why', () => {
    const reply = parseAnswererReply(
      '{"values": {"metodo": "certificado", "nacimiento": "ayer"}}',
      form,
    );
    expect(reply.ok).toBe(false);
    expect(!reply.ok && reply.issues).toHaveLength(2);
  });

  it('refuses replies that are not the expected object', () => {
    for (const text of [
      'Hola',
      '[1,2]',
      '{"foo": "bar"}',
      '{"values": "x"}',
      '{"dismiss": "yes"}',
      '',
    ]) {
      expect(parseAnswererReply(text, form).ok, text).toBe(false);
    }
  });
});
