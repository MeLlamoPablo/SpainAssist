/**
 * What the main process needs from the library packages. The composition root wires the real
 * implementations (@sa/agent, @sa/browser, @sa/vault, @sa/signer, @sa/pii); tests inject fakes.
 */
import type {
  AgentEvent,
  AgentLaunch,
  AgentLaunchOptions,
  ChatGPTLoginCallbacks,
  FixedModel,
  PiCredential,
  PromptDisposition,
  PromptImage,
} from '@sa/agent';
import type { CodexLoginCallbacks } from '@sa/agent/codex';
import type { BrowserService, BrowserServiceOptions, Logger } from '@sa/browser';
import type { ScrubOptions, ScrubResult } from '@sa/pii';
import type {
  AfirmaHandler,
  CertificateInfo,
  ChatGPTKeyResponse,
  ModelOption,
  ProviderOption,
  RedeemVoucherResponse,
  VoucherCreditResponse,
} from '@sa/shared';
import type { Vault } from '@sa/vault';

export type VaultPort = Pick<
  Vault,
  | 'overview'
  | 'storageInfo'
  | 'listPersonal'
  | 'getPersonal'
  | 'setPersonal'
  | 'deletePersonal'
  | 'listDocuments'
  | 'getDocument'
  | 'addDocument'
  | 'readDocument'
  | 'deleteDocument'
  | 'listCredentials'
  | 'getCredential'
  | 'addClave'
  | 'addClaveMovil'
  | 'addDnie'
  | 'setDnieCertificate'
  | 'addCertificate'
  | 'setCredentialPolicy'
  | 'getCredentialSecret'
  | 'markCredentialUsed'
  | 'deleteCredential'
  | 'listSecrets'
  | 'setSecret'
  | 'getSecret'
  | 'deleteSecret'
  | 'knownSensitiveValues'
  | 'wipe'
>;

export type BrowserPort = BrowserService;
export type BrowserFactory = (opts: BrowserServiceOptions) => BrowserPort;
/** Makes sure Playwright's Chromium exists (downloads it once) and returns its path. */
export type BrowserInstaller = (logger: Logger) => Promise<string>;

/** One agent process (PiRpcClient). The app never sends pi's `bash` RPC command. */
export interface AgentClientPort {
  start(): Promise<unknown>;
  prompt(text: string, images?: PromptImage[]): Promise<PromptDisposition>;
  steer(text: string): Promise<PromptDisposition>;
  /** Queue a message until the current run finishes. */
  followUp(text: string): Promise<PromptDisposition>;
  abort(): Promise<void>;
  readonly running: boolean;
  on(listener: (event: AgentEvent) => void): () => void;
  stop(): Promise<void>;
}

export interface AgentLib {
  buildAgentLaunch(opts: AgentLaunchOptions): AgentLaunch;
  createClient(launch: AgentLaunch): AgentClientPort;
}

export interface ProviderLib {
  /** `idToken`: the verified OpenAI ID token, only for our key server (scan-decider key). */
  loginChatGPT(
    cb: ChatGPTLoginCallbacks,
  ): Promise<{ credential: PiCredential; account?: string; idToken?: string }>;
  refreshOAuthCredential(providerId: string, credential: PiCredential): Promise<PiCredential>;
  listByokProviders(): ProviderOption[];
  /** pi catalogue models of one provider. */
  listProviderModels(providerId: string): ModelOption[];
  /** `currentKey`: the voucher key the app holds, so the voucher tops it up while it is active. */
  redeemVoucher(
    keyServerUrl: string,
    code: string,
    currentKey?: string,
  ): Promise<RedeemVoucherResponse>;
  /** The scan-decider key of a ChatGPT account (POST /v1/chatgpt-keys with its ID token). */
  getChatGPTKey(keyServerUrl: string, idToken: string): Promise<ChatGPTKeyResponse>;
  /** A voucher key's balance and expiry (GET /v1/vouchers/credit on the key server). */
  getVoucherCredit(keyServerUrl: string, apiKey: string): Promise<VoucherCreditResponse>;
  /** The procedure agents' model of ChatGPT (and Codex) and of vouchers: fixed per app version. */
  defaultModels: { chatgpt: string; voucher: string };
  /** The assistant's (orchestrator's) model and effort of ChatGPT/Codex and vouchers: same rules. */
  assistantModels: { chatgpt: FixedModel; voucher: FixedModel };
  /** Legacy Codex device-code login. Development builds only: undefined when packaged. */
  codex?: CodexLib;
}

export interface CodexLib {
  login(cb: CodexLoginCallbacks): Promise<{ credential: PiCredential; account?: string }>;
  refresh(credential: PiCredential): Promise<PiCredential>;
}

export interface PiiLib {
  scrubPii(text: string, opts?: ScrubOptions): ScrubResult;
  stripUrlParams(url: string): string;
}

export interface SignerLib {
  shimSource: string;
  handler: AfirmaHandler;
  /** Details of a DER certificate (the DNIe's, read by the phone). */
  certificateInfo(der: Uint8Array): CertificateInfo;
}

/** Touch ID (macOS) or nothing. */
export interface Biometric {
  available(): boolean;
  /** Resolves true when verified, false when cancelled/failed. */
  prompt(reason: string): Promise<boolean>;
}

export const noBiometric: Biometric = {
  available: () => false,
  prompt: async () => true,
};
