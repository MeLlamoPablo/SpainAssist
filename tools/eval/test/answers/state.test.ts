import { describe, expect, it } from 'vitest';
import {
  AnswerState,
  answerSource,
  DEFAULT_IMPROVISE_INSTRUCTIONS,
  decideUnmatched,
  defaultResponse,
  redactAction,
} from '../../src/answers/state';
import type { Answer, AnswerGroup, PendingPrompt } from '../../src/contracts';

const form = (overrides: Partial<PendingPrompt> = {}): PendingPrompt => ({
  itemId: 'f1',
  agent: 'procedure',
  kind: 'form',
  title: 'Pregunta',
  ...overrides,
});

const methods = form({
  title: '¿Cómo te identificas?',
  fields: [
    {
      key: 'metodo',
      type: 'select',
      label: 'Método',
      options: [
        { value: 'cp', label: 'Cl@ve Permanente' },
        { value: 'cm', label: 'Cl@ve Móvil' },
      ],
    },
  ],
});

const credentialRequest: PendingPrompt = {
  itemId: 'c1',
  agent: 'procedure',
  kind: 'credential',
  title: 'Cl@ve',
  credentialKind: 'clave_permanente',
};

const chooseClave: Answer = {
  id: 'choose-clave',
  optional: true,
  match: { kind: 'form', optionLabel: 'cl@ve permanente' },
  action: { type: 'select', optionLabel: 'cl@ve permanente' },
};
const credential: Answer = {
  id: 'credential',
  match: { kind: 'credential', credentialKind: 'clave_permanente' },
  action: { type: 'credential', username: '53918274H', password: 'secret-pass' },
};
const freeform: Answer = {
  id: 'freeform',
  match: { kind: 'form' },
  action: { type: 'freeform', instructions: 'Answer briefly' },
};

const script: AnswerGroup[] = [
  { id: 'methods', answers: [chooseClave] },
  { id: 'credential', answers: [credential] },
];

