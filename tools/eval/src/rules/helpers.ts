import { testPattern } from '../answers/text';
import type { Condition, Observation, RunView } from '../contracts';

/**
 * Conditions that the declarative vocabulary cannot express (they count or combine several
 * observations). They are `custom` conditions built here so fixtures share them.
 */

const CLAVE_PERMANENTE = /cl[@a]ve\s+permanente/i;
// "SMS" alone is not a method (it is also how any other method is confirmed): "vía SMS" is.
const OTHER_METHODS =
  /cl[@a]ve\s+(?:m[oó]vil|pin)|certificado\s+(?:digital|electr[oó]nico)|\bdni[\s-]?e\b|dni\s+electr[oó]nico|\bv[ií]a\s+sms\b/i;

function namesTwoMethods(text: string): boolean {
  return testPattern(CLAVE_PERMANENTE, text) && testPattern(OTHER_METHODS, text);
}

type PromptShown = Extract<Observation, { type: 'prompt_shown' }>;

function formOffersTwoMethods(observation: PromptShown): boolean {
  return (observation.prompt.fields ?? []).some((field) => {
    const labels = (field.options ?? []).map((option) => option.label);
    const clave = labels.findIndex((label) => testPattern(CLAVE_PERMANENTE, label));
    return (
      clave !== -1 && labels.some((label, i) => i !== clave && testPattern(OTHER_METHODS, label))
    );
  });
}

/**
 * The user was offered at least two authentication methods that include Cl@ve Permanente: a form
 * whose choice has it among its options with another method, or whose own title or message names
 * both (the question an `ask_user` asks), at any time; or a message of either agent that names
 * both, before the user was first asked for the credential. After that point a message that names
 * methods is a report ("entré con Cl@ve Permanente, no con certificado digital"), not an offer, and
 * a confirmation or any other prompt is no choice of a method at all.
 */
export function offersAuthenticationOptions(view: RunView): boolean {
  let credentialAsked = false;
  for (const observation of view.observations()) {
    switch (observation.type) {
      case 'prompt_shown': {
        const { kind, title, message } = observation.prompt;
        if (kind === 'credential') credentialAsked = true;
        if (
          kind === 'form' &&
          (formOffersTwoMethods(observation) || namesTwoMethods(`${title}\n${message ?? ''}`))
        ) {
          return true;
        }
        break;
      }
      case 'assistant_message':
        if (!credentialAsked && namesTwoMethods(observation.text)) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

/** The agent asked for a credential at least `count` times (distinct prompts). */
export function credentialPromptsAtLeast(count: number): (view: RunView) => boolean {
  return (view) => {
    const ids = new Set<string>();
    for (const observation of view.observations()) {
      if (observation.type === 'prompt_shown' && observation.prompt.kind === 'credential') {
        ids.add(observation.prompt.itemId);
      }
    }
    return ids.size >= count;
  };
}

const DOCUMENT_LINK = /\(sa:document\/([^)\s]+)\)/g;

/**
 * A message of the orchestrator links a document of the user's vault as `[name](sa:document/<id>)`,
 * the way its prompt tells it to. A link to an id that is not in the vault does not count.
 */
export async function orchestratorLinksSavedDocument(view: RunView): Promise<boolean> {
  const linked = new Set<string>();
  for (const observation of view.observations()) {
    if (observation.type !== 'assistant_message' || observation.agent !== 'assistant') continue;
    for (const match of observation.text.matchAll(DOCUMENT_LINK)) linked.add(match[1]!);
  }
  if (linked.size === 0) return false;
  const documents = await view.vaultDocuments();
  return documents.some((document) => linked.has(document.id));
}

export const offeredAuthOptionsCondition: Condition = {
  type: 'custom',
  name: 'offered-authentication-options',
  test: offersAuthenticationOptions,
};

export function credentialPromptsAtLeastCondition(count: number): Condition {
  return {
    type: 'custom',
    name: `credential-prompts-at-least-${count}`,
    test: credentialPromptsAtLeast(count),
  };
}

export const orchestratorLinksDocumentCondition: Condition = {
  type: 'custom',
  name: 'orchestrator-links-saved-document',
  test: orchestratorLinksSavedDocument,
};
