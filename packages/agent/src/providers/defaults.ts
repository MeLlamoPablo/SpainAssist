import type { ThinkingLevel } from '@sa/shared';

/**
 * The procedure agents' models of ChatGPT (also Codex in development builds) and vouchers. The app
 * uses them as is and never stores them, so a new app version changes the model for every
 * install. ChatGPT: the best model of the current Plus/Pro generation; a ChatGPT account whose
 * plan does not offer it gets the model OpenAI ranks first for it. Voucher: OpenRouter id.
 */
export const DEFAULT_MODELS: { chatgpt: string; voucher: string } = {
  chatgpt: 'gpt-6.1-sol',
  voucher: 'anthropic/claude-haiku-5.5',
};

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
