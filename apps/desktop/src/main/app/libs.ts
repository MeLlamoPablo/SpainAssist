import * as agent from '@sa/agent';
import { CERTIFICATE_ORIGINS, createBrowserService, ensureChromium } from '@sa/browser';
import * as pii from '@sa/pii';
import { AUTOSCRIPT_SHIM_SOURCE, afirmaHandler, certificateInfo } from '@sa/signer';
import { createTestKeyProvider, type KeyProvider, Vault } from '@sa/vault';
import type { Logger } from '../core/logger';
import type {
  AgentLib,
  BrowserFactory,
  BrowserInstaller,
  CodexLib,
  PiiLib,
  ProviderLib,
  SignerLib,
  VaultPort,
} from '../ports';
import type { FetchFn } from '../remote/http';

export const agentLib: AgentLib = {
  buildAgentLaunch: (opts) => agent.buildAgentLaunch(opts),
  createClient: (launch) => new agent.PiRpcClient(launch),
};

export function providerLib(_fetchFn: FetchFn): ProviderLib {
  return {
    loginChatGPT: agent.loginChatGPT,
    refreshOAuthCredential: agent.refreshOAuthCredential,
    revokeChatGPTCredential: (credential) =>
      agent.revokeChatGPTCredential(credential, { signal: AbortSignal.timeout(15_000) }),
    listByokProviders: agent.listByokProviders,
    listProviderModels: agent.listProviderModels,
    redeemVoucher: agent.redeemVoucher,
    getChatGPTKey: (keyServerUrl, idToken) => agent.getChatGPTKey(keyServerUrl, idToken),
    getVoucherCredit: (keyServerUrl, apiKey) => agent.getVoucherCredit(keyServerUrl, apiKey),
    defaultModels: agent.DEFAULT_MODELS,
    assistantModels: agent.ASSISTANT_MODELS,
    // Impersonating Codex CLI is against OpenAI's terms: production builds must not contain it.
    // Vite replaces import.meta.env.DEV with `false` there, so the module is never bundled.
    ...(import.meta.env.DEV ? { codex: devCodexLib } : {}),
  };
}

const devCodexLib: CodexLib = {
  login: async (cb) => (await import('@sa/agent/codex')).loginCodexDevice(cb),
  refresh: async (credential) =>
    (await import('@sa/agent/codex')).refreshCodexCredential(credential),
};

export const browserFactory: BrowserFactory = (opts) => createBrowserService(opts);
export const ensureBrowser: BrowserInstaller = (logger) => ensureChromium({ logger });
export const certificateOrigins: readonly string[] = CERTIFICATE_ORIGINS;

export const signerLib: SignerLib = {
  shimSource: AUTOSCRIPT_SHIM_SOURCE,
  handler: afirmaHandler,
  certificateInfo,
};

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
