/**
 * Desktop: signatures with the DNIe in the paired phone. One request at a time.
 *
 * `request()` sends `sign.request` and resolves with a `PhoneKey` once the phone has read the
 * card's certificate (the user approved, typed the PIN or got the desktop's, and held the card
 * to the phone). Each
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
  /** The DNI's CAN (6 digits), so the phone doesn't ask for it. */
  can?: string;
  /**
   * The saved DNIe PIN, so the phone doesn't ask for it. Only after the desktop approval this
   * use needs (DECISIONS D18).
   */
  pin?: string;
  /** The card refused `pin`: the phone dropped it and asks the user. Called at most once. */
  onWrongPin?(): void;
  /** Time to review, type the PIN and read the card. Default 5 minutes. */
  reviewTimeoutMs?: number;
  signal?: AbortSignal;
  onStage?(stage: CompanionStage): void;
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
  signatures: Map<number, Waiter<Buffer> & { timer: ReturnType<typeof setTimeout> }>;
  nextSeq: number;
  timer?: ReturnType<typeof setTimeout>;
  onStage?(stage: CompanionStage): void;
  /** Only while the request carries a PIN the card hasn't refused. */
  onWrongPin?(): void;
  cleanup(): void;
}

const SIGNATURE_TIMEOUT_MS = 90_000;

/** Removes the PIN from the request kept for re-sending. */
function dropPin(active: Active): void {
  const request = active.outbox.get('request');
  if (request?.type !== 'sign.request' || !request.pin) return;
  const { pin: _sent, ...rest } = request;
  active.outbox.set('request', rest);
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
        onStage: req.onStage,
        ...(req.pin ? { onWrongPin: () => req.onWrongPin?.() } : {}),
        cleanup: () => req.signal?.removeEventListener('abort', onAbort),
      };
      this.active = active;
      req.signal?.addEventListener('abort', onAbort, { once: true });
      active.timer = setTimeout(
        () => this.fail(id, new PhoneSignError('timeout'), 'timeout'),
        reviewMs,
      );
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
        ...(req.can ? { can: req.can } : {}),
        ...(req.pin ? { pin: req.pin } : {}),
      });
    });
  }

  /** Messages from the phone. */
  onMessage(message: PhoneToDesktop): void {
    const active = this.active;
    if (!active || message.type === 'bye' || message.requestId !== active.id) return;
    // The phone has the request: the PIN goes once. A request sent again after a reconnect
    // leaves it out, so a phone that joins later (anyone with the pairing link) never gets it.
    dropPin(active);
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
      case 'sign.wrongPin': {
        const onWrongPin = active.onWrongPin;
        if (!onWrongPin) return;
        active.onWrongPin = undefined;
        onWrongPin();
        return;
      }
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
          const timer = setTimeout(
            () => this.fail(active.id, new PhoneSignError('timeout'), 'timeout'),
            SIGNATURE_TIMEOUT_MS,
          );
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
