import { networkInterfaces } from 'node:os';
import { certificateSite } from '@sa/browser';
import {
  DesktopPairing,
  type PairingStatus,
  type PhoneKey,
  type PhoneNeed,
  PhoneSignError,
  type PhoneSignErrorCode,
  PhoneSigner,
  type RelaySocketOptions,
} from '@sa/companion';
import {
  type AfirmaSignatureSummary,
  type CompanionAlgorithm,
  type CompanionCheck,
  type CompanionStatus,
  type CredentialSummary,
  DniAccessNumber,
  DniePin,
  type DnieSignaturePrompt,
  type DnieUnlock,
  type DnieUnlockValues,
  type ExternalSigningKey,
  type Language,
  type SignatureBinding,
  type SignatureDigest,
} from '@sa/shared';
import { SidecarError, type SidecarHash, type SidecarIdentity } from '@sa/sidecar';
import type { PromptManager } from '../chat/prompts';
import { UserError } from '../core/errors';
import type { EventBus } from '../core/events';
import { type StringKey, t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage, formatBytes, hostOf } from '../core/util';
import type { SignerLib, VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';

export interface CompanionDeps {
  /** ws(s):// or http(s):// base URL of the relay; undefined = DNIe signing unavailable. */
  relayUrl?: string;
  /** Development: put this machine's LAN address in the QR when the relay is on loopback. */
  lanRelay?: boolean;
  appVersion: string;
  events: EventBus;
  prompts: PromptManager;
  procedures: ProcedureService;
  vault: () => VaultPort;
  /** Parses the card's certificate for Mis datos (from `@sa/signer`). */
  certificateInfo?: SignerLib['certificateInfo'];
  logger: Logger;
  lang: () => Language;
  /** Tests: the relay socket (e.g. `@sa/companion/testing`'s MemoryRelay). */
  socket?: RelaySocketOptions['WebSocket'];
}

/** Close the phone approval after a quiet period, before its next-item timeout. */
export const DNIE_LOGIN_IDLE_MS = 30_000;

/** A `dnie_signature` prompt waiting in its `unlock` stage. */
interface UnlockWaiter {
  unlock: DnieUnlock;
  resolve(values: { can?: string; pin?: string }): void;
}

const TLS_ALGORITHMS: Record<SidecarHash, SignatureDigest> = {
  'SHA-1': 'sha1',
  'SHA-256': 'sha256',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
};

const ALGORITHMS: Record<SignatureDigest, CompanionAlgorithm> = {
  sha1: 'SHA1withRSA',
  sha256: 'SHA256withRSA',
  sha384: 'SHA384withRSA',
  sha512: 'SHA512withRSA',
};

/** What the user reads when the phone did not sign (declines and cancels show nothing). */
const NOTICES: Partial<Record<PhoneSignErrorCode, StringKey>> = {
  pin_blocked: 'dnieError_pin_blocked',
  card_unsupported: 'dnieError_card_unsupported',
  no_certificate: 'dnieError_no_certificate',
  certificate_expired: 'dnieError_certificate_expired',
  wrong_card: 'dnieError_wrong_card',
  binding_mismatch: 'dnieError_binding_mismatch',
  nfc_unavailable: 'dnieError_nfc_unavailable',
  timeout: 'dnieError_timeout',
  busy: 'dnieError_busy',
  unpaired: 'dnieError_unpaired',
  expired: 'dnieError_expired',
};

/** Why a DNIe login wasn't approved, for the agent. */
const LOGIN_REFUSALS: Partial<Record<PhoneSignErrorCode, string>> = {
  rejected: 'the user declined it on the phone',
  cancelled: 'the user cancelled it',
  timeout: 'nobody approved it in time',
  pin_blocked: 'the DNIe PIN is blocked',
  wrong_card: 'a different DNIe was held to the phone',
  unpaired: 'the phone was unpaired',
  expired: 'the phone pairing expired',
};

/** "Seguridad Social (idp.seg-social.es, ipce.seg-social.es…)", or just the host. */
function siteLabel(host: string): string {
  const site = certificateSite(host);
  return site.name === host ? host : `${site.name} (${site.hosts.join(', ')})`;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** A loopback relay seen from the phone: the same port on this machine's LAN address. */
export function lanRelayUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (!LOOPBACK.has(url.hostname)) return relayUrl;
  for (const addresses of Object.values(networkInterfaces())) {
    const lan = addresses?.find((a) => a.family === 'IPv4' && !a.internal);
    if (lan) {
      url.hostname = lan.address;
      return url.toString().replace(/\/+$/, '');
    }
  }
  return relayUrl;
}

function toCheck(binding: SignatureBinding | undefined): CompanionCheck | undefined {
  if (!binding) return undefined;
  if (binding.kind === 'cms') return binding;
  return {
    kind: 'pades',
    document: binding.document,
    update: Buffer.from(binding.update).toString('base64'),
    byteRange: binding.byteRange,
  };
}

/**
 * The pairing with the phone app and signatures with the DNIe in it (`@sa/companion`). One
 * pairing at a time, created on demand (a signature, or "Vincular móvil"). The QR link stays in
 * memory: the renderer gets it through `companion.status`, never in a saved prompt.
 */
export class CompanionService {
  private pairing?: DesktopPairing;
  private endLogin?: () => void;
  private readonly signer: PhoneSigner;
  private readonly relayUrl?: string;
  /** The CAN the user typed, while the app runs. */
  private can?: string;
  /** CANs the card refused: not offered again while the app runs (also Mis datos' one). */
  private readonly refusedCans = new Set<string>();
  private readonly unlocks = new Map<string, UnlockWaiter>();
  /** DNIe login news for each procedure's agent (`takeLoginNotes`). */
  private readonly logins = new Map<string, { waiting?: string; notes: string[] }>();

  constructor(private readonly deps: CompanionDeps) {
    this.relayUrl = deps.relayUrl && deps.lanRelay ? lanRelayUrl(deps.relayUrl) : deps.relayUrl;
    this.signer = new PhoneSigner({ send: (m) => this.pairing?.send(m) ?? false });
  }

  status(): CompanionStatus {
    if (!this.relayUrl) return { state: 'unavailable' };
    const pairing = this.pairing;
    if (!pairing) return { state: 'off' };
    return this.describe(pairing, pairing.status);
  }

  /** Starts a pairing (a new QR code) unless one is active. */
  pair(): CompanionStatus {
    if (!this.relayUrl) return { state: 'unavailable' };
    if (!this.pairing) this.start(this.relayUrl);
    return this.status();
  }

  unpair(): CompanionStatus {
    this.endLogin?.();
    const pairing = this.pairing;
    this.pairing = undefined;
    pairing?.unpair();
    this.signer.onEnded('unpaired');
    this.emit();
    return this.status();
  }

  /**
   * What the user typed in a pending prompt's `unlock` stage (`companion.unlock`). It must hold
   * what the prompt asks for. Validated by the IPC schema; never logged.
   */
  unlock(itemId: string, values: DnieUnlockValues): void {
    const lang = this.deps.lang();
    const waiter = this.unlocks.get(itemId);
    if (!waiter) throw new UserError(t(lang, 'promptNotPending'), 'not_pending');
    if (values.pin) this.deps.logger.addSecret(values.pin);
    const can = DniAccessNumber.safeParse(values.can).success ? values.can : undefined;
    const pin = DniePin.safeParse(values.pin).success ? values.pin : undefined;
    if ((waiter.unlock.can && !can) || (waiter.unlock.pin && !pin))
      throw new UserError(t(lang, 'dnieUnlockMissing'), 'invalid_input');
    this.unlocks.delete(itemId);
    waiter.resolve({
      ...(waiter.unlock.can ? { can } : {}),
      ...(waiter.unlock.pin ? { pin } : {}),
    });
  }

  shutdown(): void {
    this.endLogin?.();
    this.signer.onEnded('unpaired');
    const pairing = this.pairing;
    this.pairing = undefined;
    pairing?.unpair();
  }

  /**
   * A signature with the DNIe in the phone: shows the card, which first asks for the CAN and the
   * PIN when the desktop doesn't have them (D20), then the QR code when no phone is connected,
   * sends the request, and resolves with the key once the phone has read the card's
   * certificate. Null when the user cancels, declines or it fails (with a notice).
   */
  async approve(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    credential: CredentialSummary,
    options: {
      login?: {
        /** What the user approves: the login's site, with all its hosts. */
        site: string;
        signal?: AbortSignal;
        onCancelled?: () => void;
        onRefused?: (code: PhoneSignErrorCode) => void;
      };
    } = {},
  ): Promise<ExternalSigningKey | null> {
    const { login } = options;
    if (!login) this.endLogin?.();
    const { deps } = this;
    const lang = deps.lang();
    const host = hostOf(summary.origin);
    if (!this.relayUrl) {
      deps.procedures.addNotice(procedureId, 'warning', t(lang, 'dnieUnavailable'));
      return null;
    }
    this.pair();
    const purpose = login
      ? 'login'
      : summary.method === 'selectCertificate'
        ? 'certificate'
        : 'document';
    const details: { label: string; value: string }[] = [
      { label: t(lang, 'detailWhat'), value: summary.description.slice(0, 500) },
      { label: t(lang, 'detailFor'), value: login?.site ?? host },
    ];
    if (summary.format)
      details.push({
        label: t(lang, 'detailFormat'),
        value: `${summary.format} · ${summary.algorithm}`.slice(0, 500),
      });
    if (summary.dataSize !== undefined && purpose === 'document' && !summary.signatures)
      details.push({ label: t(lang, 'detailSize'), value: formatBytes(summary.dataSize) });
    // Reading the certificate needs no PIN.
    const needsPin = purpose !== 'certificate';
    let can = this.knownCan();
    let pin = needsPin ? await this.savedPin(credential) : undefined;
    // A PIN the user typed goes into the vault once the card accepts it (the first signature).
    let typedPin = false;
    const first: DnieUnlock = { can: !can, pin: needsPin && !pin };
    const base: DnieSignaturePrompt = {
      kind: 'dnie_signature',
      purpose,
      title: t(lang, login ? 'dnieLoginTitle' : 'dnieSignatureTitle'),
      message: t(
        lang,
        login
          ? 'dnieLoginMessage'
          : purpose === 'certificate'
            ? 'dnieCertificateMessage'
            : 'dnieSignatureMessage',
        { host: login?.site ?? host },
      ),
      details,
      stage: 'phone',
    };
    let prompt: DnieSignaturePrompt =
      first.can || first.pin ? { ...base, stage: 'unlock', unlock: first } : base;

    let itemId: string | undefined;
    const abort = new AbortController();
    const cancel = () => {
      abort.abort();
      login?.onCancelled?.();
    };
    login?.signal?.addEventListener('abort', cancel, { once: true });
    if (login?.signal?.aborted) abort.abort();
    deps.prompts.ask(procedureId, prompt, { onShown: (id) => (itemId = id) }).then(
      (answer) => {
        if (answer.kind === 'dnie_signature' && answer.outcome === 'cancelled') cancel();
      },
      // The procedure stopped or the app quits.
      () => cancel(),
    );
    const show = (next: DnieSignaturePrompt) => {
      prompt = next;
      if (itemId) deps.prompts.update(itemId, prompt);
    };
    const settle = (outcome: 'signed' | 'failed' | 'cancelled') => {
      login?.signal?.removeEventListener('abort', cancel);
      if (itemId) deps.prompts.settle(itemId, { kind: 'dnie_signature', outcome });
    };

    if (prompt.stage === 'unlock') {
      const typed = await this.waitUnlock(itemId, first, abort.signal);
      if (!typed) {
        settle('cancelled');
        login?.onRefused?.('cancelled');
        return null;
      }
      can = typed.can ?? can;
      if (typed.pin) {
        pin = typed.pin;
        typedPin = true;
      }
      show(base);
    }

    // The phone needs a new CAN or PIN: the card refused it (never offered again), or a request
    // sent again after a reconnect came without the PIN. The user types it here.
    const onNeed = async (need: PhoneNeed): Promise<string | null> => {
      if (need.what === 'can') this.canRefused(can);
      else if (need.refused && !typedPin) await this.forgetPin(credential);
      const unlock: DnieUnlock = {
        can: need.what === 'can',
        pin: need.what === 'pin',
        ...(need.refused ? { refused: need.what } : {}),
        ...(need.triesLeft ? { triesLeft: need.triesLeft } : {}),
      };
      deps.logger.info('dnie needs a new value', { procedureId, what: need.what });
      show({ ...base, stage: 'unlock', unlock });
      const typed = await this.waitUnlock(itemId, unlock, abort.signal);
      if (!typed) return null;
      show({ ...base, stage: 'card' });
      if (need.what === 'can') {
        can = typed.can;
        return can ?? null;
      }
      pin = typed.pin;
      typedPin = true;
      return pin ?? null;
    };

    let key: PhoneKey;
    try {
      key = await this.signer.request({
        purpose,
        origin: summary.origin,
        description: summary.description,
        format: summary.format,
        documents: summary.documents,
        verifiable: summary.verifiable,
        ...(summary.signatures ? { signatures: summary.signatures } : {}),
        can: can as string,
        ...(pin ? { pin } : {}),
        onNeed,
        signal: abort.signal,
        onStage: (stage) => show({ ...base, stage }),
      });
    } catch (err) {
      const code: PhoneSignErrorCode = err instanceof PhoneSignError ? err.code : 'internal';
      if (code === 'pin_blocked') await this.forgetPin(credential);
      deps.logger.info('dnie signature not approved', { procedureId, code });
      login?.onRefused?.(code);
      const declined = code === 'cancelled' || code === 'rejected';
      settle(declined ? 'cancelled' : 'failed');
      if (!declined) {
        deps.procedures.addNotice(
          procedureId,
          'warning',
          t(lang, NOTICES[code] ?? 'dnieError_failed'),
        );
      }
      return null;
    }

    if (!login) await this.remember(credential, key.certificates[0] as Buffer);
    deps.logger.info('dnie signature approved', { procedureId, host, format: summary.format });
    let released = false;
    return {
      kind: 'external',
      credentialId: credential.id,
      certificates: key.certificates,
      sign: (data, digest, binding) =>
        key.sign(data, ALGORITHMS[digest], toCheck(binding), !!login).then(
          async (signature) => {
            if (typedPin && pin) {
              typedPin = false;
              await this.savePin(credential, pin);
            }
            return signature;
          },
          async (err) => {
            if (err instanceof PhoneSignError && err.code === 'pin_blocked')
              await this.forgetPin(credential);
            throw err;
          },
        ),
      release: (ok) => {
        if (released) return;
        released = true;
        key.finish(ok);
        settle(abort.signal.aborted ? 'cancelled' : ok ? 'signed' : 'failed');
        if (!ok && !abort.signal.aborted)
          deps.procedures.addNotice(procedureId, 'warning', t(lang, 'dnieError_failed'));
      },
    };
  }

  /**
   * Authentication key for the browser sidecar; the private key stays on the phone. Called once
   * `browser.useCertificate` has applied the credential's policy (its consent, without Touch ID).
   * One phone approval covers the hosts of one site (`certificateSite`): a login that hops
   * between them signs every handshake with the card already on the phone. Another site asks
   * again.
   */
  async login(
    procedureId: string,
    credential: CredentialSummary,
    origin: string,
  ): Promise<SidecarIdentity | null> {
    this.endLogin?.();
    const { logger } = this.deps;
    let active: ExternalSigningKey | undefined;
    let currentOrigin = origin;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preparing: Promise<void> | undefined;
    let chain: Uint8Array[] | undefined;
    const siteOf = (host: string) => certificateSite(host).id;
    const sameSite = (host: string) => siteOf(new URL(currentOrigin).hostname) === siteOf(host);
    const end = (ok = true) => {
      clearTimeout(timer);
      timer = undefined;
      active?.release(ok);
      active = undefined;
    };
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => end(), DNIE_LOGIN_IDLE_MS);
      timer.unref();
    };
    const acquire = async (site: string, signal?: AbortSignal) => {
      this.endLogin?.();
      const label = siteLabel(hostOf(site));
      this.loginNews(procedureId).waiting = label;
      let refused: PhoneSignErrorCode | undefined;
      const key = await this.approve(
        procedureId,
        {
          method: 'selectCertificate',
          origin: site,
          description: t(this.deps.lang(), 'dnieLoginMessage', { host: label }),
          format: '',
          algorithm: 'SHA256withRSA',
          documents: [],
          verifiable: false,
        },
        credential,
        {
          login: {
            site: label,
            signal,
            onCancelled: () => end(false),
            onRefused: (code) => {
              refused = code;
            },
          },
        },
      ).finally(() => {
        const news = this.logins.get(procedureId);
        if (news?.waiting === label) news.waiting = undefined;
      });
      if (!key) {
        const why =
          (refused && LOGIN_REFUSALS[refused]) ?? `it failed (${refused ?? 'unavailable'})`;
        this.loginNews(procedureId).notes.push(
          `The DNIe login for ${label} was not approved: ${why}.`,
        );
        throw new SidecarError('declined', 'DNIe login was not approved.');
      }
      if (chain && !Buffer.from(chain[0]!).equals(Buffer.from(key.certificates[0]!))) {
        key.release(false);
        this.loginNews(procedureId).notes.push(
          `The DNIe login for ${label} failed: the user held a different DNIe than for the previous login.`,
        );
        throw new SidecarError('wrong_card', 'Use the same DNIe for this login.');
      }
      this.loginNews(procedureId).notes.push(
        `The user approved the DNIe login for ${label} on their phone.`,
      );
      chain = key.certificates;
      active = key;
      currentOrigin = site;
      this.endLogin = end;
      idle();
    };
    try {
      await acquire(origin);
    } catch {
      return null;
    }
    return {
      id: credential.id,
      chain: chain!,
      key: {
        prepare: async (host, signal) => {
          if (signal.aborted) throw new SidecarError('declined');
          if (active && !sameSite(host)) end();
          if (!active) {
            const site =
              new URL(currentOrigin).hostname === host ? currentOrigin : `https://${host}`;
            preparing ??= acquire(site, signal).finally(() => {
              preparing = undefined;
            });
            await preparing;
          }
          idle();
        },
        sign: async (digest, hash, host, signal) => {
          if (signal.aborted || !active || !sameSite(host))
            throw new SidecarError('declined', 'DNIe login approval ended.');
          clearTimeout(timer);
          const cancel = () => end(false);
          signal.addEventListener('abort', cancel, { once: true });
          try {
            return Buffer.from(await active.sign(digest, TLS_ALGORITHMS[hash]));
          } catch (err) {
            const code = err instanceof PhoneSignError ? err.code : 'internal';
            logger.warn('dnie login signature failed', { procedureId, host, code });
            this.loginNews(procedureId).notes.push(
              `The phone could not sign the DNIe login for ${host} (${code}). Ask the user to keep the DNIe on the phone, then start the login again from the site.`,
            );
            end(false);
            throw new SidecarError('failed', 'The phone could not complete the login.');
          } finally {
            signal.removeEventListener('abort', cancel);
            if (active) idle();
          }
        },
      },
    };
  }

  /**
   * What happened to the procedure's DNIe logins since the last call, and whether one waits for
   * the user on the phone: notes for the agent's next browser observation.
   */
  takeLoginNotes(procedureId: string): string[] {
    const news = this.logins.get(procedureId);
    if (!news) return [];
    const notes = news.notes.splice(0);
    if (news.waiting)
      notes.push(
        `Waiting for the user to approve the DNIe login for ${news.waiting} on their phone. The page may not change until then: use browser_wait instead of clicking again.`,
      );
    else this.logins.delete(procedureId);
    return notes;
  }

  private loginNews(procedureId: string): { waiting?: string; notes: string[] } {
    let news = this.logins.get(procedureId);
    if (!news) {
      news = { notes: [] };
      this.logins.set(procedureId, news);
    }
    return news;
  }

  /**
   * The CAN the user typed, or Mis datos' one (scanned with the DNI), unless the card refused it.
   * Never logged.
   */
  private knownCan(): string | undefined {
    if (this.can) return this.can;
    try {
      const can = this.deps.vault().getPersonal('dniAccessNumber')?.value;
      return can && DniAccessNumber.safeParse(can).success && !this.refusedCans.has(can)
        ? can
        : undefined;
    } catch {
      // The vault can't be read: the user types it.
      return undefined;
    }
  }

  private canRefused(can: string | undefined): void {
    if (!can) return;
    this.refusedCans.add(can);
    if (this.can === can) this.can = undefined;
  }

  /** The PIN saved on the DNIe credential (D22). Never logged. */
  private async savedPin(credential: CredentialSummary): Promise<string | undefined> {
    try {
      const secret = await this.deps.vault().getCredentialSecret(credential.id);
      const pin = secret.kind === 'dnie' ? secret.pin : undefined;
      if (!pin || !DniePin.safeParse(pin).success) return undefined;
      this.deps.logger.addSecret(pin);
      return pin;
    } catch {
      // The vault can't be read: the user types it.
      return undefined;
    }
  }

  private async savePin(credential: CredentialSummary, pin: string): Promise<void> {
    try {
      await this.deps.vault().setDniePin(credential.id, pin);
      this.deps.events.emit({ type: 'vault.changed' });
    } catch (err) {
      this.deps.logger.warn('dnie pin not saved', { error: errorMessage(err) });
    }
  }

  /** The card refused the saved PIN, or blocked: it isn't sent again until the user saves one. */
  private async forgetPin(credential: CredentialSummary): Promise<void> {
    try {
      if (!this.deps.vault().getCredential(credential.id)?.hasPin) return;
      await this.deps.vault().setDniePin(credential.id, null);
      this.deps.events.emit({ type: 'vault.changed' });
    } catch (err) {
      this.deps.logger.warn('dnie pin not forgotten', { error: errorMessage(err) });
    }
  }

  /**
   * Waits for `companion.unlock` on the prompt, and remembers the CAN the user typed while the
   * app runs. Null when the request is cancelled first.
   */
  private waitUnlock(
    itemId: string | undefined,
    unlock: DnieUnlock,
    signal: AbortSignal,
  ): Promise<{ can?: string; pin?: string } | null> {
    if (!itemId || signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this.unlocks.get(itemId)?.resolve === done) this.unlocks.delete(itemId);
        resolve(null);
      };
      const done = (values: { can?: string; pin?: string }) => {
        signal.removeEventListener('abort', onAbort);
        if (values.can) {
          this.refusedCans.delete(values.can);
          this.can = values.can;
        }
        resolve(values);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.unlocks.set(itemId, { unlock, resolve: done });
    });
  }

  /** Keeps the card's certificate details on the credential (shown in Mis datos). */
  private async remember(credential: CredentialSummary, certificate: Buffer): Promise<void> {
    const vault = this.deps.vault();
    try {
      const info = this.deps.certificateInfo?.(certificate);
      if (info && credential.certificate?.fingerprint !== info.fingerprint)
        await vault.setDnieCertificate(credential.id, info);
    } catch (err) {
      this.deps.logger.warn('dnie certificate not saved', { error: errorMessage(err) });
    }
    try {
      await vault.markCredentialUsed(credential.id);
      this.deps.events.emit({ type: 'vault.changed' });
    } catch (err) {
      this.deps.logger.warn('dnie credential not updated', { error: errorMessage(err) });
    }
  }

  private start(relayUrl: string): void {
    const { deps } = this;
    const pairing = new DesktopPairing({
      relayUrl,
      appVersion: deps.appVersion,
      onStatus: (status) => {
        if (this.pairing !== pairing) return;
        if (status.state === 'ended') {
          this.pairing = undefined;
          this.signer.onEnded(status.reason === 'expired' ? 'expired' : 'unpaired');
        }
        this.emit();
      },
      onMessage: (message) => {
        if (this.pairing === pairing) this.signer.onMessage(message);
      },
      onSession: () => {
        if (this.pairing === pairing) this.signer.onSession();
      },
      log: (message, fields) => deps.logger.info(message, fields),
      ...(deps.socket ? { socket: { WebSocket: deps.socket } } : {}),
    });
    this.pairing = pairing;
    deps.logger.info('companion pairing started', { relay: new URL(relayUrl).host });
    this.emit();
  }

  private describe(pairing: DesktopPairing, status: PairingStatus): CompanionStatus {
    const expiresAt = new Date(pairing.expiresAt).toISOString();
    switch (status.state) {
      case 'connected':
        return { state: 'connected', device: status.phone.device, expiresAt };
      case 'away':
        return { state: 'away', device: status.phone.device, link: pairing.link, expiresAt };
      case 'waiting':
        return { state: 'waiting', link: pairing.link, expiresAt };
      case 'connecting':
        return {
          state: 'connecting',
          link: pairing.link,
          expiresAt,
          ...(status.phone ? { device: status.phone.device } : {}),
        };
      case 'ended':
        return { state: 'off' };
    }
  }

  private emit(): void {
    this.deps.events.emit({ type: 'companion.changed', status: this.status() });
  }
}
