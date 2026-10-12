import { networkInterfaces } from 'node:os';
import {
  DesktopPairing,
  type PairingStatus,
  type PhoneKey,
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
  type DnieSignaturePrompt,
  type ExternalSigningKey,
  type Language,
  type SignatureBinding,
  type SignatureDigest,
} from '@sa/shared';
import { SidecarError, type SidecarHash, type SidecarIdentity } from '@sa/sidecar';
import type { PromptManager } from '../chat/prompts';
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

  shutdown(): void {
    this.endLogin?.();
    this.signer.onEnded('unpaired');
    const pairing = this.pairing;
    this.pairing = undefined;
    pairing?.unpair();
  }

  /**
   * A signature with the DNIe in the phone: shows the progress card (with the QR code when no
   * phone is connected), sends the request, and resolves with the key once the phone has read
   * the card's certificate. Null when the user cancels, declines or it fails (with a notice).
   *
   * `pin`: the caller has the approval the credential's policy asks for this use, so the request
   * carries the PIN saved in Mis datos, if there is one the card hasn't refused (D18).
   */
  async approve(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    credential: CredentialSummary,
    options: {
      pin?: boolean;
      login?: { signal?: AbortSignal; onCancelled?: () => void };
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
      { label: t(lang, 'detailFor'), value: host },
    ];
    if (summary.format)
      details.push({
        label: t(lang, 'detailFormat'),
        value: `${summary.format} · ${summary.algorithm}`.slice(0, 500),
      });
    if (summary.dataSize !== undefined && purpose === 'document' && !summary.signatures)
      details.push({ label: t(lang, 'detailSize'), value: formatBytes(summary.dataSize) });
    // Reading certificates needs no PIN.
    const pin =
      options.pin && purpose !== 'certificate' ? await this.savedPin(credential) : undefined;
    let prompt: DnieSignaturePrompt = {
      kind: 'dnie_signature',
      purpose,
      title: t(lang, login ? 'dnieLoginTitle' : 'dnieSignatureTitle'),
      message: t(
        lang,
        login
          ? 'dnieLoginMessage'
          : purpose === 'certificate'
            ? 'dnieCertificateMessage'
            : pin
              ? 'dnieSignatureMessageSavedPin'
              : 'dnieSignatureMessage',
        { host },
      ),
      details,
      stage: 'phone',
      ...(pin ? { savedPin: true } : {}),
    };

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
    const settle = (outcome: 'signed' | 'failed' | 'cancelled') => {
      login?.signal?.removeEventListener('abort', cancel);
      if (itemId) deps.prompts.settle(itemId, { kind: 'dnie_signature', outcome });
    };

    const can = this.savedCan();
    // The card refused the PIN (the phone asks the user now), or is blocked: stop sending it.
    const refused = (err: unknown) => {
      if (err instanceof PhoneSignError && err.code === 'pin_blocked')
        void this.pinRefused(credential, pin);
      return err;
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
        ...(can ? { can } : {}),
        ...(pin ? { pin, onWrongPin: () => void this.pinRefused(credential, pin) } : {}),
        signal: abort.signal,
        onStage: (stage) => {
          prompt = { ...prompt, stage };
          if (itemId) deps.prompts.update(itemId, prompt);
        },
      });
    } catch (err) {
      refused(err);
      const code: PhoneSignErrorCode = err instanceof PhoneSignError ? err.code : 'internal';
      deps.logger.info('dnie signature not approved', { procedureId, code });
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
        key.sign(data, ALGORITHMS[digest], toCheck(binding), !!login).catch((err) => {
          throw refused(err);
        }),
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
   * `browser.useCertificate` has applied the credential's policy (its consent, with Touch ID),
   * so every approval request of this login carries the saved PIN (D18).
   */
  async login(
    procedureId: string,
    credential: CredentialSummary,
    origin: string,
  ): Promise<SidecarIdentity | null> {
    this.endLogin?.();
    let active: ExternalSigningKey | undefined;
    let currentOrigin = origin;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let preparing: Promise<void> | undefined;
    let chain: Uint8Array[] | undefined;
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
      const key = await this.approve(
        procedureId,
        {
          method: 'selectCertificate',
          origin: site,
          description: t(this.deps.lang(), 'dnieLoginMessage', { host: hostOf(site) }),
          format: '',
          algorithm: 'SHA256withRSA',
          documents: [],
          verifiable: false,
        },
        credential,
        { pin: true, login: { signal, onCancelled: () => end(false) } },
      );
      if (!key) throw new SidecarError('declined', 'DNIe login was not approved.');
      if (chain && !Buffer.from(chain[0]!).equals(Buffer.from(key.certificates[0]!))) {
        key.release(false);
        throw new SidecarError('wrong_card', 'Use the same DNIe for this login.');
      }
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
          const site = new URL(currentOrigin).hostname === host ? currentOrigin : `https://${host}`;
          if (active && new URL(currentOrigin).hostname !== host) end();
          if (!active) {
            preparing ??= acquire(site, signal).finally(() => {
              preparing = undefined;
            });
            await preparing;
          }
          idle();
        },
        sign: async (digest, hash, host, signal) => {
          if (signal.aborted || !active || new URL(currentOrigin).hostname !== host)
            throw new SidecarError('declined', 'DNIe login approval ended.');
          clearTimeout(timer);
          const cancel = () => end(false);
          signal.addEventListener('abort', cancel, { once: true });
          try {
            return Buffer.from(await active.sign(digest, TLS_ALGORITHMS[hash]));
          } catch {
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

  /** The DNI's CAN from Mis datos, so the phone doesn't ask for it. Never logged. */
  private savedCan(): string | undefined {
    try {
      const can = this.deps.vault().getPersonal('dniAccessNumber')?.value;
      return DniAccessNumber.safeParse(can).success ? can : undefined;
    } catch {
      // The vault can't be read: the phone asks for the CAN itself.
      return undefined;
    }
  }

  /** The DNIe PIN from Mis datos, unless the card refused it. Never logged. */
  private async savedPin(credential: CredentialSummary): Promise<string | undefined> {
    try {
      const secret = await this.deps.vault().getCredentialSecret(credential.id);
      if (secret.kind !== 'dnie' || !secret.pin) return undefined;
      this.deps.logger.addSecret(secret.pin);
      return secret.pin;
    } catch {
      // The vault can't be read: the phone asks for the PIN itself.
      return undefined;
    }
  }

  /**
   * The card refused the saved PIN, or is blocked: Mis datos shows it, and it isn't sent again
   * until the user saves a new one. `sent`: the PIN the request carried (else the saved one).
   */
  private async pinRefused(credential: CredentialSummary, sent: string | undefined): Promise<void> {
    try {
      const pin = sent ?? (await this.savedPin(credential));
      if (!pin || !(await this.deps.vault().markDniePinWrong(credential.id, pin))) return;
      this.deps.logger.info('dnie saved PIN refused by the card');
      this.deps.events.emit({ type: 'vault.changed' });
    } catch (err) {
      this.deps.logger.warn('dnie saved PIN not marked', { error: errorMessage(err) });
    }
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
