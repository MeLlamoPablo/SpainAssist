import * as agent from '@sa/agent';
import { CERTIFICATE_ORIGINS, createBrowserService } from '@sa/browser';
import * as pii from '@sa/pii';
import {
  AUTOSCRIPT_SHIM_SOURCE,
  certificateInfo,
  createAfirmaHandler,
  createDocument,
  type DocumentFonts,
  defaultPlacement,
  FNMT_SHIM_SOURCE,
  fillPdf,
  type LongTermOptions,
  maskIds,
  pdfLayout,
  pdfSignatures,
  signatureName,
  signPdf,
} from '@sa/signer';
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
    modelLists: agent.BUNDLED_MODEL_LISTS,
    parseModelLists: agent.parseModelLists,
    ...(codex ? { codex } : {}),
  };
}

export const browserFactory: BrowserFactory = (opts) => createBrowserService(opts);
export const certificateOrigins: readonly string[] = CERTIFICATE_ORIGINS;

export interface SignerLibOptions {
  /**
   * The script font of visible PDF signatures (`app/pdf-fonts.ts`, which only the Electron
   * build can import); without it the name is drawn in Helvetica Oblique.
   */
  signatureFont?: Uint8Array;
  /**
   * The font for filled-in text Helvetica can't write (Ł, ș, Cyrillic…), Noto Sans; without it
   * such text is left out with a warning to the agent.
   */
  formFont?: Uint8Array;
  /** The font of documents the agent writes (Lora); without it, Helvetica. */
  documentFonts?: DocumentFonts;
  /** Makes PDF signatures long-term (PAdES-B-LT); without it nothing is fetched. */
  longTerm?: Omit<LongTermOptions, 'logger'>;
}

export function signerLib(logger: Logger, o: SignerLibOptions = {}): SignerLib {
  const { signatureFont, formFont, documentFonts, longTerm } = o;
  return {
    shimSource: AUTOSCRIPT_SHIM_SOURCE,
    handler: createAfirmaHandler({
      logger,
      ...(signatureFont ? { signatureFont } : {}),
      ...(longTerm ? { longTerm } : {}),
    }),
    fnmtShimSource: FNMT_SHIM_SOURCE,
    certificateInfo,
    pdfLayout,
    pdfSignatures,
    defaultPlacement,
    signPdf: (options) =>
      signPdf({
        ...options,
        ...(signatureFont ? { signatureFont } : {}),
        ...(longTerm ? { longTerm: { ...longTerm, logger } } : {}),
      }),
    fillPdf: (pdf, edits) => fillPdf(pdf, edits, formFont ? { unicodeFont: formFont } : {}),
    createPdf: (markdown, title) =>
      createDocument(markdown, { title, ...(documentFonts ? { fonts: documentFonts } : {}) }),
    signatureName,
    maskIds,
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
