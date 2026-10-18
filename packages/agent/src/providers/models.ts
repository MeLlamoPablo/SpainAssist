import { findEnvKeys } from '@earendil-works/pi-ai/compat';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ModelOption, ProviderOption } from '@sa/shared';

export { ASSISTANT_MODELS, CHATGPT_MODELS, DEFAULT_MODELS, type FixedModel } from './defaults';

/** Providers that are not plain "bring your own API key" options. */
const NOT_BYOK = new Set(['openai-codex', 'radius', 'typesafe', 'github-copilot']);

const PREFERRED_ORDER = [
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'mistral',
  'deepseek',
  'xai',
  'groq',
  'moonshotai',
  'together',
  'fireworks',
];

const ANY_ENV = new Proxy({} as Record<string, string>, { get: () => 'x' });

function envVarFor(providerId: string): string | undefined {
  try {
    const keys = findEnvKeys(providerId, ANY_ENV);
    return keys?.find((k: string) => k.endsWith('_API_KEY')) ?? keys?.[0];
  } catch {
    return undefined;
  }
}

type BuiltinProvider = ReturnType<typeof builtinProviders>[number];

function catalogModels(provider: BuiltinProvider): ModelOption[] {
  return provider
    .getModels()
    .map((model) => ({
      provider: provider.id,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      supportsImages: model.input.includes('image'),
      reasoning: model.reasoning,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Catalogue models of any pi built-in provider (e.g. "openai-codex"); [] if unknown. */
export function listProviderModels(providerId: string): ModelOption[] {
  const provider = builtinProviders().find((p) => p.id === providerId);
  return provider ? catalogModels(provider) : [];
}

/** Providers/models available for BYOK, from pi-ai's built-in registry. */
export function listByokProviders(): ProviderOption[] {
  const options: ProviderOption[] = [];
  for (const provider of builtinProviders()) {
    if (NOT_BYOK.has(provider.id) || !provider.auth.apiKey) continue;
    const models = catalogModels(provider);
    if (models.length === 0) continue;
    const envVar = envVarFor(provider.id);
    options.push({ id: provider.id, name: provider.name, ...(envVar ? { envVar } : {}), models });
  }
  const rank = (id: string) => {
    const index = PREFERRED_ORDER.indexOf(id);
    return index === -1 ? PREFERRED_ORDER.length : index;
  };
  return options.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}