describe('AnswerState', () => {
  it('a repeatable answer can be used again and again, and still counts as used', () => {
    const refuse: Answer = {
      id: 'refuse',
      optional: true,
      repeatable: true,
      match: { kind: 'confirm', text: 'peligro' },
      action: { type: 'confirm', approved: false },
    };
    const state = new AnswerState([{ id: 'g', answers: [refuse] }]);
    const confirm = (itemId: string): PendingPrompt => ({
      itemId,
      agent: 'procedure',
      kind: 'confirm',
      title: 'peligro',
    });
    for (let i = 0; i < 3; i++) expect(state.claim(confirm(`c${i}`))?.id).toBe('refuse');
    expect(state.isUsed('refuse')).toBe(true);
    expect(state.snapshot()).toEqual({ unlockedGroup: 0, used: ['refuse'] });
    // A restored cursor keeps answering it.
    const restored = new AnswerState([{ id: 'g', answers: [refuse] }], state.snapshot());
    expect(restored.claim(confirm('later'))?.id).toBe('refuse');
  });

  it('an answer that is not repeatable is used once', () => {
    const once: Answer = {
      id: 'once',
      match: { kind: 'confirm' },
      action: { type: 'confirm', approved: false },
    };
    const state = new AnswerState([{ id: 'g', answers: [once] }]);
    const confirm = (itemId: string): PendingPrompt => ({
      itemId,
      agent: 'procedure',
      kind: 'confirm',
      title: 'x',
    });
    expect(state.claim(confirm('a'))?.id).toBe('once');
    expect(state.claim(confirm('b'))).toBeUndefined();
  });

  it('unlocks the next group when the non-optional answers are used', () => {
    const groups: AnswerGroup[] = [
      {
        id: 'g1',
        answers: [
          { ...freeform, id: 'a' },
          { ...freeform, id: 'b', optional: true },
        ],
      },
      { id: 'g2', answers: [{ ...credential, id: 'c' }] },
    ];
    const state = new AnswerState(groups);
    expect(state.unlockedGroup).toBe(0);
    expect(state.answerable().map((a) => a.id)).toEqual(['a', 'b']);
    expect(state.claim(form())?.id).toBe('a');
    expect(state.unlockedGroup).toBe(1);
    expect(state.answerable().map((a) => a.id)).toEqual(['b', 'c']);
  });

  it('uses answers of a group in any order', () => {
    const groups: AnswerGroup[] = [
      {
        id: 'g1',
        answers: [
          {
            id: 'a',
            match: { kind: 'form', text: 'primera' },
            action: { type: 'confirm', approved: true },
          },
          {
            id: 'b',
            match: { kind: 'form', text: 'segunda' },
            action: { type: 'confirm', approved: true },
          },
        ],
      },
      { id: 'g2', answers: [{ ...credential, id: 'c' }] },
    ];
    const state = new AnswerState(groups);
    expect(state.claim(form({ title: 'La segunda' }))?.id).toBe('b');
    expect(state.unlockedGroup).toBe(0);
    expect(state.claim(credentialRequest)).toBeUndefined(); // group 2 still locked
    expect(state.claim(form({ title: 'La primera' }))?.id).toBe('a');
    expect(state.unlockedGroup).toBe(1);
    expect(state.claim(credentialRequest)?.id).toBe('c');
  });

  it('uses each answer once', () => {
    const state = new AnswerState(script);
    expect(state.claim(credentialRequest)?.id).toBe('credential');
    expect(state.claim(credentialRequest)).toBeUndefined();
    expect(state.isUsed('credential')).toBe(true);
  });

  it('select does not use the answer', () => {
    const state = new AnswerState(script);
    expect(state.select(methods)?.id).toBe('choose-clave');
    expect(state.select(methods)?.id).toBe('choose-clave');
    expect(state.isUsed('choose-clave')).toBe(false);
  });

  it('keeps optional answers answerable next to an unlocked later group', () => {
    // Group 2 is unlocked from the start (group 1 has nothing required), and the methods
    // question may still come first.
    const state = new AnswerState(script);
    expect(state.unlockedGroup).toBe(1);
    expect(state.claim(methods)?.id).toBe('choose-clave');
    expect(state.claim(credentialRequest)?.id).toBe('credential');
  });

  it('lets a later group be answered first and then retires the optional answer', () => {
    const state = new AnswerState(script);
    expect(state.claim(credentialRequest)?.id).toBe('credential');
    // The conversation moved on: the methods question has no scripted answer any more.
    expect(state.select(methods)).toBeUndefined();
    expect(state.answerable()).toEqual([]);
    expect(state.unusedRequired()).toEqual([]);
  });

  it('keeps an optional answer while its own group is current', () => {
    const groups: AnswerGroup[] = [
      {
        id: 'g1',
        answers: [
          { ...freeform, id: 'req' },
          { ...chooseClave, id: 'opt' },
        ],
      },
      { id: 'g2', answers: [credential] },
    ];
    const state = new AnswerState(groups);
    expect(state.claim(form())?.id).toBe('req');
    expect(state.unlockedGroup).toBe(1);
    expect(state.select(methods)?.id).toBe('opt'); // same group as a used answer: still fine
    expect(state.claim(credentialRequest)?.id).toBe('credential');
    expect(state.select(methods)).toBeUndefined();
  });

  it('prefers earlier groups and earlier answers when several match', () => {
    const groups: AnswerGroup[] = [
      {
        id: 'g1',
        answers: [
          { ...freeform, id: 'one', optional: true },
          { ...freeform, id: 'two', optional: true },
        ],
      },
      { id: 'g2', answers: [{ ...freeform, id: 'three' }] },
    ];
    const state = new AnswerState(groups);
    expect(state.claim(form())?.id).toBe('one');
    expect(state.claim(form())?.id).toBe('two');
    expect(state.claim(form())?.id).toBe('three');
    expect(state.claim(form())).toBeUndefined();
  });

  it('reports the required answers that were never used', () => {
    const state = new AnswerState(script);
    expect(state.unusedRequired()).toEqual(['credential']);
    state.claim(credentialRequest);
    expect(state.unusedRequired()).toEqual([]);
  });

  it('handles no groups at all', () => {
    const state = new AnswerState([]);
    expect(state.unlockedGroup).toBe(0);
    expect(state.answerable()).toEqual([]);
    expect(state.claim(form())).toBeUndefined();
  });

  it('rejects duplicate answer ids', () => {
    expect(
      () =>
        new AnswerState([
          { id: 'g1', answers: [freeform] },
          { id: 'g2', answers: [freeform] },
        ]),
    ).toThrow(/Duplicate answer id "freeform"/);
  });

  describe('snapshots', () => {
    it('round-trip through JSON', () => {
      const state = new AnswerState(script);
      state.claim(methods);
      const snapshot = JSON.parse(JSON.stringify(state.snapshot()));
      expect(snapshot).toEqual({ unlockedGroup: 1, used: ['choose-clave'] });
      const restored = new AnswerState(script, snapshot);
      expect(restored.isUsed('choose-clave')).toBe(true);
      expect(restored.claim(credentialRequest)?.id).toBe('credential');
    });

    it('refuse unknown answers and inconsistent states', () => {
      expect(() => new AnswerState(script, { unlockedGroup: 0, used: ['nope'] })).toThrow(
        /unknown answer/,
      );
      const locked: AnswerGroup[] = [
        { id: 'g1', answers: [{ ...freeform, id: 'req' }] },
        { id: 'g2', answers: [credential] },
      ];
      expect(() => new AnswerState(locked, { unlockedGroup: 1, used: ['credential'] })).toThrow(
        /inconsistent/,
      );
      expect(() => new AnswerState(locked, { unlockedGroup: 1, used: [] })).toThrow(/inconsistent/);
    });
  });
});

