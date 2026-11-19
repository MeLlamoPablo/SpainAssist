/**
 * What the main process needs from the library packages. The composition root wires the real
 * implementations (@sa/agent, @sa/browser, @sa/vault, @sa/signer, @sa/pii); tests inject fakes.
 */
import type {
  AgentEvent,
  AgentLaunch,
  AgentLaunchOptions,
  ChatGPTLoginCallbacks,
  ModelLists,
  PiCredential,
  PromptDisposition,
  PromptImage,
} from '@sa/agent';
import type { CodexLoginCallbacks } from '@sa/agent/codex';
import type { BrowserService, BrowserServiceOptions } from '@sa/browser';
import type { ScrubOptions, ScrubResult } from '@sa/pii';
import type {
  AfirmaHandler,
  CertificateInfo,
  ChatGPTKeyResponse,
  DocumentSignature,
  ModelOption,
  ProviderOption,
  RedeemVoucherResponse,
  SignaturePlacement,
  SigningKey,
  VoucherCreditResponse,
} from '@sa/shared';
import type { CreateResult, FillEdit, FillResult, PdfLayout } from '@sa/signer';
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
  | 'renameDocument'
  | 'replaceDocument'
  | 'deleteDocument'
  | 'listCredentials'
  | 'getCredential'
  | 'addClave'
  | 'updateClave'
  | 'addClaveMovil'
  | 'addDnie'
  | 'setDnieCertificate'
  | 'setDniePin'
  | 'addCertificate'
  | 'addCertificateFromKey'
  | 'exportCertificate'
  | 'listCertificateRequests'
  | 'findCertificateRequest'
  | 'addCertificateRequest'
  | 'getCertificateRequestKey'
  | 'deleteCertificateRequest'
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
  /** `onRotatedRefreshToken`: as `CodexLib.refresh`, the new refresh token before validation. */
  refreshOAuthCredential(
    providerId: string,
    credential: PiCredential,
    onRotatedRefreshToken?: (refreshToken: string) => Promise<void>,
  ): Promise<PiCredential>;
  /** Ends a ChatGPT credential's session at OpenAI; throws when OpenAI could not be told. */
  revokeChatGPTCredential(credential: PiCredential): Promise<void>;
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
  /** The models file this app version was built with (see ModelLists). */
  modelLists: ModelLists;
  /** Reads a downloaded models file; lists it lacks are `fallback`'s (see parseModelLists). */
  parseModelLists(json: unknown, fallback: ModelLists): ModelLists;
  /** Legacy Codex device-code login. Development builds only: undefined when packaged. */
  codex?: CodexLib;
}

export interface CodexLib {
  login(cb: CodexLoginCallbacks): Promise<{ credential: PiCredential; account?: string }>;
  /**
   * Refresh tokens rotate: `onRotatedRefreshToken` gets the new one as soon as OpenAI sends it,
   * before the rest of the answer is validated, so the caller can save it even if the refresh
   * then fails.
   */
  refresh(
    credential: PiCredential,
    onRotatedRefreshToken?: (refreshToken: string) => Promise<void>,
  ): Promise<PiCredential>;
}

export interface PiiLib {
  scrubPii(text: string, opts?: ScrubOptions): ScrubResult;
  stripUrlParams(url: string): string;
}

export interface SignerLib {
  shimSource: string;
  handler: AfirmaHandler;
  /** The in-page stand-in for FNMT's Configurador (`FNMT_SHIM_SOURCE`). */
  fnmtShimSource?: string;
  /** Details of a DER certificate (the DNIe's, read by the phone). */
  certificateInfo(der: Uint8Array): CertificateInfo;
  /** Pages and empty signature fields of a PDF (throws an AfirmaError when it isn't one). */
  pdfLayout(pdf: Uint8Array): Promise<PdfLayout>;
  /** Who signed a PDF, when and with which certificate, in signing order (none if it isn't one). */
  pdfSignatures(pdf: Uint8Array): Promise<DocumentSignature[]>;
  /** Where a signature goes when nobody said (the first empty field, else bottom right). */
  defaultPlacement(layout: PdfLayout): SignaturePlacement;
  /** A visible PAdES signature on a PDF of the user's, with the approved key (released). */
  signPdf(options: {
    pdf: Uint8Array;
    key: SigningKey;
    placement: SignaturePlacement;
  }): Promise<Buffer>;
  /** Fills in a PDF where the agent pointed (throws a FillError when it can't be filled). */
  fillPdf(pdf: Uint8Array, edits: FillEdit[]): Promise<FillResult>;
  /** A new PDF written from Markdown, with fillable blanks (throws when there is nothing to write). */
  createPdf(markdown: string, title: string): Promise<CreateResult>;
  /** A certificate's holder name as people write it ("Pablo Rodriguez"). */
  signatureName(name: string): string;
  /** AutoFirma's ID mask: `12345678Z` → `***4567**`. */
  maskIds(text: string): string;
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
