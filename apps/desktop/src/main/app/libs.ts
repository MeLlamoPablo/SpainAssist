import * as agent from '@sa/agent';
import { CERTIFICATE_ORIGINS, createBrowserService } from '@sa/browser';
import * as pii from '@sa/pii';
import { AUTOSCRIPT_SHIM_SOURCE, certificateInfo, createAfirmaHandler } from '@sa/signer';
import { createTestKeyProvider, type KeyProvider, Vault } from '@sa/vault';
import type { Logger } from '../core/logger';
import type {
  AgentLib,
  BrowserFactory,
  CodexLib,
  PiiLib,
  ProviderLib,
  SignerLib,
  VaultPort,
} from '../ports';

export const agentLib: AgentLib = {
  buildAgentLaunch: (opts) => agent.buildAgentLaunch(opts),
  createClient: (launch) => new agent.PiRpcClient(launch),
};

/**
 * The real provider functions. `codex` is the development-only Codex login (`app/codex-dev.ts`):
 * pass it only from development entry points, never from production code.
 */
export function providerLib(codex?: CodexLib): ProviderLib {
  return {
    loginChatGPT: agent.loginChatGPT,
    refreshOAuthCredential: (providerId, credential, onRotatedRefreshToken) =>
      agent.refreshOAuthCredential(providerId, credential, {
        ...(onRotatedRefreshToken ? { onRotatedRefreshToken } : {}),
      }),
    revokeChatGPTCredential: (credential) =>
      agent.revokeChatGPTCredential(credential, { signal: AbortSignal.timeout(15_000) }),
    listByokProviders: agent.listByokProviders,
    listProviderModels: agent.listProviderModels,
    redeemVoucher: agent.redeemVoucher,
    getChatGPTKey: (keyServerUrl, idToken) => agent.getChatGPTKey(keyServerUrl, idToken),
    getVoucherCredit: (keyServerUrl, apiKey) => agent.getVoucherCredit(keyServerUrl, apiKey),
    defaultModels: agent.DEFAULT_MODELS,
    chatgptModels: agent.CHATGPT_MODELS,
    assistantModels: agent.ASSISTANT_MODELS,
    ...(codex ? { codex } : {}),
  };
}

export const browserFactory: BrowserFactory = (opts) => createBrowserService(opts);
export const certificateOrigins: readonly string[] = CERTIFICATE_ORIGINS;

export function signerLib(logger: Logger): SignerLib {
  return {
    shimSource: AUTOSCRIPT_SHIM_SOURCE,
    handler: createAfirmaHandler({ logger }),
    certificateInfo,
  };
}

export async function openVault(
  dir: string,
  keys: KeyProvider,
  _logger: Logger,
): Promise<VaultPort> {
  return Vault.open(dir, keys);
}

export function testKeyProvider(_logger: Logger): KeyProvider {
  return createTestKeyProvider('sa-e2e');
}

export const piiLib: PiiLib = { scrubPii: pii.scrubPii, stripUrlParams: pii.stripUrlParams };
