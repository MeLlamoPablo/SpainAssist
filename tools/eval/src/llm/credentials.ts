import type { PiCredential } from '@sa/agent';
import { CODEX_PROVIDER_ID } from '@sa/agent/codex';
import type { CacheMode, EvalProvider } from '../contracts';
import {
  type CodexCommonOptions,
  type CodexRefreshOptions,
  isReplayCodexCredential,
  loadCodexCredential,
  refreshCodexCredentialIfNeeded,
  replayCodexCredential,
} from './codex-auth';
import { loadVoucherCredential } from './home';

/** pi provider ids of the agent hosts: the app's voucher runs use `litellm`, never `custom`. */
export const LITELLM_PROVIDER_ID = 'litellm';

/** What replay and mock runs hand the hosts instead of a key: nothing real is ever sent. */
export const PLACEHOLDER_API_KEY = 'sk-eval-placeholder-not-a-key';

/**
 * What the run loop's bridge needs to answer a host's `agent.credential` and
 * `agent.refreshCredential`, with the semantics of the app's `ProviderManager`: a credential only
 * for the configured provider's pi id, `null` for every other id.
 */
export interface CredentialSource {
  /** The pi provider id the hosts run with (`litellm` or `openai-codex`). */
  readonly providerId: string;
  /** `agent.credential`. */
  credential(providerId: string): Promise<PiCredential | null>;
  /** `agent.refreshCredential`: serialized and persisted before it returns (Codex). */
  refreshCredential(providerId: string): Promise<PiCredential | null>;
}

export interface CredentialSourceOptions extends CodexCommonOptions {
  provider: EvalProvider;
  /** `replay` never reaches the provider, so it needs no real credential at all. */
  cache?: CacheMode;
  /** Tests: where Codex refreshes (a local fake of auth.openai.com). */
  codex?: Pick<CodexRefreshOptions, 'endpoints' | 'fetchImpl' | 'now' | 'lock' | 'minValidityMs'>;
}

function fixed(providerId: string, credential: PiCredential): CredentialSource {
  const answer = async (id: string) => (id === providerId ? credential : null);
  return { providerId, credential: answer, refreshCredential: answer };
}

/**
 * The credential source of a run. It fails here, before any agent starts, when the provider's
 * credential is missing (`EvalHomeError`/`CodexAuthError`) or Codex consent is not given.
 */
export function createCredentialSource(options: CredentialSourceOptions): CredentialSource {
  const replay = options.cache === 'replay';
  switch (options.provider) {
    case 'mock':
      return fixed(LITELLM_PROVIDER_ID, { type: 'api_key', key: PLACEHOLDER_API_KEY });
    case 'voucher': {
      if (replay) {
        return fixed(LITELLM_PROVIDER_ID, { type: 'api_key', key: PLACEHOLDER_API_KEY });
      }
      const voucher = loadVoucherCredential({ ...(options.home ? { home: options.home } : {}) });
      return fixed(LITELLM_PROVIDER_ID, { type: 'api_key', key: voucher.apiKey });
    }
    case 'codex': {
      if (replay) return fixed(CODEX_PROVIDER_ID, replayCodexCredential(options.codex?.now));
      const common: CodexRefreshOptions = {
        ...(options.home ? { home: options.home } : {}),
        ...(options.consent !== undefined ? { consent: options.consent } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.warn ? { warn: options.warn } : {}),
        ...options.codex,
      };
      // Fail early: consent and a stored login.
      loadCodexCredential(common);
      return {
        providerId: CODEX_PROVIDER_ID,
        credential: async (id) => (id === CODEX_PROVIDER_ID ? loadCodexCredential(common) : null),
        refreshCredential: async (id) =>
          id === CODEX_PROVIDER_ID ? refreshCodexCredentialIfNeeded(common) : null,
      };
    }
  }
}

/**
 * The secret strings of a credential, for the logger's mask list. The placeholders of mock and
 * replay runs are not secrets and register nothing (a placeholder that is an ordinary word would
 * be masked wherever it occurs in every file of the run).
 */
export function credentialSecrets(credential: PiCredential): string[] {
  if (credential.key === PLACEHOLDER_API_KEY || isReplayCodexCredential(credential)) return [];
  const out: string[] = [];
  for (const key of ['access', 'refresh', 'key', 'id_token']) {
    const value = credential[key];
    if (typeof value === 'string' && value) out.push(value);
  }
  return out;
}
