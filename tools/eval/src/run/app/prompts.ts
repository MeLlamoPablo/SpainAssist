/**
 * The app's prompts (`PromptItem` of the conversation or of a procedure) as the harness sees them
 * (`PendingPrompt`): what the user simulator matches its answers against and what the rules read.
 * Everything a person reading the prompt would read is in it (a confirmation's details too, in its
 * message, so text matchers see them); secret values never are (a prompt holds none).
 */
import { ASSISTANT_AGENT_ID, type Prompt, type PromptItem } from '@sa/shared';
import type { PendingPrompt, PromptKind } from '../../contracts';

function messageOf(prompt: Prompt): string | undefined {
  switch (prompt.kind) {
    case 'form':
    case 'user_action':
    case 'credential':
      return prompt.message;
    case 'confirm':
    case 'dnie_signature': {
      const details = (prompt.details ?? []).map((d) => `${d.label}: ${d.value}`);
      return [prompt.message, ...details].join('\n');
    }
    case 'phone_call': {
      return [
        `${prompt.organization} · ${prompt.phoneNumber}`,
        prompt.purpose,
        ...prompt.questions,
        ...(prompt.haveAtHand ?? []),
      ].join('\n');
    }
  }
}

/**
 * The kind the harness knows it by. A DNIe signature (raised by the app for the paired phone,
 * which a run never has: the feature is off) is a manual action as far as an answer is concerned.
 */
function kindOf(prompt: Prompt): PromptKind {
  return prompt.kind === 'dnie_signature' ? 'user_action' : prompt.kind;
}

/** `owner` is the agent that asked: `ASSISTANT_AGENT_ID` or a procedure id. */
export function toPendingPrompt(owner: string, item: PromptItem): PendingPrompt {
  const { prompt } = item;
  const message = messageOf(prompt);
  const procedureId = owner === ASSISTANT_AGENT_ID ? undefined : owner;
  return {
    itemId: item.id,
    agent: procedureId ? 'procedure' : 'assistant',
    ...(procedureId ? { procedureId } : {}),
    kind: kindOf(prompt),
    title: prompt.title,
    ...(message ? { message } : {}),
    ...(prompt.kind === 'form'
      ? {
          fields: prompt.fields.map((field) => ({
            key: field.key,
            type: field.type,
            label: field.label,
            ...(field.options
              ? { options: field.options.map(({ value, label }) => ({ value, label })) }
              : {}),
            ...(field.type === 'secret' ? { secret: true } : {}),
            // What the form logic of the UI reads: the simulator answers through the same logic.
            ...(field.vaultKey ? { vaultKey: field.vaultKey } : {}),
            required: field.required,
            ...(field.defaultValue !== undefined && field.type !== 'secret'
              ? { defaultValue: field.defaultValue }
              : {}),
            ...(field.visibleWhen
              ? {
                  visibleWhen: {
                    field: field.visibleWhen.field,
                    values: [...field.visibleWhen.values],
                  },
                }
              : {}),
          })),
        }
      : {}),
    ...(prompt.kind === 'credential' ? { credentialKind: prompt.credential } : {}),
  };
}

/** Every string of a prompt that the model is shown or could be asked about (for the leak check). */
export function promptTexts(prompt: PendingPrompt): string[] {
  return [
    prompt.title,
    ...(prompt.message ? [prompt.message] : []),
    ...(prompt.fields ?? []).flatMap((field) => [
      field.label,
      ...(field.options ?? []).flatMap((option) => [option.label, option.value]),
    ]),
  ];
}
