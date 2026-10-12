import { ChatItem, ConfirmKind, FormFieldType, NextAction, UserActionKind } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { appointmentExample, examplePromptItems, playgroundExamples } from './examples';

describe('agent UI playground', () => {
  for (const language of ['es', 'en'] as const) {
    it(`has valid, unique examples for every prompt type in ${language}`, () => {
      const examples = playgroundExamples(language);
      expect(new Set(examples.map((e) => e.id)).size).toBe(examples.length);
      for (const example of examples)
        if (example.item) expect(ChatItem.safeParse(example.item).success, example.id).toBe(true);
      const prompts = examplePromptItems(language).map((i) => i.prompt);
      const fields = prompts.flatMap((p) => (p.kind === 'form' ? p.fields.map((f) => f.type) : []));
      const confirmations = prompts.flatMap((p) => (p.kind === 'confirm' ? [p.confirmKind] : []));
      const actions = prompts.flatMap((p) => (p.kind === 'user_action' ? [p.actionKind] : []));
      expect([...new Set(fields)].sort()).toEqual([...FormFieldType.options].sort());
      expect([...new Set(confirmations)].sort()).toEqual([...ConfirmKind.options].sort());
      expect([...new Set(actions)].sort()).toEqual([...UserActionKind.options].sort());
      expect(prompts.some((p) => p.kind === 'credential')).toBe(true);
      expect(prompts.some((p) => p.kind === 'phone_call')).toBe(true);
      expect(prompts.some((p) => p.kind === 'dnie_signature')).toBe(true);
      const t = (es: string, en: string) => (language === 'es' ? es : en);
      expect(NextAction.safeParse(appointmentExample(t)).success).toBe(true);
    });
  }
});
