import type { Api, Model, ModelPromptCache } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ResolvedHostConfig } from '../config';
import { TEMPLATE_MODEL_BY_PROVIDER } from '../providers/defaults';

export const CUSTOM_PROVIDER_ID = 'custom';
/**
 * Voucher keys: our LiteLLM gateway (D10). OpenAI-compatible, and LiteLLM serves models under
 * their OpenRouter ids, so model metadata comes from pi's OpenRouter catalog.
 */
export const LITELLM_PROVIDER_ID = 'litellm';
/** Catalog whose metadata (context window, images, reasoning levels) describes LiteLLM models. */
const LITELLM_CATALOG_PROVIDER = 'openrouter';
/**
 * API key used for "custom" endpoints when the app has none (local models): pi only considers a
 * provider configured when some key resolves. A real key from the app (bridge) always wins.
 */
export const NO_KEY_PLACEHOLDER = 'sa-no-key';

type ModelConfig = ResolvedHostConfig['model'];

function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Template for a model id the catalog does not list: the sibling sharing the longest id prefix
 * (gpt-6.2-sol → gpt-6.1-sol, vendor/model-5 → vendor/model-4), else the provider's default.
 */
export function templateFor(
  provider: string,
  models: readonly Model<Api>[],
  id: string,
): Model<Api> | undefined {
  if (models.length === 0) return undefined;
  const preferred = models.find((m) => m.id === TEMPLATE_MODEL_BY_PROVIDER[provider]);
  let best: Model<Api> | undefined;
  let bestLength = 5; // shorter shared prefixes ("gpt-", "meta-") say little
  for (const model of models) {
    const length = commonPrefixLength(model.id, id);
    if (length > bestLength || (length === bestLength && best && model === preferred)) {
      best = model;
      bestLength = length;
    }
  }
  return best ?? preferred ?? models[0];
}

/**
 * Prompt cache lifetimes (seconds) of LiteLLM models by upstream (the id's `vendor/` prefix), for
 * idle compaction. Anthropic: the 5-minute and 1-hour `cache_control` TTLs. OpenAI caches long
 * prefixes by itself for 5 to 10 idle minutes, or 24 hours with `prompt_cache_retention`.
 */
const LITELLM_PROMPT_CACHE: Readonly<Record<string, ModelPromptCache>> = {
  anthropic: { short: 300, long: 3600 },
  openai: { short: 300, long: 86_400 },
};

function litellmUpstream(id: string): string {
  return id.split('/')[0] ?? '';
}

/**
 * LiteLLM OpenAI models need the session id as `prompt_cache_key` (pi only sends it to
 * api.openai.com) so requests of one session reach the same cache.
 */
export function needsPromptCacheKey(model: Model<Api>): boolean {
  return model.provider === LITELLM_PROVIDER_ID && litellmUpstream(model.id) === 'openai';
}

/**
 * OpenAI-compatible request shape for LiteLLM: the standard `reasoning_effort` (LiteLLM maps it
 * for each upstream) instead of OpenRouter's `reasoning` object, `max_tokens`, no `store`, no
 * `developer` role and no OpenRouter session headers. Anthropic models always get cache-control
 * markers (pi's OpenRouter catalog lists them for the Anthropic API, without the marker format);
 * other models keep the catalog's format and strict-mode support.
 */
function litellmCompat(template: Model<Api>, id: string): NonNullable<Model<Api>['compat']> {
  const catalog = (template.compat ?? {}) as Record<string, unknown>;
  const cacheControlFormat =
    litellmUpstream(id) === 'anthropic' ? 'anthropic' : catalog.cacheControlFormat;
  return {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    supportsUsageInStreaming: true,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'openai',
    sendSessionAffinityHeaders: false,
    ...(cacheControlFormat ? { cacheControlFormat } : {}),
    ...(catalog.supportsStrictMode !== undefined
      ? { supportsStrictMode: catalog.supportsStrictMode }
      : {}),
  } as NonNullable<Model<Api>['compat']>;
}

/**
 * Registers the "litellm" provider with one model at `cfg.baseUrl`. Metadata comes from the
 * OpenRouter catalog entry with the same id (or its closest sibling, e.g. for the mock LLM).
 */
