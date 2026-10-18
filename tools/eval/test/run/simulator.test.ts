import '../llm/helpers/no-network';
import type { PromptResponse } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { AnswerGroup, Fixture, Observation, PendingPrompt } from '../../src/contracts';
import { AnswererError, type AnswererResult } from '../../src/llm';
import { createUserSimulator, ObservationLog, SimulatorError } from '../../src/run';
import { prompt } from '../rules/support/run';
import { fakeAnswerer } from './support/harness';

type SimFixture = Pick<Fixture, 'persona' | 'language' | 'answerGroups' | 'unexpectedPrompt'>;

const methods = (itemId = 'form-1'): PendingPrompt =>
  prompt({
    itemId,
    title: '¿Cómo quieres identificarte?',
    message: 'Elige un método',
    fields: [
      {
        key: 'metodo',
        type: 'select',
        label: 'Método',
        options: [
          { value: 'clave_permanente', label: 'Cl@ve Permanente' },
          { value: 'clave_movil', label: 'Cl@ve Móvil' },
        ],
      },
    ],
  });

const credentialPrompt = (itemId = 'cred-1'): PendingPrompt =>
  prompt({
    itemId,
    kind: 'credential',
    title: 'Añade tu Cl@ve',
    credentialKind: 'clave_permanente',
  });

const confirmPrompt = (itemId = 'conf-1', title = '¿Seguro?'): PendingPrompt =>
  prompt({ itemId, kind: 'confirm', title });

const userAction = (itemId = 'act-1'): PendingPrompt =>
  prompt({ itemId, kind: 'user_action', title: 'Resuelve el captcha' });

const dataForm = (itemId = 'form-2'): PendingPrompt =>
  prompt({
    itemId,
    title: 'Tus datos',
    fields: [
      { key: 'email', type: 'email', label: 'Correo' },
      { key: 'fecha', type: 'date', label: 'Fecha de nacimiento' },
      { key: 'acepto', type: 'boolean', label: 'Acepto' },
      { key: 'codigo', type: 'secret', label: 'Código', secret: true },
    ],
  });

const group = (id: string, ...answers: AnswerGroup['answers']): AnswerGroup => ({ id, answers });

function fixtureOf(overrides: Partial<SimFixture> = {}): SimFixture {
  return {
    persona: 'Eres Lucía.',
    language: 'es',
    answerGroups: [],
    unexpectedPrompt: 'dismiss',
    ...overrides,
  };
}

class SimApp {
  pending: PendingPrompt[] = [];
  readonly responses: { itemId: string; response: PromptResponse }[] = [];
  readonly claves: { username: string; password: string }[] = [];
  readonly order: string[] = [];
  gate: (() => Promise<void>) | undefined;
  error: ((itemId: string) => Error | undefined) | undefined;

  pendingPrompts = () => [...this.pending];

  respond = async (itemId: string, response: PromptResponse): Promise<void> => {
    this.order.push(`start:${itemId}`);
    await this.gate?.();
    const failure = this.error?.(itemId);
    if (failure) throw failure;
    this.pending = this.pending.filter((p) => p.itemId !== itemId);
    this.responses.push({ itemId, response });
    this.order.push(`end:${itemId}`);
  };

  addClave = async (input: { username: string; password: string }): Promise<string> => {
    this.order.push('addClave');
    this.claves.push(input);
    return `cred-${this.claves.length}`;
  };
}

