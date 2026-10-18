import type { ThinkingLevel } from '@sa/shared';

/**
 * The procedure agents' models of ChatGPT (also Codex in development builds) and vouchers. The app
 * uses them as is and never stores them, so a new app version changes the model for every
 * install. ChatGPT: the best model of the current Plus/Pro generation; a ChatGPT account whose
 * plan does not offer it gets the first model of CHATGPT_MODELS it lists. Voucher: OpenRouter id.
 */
export const DEFAULT_MODELS: { chatgpt: string; voucher: string } = {
  chatgpt: 'gpt-6.1-sol',
  voucher: 'anthropic/claude-haiku-5.5',
};

/**
 * The procedure agents' ChatGPT models, best first. Plans offer different models (Plus has no
 * gpt-6.1-sol), so the app uses the first one the account lists. gpt-6-luna comes before
 * gpt-5.6-terra: it is the newer generation and already the ChatGPT assistant's model.
 */
export const CHATGPT_MODELS: readonly string[] = [
  DEFAULT_MODELS.chatgpt,
  'gpt-6-luna',
  'gpt-5.6-terra',
];

/** A fixed agent model and its reasoning effort. */
export interface FixedModel {
  id: string;
  thinkingLevel: ThinkingLevel;
}

/**
 * The assistant's (orchestrator's) models of ChatGPT/Codex and vouchers, same rules as
 * DEFAULT_MODELS. It only talks to the user and delegates, so a faster model thinking harder.
 */
export const ASSISTANT_MODELS: { chatgpt: FixedModel; voucher: FixedModel } = {
  chatgpt: { id: 'gpt-6-luna', thinkingLevel: 'high' },
  voucher: { id: 'anthropic/claude-haiku-5.5', thinkingLevel: 'high' },
};

/** Catalog model used as a template when a provider is asked for an id it does not list. */
export const TEMPLATE_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  openai: DEFAULT_MODELS.chatgpt,
  'openai-codex': DEFAULT_MODELS.chatgpt,
  // Not the voucher default: pi's bundled catalog does not list Claude Haiku 5.5 yet.
  openrouter: 'openai/gpt-6-luna',
};
