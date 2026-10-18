import type { AgentHostConfig, ChatGPTLoginPages, PiCredential } from '@sa/agent';
import type {
  ByokInput,
  CustomModelCapabilities,
  CustomProbeInput,
  CustomProbeResult,
  CustomProviderInput,
  Language,
  LoginResult,
  LogoutResult,
  ModelOption,
  ProviderConfig,
  ProviderOption,
  ProviderStatus,
  RedeemVoucherResult,
  VoucherCreditResponse,
} from '@sa/shared';
import { agentAuthor, DEFAULT_THINKING_LEVEL, litellmDeciderUrl } from '@sa/shared';
import { classifyAgentError, NoProviderError, UserError } from '../core/errors';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { SECRET_IDS } from '../core/secrets';
import { type Clock, errorMessage, hostOf, Mutex } from '../core/util';
import type { ProviderLib, VaultPort } from '../ports';
import type { FetchFn } from '../remote/http';
import type { AppStateStore, SettingsStore } from '../settings/store';
import { fetchChatGPTModels, pickChatGPTModel } from './chatgpt-models';
import { probeCustomEndpoint } from './probe';

/** pi provider of voucher keys: our LiteLLM gateway at the voucher's base URL. */
const VOUCHER_PROVIDER = 'litellm';
/** Output token cap for credit-capped voucher keys (pi defaults to the model maximum). */
const VOUCHER_MAX_TOKENS = 8192;
/** LiteLLM writes spend to its database in batches (`proxy_batch_write_at: 10` s). */
const CREDIT_RECHECK_MS = 12_000;
/** Placeholder key for custom endpoints without auth (local models, mock LLM). */
const NO_KEY = 'sa-no-key';

/** A voucher key's balance: see VoucherCreditResponse. */
type VoucherBalance = Omit<VoucherCreditResponse, 'expiresAt'>;

/** Research lowers the gateway's cap instead of adding spend: it counts as used. */
function creditOf(b: VoucherBalance): NonNullable<ProviderStatus['credit']> {
  const remainingUsd = Math.max(0, b.maxBudgetUsd - b.spendUsd);
  return { limitUsd: b.limitUsd, remainingUsd, usageUsd: Math.max(0, b.limitUsd - remainingUsd) };
}

/**
 * The user, to our services: a key on our LiteLLM gateway, which they check with LiteLLM and
 * which stands for one user. Voucher: the voucher key (top-ups keep it). ChatGPT: the account's
 * key from the key server (one per OpenAI account). Codex (development builds only):
 * SA_DEV_USER_KEY. BYOK and custom endpoints have none: features that need it are off (scan
 * screening, call transcription, map lookups, sharing and rating learnings).
 */
export interface UserKey {
  /** `…/v1` base URL of the gateway. */
  baseUrl: string;
  apiKey: string;
}

/** Where and with which key the scanner screens frames. Main process only. */
export interface ScanGateAccess {
  endpoint: string;
  apiKey: string;
}

