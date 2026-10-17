import './helpers/no-network';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { replayCodexCredential } from '../../src/llm/codex-auth';
import {
  createCredentialSource,
  credentialSecrets,
  LITELLM_PROVIDER_ID,
  PLACEHOLDER_API_KEY,
} from '../../src/llm/credentials';
import { EvalHomeError } from '../../src/llm/home';
import { RunSecrets } from '../../src/run/secrets';
import { makeHome, TEST_VOUCHER_KEY, type TestHome, writeLitellmFile } from './helpers/tmp-home';

describe('credential sources', () => {
  let t: TestHome;
  beforeEach(() => {
    t = makeHome();
  });
  afterEach(() => t.cleanup());

  it('gives the hosts the voucher key as an api_key credential for litellm only', async () => {
    writeLitellmFile(t.home);
    const source = createCredentialSource({ provider: 'voucher', home: t.home });
    expect(source.providerId).toBe(LITELLM_PROVIDER_ID);
    expect(await source.credential('litellm')).toEqual({ type: 'api_key', key: TEST_VOUCHER_KEY });
    expect(await source.refreshCredential('litellm')).toEqual({
      type: 'api_key',
      key: TEST_VOUCHER_KEY,
    });
    expect(await source.credential('openai-codex')).toBeNull();
    expect(await source.credential('custom')).toBeNull();
    expect(credentialSecrets({ type: 'api_key', key: TEST_VOUCHER_KEY })).toEqual([
      TEST_VOUCHER_KEY,
    ]);
  });

  it('fails early when the voucher key is missing or unsafe', () => {
    expect(() => createCredentialSource({ provider: 'voucher', home: t.home })).toThrow(
      EvalHomeError,
    );
    writeLitellmFile(t.home, {}, 0o644);
    expect(() => createCredentialSource({ provider: 'voucher', home: t.home })).toThrow(
      /chmod 600/,
    );
  });

  it('uses a placeholder, never the real key, for replay and mock runs', async () => {
    writeLitellmFile(t.home);
    for (const options of [
      { provider: 'voucher', cache: 'replay' },
      { provider: 'mock' },
      { provider: 'mock', cache: 'record' },
    ] as const) {
      const source = createCredentialSource({ ...options, home: t.home });
      const credential = await source.credential('litellm');
      expect(credential).toEqual({ type: 'api_key', key: PLACEHOLDER_API_KEY });
      expect(JSON.stringify(credential)).not.toContain(TEST_VOUCHER_KEY);
    }
  });

  it('replay needs no credentials file at all', async () => {
    const source = createCredentialSource({ provider: 'voucher', cache: 'replay', home: t.home });
    expect(await source.credential('litellm')).toEqual({
      type: 'api_key',
      key: PLACEHOLDER_API_KEY,
    });
  });

  it('registers no secret for the placeholders of mock and replay runs, so no word is masked', () => {
    expect(credentialSecrets({ type: 'api_key', key: PLACEHOLDER_API_KEY })).toEqual([]);
    expect(credentialSecrets(replayCodexCredential())).toEqual([]);
    const run = new RunSecrets();
    run.addAll(credentialSecrets(replayCodexCredential()));
    run.addAll(credentialSecrets({ type: 'api_key', key: PLACEHOLDER_API_KEY }));
    expect(run.list()).toEqual([]);
    for (const text of ['run ended: replay-miss', 'Use --cache replay']) {
      expect(run.scrub(text)).toBe(text);
    }
    // A real credential still is registered, token by token.
    expect(
      credentialSecrets({ type: 'oauth', access: 'a-token-1', refresh: 'r-token-1', expires: 1 }),
    ).toEqual(['a-token-1', 'r-token-1']);
  });
});