function setup(
  fixture: Partial<SimFixture> = {},
  options: {
    answerer?: ReturnType<typeof fakeAnswerer>;
    start?: boolean;
    delayMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    state?: { unlockedGroup: number; used: string[] };
  } = {},
) {
  const log = new ObservationLog();
  const app = new SimApp();
  const fatal: Error[] = [];
  const unexpected: { prompt: PendingPrompt; reason: string }[] = [];
  const secrets: string[] = [];
  const answerer = options.answerer;
  const sim = createUserSimulator({
    fixture: fixtureOf(fixture),
    app,
    log,
    ...(options.state ? { state: options.state } : {}),
    ...(answerer ? { answerer: () => answerer({} as never) } : {}),
    secrets: (value) => {
      app.order.push('secret');
      secrets.push(value);
    },
    scrub: (text) => text.replaceAll('hunter2-secret', '[redacted]'),
    onUnexpected: (p, reason) => unexpected.push({ prompt: p, reason }),
    onFatal: (error) => fatal.push(error),
    ...(options.delayMs ? { delayMs: options.delayMs } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  if (options.start !== false) sim.start();
  const show = (p: PendingPrompt) => {
    app.pending.push(p);
    log.push({ type: 'prompt_shown', prompt: p });
  };
  const answered = () =>
    log
      .all()
      .filter(
        (o): o is Extract<Observation, { type: 'prompt_answered' }> => o.type === 'prompt_answered',
      );
  const notes = () => log.all().flatMap((o) => (o.type === 'note' ? [o.text] : []));
  return { log, app, sim, fatal, unexpected, secrets, show, answered, notes };
}

describe('structured answers', () => {
  const select: AnswerGroup = group('method', {
    id: 'choose-clave',
    match: { kind: 'form', optionLabel: 'cl[@a]ve\\s*permanente' },
    action: { type: 'select', optionLabel: 'cl[@a]ve\\s*permanente' },
  });

  it('picks the option whose label matches and answers as the UI would', async () => {
    const t = setup({ answerGroups: [select] });
    t.show(methods());
    await t.sim.settled();
    expect(t.app.responses).toEqual([
      {
        itemId: 'form-1',
        response: {
          kind: 'form',
          values: { metodo: 'clave_permanente' },
          dismissed: false,
          savedToVault: [],
        },
      },
    ]);
    expect(t.answered()).toMatchObject([
      { itemId: 'form-1', answerId: 'choose-clave', by: 'structured' },
    ]);
    expect(t.sim.state()).toEqual({ unlockedGroup: 0, used: ['choose-clave'] });
    expect(t.fatal).toEqual([]);
  });

  it('submits what the form shows for the fields the answer does not set', async () => {
    const t = setup({
      answerGroups: [
        group('data', {
          id: 'data',
          match: { kind: 'form', fieldKeys: ['email'] },
          action: { type: 'values', values: { email: 'lucia@example.com', fecha: '23/05/1991' } },
        }),
      ],
    });
    t.show(dataForm());
    await t.sim.settled();
    expect(t.app.responses[0]!.response).toEqual({
      kind: 'form',
      values: { email: 'lucia@example.com', fecha: '1991-05-23', acepto: false },
      dismissed: false,
      savedToVault: [],
    });
  });

  describe('answers the way the UI would: what the form says of its fields counts', () => {
    // A form of the real procedure: the agent asks for the DNI and wants it kept in the user's data.
    const dniForm = (itemId = 'form-dni'): PendingPrompt =>
      prompt({
        itemId,
        title: 'Tu DNI',
        fields: [
          { key: 'dni', type: 'text', label: 'DNI', required: true, vaultKey: 'dniNumber' },
          { key: 'nota', type: 'text', label: 'Nota', required: false },
          { key: 'codigo', type: 'secret', label: 'Código', secret: true, vaultKey: 'otp' },
        ],
      });

    it("saves a field with a vaultKey to the user's data, as the form of the UI does", async () => {
      const t = setup({
        answerGroups: [
          group('data', {
            id: 'dni',
            match: { kind: 'form', fieldKeys: ['dni'] },
            action: { type: 'values', values: { dni: '53918274H', nota: 'hola' } },
          }),
        ],
      });
      t.show(dniForm());
      await t.sim.settled();
      expect(t.app.responses[0]!.response).toEqual({
        kind: 'form',
        values: { dni: '53918274H', nota: 'hola' },
        dismissed: false,
        // The key of the field in the answer: the app stores it under the field's vaultKey. Never a
        // secret, and never a field the answer left empty.
        savedToVault: ['dni'],
      });
    });

    it('saves what the answerer said for such a field too', async () => {
      const answerer = fakeAnswerer([
        () => ({ type: 'values', values: { dni: '53918274H' }, skipped: [] }),
      ]);
      const t = setup({ answerGroups: [], unexpectedPrompt: 'answerer' }, { answerer });
      t.show(dniForm());
      await t.sim.settled();
      expect(t.app.responses[0]!.response).toMatchObject({
        values: { dni: '53918274H' },
        savedToVault: ['dni'],
      });
    });

    it('prefills the default of a field and leaves out a field that its select hides', async () => {
      const form = prompt({
        itemId: 'form-visible',
        title: 'Método',
        fields: [
          {
            key: 'metodo',
            type: 'select',
            label: 'Método',
            required: true,
            options: [
              { value: 'a', label: 'Cl@ve Permanente' },
              { value: 'b', label: 'Cl@ve Móvil' },
            ],
          },
          {
            key: 'telefono',
            type: 'text',
            label: 'Teléfono',
            required: true,
            visibleWhen: { field: 'metodo', values: ['b'] },
            vaultKey: 'phone',
          },
          { key: 'pais', type: 'text', label: 'País', required: false, defaultValue: 'España' },
        ],
      });
      const t = setup({
        answerGroups: [
          group('data', {
            id: 'choose',
            match: { kind: 'form', optionLabel: 'permanente' },
            action: { type: 'values', values: { metodo: 'a', telefono: '600000000' } },
          }),
        ],
      });
      t.show(form);
      await t.sim.settled();
      expect(t.app.responses[0]!.response).toEqual({
        kind: 'form',
        // The phone belongs to the other method: hidden, so neither answered nor saved.
        values: { metodo: 'a', pais: 'España' },
        dismissed: false,
        savedToVault: [],
      });
    });
  });

  it('never fills a secret field and says which keys the form does not have', async () => {
    const t = setup({
      answerGroups: [
        group('data', {
          id: 'data',
          match: { kind: 'form', fieldKeys: ['email'] },
          action: {
            type: 'values',
            values: { email: 'lucia@example.com', nada: 'x', codigo: '123456' },
          },
        }),
      ],
    });
    t.show(dataForm());
    await t.sim.settled();
    const response = t.app.responses[0]!.response;
    expect(response).toMatchObject({ values: { email: 'lucia@example.com' } });
    expect(JSON.stringify(response)).not.toContain('123456');
    expect(t.notes().join('\n')).toMatch(/ignored fields.*nada, codigo/);
  });

  it('an invalid structured answer is a fixture bug: the run must end as an error naming the fields', async () => {
    const t = setup({
      answerGroups: [
        group('data', {
          id: 'bad-date',
          match: { kind: 'form', fieldKeys: ['email'] },
          action: { type: 'values', values: { email: 'no-es-un-correo', fecha: 'ayer' } },
        }),
      ],
    });
    t.show(dataForm());
    await t.sim.settled();
    expect(t.app.responses).toEqual([]);
    expect(t.fatal).toHaveLength(1);
    const [error] = t.fatal;
    expect(error).toBeInstanceOf(SimulatorError);
    expect((error as SimulatorError).code).toBe('invalid_answer');
    expect(error!.message).toContain('bad-date');
    expect(error!.message).toContain('email');
    expect(error!.message).toContain('fecha');
  });

  it('a select that names no option of the form is a fixture bug too', async () => {
    const t = setup({
      answerGroups: [
        group('m', {
          id: 'wrong-label',
          match: { kind: 'form' },
          action: { type: 'select', optionLabel: 'certificado' },
        }),
      ],
    });
    t.show(methods());
    await t.sim.settled();
    expect(t.fatal[0]?.message).toMatch(/wrong-label.*no option matches \/certificado\//s);
    expect(t.app.responses).toEqual([]);
  });

  describe('typed answers', () => {
    const typed = (id = 'type-code'): AnswerGroup =>
      group('code', {
        id,
        match: { kind: 'form' },
        action: { type: 'typed', value: 'SPAIN' },
      });
    // What `browser_fill_from_user` asks: one secret field, `value`.
    const fillFromUser = (itemId = 'form-fill'): PendingPrompt =>
      prompt({
        itemId,
        title: 'Escribe el código de seguridad',
        fields: [{ key: 'value', type: 'secret', label: 'Código de seguridad', secret: true }],
      });

    it("fills the form's secret field, as browser_fill_from_user asks", async () => {
      const t = setup({ answerGroups: [typed()] });
      t.show(fillFromUser());
      await t.sim.settled();
      expect(t.fatal).toEqual([]);
      expect(t.app.responses[0]).toMatchObject({
        itemId: 'form-fill',
        response: { kind: 'form', values: { value: 'SPAIN' }, dismissed: false },
      });
      expect(t.answered()).toMatchObject([
        { itemId: 'form-fill', answerId: 'type-code', by: 'structured' },
      ]);
    });

    it('fills the secret field of a form that has other fields too', async () => {
      const t = setup({ answerGroups: [typed()] });
      t.show(dataForm());
      await t.sim.settled();
      expect(t.fatal).toEqual([]);
      expect(t.app.responses[0]!.response).toMatchObject({
        kind: 'form',
        values: { codigo: 'SPAIN' },
      });
    });

    it('fills the only text field of a form without a secret one', async () => {
      const t = setup({ answerGroups: [typed()] });
      t.show(
        prompt({
          itemId: 'form-text',
          title: 'Caracteres de la imagen',
          fields: [
            { key: 'captcha', type: 'text', label: 'Caracteres' },
            { key: 'acepto', type: 'boolean', label: 'Acepto' },
          ],
        }),
      );
      await t.sim.settled();
      expect(t.fatal).toEqual([]);
      expect(t.app.responses[0]!.response).toMatchObject({
        kind: 'form',
        values: { captcha: 'SPAIN' },
      });
    });

    it.each([
      ['no text field', [{ key: 'acepto', type: 'boolean', label: 'Acepto' }]],
      [
        'two text fields',
        [
          { key: 'a', type: 'text', label: 'A' },
          { key: 'b', type: 'text', label: 'B' },
        ],
      ],
    ] as const)('is a fixture bug on a form with %s and no secret field', async (_name, fields) => {
      const t = setup({ answerGroups: [typed('bad-typed')] });
      t.show(prompt({ itemId: 'form-x', title: 'Datos', fields: fields.map((f) => ({ ...f })) }));
      await t.sim.settled();
      expect(t.app.responses).toEqual([]);
      expect(t.fatal).toHaveLength(1);
      expect(t.fatal[0]).toBeInstanceOf(SimulatorError);
      expect((t.fatal[0] as SimulatorError).code).toBe('invalid_answer');
      expect(t.fatal[0]!.message).toMatch(
        /bad-typed.*no secret field and not exactly one text field/s,
      );
    });
  });

  it('creates the credential first, registers the password as a secret and answers with the id', async () => {
    const t = setup({
      answerGroups: [
        group('cred', {
          id: 'clave',
          match: { kind: 'credential', credentialKind: 'clave_permanente' },
          action: { type: 'credential', username: '53918274H', password: 'hunter2-secret' },
        }),
      ],
    });
    t.show(credentialPrompt());
    await t.sim.settled();
    expect(t.app.claves).toEqual([{ username: '53918274H', password: 'hunter2-secret' }]);
    expect(t.secrets).toEqual(['hunter2-secret']);
    expect(t.app.order.slice(0, 2)).toEqual(['secret', 'addClave']);
    expect(t.app.responses[0]!.response).toEqual({ kind: 'credential', credentialId: 'cred-1' });
    expect(t.answered()[0]).toMatchObject({ answerId: 'clave', by: 'structured' });
    expect(JSON.stringify(t.log.all())).not.toContain('hunter2-secret');
  });

  it('answers confirmations and user actions', async () => {
    const t = setup({
      answerGroups: [
        group(
          'g',
          {
            id: 'no',
            match: { kind: 'confirm', text: 'peligro' },
            action: { type: 'confirm', approved: false },
          },
          { id: 'yes', match: { kind: 'confirm' }, action: { type: 'confirm', approved: true } },
          {
            id: 'act',
            match: { kind: 'user_action' },
            action: { type: 'user_action', done: true, note: 'hecho' },
          },
        ),
      ],
    });
    t.show(confirmPrompt('c1', 'Esto es un peligro'));
    t.show(confirmPrompt('c2'));
    t.show(userAction());
    await t.sim.settled();
    expect(t.app.responses.map((r) => r.response)).toEqual([
      { kind: 'confirm', approved: false },
      { kind: 'confirm', approved: true },
      { kind: 'user_action', done: true, note: 'hecho' },
    ]);
  });
});

describe('order', () => {
  it('answers prompts one at a time, in the order they appeared, even when they arrive while one is being answered', async () => {
    const t = setup({ unexpectedPrompt: 'dismiss' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.app.gate = () => gate;
    t.show(confirmPrompt('c1'));
    await new Promise((r) => setTimeout(r, 5));
    t.show(confirmPrompt('c2'));
    t.show(confirmPrompt('c3'));
    await new Promise((r) => setTimeout(r, 5));
    // c1 is in the app's hands; the others wait their turn.
    expect(t.app.order).toEqual(['start:c1']);
    release();
    await t.sim.settled();
    expect(t.app.order).toEqual(['start:c1', 'end:c1', 'start:c2', 'end:c2', 'start:c3', 'end:c3']);
    expect(t.answered().map((a) => a.itemId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('opens answer groups in order: a later group does not answer until the earlier one is used', async () => {
    const t = setup({
      unexpectedPrompt: 'dismiss',
      answerGroups: [
        group('first', {
          id: 'confirm-first',
          match: { kind: 'confirm' },
          action: { type: 'confirm', approved: true },
        }),
        group('second', {
          id: 'act-second',
          match: { kind: 'user_action' },
          action: { type: 'user_action', done: true },
        }),
      ],
    });
    t.show(userAction('early'));
    t.show(confirmPrompt('c1'));
    t.show(userAction('late'));
    await t.sim.settled();
    expect(t.answered()).toMatchObject([
      { itemId: 'early', by: 'default' },
      { itemId: 'c1', answerId: 'confirm-first', by: 'structured' },
      { itemId: 'late', answerId: 'act-second', by: 'structured' },
    ]);
    expect(t.app.responses[0]!.response).toEqual({
      kind: 'user_action',
      done: false,
      note: 'No puedo hacer eso.',
    });
  });

  it('answers the prompts that are already pending when it starts, once', async () => {
    const t = setup({ unexpectedPrompt: 'dismiss' }, { start: false });
    t.app.pending.push(confirmPrompt('restored'));
    t.sim.start();
    await t.sim.settled();
    expect(t.app.responses.map((r) => r.itemId)).toEqual(['restored']);
    // The same prompt announced later is not answered twice.
    t.log.push({ type: 'prompt_shown', prompt: confirmPrompt('restored') });
    await t.sim.settled();
    expect(t.app.responses).toHaveLength(1);
  });

  it('starts from the answer cursor of a checkpoint', async () => {
    const answerGroups = [
      group('one', {
        id: 'only',
        match: { kind: 'credential' },
        action: { type: 'credential', username: '53918274H', password: 'hunter2-secret' },
      }),
    ];
    const fresh = setup({ answerGroups });
    fresh.show(credentialPrompt('a'));
    await fresh.sim.settled();
    const snapshot = fresh.sim.state();

    const resumed = setup({ answerGroups }, { state: snapshot });
    resumed.show(credentialPrompt('b'));
    await resumed.sim.settled();
    // The scripted answer was already used: the second request gets the policy's default.
    expect(resumed.app.claves).toEqual([]);
    expect(resumed.answered()[0]).toMatchObject({ by: 'default' });
    expect(resumed.app.responses[0]!.response).toEqual({ kind: 'credential' });
  });

  it('settled() resolves at once when nothing is queued', async () => {
    const t = setup();
    await expect(t.sim.settled()).resolves.toBeUndefined();
  });
});

describe('prompts nobody scripted', () => {
  it("'answerer' lets the answerer improvise a form and approves a confirmation", async () => {
    const answerer = fakeAnswerer([
      () => ({
        type: 'values',
        values: { email: 'lucia@example.com' },
        skipped: ['fecha', 'acepto'],
      }),
    ]);
    const t = setup({ unexpectedPrompt: 'answerer' }, { answerer });
    t.show(dataForm());
    t.show(confirmPrompt());
    await t.sim.settled();
    expect(t.answered()).toMatchObject([
      { itemId: 'form-2', by: 'answerer' },
      { itemId: 'conf-1', by: 'default' },
    ]);
    expect(t.answered()[0]!.answerId).toBeUndefined();
    expect(t.app.responses[0]!.response).toEqual({
      kind: 'form',
      values: { email: 'lucia@example.com', acepto: false },
      dismissed: false,
      savedToVault: [],
    });
    expect(t.app.responses[1]!.response).toEqual({ kind: 'confirm', approved: true });
    expect(answerer.state.requests).toHaveLength(1);
    expect(answerer.state.requests[0]).toMatchObject({
      persona: 'Eres Lucía.',
      language: 'es',
      prompt: { kind: 'form', title: 'Tus datos' },
    });
  });

  it("'dismiss' declines everything and never needs the answerer", async () => {
    const answerer = fakeAnswerer();
    const t = setup({ unexpectedPrompt: 'dismiss' }, { answerer });
    t.show(dataForm());
    t.show(confirmPrompt());
    t.show(credentialPrompt());
    t.show(userAction());
    t.show(prompt({ itemId: 'call', kind: 'phone_call', title: 'Llama' }));
    await t.sim.settled();
    expect(t.app.responses.map((r) => r.response)).toEqual([
      { kind: 'form', dismissed: true, savedToVault: [] },
      { kind: 'confirm', approved: false },
      { kind: 'credential' },
      { kind: 'user_action', done: false, note: 'No puedo hacer eso.' },
      { kind: 'phone_call', outcome: 'skipped' },
    ]);
    expect(t.answered().every((a) => a.by === 'default')).toBe(true);
    expect(answerer.state.created).toBe(0);
  });

  it("'fail' reports the prompt, leaves it unanswered and stops answering", async () => {
    const t = setup({ unexpectedPrompt: 'fail' });
    t.show(confirmPrompt('c1'));
    t.show(confirmPrompt('c2'));
    await t.sim.settled();
    expect(t.unexpected).toHaveLength(1);
    expect(t.unexpected[0]!.prompt.itemId).toBe('c1');
    expect(t.unexpected[0]!.reason).toContain('unexpected prompt');
    expect(t.app.responses).toEqual([]);
    expect(t.app.pending.map((p) => p.itemId)).toEqual(['c1', 'c2']);
    expect(t.fatal).toEqual([]);
  });
});

const freeformGroup = (id = 'ask'): AnswerGroup =>
  group('g', {
    id,
    match: { kind: 'form', fieldKeys: ['email'] },
    action: { type: 'freeform', instructions: 'Da tu correo.' },
  });

describe('freeform answers and the answerer', () => {
  const freeform = freeformGroup;

  it('is created the first time it is needed, once, and never when nothing needs it', async () => {
    const answerer = fakeAnswerer([
      () => ({ type: 'values', values: { email: 'a@example.com' }, skipped: [] }),
      () => ({ type: 'values', values: { email: 'b@example.com' }, skipped: [] }),
    ]);
    const idle = setup({ answerGroups: [freeform()] }, { answerer });
    idle.show(confirmPrompt());
    await idle.sim.settled();
    expect(answerer.state.created).toBe(0);

    idle.show(dataForm('f1'));
    await idle.sim.settled();
    expect(answerer.state.created).toBe(1);
    expect(answerer.state.requests[0]).toMatchObject({ instructions: 'Da tu correo.' });
    // The second form is unscripted (the only answer is used) and dismissed by policy, so the
    // answerer is not asked again.
    idle.show(dataForm('f2'));
    await idle.sim.settled();
    expect(answerer.state.created).toBe(1);
    expect(idle.answered()[1]).toMatchObject({ itemId: 'f1', answerId: 'ask', by: 'answerer' });
  });

  it('shows the answerer the conversation so far, without secrets', async () => {
    const answerer = fakeAnswerer([
      () => ({ type: 'values', values: { email: 'a@example.com' }, skipped: [] }),
    ]);
    const t = setup({ answerGroups: [freeform()] }, { answerer });
    t.log.push({ type: 'user_message', text: 'sácame la vida laboral' });
    t.log.push({
      type: 'assistant_message',
      agent: 'assistant',
      text: 'Tu clave es hunter2-secret, ¿vale?',
    });
    t.show(dataForm());
    await t.sim.settled();
    const request = answerer.state.requests[0]!;
    expect(request.conversation).toEqual([
      { from: 'user', text: 'sácame la vida laboral' },
      { from: 'agent', text: 'Tu clave es [redacted], ¿vale?' },
    ]);
  });

  it('knows what was said before it started, when told (a resumed run)', async () => {
    const answerer = fakeAnswerer([
      () => ({ type: 'values', values: { email: 'a@example.com' }, skipped: [] }),
    ]);
    const log = new ObservationLog();
    const app = new SimApp();
    const history: Observation[] = [
      { seq: 1, t: 't', type: 'user_message', text: 'sácame la vida laboral' },
      { seq: 2, t: 't', type: 'assistant_message', agent: 'assistant', text: 'Voy a ello.' },
      // A prompt that was already answered before: it is not asked again.
      { seq: 3, t: 't', type: 'prompt_shown', prompt: confirmPrompt('old') },
    ];
    const sim = createUserSimulator({
      fixture: fixtureOf({ answerGroups: [freeformGroup()] }),
      app,
      log,
      history,
      answerer: () => answerer({} as never),
      secrets: () => {},
      onUnexpected: () => {},
      onFatal: () => {},
    });
    sim.start();
    app.pending.push(dataForm());
    log.push({ type: 'prompt_shown', prompt: dataForm() });
    await sim.settled();
    expect(app.responses.map((r) => r.itemId)).toEqual(['form-2']);
    expect(answerer.state.requests[0]!.conversation).toEqual([
      { from: 'user', text: 'sácame la vida laboral' },
      { from: 'agent', text: 'Voy a ello.' },
    ]);
  });

  it('dismisses a form whose answer has no usable values and drops invalid ones', async () => {
    const replies: AnswererResult[] = [
      { type: 'values', values: {}, skipped: ['email'] },
      { type: 'values', values: { email: 'no-correo', fecha: '1991-05-23' }, skipped: [] },
    ];
    const answerer = fakeAnswerer(replies.map((reply) => () => reply));
    const t = setup(
      {
        answerGroups: [
          group(
            'g',
            {
              id: 'a',
              match: { kind: 'form', fieldKeys: ['email'] },
              action: { type: 'freeform', instructions: 'x' },
            },
            {
              id: 'b',
              match: { kind: 'form', fieldKeys: ['email'] },
              action: { type: 'freeform', instructions: 'y' },
            },
          ),
        ],
      },
      { answerer },
    );
    t.show(dataForm('f1'));
    t.show(dataForm('f2'));
    await t.sim.settled();
    expect(t.app.responses[0]!.response).toEqual({
      kind: 'form',
      dismissed: true,
      savedToVault: [],
    });
    expect(t.app.responses[1]!.response).toMatchObject({
      values: { fecha: '1991-05-23', acepto: false },
      dismissed: false,
    });
    expect(t.notes().join('\n')).toMatch(/dropped.*email/);
  });

  it('cannot answer a prompt that is not a form: it is an unexpected prompt', async () => {
    const answerer = fakeAnswerer();
    const t = setup(
      {
        answerGroups: [
          group('g', {
            id: 'chatty',
            match: { kind: 'confirm' },
            action: { type: 'freeform', instructions: 'responde' },
          }),
        ],
      },
      { answerer },
    );
    t.show(confirmPrompt());
    await t.sim.settled();
    expect(t.unexpected).toHaveLength(1);
    expect(t.unexpected[0]!.reason).toMatch(/only answers forms, not confirm/);
    expect(answerer.state.created).toBe(0);
  });

  it('an exhausted budget or a replay miss reaches the run as such', async () => {
    for (const code of ['budget', 'replay_miss'] as const) {
      const answerer = fakeAnswerer([
        () => {
          throw new AnswererError(code, `${code} says no`);
        },
      ]);
      const t = setup({ answerGroups: [freeform()] }, { answerer });
      t.show(dataForm());
      await t.sim.settled();
      expect(t.fatal).toHaveLength(1);
      expect(t.fatal[0]).toBeInstanceOf(AnswererError);
      expect((t.fatal[0] as AnswererError).code).toBe(code);
      expect(t.app.responses).toEqual([]);
    }
  });

  it('dismisses the form when the answerer could not produce valid output, but a model error is fatal', async () => {
    const invalid = fakeAnswerer([
      () => {
        throw new AnswererError('invalid_output', 'no JSON');
      },
    ]);
    const a = setup({ answerGroups: [freeform()] }, { answerer: invalid });
    a.show(dataForm());
    await a.sim.settled();
    expect(a.fatal).toEqual([]);
    expect(a.app.responses[0]!.response).toEqual({
      kind: 'form',
      dismissed: true,
      savedToVault: [],
    });
    expect(a.answered()[0]).toMatchObject({ by: 'answerer', answerId: 'ask' });
    expect(a.notes().join('\n')).toMatch(/no valid answer/);

    const broken = fakeAnswerer([
      () => {
        throw new AnswererError('model_error', 'gateway down');
      },
    ]);
    const b = setup({ answerGroups: [freeform()] }, { answerer: broken });
    b.show(dataForm());
    await b.sim.settled();
    expect(b.fatal[0]?.message).toBe('gateway down');
  });

  it('needs an answerer to improvise: without one it is a fixture problem', async () => {
    const t = setup({ unexpectedPrompt: 'answerer' });
    t.show(dataForm());
    await t.sim.settled();
    expect(t.fatal[0]).toBeInstanceOf(SimulatorError);
    expect(t.fatal[0]!.message).toMatch(/needs the answerer model/);
  });
});

describe('failures of the app', () => {
  it('skips a prompt that is no longer pending when the answer arrives, and goes on', async () => {
    const t = setup({ unexpectedPrompt: 'dismiss' });
    t.app.error = (itemId) => {
      if (itemId !== 'gone') return undefined;
      t.app.pending = t.app.pending.filter((p) => p.itemId !== 'gone');
      return new Error('The prompt was cancelled');
    };
    t.show(confirmPrompt('gone'));
    t.show(confirmPrompt('next'));
    await t.sim.settled();
    expect(t.fatal).toEqual([]);
    expect(t.app.responses.map((r) => r.itemId)).toEqual(['next']);
    expect(t.notes().join('\n')).toMatch(/gone was no longer pending.*cancelled/);
  });

  it('ends the run when the app refuses an answer for a prompt that is still pending', async () => {
    const t = setup({ unexpectedPrompt: 'dismiss' });
    t.app.error = () => new Error('bad request');
    t.show(confirmPrompt('stuck'));
    t.show(confirmPrompt('later'));
    await t.sim.settled();
    expect(t.fatal).toHaveLength(1);
    expect((t.fatal[0] as SimulatorError).code).toBe('respond_failed');
    expect(t.fatal[0]!.message).toContain('bad request');
    // After a fatal error nothing more is answered.
    expect(t.app.order).toEqual(['start:stuck']);
  });
});

describe('pacing and stopping', () => {
  it('waits the configured pause before each answer', async () => {
    const pauses: number[] = [];
    const t = setup(
      { unexpectedPrompt: 'dismiss' },
      {
        delayMs: 40,
        sleep: async (ms) => {
          pauses.push(ms);
        },
      },
    );
    t.show(confirmPrompt('a'));
    t.show(confirmPrompt('b'));
    await t.sim.settled();
    expect(pauses).toEqual([40, 40]);
  });

  it('stop() abandons the pause and answers nothing afterwards', async () => {
    let aborted = false;
    const t = setup(
      { unexpectedPrompt: 'dismiss' },
      {
        delayMs: 1000,
        sleep: (_ms, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
          }),
      },
    );
    t.show(confirmPrompt('a'));
    await new Promise((r) => setTimeout(r, 5));
    await t.sim.stop();
    await t.sim.settled();
    expect(aborted).toBe(true);
    t.show(confirmPrompt('b'));
    await new Promise((r) => setTimeout(r, 5));
    expect(t.app.responses).toEqual([]);
    expect(t.answered()).toEqual([]);
  });

  it('lists the required answers it never needed', async () => {
    const t = setup({
      answerGroups: [
        group('g', {
          id: 'never',
          match: { kind: 'confirm' },
          action: { type: 'confirm', approved: true },
        }),
      ],
    });
    expect(t.sim.unusedRequired()).toEqual(['never']);
  });
});
