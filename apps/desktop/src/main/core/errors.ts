import type { BridgeErrorCode, Language } from '@sa/shared';
import { t } from './i18n';
import { errorMessage } from './util';

/** An error whose message is meant for the user (shown by the renderer as-is). */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 'user_error',
  ) {
    super(message);
    this.name = 'UserError';
  }
}

/** An error returned to the agent through the host bridge. Messages are model-facing English. */
export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

/** The user (or an abort) cancelled a pending prompt. */
export class PromptCancelledError extends BridgeError {
  constructor(message = 'The question was cancelled before the user answered.') {
    super('user_rejected', message);
    this.name = 'PromptCancelledError';
  }
}

/** No inference provider configured. */
export class NoProviderError extends Error {
  constructor() {
    super('No AI provider configured');
    this.name = 'NoProviderError';
  }
}

export type AgentErrorKind =
  | 'auth'
  | 'credit'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'unavailable'
  | 'context'
  | 'no_provider'
  | 'other';

export function classifyAgentError(raw: string): AgentErrorKind {
  if (/no api key found|no ai provider configured/i.test(raw)) return 'no_provider';
  if (
    /\b402\b|key limit exceeded|insufficient (credits|funds|balance)|payment required|budget has been exceeded|budget_exceeded|exceededbudget/i.test(
      raw,
    )
  )
    return 'credit';
  if (
    /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|incorrect api key|authentication|invalid_token|token (has )?expired|oauth/i.test(
      raw,
    )
  )
    return 'auth';
  if (/\b429\b|rate.?limit|usage_limit|too many requests|quota/i.test(raw)) return 'rate_limit';
  if (/ETIMEDOUT|timed? ?out|timeout/i.test(raw)) return 'timeout';
  if (/\b50[0234]\b|overloaded|service unavailable|internal server error/i.test(raw))
    return 'unavailable';
  if (/context_length_exceeded|context window|maximum context|too many tokens/i.test(raw))
    return 'context';
  if (
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|fetch failed|network|socket hang up|connection error|connection failed|APIConnectionError/i.test(
      raw,
    )
  )
    return 'network';
  return 'other';
}

/** Turns a raw provider / agent error into a short, plain message for the user. */
export function friendlyAgentError(raw: string, lang: Language): string {
  switch (classifyAgentError(raw)) {
    case 'auth':
      return t(lang, 'agentErrorAuth');
    case 'credit':
      return t(lang, 'agentErrorCredit');
    case 'rate_limit':
      return t(lang, 'agentErrorRateLimit');
    case 'network':
      return t(lang, 'agentErrorNetwork');
    case 'timeout':
      return t(lang, 'agentErrorTimeout');
    case 'unavailable':
      return t(lang, 'agentErrorUnavailable');
    case 'context':
      return t(lang, 'agentErrorContext');
    case 'no_provider':
      return t(lang, 'agentErrorNoProvider');
    default:
      return t(lang, 'agentErrorGeneric');
  }
}

/** Maps vault library errors (VaultError codes) to user messages. */
export function friendlyVaultError(err: unknown, lang: Language): Error {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'invalid_passphrase':
      return new UserError(t(lang, 'vaultInvalidPassphrase'), code);
    case 'invalid_certificate':
      return new UserError(t(lang, 'vaultInvalidCertificate'), code);
    case 'expired_certificate':
      return new UserError(t(lang, 'vaultExpiredCertificate'), code);
    case 'not_found':
      return new UserError(t(lang, 'vaultNotFound'), code);
    case 'corrupted':
      return new UserError(t(lang, 'vaultCorrupted'), code);
    case 'invalid_input':
      return new UserError(t(lang, 'vaultInvalidInput'), code);
    default:
      return err instanceof Error ? err : new Error(errorMessage(err));
  }
}
