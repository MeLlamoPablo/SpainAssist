/**
 * Desktop: signatures with the DNIe in the paired phone. One request at a time.
 *
 * `request()` sends `sign.request` (with the CAN and the PIN the user typed on the desktop) and
 * resolves with a `PhoneKey` once the phone has read the card's certificate (the user approved
 * and held the card to the phone). When the card refuses the CAN or the PIN, the phone asks for
 * a new one (`sign.need`): `onNeed` gets it from the user and it goes as `sign.unlock`. Each
 * `key.sign()` is a `sign.toBeSigned` → `sign.signature` round trip while the card stays near
 * the phone; `key.finish()` ends the request.
 *
 * Connections drop (phone asleep, network change, app restarted): everything the phone hasn't
 * answered stays in an outbox and is sent again when the next session starts. Both sides
 * ignore duplicates (same request id, same seq), so re-sending is always safe.
 */
import crypto from 'node:crypto';
import {
  COMPANION_MAX_DOCUMENT_BYTES,
  type CompanionAlgorithm,
  type CompanionCheck,
  type CompanionDocument,
  type CompanionErrorCode,
  type CompanionNeed,
  type CompanionPurpose,
  type CompanionStage,
  type DesktopToPhone,
  type PhoneToDesktop,
} from '@sa/shared';

export type PhoneSignErrorCode = CompanionErrorCode | 'unpaired' | 'expired';

