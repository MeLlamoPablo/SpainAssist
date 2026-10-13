import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { CUSTOM_MODEL_DEFAULTS } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import { configureModel } from '../src/host/model';

const baseUrl = 'http://127.0.0.1:11434/v1';

async function custom(extra: Record<string, unknown> = {}) {
  const runtime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  return configureModel(runtime, { provider: 'custom', id: 'qwen3:14b', baseUrl, ...extra });
}

describe('configureModel: custom endpoints', () => {
  it('assumes the safe defaults when the config says nothing', async () => {
    expect(await custom()).toMatchObject({
      provider: 'custom',
      id: 'qwen3:14b',
      api: 'openai-completions',
      baseUrl,
      reasoning: CUSTOM_MODEL_DEFAULTS.reasoning,
      input: ['text'],
      contextWindow: CUSTOM_MODEL_DEFAULTS.contextWindow,
      maxTokens: CUSTOM_MODEL_DEFAULTS.maxTokens,
    });
  });

  it('describes the model with the capabilities the app passes', async () => {
    const model = await custom({
      supportsImages: true,
      reasoning: true,
      contextWindow: 32_768,
      maxTokens: 4096,
      api: 'anthropic-messages',
    });
    expect(model).toMatchObject({
      api: 'anthropic-messages',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 32_768,
      maxTokens: 4096,
    });
  });
});