describe('decide', () => {
  it('claims the matching answer and says who answers', () => {
    const state = new AnswerState([{ id: 'g', answers: [credential, freeform] }]);
    const first = state.decide(credentialRequest, 'fail');
    expect(first).toMatchObject({ type: 'answer', by: 'structured' });
    const second = state.decide(form(), 'fail');
    expect(second).toMatchObject({ type: 'answer', by: 'answerer' });
    expect(answerSource(freeform.action)).toBe('answerer');
    expect(answerSource(credential.action)).toBe('structured');
  });

  it('applies the policy to unmatched prompts', () => {
    const state = new AnswerState([]);
    expect(state.decide(form(), 'answerer')).toEqual({
      type: 'improvise',
      instructions: DEFAULT_IMPROVISE_INSTRUCTIONS,
      by: 'answerer',
    });
    expect(state.decide(form(), 'dismiss')).toMatchObject({
      type: 'default',
      response: { kind: 'form', dismissed: true },
      by: 'default',
    });
    const failed = state.decide(form({ title: 'Raro' }), 'fail');
    expect(failed).toEqual({
      type: 'fail',
      reason: 'unexpected prompt: procedure form "Raro"',
    });
  });
});

describe('unmatched prompts', () => {
  const confirm: PendingPrompt = {
    itemId: 'k',
    agent: 'assistant',
    kind: 'confirm',
    title: 'Seguro?',
  };
  const action: PendingPrompt = {
    itemId: 'u',
    agent: 'procedure',
    kind: 'user_action',
    title: 'Haz algo',
  };
  const phone: PendingPrompt = {
    itemId: 'p',
    agent: 'procedure',
    kind: 'phone_call',
    title: 'Llama',
  };

  it('answerer policy approves confirmations and declines the rest', () => {
    expect(decideUnmatched(confirm, 'answerer')).toMatchObject({
      type: 'default',
      response: { kind: 'confirm', approved: true },
    });
    expect(decideUnmatched(action, 'answerer')).toMatchObject({
      response: { kind: 'user_action', done: false },
    });
    expect(decideUnmatched(credentialRequest, 'answerer')).toMatchObject({
      response: { kind: 'credential' },
    });
    expect(decideUnmatched(phone, 'answerer')).toMatchObject({
      response: { kind: 'phone_call', outcome: 'skipped' },
    });
  });

  it('dismiss policy declines everything, confirmations included', () => {
    expect(decideUnmatched(confirm, 'dismiss')).toMatchObject({
      response: { kind: 'confirm', approved: false },
    });
    expect(decideUnmatched(form(), 'dismiss')).toMatchObject({
      response: { kind: 'form', dismissed: true, savedToVault: [] },
    });
  });

  it('defaults mirror the app responses', () => {
    expect(defaultResponse(action, true)).toEqual({
      kind: 'user_action',
      done: false,
      note: 'No puedo hacer eso.',
    });
  });
});

describe('redactAction', () => {
  it('masks credential passwords and leaves other actions alone', () => {
    expect(redactAction(credential.action)).toEqual({
      type: 'credential',
      username: '53918274H',
      password: '••••',
    });
    expect(redactAction(freeform.action)).toBe(freeform.action);
    expect(JSON.stringify(redactAction(credential.action))).not.toContain('secret-pass');
  });
});
