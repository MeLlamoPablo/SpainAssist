import { describe, expect, it } from 'vitest';
import { CustomProviderInput, ProviderConfig, Settings } from '../src';

const custom = {
  kind: 'custom',
  baseUrl: 'http://127.0.0.1:11434/v1',
  api: 'openai-completions',
  model: 'qwen2.5vl:7b',
} as const;

const capabilities = {
  supportsImages: true,
  reasoning: false,
  contextWindow: 32_768,
  maxTokens: 8192,
};

describe('custom endpoint capabilities', () => {
  it('are optional: a config without them stays valid', () => {
    expect(ProviderConfig.parse(custom)).toEqual(custom);
  });

  it('round-trip in the provider config, settings and the setCustom input', () => {
    expect(ProviderConfig.parse({ ...custom, ...capabilities })).toEqual({
      ...custom,
      ...capabilities,
    });
    const { kind: _, ...input } = custom;
    expect(CustomProviderInput.parse({ ...input, ...capabilities })).toEqual({
      ...input,
      ...capabilities,
    });
    const settings = Settings.parse({
      language: 'es',
      onboardingCompleted: true,
      shareLearnings: false,
      errorReports: true,
      provider: { ...custom, reasoning: true },
    });
    expect(settings.provider).toEqual({ ...custom, reasoning: true });
  });

  it('reject nonsense values', () => {
    for (const bad of [
      { contextWindow: 0 },
      { contextWindow: 100 },
      { contextWindow: 2048.5 },
      { maxTokens: -1 },
      { maxTokens: 10 },
      { supportsImages: 'yes' },
    ]) {
      expect(ProviderConfig.safeParse({ ...custom, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });
});