/** The capability fields of a custom endpoint's config or input, without unset ones. */
function capabilitiesOf(source: CustomModelCapabilities): CustomModelCapabilities {
  const { supportsImages, reasoning, contextWindow, maxTokens } = source;
  return {
    ...(supportsImages !== undefined ? { supportsImages } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function sameCapabilities(a: CustomModelCapabilities, b: CustomModelCapabilities): boolean {
  return (
    a.supportsImages === b.supportsImages &&
    a.reasoning === b.reasoning &&
    a.contextWindow === b.contextWindow &&
    a.maxTokens === b.maxTokens
  );
}

/** Vault JSON of an OAuth provider (ChatGPT, and Codex in development builds). */
interface OAuthSecret {
  credential: PiCredential;
  account?: string;
  /** ChatGPT only: the account's user key from our key server. */
  scanKey?: UserKey;
}

/** Don't ask the key server again for this long after a failed attempt. */
const SCAN_KEY_RETRY_MS = 60_000;
/** A ChatGPT account's plan rarely changes: its model pick is kept this long. */
const CHATGPT_MODELS_TTL_MS = 60 * 60_000;
/** After a failed model list, agents and scans use the default model this long without asking. */
const CHATGPT_MODELS_RETRY_MS = 60_000;

/** `exp` of a JWT in ms (the ID token was verified at sign-in), or 0 when unreadable. */
function jwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

type OAuthKind = 'chatgpt' | 'codex';

const OAUTH_SECRET_IDS: Record<OAuthKind, string> = {
  chatgpt: SECRET_IDS.chatgpt,
  codex: SECRET_IDS.codex,
};

function isOAuth(p: ProviderConfig | undefined): p is Extract<ProviderConfig, { kind: OAuthKind }> {
  return p?.kind === 'chatgpt' || p?.kind === 'codex';
}

/**
 * BYOK and custom endpoints: no gateway key, so their web research uses Exa (keyless, or the
 * user's own key) instead of `web_research`.
 */
function researchesWithExa(p: ProviderConfig | undefined): boolean {
  return p?.kind === 'byok' || p?.kind === 'custom';
}

/** Vault secret holding the provider's credential, if any. */
function secretIdOf(p: ProviderConfig): string | undefined {
  return isOAuth(p) ? OAUTH_SECRET_IDS[p.kind] : p.secretId;
}

export interface ProviderManagerDeps {
  keyServerUrl?: string;
  /** Development builds only (SA_DEV_USER_KEY): the user key of a Codex session. */
  devUserKey?: UserKey;
  settings: SettingsStore;
  state: AppStateStore;
  vault: () => VaultPort;
  lib: ProviderLib;
  /** For probing custom endpoints. */
  fetch: FetchFn;
  events: EventBus;
  /** Opens the ChatGPT authorization URL in the system browser. */
  openExternal(url: string): Promise<void>;
  /** The pages the browser tab shows when ChatGPT sends the user back after signing in. */
  loginPages(): ChatGPTLoginPages;
  /** Called after the configuration changed (the app stops all agents). */
  onChanged(): Promise<void>;
  logger: Logger;
  lang: () => Language;
  clock: Clock;
  creditTtlMs?: number;
}

/**
 * Inference provider configuration: non-secret config in settings, secrets in the vault.
 * Hands credentials to agent processes over the bridge (`agent.credential`) and serializes OAuth
 * refreshes across them.
 */
export class ProviderManager {
  private login?: AbortController;
  /** Account e-mail of the configured OAuth provider (ChatGPT / Codex). */
  private oauthAccount?: string;
  private credit?: { value: VoucherBalance; at: number };
  /** When the voucher key expires (ISO 8601), from the key server. */
  private voucherExpiresAt?: string;
  private creditRefresh?: Promise<void>;
  private creditRecheck?: ReturnType<typeof setTimeout>;
  private readonly refreshMutex = new Mutex();
  /**
   * The OpenAI ID token of this session's ChatGPT sign-in, kept in memory only until the
   * account's scan key is stored (retried if the key server was unreachable).
   */
  private chatgptIdToken?: { token: string; expiresAt: number };
  private scanKeyFetch?: Promise<UserKey | undefined>;
  private scanKeyFailedAt = 0;
  /** The procedure model picked from the ChatGPT account's model list, and when. */
  private chatgptPick?: { id: string; at: number };
  private chatgptPickFetch?: Promise<string>;
  private chatgptPickFailedAt = 0;
  /** Bumped on every provider change, so a lookup for the previous account is not kept. */
  private chatgptPickGeneration = 0;

  constructor(private readonly deps: ProviderManagerDeps) {}

  async init(): Promise<void> {
    const p = this.config();
    // A Codex session from a development build is never used by other builds.
    if (p?.kind === 'codex' && !this.deps.lib.codex) {
      await this.deps.settings.setProvider(undefined);
      return;
    }
    if (isOAuth(p)) this.oauthAccount = (await this.readOAuth(p.kind))?.account;
  }

  private config(): ProviderConfig | undefined {
    return this.deps.settings.get().provider;
  }

  private lang(): Language {
    return this.deps.lang();
  }

  // --- status ------------------------------------------------------------------------------

  status(): ProviderStatus {
    const p = this.config();
    if (!p) return { configured: false };
    const status: ProviderStatus = {
      configured: true,
      kind: p.kind,
      label: this.label(p),
      model: (p.kind === 'chatgpt' && this.chatgptPick?.id) || this.modelOf(p),
    };
    if (isOAuth(p) && this.oauthAccount) status.account = this.oauthAccount;
    if (p.kind === 'voucher' && this.credit) status.credit = creditOf(this.credit.value);
    if (p.kind === 'voucher' && this.voucherExpiresAt) status.expiresAt = this.voucherExpiresAt;
    if (researchesWithExa(p)) status.exaKey = this.hasExaKey();
    return status;
  }

  private hasExaKey(): boolean {
    return this.deps
      .vault()
      .listSecrets()
      .some((s) => s.id === SECRET_IDS.exa);
  }

  /** Status with a fresh voucher balance when possible (waits briefly, then returns). */
  async currentStatus(waitMs = 1500): Promise<ProviderStatus> {
    const p = this.config();
    if (p?.kind === 'voucher' && this.creditIsStale()) {
      const refresh = this.refreshCredit();
      await Promise.race([refresh, new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    }
    return this.status();
  }

  private creditIsStale(): boolean {
    const ttl = this.deps.creditTtlMs ?? 60_000;
    return !this.credit || this.deps.clock().getTime() - this.credit.at > ttl;
  }

  /** The voucher key and the gateway it belongs to, when a voucher is configured. */
  private async voucherKey(): Promise<{ baseUrl: string; key: string } | undefined> {
    const p = this.config();
    if (p?.kind !== 'voucher') return undefined;
    const baseUrl = await this.deps.state.voucherBaseUrl();
    const key = await this.deps.vault().getSecret(p.secretId);
    if (!baseUrl || !key) return undefined;
    this.deps.logger.addSecret(key);
    return { baseUrl, key };
  }

  /** Refreshes the voucher balance (key server) and emits `providers.status`. */
  refreshCredit(): Promise<void> {
    if (this.creditRefresh) return this.creditRefresh;
    this.creditRefresh = (async () => {
      try {
        const { keyServerUrl } = this.deps;
        const voucher = await this.voucherKey();
        if (!keyServerUrl || !voucher) return;
        const { expiresAt, ...balance } = await this.deps.lib.getVoucherCredit(
          keyServerUrl,
          voucher.key,
        );
        const expiryChanged = (expiresAt ?? undefined) !== this.voucherExpiresAt;
        this.voucherExpiresAt = expiresAt ?? undefined;
        if (expiryChanged) this.emitStatus();
        this.setCredit(balance);
      } catch (err) {
        this.deps.logger.warn('voucher credit check failed', { error: errorMessage(err) });
      }
    })().finally(() => {
      this.creditRefresh = undefined;
    });
    return this.creditRefresh;
  }

  /**
   * The voucher may have been spent (an agent run ended): refreshes the balance now, and again
   * once the gateway has written the spend.
   */
  creditSpent(): void {
    if (this.config()?.kind !== 'voucher') return;
    void this.refreshCredit();
    clearTimeout(this.creditRecheck);
    this.creditRecheck = setTimeout(() => void this.refreshCredit(), CREDIT_RECHECK_MS);
    this.creditRecheck.unref?.();
  }

  /** The voucher's spend and cap as LiteLLM reported them in the headers of an agent's call. */
  voucherSpend(spend: { spendUsd: number; maxBudgetUsd: number }): void {
    if (this.config()?.kind !== 'voucher') return;
    // Only the key server knows what the vouchers add up to.
    const old = this.credit?.value;
    if (!old) {
      void this.refreshCredit();
      return;
    }
    this.setCredit({ ...old, ...spend });
  }

  /**
   * Spend only grows, but both sources lag (headers show the spend before their call, the key
   * server before the gateway's batched write): for one cap, never let one move the meter back.
   */
  private setCredit(value: VoucherBalance): void {
    const old = this.credit?.value;
    const sameCaps = old?.limitUsd === value.limitUsd && old.maxBudgetUsd === value.maxBudgetUsd;
    if (old && sameCaps && value.spendUsd < old.spendUsd) return;
    this.credit = { value, at: this.deps.clock().getTime() };
    if (!sameCaps || old?.spendUsd !== value.spendUsd) this.emitStatus();
  }

  private label(p: ProviderConfig): string {
    switch (p.kind) {
      case 'chatgpt':
        return 'ChatGPT';
      case 'codex':
        return t(this.lang(), 'providerCodex');
      case 'voucher':
        return t(this.lang(), 'providerVoucher');
      case 'byok':
        return t(this.lang(), 'providerByok', { name: this.providerName(p.provider) });
      case 'custom':
        return t(this.lang(), 'providerCustom', { host: hostOf(p.baseUrl) });
    }
  }

  private providerName(id: string): string {
    return this.listByok().find((o) => o.id === id)?.name ?? id;
  }

  private emitStatus(): void {
    this.deps.events.emit({ type: 'providers.status', status: this.status() });
  }

  listByok(): ProviderOption[] {
    try {
      return this.deps.lib.listByokProviders();
    } catch (err) {
      this.deps.logger.warn('BYOK provider list unavailable', { error: errorMessage(err) });
      return [];
    }
  }

  /**
   * Models the user may pick for the connected provider; the current model is always included.
   * Empty for ChatGPT, vouchers and Codex: the app version picks their model.
   */
  async listModels(): Promise<ModelOption[]> {
    const p = this.config();
    if (p?.kind !== 'byok' && p?.kind !== 'custom') return [];
    const provider = this.piProviderId(p);
    const models =
      p.kind === 'byok'
        ? this.catalog(provider)
        : (await this.probeSaved(p)).models.map((id) => ({ provider, id, name: id }));
    if (!models.some((m) => m.id === p.model)) {
      models.unshift({ provider, id: p.model, name: p.model });
    }
    return models;
  }

  private catalog(providerId: string): ModelOption[] {
    try {
      return this.deps.lib.listProviderModels(providerId);
    } catch (err) {
      this.deps.logger.warn('model catalogue unavailable', { error: errorMessage(err) });
      return [];
    }
  }

  // --- configuration -------------------------------------------------------------------------

  private async apply(config: ProviderConfig | undefined): Promise<void> {
    // The Exa key belongs to BYOK and custom endpoints: no other setup uses it, and the user
    // couldn't see or clear it from there.
    if (!researchesWithExa(config) && this.hasExaKey()) {
      await this.deps.vault().deleteSecret(SECRET_IDS.exa);
      this.deps.events.emit({ type: 'vault.changed' });
    }
    await this.deps.settings.setProvider(config);
    this.credit = undefined;
    this.voucherExpiresAt = undefined;
    if (!isOAuth(config)) this.oauthAccount = undefined;
    if (config?.kind !== 'chatgpt') this.chatgptIdToken = undefined;
    this.chatgptPick = undefined;
    this.chatgptPickFetch = undefined;
    this.chatgptPickFailedAt = 0;
    this.chatgptPickGeneration++;
    await this.deps.onChanged();
    this.emitStatus();
    if (config?.kind === 'voucher') void this.refreshCredit();
  }

  async loginChatGPT(): Promise<LoginResult> {
    if (this.login) return { ok: false, error: t(this.lang(), 'loginInProgress') };
    const controller = new AbortController();
    this.login = controller;
    const emit = (message: string, url?: string) =>
      this.deps.events.emit({ type: 'providers.loginProgress', message, ...(url ? { url } : {}) });
    try {
      const deviceId = await this.deps.state.deviceId();
      const { credential, account, idToken } = await this.deps.lib.loginChatGPT({
        deviceId,
        clientId: await this.deps.state.chatgptClientId(),
        pages: this.deps.loginPages(),
        signal: controller.signal,
        onAuthUrl: (url) => {
          emit(t(this.lang(), 'loginOpenBrowser'), url);
          if (url.startsWith('https://')) {
            this.deps
              .openExternal(url)
              .catch((err) =>
                this.deps.logger.warn('could not open the browser', { error: errorMessage(err) }),
              );
          }
        },
        onProgress: (stage) =>
          emit(t(this.lang(), stage === 'waiting' ? 'loginWaitingBrowser' : 'loginExchanging')),
      });
      if (controller.signal.aborted) return { ok: false, error: t(this.lang(), 'loginCancelled') };
      if (typeof credential.clientId === 'string')
        await this.deps.state.setChatgptClientId(credential.clientId);
      this.registerCredentialSecrets(credential);
      // Signing in again without signing out: end the old session, or ChatGPT keeps listing it.
      const previous = await this.readOAuth('chatgpt');
      await this.writeOAuth('chatgpt', { credential, ...(account ? { account } : {}) });
      if (previous && previous.credential.refresh !== credential.refresh) {
        void this.revokeChatGPT(previous.credential);
      }
      this.oauthAccount = account;
      this.chatgptIdToken = undefined;
      this.scanKeyFailedAt = 0;
      if (idToken) {
        this.deps.logger.addSecret(idToken);
        this.chatgptIdToken = { token: idToken, expiresAt: jwtExpiry(idToken) };
      }
      await this.apply({ kind: 'chatgpt' });
      // In the background: sign-in works without it (scans are then not pre-screened).
      void this.fetchChatGPTScanKey();
      return { ok: true, status: this.status() };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: t(this.lang(), 'loginCancelled') };
      this.deps.logger.warn('ChatGPT sign-in failed', { error: errorMessage(err) });
      const code = (err as { code?: unknown } | undefined)?.code;
      if (code === 'not_eligible' || code === 'missing_scope') {
        return { ok: false, error: t(this.lang(), 'loginChatgptNotEligible') };
      }
      return { ok: false, error: t(this.lang(), 'loginFailed', { message: errorMessage(err) }) };
    } finally {
      if (this.login === controller) this.login = undefined;
    }
  }

  // --- document-scan frame decider ---------------------------------------------------------

  /**
   * The gateway and key the scanner's frame decider uses: the user key (charged to the voucher,
   * or to the ChatGPT account's allowance). Undefined without one: the scanner then skips
   * screening.
   */
  async scanGateAccess(): Promise<ScanGateAccess | undefined> {
    const key = await this.userKey();
    return key && { endpoint: litellmDeciderUrl(key.baseUrl), apiKey: key.apiKey };
  }

  /** Whether the provider comes with a user key: see userKey(). */
  hasUserKey(): boolean {
    const kind = this.config()?.kind;
    return kind === 'voucher' || kind === 'chatgpt' || (kind === 'codex' && !!this.deps.devUserKey);
  }

  /**
   * The user's key (see UserKey): the voucher key, the ChatGPT account's key, or the development
   * key of a Codex session. Undefined for BYOK and custom endpoints, or while a ChatGPT key is
   * unavailable.
   */
  async userKey(): Promise<UserKey | undefined> {
    const p = this.config();
    let key: UserKey | undefined;
    if (p?.kind === 'voucher') {
      const voucher = await this.voucherKey();
      key = voucher ? { baseUrl: voucher.baseUrl, apiKey: voucher.key } : undefined;
    } else if (p?.kind === 'chatgpt') {
      key = (await this.readOAuth('chatgpt'))?.scanKey ?? (await this.fetchChatGPTScanKey());
    } else if (p?.kind === 'codex') {
      key = this.deps.devUserKey;
    }
    if (!key) return undefined;
    this.deps.logger.addSecret(key.apiKey);
    return key;
  }

  /**
   * Trades this session's ChatGPT ID token for the account's scan key (our key server checks
   * the token with OpenAI's keys) and stores it with the ChatGPT credential in the vault.
   * Deduplicated; after a failure it waits SCAN_KEY_RETRY_MS before asking again.
   */
  private fetchChatGPTScanKey(): Promise<UserKey | undefined> {
    this.scanKeyFetch ??= (async () => {
      const pending = this.chatgptIdToken;
      const keyServerUrl = this.deps.keyServerUrl;
      const now = this.deps.clock().getTime();
      if (!pending || !keyServerUrl || now - this.scanKeyFailedAt < SCAN_KEY_RETRY_MS) return;
      if (pending.expiresAt <= now) {
        this.chatgptIdToken = undefined;
        return;
      }
      try {
        const res = await this.deps.lib.getChatGPTKey(keyServerUrl, pending.token);
        this.deps.logger.addSecret(res.apiKey);
        const stored = await this.readOAuth('chatgpt');
        // Signed out (or into another account) meanwhile: drop the answer.
        if (!stored || this.config()?.kind !== 'chatgpt' || this.chatgptIdToken !== pending) {
          return;
        }
        const scanKey = { baseUrl: res.baseUrl.replace(/\/+$/, ''), apiKey: res.apiKey };
        await this.writeOAuth('chatgpt', { ...stored, scanKey });
        this.chatgptIdToken = undefined;
        return scanKey;
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        this.deps.logger.warn('ChatGPT scan key unavailable', { error: errorMessage(err), code });
        this.scanKeyFailedAt = this.deps.clock().getTime();
        // The token will not get better: forget it (signing in again gets a fresh one).
        if (code === 'invalid_identity' || code === 'chatgpt_keys_disabled') {
          this.chatgptIdToken = undefined;
        }
        return;
      }
    })().finally(() => {
      this.scanKeyFetch = undefined;
    });
    return this.scanKeyFetch;
  }

  /** Development builds only: legacy Codex device-code login (see @sa/agent/codex). */
  async loginCodexDevice(): Promise<LoginResult> {
    const codex = this.deps.lib.codex;
    if (!codex) return { ok: false, error: t(this.lang(), 'loginCodexUnavailable') };
    if (this.login) return { ok: false, error: t(this.lang(), 'loginInProgress') };
    const controller = new AbortController();
    this.login = controller;
    try {
      const { credential, account } = await codex.login({
        signal: controller.signal,
        onUserCode: ({ userCode, verificationUrl }) =>
          this.deps.events.emit({
            type: 'providers.loginProgress',
            message: t(this.lang(), 'loginCodexCode'),
            url: verificationUrl,
            userCode,
          }),
      });
      if (controller.signal.aborted) return { ok: false, error: t(this.lang(), 'loginCancelled') };
      this.registerCredentialSecrets(credential);
      await this.writeOAuth('codex', { credential, ...(account ? { account } : {}) });
      this.oauthAccount = account;
      await this.apply({ kind: 'codex' });
      return { ok: true, status: this.status() };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: t(this.lang(), 'loginCancelled') };
      this.deps.logger.warn('Codex device-code sign-in failed', { error: errorMessage(err) });
      return { ok: false, error: t(this.lang(), 'loginFailed', { message: errorMessage(err) }) };
    } finally {
      if (this.login === controller) this.login = undefined;
    }
  }

  cancelLogin(): void {
    this.login?.abort();
  }

  async redeemVoucher(code: string): Promise<RedeemVoucherResult> {
    const keyServerUrl = this.deps.keyServerUrl;
    try {
      if (!keyServerUrl) throw new Error('The voucher service is not available yet.');
      const vault = this.deps.vault();
      // The key of an earlier voucher, if any: while it is active the key server adds this
      // voucher to it, so the app keeps one balance.
      const currentKey = await vault.getSecret(SECRET_IDS.voucher);
      if (currentKey) this.deps.logger.addSecret(currentKey);
      const res = await this.deps.lib.redeemVoucher(keyServerUrl, code.trim(), currentKey);
      this.deps.logger.addSecret(res.apiKey);
      await vault.setSecret(SECRET_IDS.voucher, t(this.lang(), 'secretVoucher'), res.apiKey);
      await this.deps.state.setVoucherBaseUrl(res.baseUrl.replace(/\/+$/, ''));
      this.deps.events.emit({ type: 'vault.changed' });
      await this.apply({
        kind: 'voucher',
        secretId: SECRET_IDS.voucher,
        limitUsd: res.limitUsd,
      });
      // Show the credit before the key server answers. The real cap and spend are unknown here,
      // so any later reading replaces these.
      this.setCredit({
        limitUsd: res.limitUsd,
        maxBudgetUsd: res.limitUsd,
        spendUsd: res.usageUsd,
      });
      return { ok: true, status: this.status(), addedUsd: res.addedUsd };
    } catch (err) {
      this.deps.logger.warn('voucher redemption failed', {
        error: errorMessage(err),
        code: (err as { code?: unknown }).code,
      });
      return { ok: false, error: this.voucherError(err) };
    }
  }

  /** Key server error codes (VoucherErrorCode) -> plain messages. */
  private voucherError(err: unknown): string {
    const lang = this.lang();
    const code = (err as { code?: unknown } | null)?.code;
    switch (code) {
      case 'invalid_code':
      case 'bad_request':
      case 'not_found':
        return t(lang, 'voucherInvalid');
      case 'already_redeemed':
        return t(lang, 'voucherUsed');
      case 'expired':
        return t(lang, 'voucherExpired');
      case 'revoked':
        return t(lang, 'voucherRevoked');
      case 'rate_limited':
        return t(lang, 'voucherRateLimited');
      case 'provider_error':
      case 'internal':
      case 'unauthorized':
        return t(lang, 'voucherFailed');
    }
    const message = errorMessage(err);
    if (/invalid.?code|not found|404/i.test(message)) return t(lang, 'voucherInvalid');
    if (/already/i.test(message)) return t(lang, 'voucherUsed');
    if (classifyAgentError(message) === 'network') return t(lang, 'voucherNetwork');
    return t(lang, 'voucherFailed');
  }

  async setByok(input: ByokInput): Promise<LoginResult> {
    try {
      const options = this.listByok();
      if (options.length > 0 && !options.some((o) => o.id === input.provider))
        return { ok: false, error: t(this.lang(), 'invalidRequest') };
      this.deps.logger.addSecret(input.apiKey);
      await this.deps
        .vault()
        .setSecret(
          SECRET_IDS.byok,
          t(this.lang(), 'secretByok', { name: this.providerName(input.provider) }),
          input.apiKey.trim(),
        );
      this.deps.events.emit({ type: 'vault.changed' });
      await this.apply({
        kind: 'byok',
        provider: input.provider,
        model: input.model,
        secretId: SECRET_IDS.byok,
      });
      return { ok: true, status: this.status() };
    } catch (err) {
      return {
        ok: false,
        error: t(this.lang(), 'providerSaveFailed', { message: errorMessage(err) }),
      };
    }
  }

  async setCustom(input: CustomProviderInput): Promise<LoginResult> {
    try {
      const vault = this.deps.vault();
      const apiKey = input.apiKey?.trim();
      if (apiKey) {
        this.deps.logger.addSecret(apiKey);
        await vault.setSecret(SECRET_IDS.custom, t(this.lang(), 'secretCustom'), apiKey);
      } else {
        await vault.deleteSecret(SECRET_IDS.custom).catch(() => {});
      }
      this.deps.events.emit({ type: 'vault.changed' });
      await this.apply({
        kind: 'custom',
        baseUrl: input.baseUrl.replace(/\/+$/, ''),
        api: input.api,
        model: input.model,
        ...(apiKey ? { secretId: SECRET_IDS.custom } : {}),
        ...capabilitiesOf(input),
      });
      return { ok: true, status: this.status() };
    } catch (err) {
      return {
        ok: false,
        error: t(this.lang(), 'providerSaveFailed', { message: errorMessage(err) }),
      };
    }
  }

  /** SA_PROVIDER: configure a custom endpoint at startup (e2e / demos). */
  async preconfigure(input: CustomProviderInput): Promise<void> {
    const current = this.config();
    if (
      current?.kind === 'custom' &&
      current.baseUrl === input.baseUrl.replace(/\/+$/, '') &&
      current.model === input.model &&
      current.api === input.api &&
      !!current.secretId === !!input.apiKey &&
      sameCapabilities(current, input)
    )
      return;
    const result = await this.setCustom(input);
    if (!result.ok) this.deps.logger.warn('SA_PROVIDER could not be applied');
  }

  /** Only BYOK and custom endpoints: the app version picks the model of the others. */
  async setModel(model: string): Promise<ProviderStatus> {
    const p = this.config();
    if (!p) throw new UserError(t(this.lang(), 'agentErrorNoProvider'), 'no_provider');
    if (p.kind !== 'byok' && p.kind !== 'custom') {
      throw new UserError(t(this.lang(), 'invalidRequest'), 'bad_request');
    }
    if (p.kind === 'byok') {
      await this.apply({ ...p, model });
      return this.status();
    }
    // Another model can do other things: what the server reports about it replaces what the
    // user set for the previous one.
    const { detected } = await this.probeSaved({ ...p, model });
    await this.apply({
      kind: 'custom',
      baseUrl: p.baseUrl,
      api: p.api,
      model,
      ...(p.secretId ? { secretId: p.secretId } : {}),
      ...detected,
    });
    return this.status();
  }

  /** `providers.probeCustom`: asks an endpoint the user is setting up (see probe.ts). */
  async probeCustom(input: CustomProbeInput): Promise<CustomProbeResult> {
    const apiKey = input.apiKey?.trim();
    if (apiKey) this.deps.logger.addSecret(apiKey);
    return probeCustomEndpoint(input, this.deps.fetch);
  }

  /** Probes the saved custom endpoint with its stored key. */
  private async probeSaved(
    p: Extract<ProviderConfig, { kind: 'custom' }>,
  ): Promise<CustomProbeResult> {
    const apiKey = p.secretId ? await this.deps.vault().getSecret(p.secretId) : undefined;
    return this.probeCustom({
      baseUrl: p.baseUrl,
      api: p.api,
      model: p.model,
      ...(apiKey ? { apiKey } : {}),
    });
  }

  async logout(): Promise<LogoutResult> {
    const p = this.config();
    let revoked = true;
    if (p) {
      const vault = this.deps.vault();
      if (p.kind === 'chatgpt') {
        const stored = await this.readOAuth('chatgpt');
        if (stored) revoked = await this.revokeChatGPT(stored.credential);
      }
      const secretId = secretIdOf(p);
      if (secretId) await vault.deleteSecret(secretId).catch(() => {});
      this.deps.events.emit({ type: 'vault.changed' });
    }
    this.oauthAccount = undefined;
    await this.apply(undefined);
    return { status: this.status(), ...(revoked ? {} : { chatgptStillConnected: true }) };
  }

  /** Ends a ChatGPT session at OpenAI (see revokeChatGPTCredential). False when that failed. */
  private async revokeChatGPT(credential: PiCredential): Promise<boolean> {
    try {
      await this.deps.lib.revokeChatGPTCredential(credential);
      return true;
    } catch (err) {
      this.deps.logger.warn('could not end the ChatGPT session', { error: errorMessage(err) });
      return false;
    }
  }

  /**
   * BYOK and custom endpoints: saves the user's Exa key for web research, or deletes it
   * with null. Agents read it on every Exa call, so running ones pick it up without a restart.
   */
  async setExaKey(apiKey: string | null): Promise<ProviderStatus> {
    if (!researchesWithExa(this.config())) {
      throw new UserError(t(this.lang(), 'invalidRequest'), 'bad_request');
    }
    const vault = this.deps.vault();
    const key = apiKey?.trim();
    if (key) {
      this.deps.logger.addSecret(key);
      await vault.setSecret(SECRET_IDS.exa, t(this.lang(), 'secretExa'), key);
    } else {
      await vault.deleteSecret(SECRET_IDS.exa);
    }
    this.deps.events.emit({ type: 'vault.changed' });
    this.emitStatus();
    return this.status();
  }

  // --- for agent processes -----------------------------------------------------------------

  /** Whether procedure agents research with the user's Exa key (`research.exa`). */
  researchesWithExa(): boolean {
    return researchesWithExa(this.config());
  }

  /**
   * `agent.exaKey`: the user's Exa key, only while a BYOK or custom endpoint is configured.
   * The agent host sends it to Exa and nowhere else.
   */
  async exaKey(): Promise<string | undefined> {
    if (!researchesWithExa(this.config())) return undefined;
    const key = await this.deps.vault().getSecret(SECRET_IDS.exa);
    if (key) this.deps.logger.addSecret(key);
    return key || undefined;
  }

  /**
   * Model section of the agent host config of a role (default: a procedure agent's, also used by
   * the scanner). Throws NoProviderError when not configured. BYOK and custom endpoints run every
   * role on the user's model.
   */
  async agentModel(role: AgentHostConfig['role'] = 'procedure'): Promise<AgentHostConfig['model']> {
    const p = this.config();
    if (!p) throw new NoProviderError();
    const assistant = this.deps.lib.assistantModels;
    switch (p.kind) {
      case 'chatgpt':
      case 'codex': {
        const provider = p.kind === 'chatgpt' ? 'openai' : 'openai-codex';
        if (role === 'assistant') return { provider, ...assistant.chatgpt };
        return { provider, id: p.kind === 'chatgpt' ? await this.chatgptModel() : this.modelOf(p) };
      }
      case 'voucher': {
        const baseUrl = await this.deps.state.voucherBaseUrl();
        if (!baseUrl) throw new NoProviderError();
        return {
          provider: VOUCHER_PROVIDER,
          ...(role === 'assistant' ? assistant.voucher : { id: this.modelOf(p) }),
          baseUrl,
          maxTokens: VOUCHER_MAX_TOKENS,
        };
      }
      case 'byok':
        return { provider: p.provider, id: p.model };
      case 'custom':
        return {
          provider: 'custom',
          id: p.model,
          baseUrl: p.baseUrl,
          api: p.api,
          ...capabilitiesOf(p),
        };
    }
  }

  /**
   * Author of the learnings a role's agents share: "<model id> · <reasoning level>" as the agent
   * runs it (custom endpoints without reasoning run at "off").
   */
  async agentAuthor(role: AgentHostConfig['role'] = 'procedure'): Promise<string> {
    const model = await this.agentModel(role);
    const level =
      model.provider === 'custom' && !model.reasoning
        ? 'off'
        : (model.thinkingLevel ?? DEFAULT_THINKING_LEVEL);
    return agentAuthor(model.id, level);
  }

  /**
   * The ChatGPT procedure model: the first of `chatgptModels` the account's plan offers (Plus has
   * no gpt-6.1-sol). Kept for an hour and shared by callers at the same time. When OpenAI can't
   * say, the app's default model, without asking again for a minute.
   */
  private async chatgptModel(): Promise<string> {
    const now = this.deps.clock().getTime();
    if (this.chatgptPick && now - this.chatgptPick.at < CHATGPT_MODELS_TTL_MS) {
      return this.chatgptPick.id;
    }
    if (this.chatgptPickFetch) return this.chatgptPickFetch;
    const fallback = this.deps.lib.defaultModels.chatgpt;
    if (now - this.chatgptPickFailedAt < CHATGPT_MODELS_RETRY_MS) return fallback;
    const generation = this.chatgptPickGeneration;
    const current = () => generation === this.chatgptPickGeneration;
    const lookup = (async () => {
      let category: string;
      try {
        const credential = await this.refreshCredential('openai');
        const access = credential?.access;
        if (typeof access === 'string' && access) {
          const ids = await fetchChatGPTModels(this.deps.fetch, access);
          const picked = pickChatGPTModel(ids, this.deps.lib.chatgptModels);
          if (!picked) this.deps.logger.warn('chatgpt model list has no known model');
          const id = picked ?? fallback;
          // Signed in again meanwhile: the list was the old account's, so ask for the new one.
          if (!current()) return this.chatgptModel();
          const shown = this.status().model;
          this.chatgptPick = { id, at: this.deps.clock().getTime() };
          if (shown !== id) this.emitStatus();
          return id;
        }
        category = 'no_credential';
      } catch (err) {
        // Model list errors carry a category; anything else came from the credential refresh.
        const listError = (err as { category?: unknown } | null)?.category;
        category = typeof listError === 'string' ? listError : 'credential';
      }
      this.deps.logger.warn('chatgpt model list unavailable', { category });
      if (current()) this.chatgptPickFailedAt = this.deps.clock().getTime();
      return fallback;
    })().finally(() => {
      if (this.chatgptPickFetch === lookup) this.chatgptPickFetch = undefined;
    });
    this.chatgptPickFetch = lookup;
    return lookup;
  }

  /** BYOK and custom endpoints keep the user's model; the others use this app version's. */
  private modelOf(p: ProviderConfig): string {
    switch (p.kind) {
      case 'chatgpt':
      case 'codex':
        return this.deps.lib.defaultModels.chatgpt;
      case 'voucher':
        return this.deps.lib.defaultModels.voucher;
      case 'byok':
      case 'custom':
        return p.model;
    }
  }

  private piProviderId(p: ProviderConfig): string {
    switch (p.kind) {
      case 'chatgpt':
        return 'openai';
      case 'codex':
        return 'openai-codex';
      case 'voucher':
        return VOUCHER_PROVIDER;
      case 'byok':
        return p.provider;
      case 'custom':
        return 'custom';
    }
  }

  /** `agent.credential`: only for the configured provider; null otherwise. */
  async credentialFor(providerId: string): Promise<PiCredential | null> {
    const p = this.config();
    if (!p || this.piProviderId(p) !== providerId) return null;
    const vault = this.deps.vault();
    if (isOAuth(p)) {
      const stored = await this.readOAuth(p.kind);
      if (!stored) return null;
      this.registerCredentialSecrets(stored.credential);
      return stored.credential;
    }
    const key = p.secretId ? await vault.getSecret(p.secretId) : undefined;
    if (key) {
      this.deps.logger.addSecret(key);
      return { type: 'api_key', key };
    }
    return p.kind === 'custom' ? { type: 'api_key', key: NO_KEY } : null;
  }

  /**
   * `agent.refreshCredential`: serialized across agent processes. If another process refreshed
   * meanwhile (the stored token is fresh), the stored credential is returned as is.
   */
  refreshCredential(providerId: string): Promise<PiCredential | null> {
    return this.refreshMutex.run(async () => {
      const p = this.config();
      if (!p || this.piProviderId(p) !== providerId) return null;
      if (!isOAuth(p)) return this.credentialFor(providerId);
      const stored = await this.readOAuth(p.kind);
      if (!stored) return null;
      const expires = Number(stored.credential.expires);
      if (Number.isFinite(expires) && expires - this.deps.clock().getTime() > 5 * 60_000)
        return stored.credential;
      const codex = this.deps.lib.codex;
      if (p.kind === 'codex' && !codex) return null;
      // A rotated refresh token is saved the moment it arrives: the old one is spent, so losing
      // the new one (an answer that then fails validation) would end the session.
      const saveRotated = async (refresh: string) => {
        this.deps.logger.addSecret(refresh);
        await this.writeOAuth(p.kind, { ...stored, credential: { ...stored.credential, refresh } });
      };
      const fresh =
        p.kind === 'codex'
          ? await codex!.refresh(stored.credential, saveRotated)
          : await this.deps.lib.refreshOAuthCredential(providerId, stored.credential, saveRotated);
      this.registerCredentialSecrets(fresh);
      await this.writeOAuth(p.kind, { ...stored, credential: fresh });
      return fresh;
    });
  }

  private registerCredentialSecrets(credential: PiCredential): void {
    for (const key of ['access', 'refresh', 'key', 'id_token']) {
      const value = credential[key];
      if (typeof value === 'string') this.deps.logger.addSecret(value);
    }
  }

  private async readOAuth(kind: OAuthKind): Promise<OAuthSecret | undefined> {
    const raw = await this.deps.vault().getSecret(OAUTH_SECRET_IDS[kind]);
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as OAuthSecret;
      if (parsed?.credential && typeof parsed.credential === 'object') return parsed;
    } catch {
      this.deps.logger.warn('stored OAuth credential is unreadable', { kind });
    }
    return undefined;
  }

  private async writeOAuth(kind: OAuthKind, value: OAuthSecret): Promise<void> {
    const label = t(this.lang(), kind === 'codex' ? 'secretCodex' : 'secretChatgpt');
    await this.deps.vault().setSecret(OAUTH_SECRET_IDS[kind], label, JSON.stringify(value));
    this.deps.events.emit({ type: 'vault.changed' });
  }
}
