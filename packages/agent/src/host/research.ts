import type { ResolvedHostConfig } from '../config';
import type { PromptResearch } from '../prompt/system';
import { CHATGPT_PLAN_PROVIDERS } from '../research/chatgpt-research';
import { LITELLM_PROVIDER_ID } from './model';

/**
 * How a procedure's agent researches the web:
 * - "key server": vouchers, `web_research` on Parallel through our key server;
 * - "chatgpt": ChatGPT plans (OAuth), `web_research` with OpenAI's hosted web search;
 * - "exa": BYOK and custom endpoints, `exa_search` and `exa_fetch` on Exa's keyless tier, or
 *   with the user's optional Exa key. They never get `web_research`.
 * Undefined: no web research (the assistant, or a provider with none); the prompt then makes the
 * agent report a research blocker.
 */
export type ResearchBackend = 'key server' | 'chatgpt' | 'exa';

export async function researchBackend(
  config: Pick<ResolvedHostConfig, 'role' | 'model' | 'research'>,
  /** Whether this provider's credential is OAuth (a ChatGPT plan, not an API key). */
  oauth: () => Promise<boolean>,
): Promise<ResearchBackend | undefined> {
  if (config.role === 'assistant') return undefined;
  if (config.research.exa) return 'exa';
  if (config.model.provider === LITELLM_PROVIDER_ID && config.research.keyServerUrl) {
    return 'key server';
  }
  if (CHATGPT_PLAN_PROVIDERS.includes(config.model.provider) && (await oauth())) return 'chatgpt';
  return undefined;
}

/** The research the system prompt describes for a backend. */
export function promptResearch(backend: ResearchBackend | undefined): PromptResearch | undefined {
  if (!backend) return undefined;
  return backend === 'exa' ? 'exa' : 'web_research';
}
