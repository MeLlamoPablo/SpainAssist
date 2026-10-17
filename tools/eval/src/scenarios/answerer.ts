/**
 * The user simulator's model (`agentKey: 'answerer'`) goes through the same mock as the agents. A
 * scenario answers it with the default of a person who has nothing to say: a form gets no value
 * (the user dismisses it) and a chat message gets "I don't know". A freeform question therefore
 * never hangs a run, and the answer is the same every time.
 */
import { ANSWERER, type Rule } from './kit';

export function answererRules(): Rule[] {
  return [
    {
      id: 'answerer-chat',
      when: { ...ANSWERER, lastUser: '^The assistant wrote to you' },
      reply: { text: '{"reply": "No lo sé, perdona."}' },
    },
    {
      // The form is shown as JSON with the keys of its fields: leaving the first one empty (null)
      // is a valid answer to any form, and says that the user does not know.
      id: 'answerer-form',
      when: { ...ANSWERER, lastUser: '"key":\\s*"(?<key>[^"]+)"' },
      reply: { text: '{"{{key}}": null}' },
    },
    {
      id: 'answerer-other',
      when: ANSWERER,
      reply: { text: '{}' },
    },
  ];
}