export class PhoneSignError extends Error {
  constructor(
    readonly code: PhoneSignErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface PhoneDocument {
  name?: string;
  mimeType: string;
  data: Uint8Array;
}

export interface PhoneSignRequest {
  purpose: CompanionPurpose;
  origin: string;
  description: string;
  format: string;
  documents: PhoneDocument[];
  /** Every `sign()` will carry a `check` (see `CompanionSignRequest.verifiable`). */
  verifiable: boolean;
  signatures?: number;
  /** The DNI's CAN (6 digits). */
  can: string;
  /** The DNIe PIN (D20); left out for `certificate` requests. */
  pin?: string;
  /**
   * The phone needs a new CAN or PIN (the card refused it, or a re-sent request came without
   * it). Resolves with what the user typed, or null to cancel the request. The request's timers
   * wait meanwhile. Without it, the request ends with `cancelled`.
   */
  onNeed?(need: PhoneNeed): Promise<string | null>;
  /** Time to review and read the card. Default 5 minutes. */
  reviewTimeoutMs?: number;
  signal?: AbortSignal;
  onStage?(stage: CompanionStage): void;
}

export interface PhoneNeed {
  what: CompanionNeed;
  /** The card refused the one the phone had (else the request came without it). */
  refused: boolean;
  /** PIN tries the card has left after a wrong PIN. */
  triesLeft?: number;
}

export interface PhoneKey {
  /** DER, leaf first. */
  certificates: Buffer[];
  sign(
    data: Uint8Array,
    algorithm: CompanionAlgorithm,
    check?: CompanionCheck,
    prehashed?: boolean,
  ): Promise<Buffer>;
  /** Tells the phone the operation is over: `true` = signed, `false` = failed. */
  finish(ok: boolean): void;
}

export interface PhoneLinkPort {
  send(message: DesktopToPhone): boolean;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface Active {
  id: string;
  /** Unanswered messages, in sending order. */
  outbox: Map<string, DesktopToPhone>;
  verifiable: boolean;
  certificates?: Buffer[];
  certificate: Waiter<Buffer[]>;
  signatures: Map<number, Waiter<Buffer> & { timer: ReturnType<typeof setTimeout> | undefined }>;
  nextSeq: number;
  reviewMs: number;
  timer?: ReturnType<typeof setTimeout>;
  onStage?(stage: CompanionStage): void;
  onNeed?(need: PhoneNeed): Promise<string | null>;
  /** Waiting for the user to type what the phone needs: timers stopped. */
  needing: boolean;
  cleanup(): void;
}

const SIGNATURE_TIMEOUT_MS = 90_000;

/**
 * Removes the PIN from the request kept for re-sending, and an answered `sign.unlock`: they go
 * once, so a phone that joins later never gets them.
 */
function dropSecrets(active: Active, message: PhoneToDesktop): void {
  const request = active.outbox.get('request');
  if (request?.type === 'sign.request' && request.pin) {
    const { pin: _sent, ...rest } = request;
    active.outbox.set('request', rest);
  }
  // A `sign.need` re-sent after a reconnect doesn't answer the unlock; anything else does.
  if (message.type !== 'sign.need') active.outbox.delete('unlock');
}

export class PhoneSigner {
  private active?: Active;

  constructor(private readonly link: PhoneLinkPort) {}

  get busy(): boolean {
    return this.active !== undefined;
  }

  request(req: PhoneSignRequest): Promise<PhoneKey> {
    if (this.active) return Promise.reject(new PhoneSignError('busy'));
    if (req.signal?.aborted) return Promise.reject(new PhoneSignError('cancelled'));
    const id = crypto.randomUUID();
    const reviewMs = req.reviewTimeoutMs ?? 5 * 60_000;
    const total = req.documents.reduce((sum, d) => sum + d.data.length, 0);
    const sendData = total <= COMPANION_MAX_DOCUMENT_BYTES;
    const documents: CompanionDocument[] = req.documents.map((d) => ({
      ...(d.name ? { name: d.name.slice(0, 200) } : {}),
      mimeType: d.mimeType,
      size: d.data.length,
      sha256: crypto.createHash('sha256').update(d.data).digest('hex'),
      ...(sendData ? { data: Buffer.from(d.data).toString('base64') } : {}),
    }));
    // Without the documents the phone can't check anything.
    const verifiable = req.verifiable && sendData && req.documents.length > 0;

    return new Promise<PhoneKey>((resolve, reject) => {
      const onAbort = () => this.fail(id, new PhoneSignError('cancelled'), 'cancelled');
      const active: Active = {
        id,
        outbox: new Map(),
        verifiable,
        certificate: {
          resolve: (certificates) => {
            clearTimeout(active.timer);
            resolve(this.key(active, certificates));
          },
          reject,
        },
        signatures: new Map(),
        nextSeq: 1,
        reviewMs,
        onStage: req.onStage,
        onNeed: req.onNeed,
        needing: false,
        cleanup: () => req.signal?.removeEventListener('abort', onAbort),
      };
      this.active = active;
      req.signal?.addEventListener('abort', onAbort, { once: true });
      this.armReview(active);
      this.post(active, 'request', {
        type: 'sign.request',
        requestId: id,
        purpose: req.purpose,
        origin: req.origin,
        description: req.description.slice(0, 4000),
        format: req.format.slice(0, 64),
        documents,
        verifiable,
        ...(req.signatures ? { signatures: req.signatures } : {}),
        expiresAt: new Date(Date.now() + reviewMs).toISOString(),
        can: req.can,
        ...(req.pin ? { pin: req.pin } : {}),
      });
    });
  }

  /** Messages from the phone. */
  onMessage(message: PhoneToDesktop): void {
    const active = this.active;
    if (!active || message.type === 'bye' || message.requestId !== active.id) return;
    // The phone has the request (and any unlock): the PIN goes once.
    dropSecrets(active, message);
    switch (message.type) {
      case 'sign.progress':
        active.onStage?.(message.stage);
        return;
      case 'sign.certificate': {
        const certificates = message.certificates.map((c) => Buffer.from(c, 'base64'));
        if (active.certificates) {
          // Re-sent after a reconnect: it must be the same card.
          if (!certificates[0]?.equals(active.certificates[0] as Buffer)) {
            this.fail(active.id, new PhoneSignError('wrong_card'), 'failed');
          }
          return;
        }
        active.certificates = certificates;
        active.certificate.resolve(certificates);
        return;
      }
      case 'sign.signature': {
        const waiter = active.signatures.get(message.seq);
        if (!waiter) return;
        active.signatures.delete(message.seq);
        active.outbox.delete(`tbs:${message.seq}`);
        clearTimeout(waiter.timer);
        waiter.resolve(Buffer.from(message.signature, 'base64'));
        return;
      }
      case 'sign.need':
        // Already asking the user, or re-sent while the unlock is on its way.
        if (active.needing || active.outbox.has('unlock')) return;
        this.need(active, {
          what: message.what,
          refused: message.refused,
          ...(message.triesLeft ? { triesLeft: message.triesLeft } : {}),
        });
        return;
      case 'sign.error':
        this.fail(active.id, new PhoneSignError(message.code, message.message));
        return;
    }
  }

  /** A new session with the phone: send again whatever it hasn't answered. */
  onSession(): void {
    const active = this.active;
    if (!active) return;
    for (const message of active.outbox.values()) {
      if (!this.link.send(message)) return;
    }
  }

  /** The pairing ended: nothing more can arrive. */
  onEnded(reason: 'unpaired' | 'expired'): void {
    if (this.active) this.fail(this.active.id, new PhoneSignError(reason));
  }

  /** Asks `onNeed` with the timers stopped, then sends `sign.unlock` and starts them again. */
  private need(active: Active, need: PhoneNeed): void {
    if (!active.onNeed) {
      this.fail(active.id, new PhoneSignError('cancelled'), 'cancelled');
      return;
    }
    active.needing = true;
    clearTimeout(active.timer);
    for (const waiter of active.signatures.values()) clearTimeout(waiter.timer);
    active.onNeed(need).then(
      (value) => {
        if (this.active !== active) return;
        active.needing = false;
        if (!value) {
          this.fail(active.id, new PhoneSignError('cancelled'), 'cancelled');
          return;
        }
        if (!active.certificates) this.armReview(active);
        for (const waiter of active.signatures.values()) waiter.timer = this.signatureTimer(active);
        this.post(active, 'unlock', {
          type: 'sign.unlock',
          requestId: active.id,
          ...(need.what === 'can' ? { can: value } : { pin: value }),
          expiresAt: new Date(Date.now() + active.reviewMs).toISOString(),
        });
      },
      () => this.fail(active.id, new PhoneSignError('cancelled'), 'cancelled'),
    );
  }

  private armReview(active: Active): void {
    clearTimeout(active.timer);
    active.timer = setTimeout(
      () => this.fail(active.id, new PhoneSignError('timeout'), 'timeout'),
      active.reviewMs,
    );
  }

  private signatureTimer(active: Active): ReturnType<typeof setTimeout> {
    return setTimeout(
      () => this.fail(active.id, new PhoneSignError('timeout'), 'timeout'),
      SIGNATURE_TIMEOUT_MS,
    );
  }

  private post(active: Active, key: string, message: DesktopToPhone): void {
    active.outbox.set(key, message);
    this.link.send(message);
  }

  private key(active: Active, certificates: Buffer[]): PhoneKey {
    return {
      certificates,
      sign: (data, algorithm, check, prehashed) => {
        if (this.active !== active) return Promise.reject(new PhoneSignError('cancelled'));
        const seq = active.nextSeq++;
        return new Promise<Buffer>((resolve, reject) => {
          // While the user types a new PIN the timer waits; `need` starts it afterwards.
          const timer = active.needing ? undefined : this.signatureTimer(active);
          active.signatures.set(seq, { resolve, reject, timer });
          this.post(active, `tbs:${seq}`, {
            type: 'sign.toBeSigned',
            requestId: active.id,
            seq,
            algorithm,
            data: Buffer.from(data).toString('base64'),
            ...(prehashed ? { prehashed: true } : {}),
            ...(active.verifiable && check ? { check } : {}),
          });
        });
      },
      finish: (ok) => {
        if (this.active !== active) return;
        this.clear(active);
        this.link.send(
          ok
            ? { type: 'sign.done', requestId: active.id }
            : { type: 'sign.cancel', requestId: active.id, reason: 'failed' },
        );
      },
    };
  }

  /** Ends the active request with `error`; tells the phone when `cancel` is given. */
  private fail(id: string, error: PhoneSignError, cancel?: 'cancelled' | 'timeout' | 'failed') {
    const active = this.active;
    if (!active || active.id !== id) return;
    this.clear(active);
    if (cancel) this.link.send({ type: 'sign.cancel', requestId: id, reason: cancel });
    if (!active.certificates) active.certificate.reject(error);
    for (const waiter of active.signatures.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    active.signatures.clear();
  }

  private clear(active: Active): void {
    clearTimeout(active.timer);
    active.cleanup();
    if (this.active === active) this.active = undefined;
  }
}