function configureLiteLLM(runtime: ModelRuntime, cfg: ModelConfig): void {
  if (!cfg.baseUrl) throw new Error('A "litellm" model needs a baseUrl');
  const catalog = runtime.getModels(LITELLM_CATALOG_PROVIDER);
  const known = catalog.find((m) => m.id === cfg.id);
  const template = known ?? templateFor(LITELLM_CATALOG_PROVIDER, catalog, cfg.id);
  if (!template) throw new Error(`Model ${cfg.id} has no catalog entry to describe it`);
  const maxTokens = cfg.maxTokens
    ? Math.min(cfg.maxTokens, template.maxTokens)
    : template.maxTokens;
  const promptCache = LITELLM_PROMPT_CACHE[litellmUpstream(cfg.id)];
  runtime.registerProvider(LITELLM_PROVIDER_ID, {
    name: 'Spain Assist (LiteLLM)',
    baseUrl: cfg.baseUrl,
    api: 'openai-completions',
    // The app's key (bridge credential store) always wins; pi needs some key to resolve.
    apiKey: NO_KEY_PLACEHOLDER,
    models: [
      {
        id: cfg.id,
        name: known?.name ?? cfg.id,
        api: 'openai-completions',
        baseUrl: cfg.baseUrl,
        reasoning: template.reasoning,
        ...(template.thinkingLevelMap ? { thinkingLevelMap: template.thinkingLevelMap } : {}),
        input: template.input,
        ...(template.inputLimits ? { inputLimits: template.inputLimits } : {}),
        cost: template.cost,
        contextWindow: template.contextWindow,
        maxTokens,
        ...(promptCache ? { promptCache } : {}),
        compat: litellmCompat(template, cfg.id),
      },
    ],
  });
}

/**
 * Registers what is needed so `runtime.getModel(provider, id)` returns the model to use:
 * - "custom": an OpenAI-compatible (or Anthropic-compatible) endpoint with one model;
 * - "litellm": our LiteLLM gateway (vouchers) with one model described by the OpenRouter catalog;
 * - built-in providers: the catalog model, optionally with a different base URL (dev/e2e: the
 *   mock LLM) and capped output tokens. Model ids missing from the bundled catalog (e.g. a newer
 *   ChatGPT model) are cloned from a sibling model.
 */
export function configureModel(runtime: ModelRuntime, cfg: ModelConfig): Model<Api> {
  if (cfg.provider === LITELLM_PROVIDER_ID) {
    configureLiteLLM(runtime, cfg);
  } else if (cfg.provider === CUSTOM_PROVIDER_ID) {
    if (!cfg.baseUrl) throw new Error('A "custom" model needs a baseUrl');
    const api = cfg.api ?? 'openai-completions';
    runtime.registerProvider(CUSTOM_PROVIDER_ID, {
      name: 'Custom endpoint',
      baseUrl: cfg.baseUrl,
      api,
      apiKey: NO_KEY_PLACEHOLDER,
      models: [
        {
          id: cfg.id,
          name: cfg.id,
          api,
          reasoning: cfg.reasoning ?? false,
          input: cfg.supportsImages ? ['text', 'image'] : ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: cfg.contextWindow ?? 128_000,
          maxTokens: cfg.maxTokens ?? 16_384,
          ...(api === 'openai-completions'
            ? {
                // Widest compatibility with local servers (Ollama, LM Studio, llama.cpp, vLLM).
                compat: {
                  supportsDeveloperRole: false,
                  supportsStore: false,
                  maxTokensField: 'max_tokens',
                },
              }
            : {}),
        },
      ],
    });
  } else {
    if (!runtime.getProvider(cfg.provider)) {
      throw new Error(`Unknown model provider "${cfg.provider}"`);
    }
    const known = runtime.getModel(cfg.provider, cfg.id);
    if (!known || cfg.baseUrl || cfg.maxTokens) {
      const template = known ?? templateFor(cfg.provider, runtime.getModels(cfg.provider), cfg.id);
      if (!template) throw new Error(`Model ${cfg.provider}/${cfg.id} is not available`);
      const maxTokens = cfg.maxTokens
        ? Math.min(cfg.maxTokens, template.maxTokens)
        : template.maxTokens;
      runtime.registerProvider(cfg.provider, {
        ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
        models: [
          {
            ...template,
            id: cfg.id,
            name: known?.name ?? cfg.id,
            baseUrl: cfg.baseUrl ?? template.baseUrl,
            maxTokens,
          },
        ],
      });
    }
  }
  const model = runtime.getModel(cfg.provider, cfg.id);
  if (!model) throw new Error(`Model ${cfg.provider}/${cfg.id} could not be configured`);
  return model;
}
