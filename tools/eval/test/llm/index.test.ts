import './helpers/no-network';
import { describe, expect, it } from 'vitest';
import * as llm from '../../src/llm';

describe('public API of src/llm', () => {
  it('exports what the run loop and the CLI use', () => {
    for (const name of [
      'createMeter',
      'createCredentialSource',
      'credentialSecrets',
      'loadVoucherCredential',
      'createAnswerer',
      'createDirectorySink',
      'budgetStatus',
      'evalHome',
      'Ledger',
    ]) {
      expect(typeof (llm as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(llm.CACHE_MODES).toEqual(['off', 'record', 'replay', 'auto']);
    expect(llm.CODEX_CONSENT_FLAG).toBe('--codex-consent');
    expect(llm.ANSWERER_AGENT_KEY).toBe('answerer');
    expect(llm.DEFAULT_ANSWERER_MODEL).toBe('anthropic/claude-haiku-5.5');
    expect(llm.DEFAULT_LIMITS.reserveUsd).toBe(1);
  });
});
