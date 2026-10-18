/**
 * Desktop side of a pairing: creates the link (QR), keeps the relay connection, answers the
 * phone's handshake and carries messages. One pairing lasts until `unpair()`, the phone says
 * `bye`, or its lifetime (72 h) ends; a new QR means a new pairing.
 *
 * The QR's secret works for one handshake. Its WELCOME gives the phone the pairing's own
 * secret, which every later handshake uses; from then on the QR is useless, so a screenshot or
 * a shared screen can't let anyone take the phone's place.
 *
 * Every time either side (re)connects, the relay reports the phone as present and the desktop
 * sends a fresh CHALLENGE: the phone must handshake again, so a session never outlives a
 * connection. Requests in flight are re-sent by `PhoneSigner` when the new session starts.
 */
import crypto from 'node:crypto';
import {
  COMPANION_PROTOCOL,
  CompanionHello,
  type CompanionWelcome,
  type DesktopToPhone,
  PhoneToDesktop,
} from '@sa/shared';
import { toBase64Url } from './bytes';
import {
  ChannelError,
  deriveSessionKeys,
  ecdh,
  FRAME,
  generateKeyPair,
  HELLO_PREFIX_BYTES,
  type KeyPair,
  MessageAssembler,
  NONCE_BYTES,
  Opener,
  parseSingleRecord,
  Sealer,
  sealMessage,
  singleRecord,
} from './channel';
import { encodePairingLink, PUBLIC_KEY_BYTES, ROOM_BYTES, roomId, SECRET_BYTES } from './link';
import { RelaySocket, type RelaySocketOptions, type RelayState } from './relay-socket';

export const PAIRING_LIFETIME_MS = 72 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export type PairingEndReason = 'unpaired' | 'phone_unpaired' | 'expired' | 'relay_refused';

export type PairingStatus =
  /** No relay connection yet (or reconnecting). */
  | { state: 'connecting'; phone?: CompanionHello }
  /** The relay is there; no phone has paired yet: show the QR. */
  | { state: 'waiting' }
  /** A phone paired, but it isn't connected now (app closed, phone asleep, no network). */
  | { state: 'away'; phone: CompanionHello }
  | { state: 'connected'; phone: CompanionHello }
  | { state: 'ended'; reason: PairingEndReason };

export interface DesktopPairingOptions {
  relayUrl: string;
  /** Desktop app version (sent in WELCOME). */
  appVersion: string;
  lifetimeMs?: number;
  now?: () => number;
  onStatus?(status: PairingStatus): void;
  onMessage?(message: PhoneToDesktop): void;
  /** A new session started: re-send whatever the phone may have missed. */
  onSession?(): void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  socket?: Pick<RelaySocketOptions, 'WebSocket' | 'pingIntervalMs' | 'pongTimeoutMs' | 'backoffMs'>;
}

interface Session {
  sealer: Sealer;
  opener: Opener;
  assembler: MessageAssembler;
}

export class DesktopPairing {
  readonly expiresAt: number;
  private readonly keys: KeyPair;
  /** The QR's secret until a phone pairs, then the one sent in that WELCOME. */
  private secret: Buffer;
  private qr?: string;
  private readonly socket: RelaySocket;
  private readonly expiryTimer: ReturnType<typeof setTimeout>;
  private challenge?: { nonce: Buffer; at: number };
  private session?: Session;
  private phone?: CompanionHello;
  private relay: RelayState = { status: 'connecting' };
  private ended?: PairingEndReason;

  constructor(private readonly opts: DesktopPairingOptions) {
    const now = opts.now ?? Date.now;
    this.keys = generateKeyPair();
    this.secret = crypto.randomBytes(SECRET_BYTES);
    const room = crypto.randomBytes(ROOM_BYTES);
    this.qr = encodePairingLink({
      relayUrl: opts.relayUrl,
      room,
      secret: this.secret,
      desktopKey: this.keys.publicKey,
    });
    const lifetime = opts.lifetimeMs ?? PAIRING_LIFETIME_MS;
    this.expiresAt = now() + lifetime;
    this.expiryTimer = setTimeout(() => this.end('expired'), lifetime);
    this.socket = new RelaySocket({
      ...opts.socket,
      relayUrl: opts.relayUrl,
      room: roomId(room),
      role: 'desktop',
      key: toBase64Url(crypto.randomBytes(32)),
      onState: (state) => this.onRelayState(state),
      onFrame: (frame) => this.onFrame(frame),
      log: opts.log,
    });
    this.socket.start();
  }

  get status(): PairingStatus {
    if (this.ended) return { state: 'ended', reason: this.ended };
    if (this.relay.status !== 'open') {
      return this.phone ? { state: 'connecting', phone: this.phone } : { state: 'connecting' };
    }
    if (!this.phone) return { state: 'waiting' };
    return this.session
      ? { state: 'connected', phone: this.phone }
      : { state: 'away', phone: this.phone };
  }

  /** The pairing link for the QR code, until a phone pairs with it. */
  get link(): string | undefined {
    return this.qr;
  }

  /** A phone has paired at least once. */
  get paired(): boolean {
    return this.phone !== undefined;
  }

  get connected(): boolean {
    return this.session !== undefined;
  }

  /** False when no phone is connected (the caller re-sends on the next `onSession`). */
  send(message: DesktopToPhone): boolean {
    const session = this.session;
    if (!session) return false;
    for (const frame of sealMessage(session.sealer, message)) {
      if (!this.socket.send(frame)) {
        this.dropSession();
        return false;
      }
    }
    return true;
  }

  /** Ends the pairing, telling the phone (best effort). */
  unpair(): void {
    this.end('unpaired');
  }

  private end(reason: PairingEndReason): void {
    if (this.ended) return;
    if (reason !== 'phone_unpaired' && reason !== 'relay_refused') this.send({ type: 'bye' });
    this.ended = reason;
    clearTimeout(this.expiryTimer);
    this.session = undefined;
    // Give the bye a moment to leave before closing the socket.
    setTimeout(() => this.socket.stop(), 200).unref?.();
    this.emitStatus();
  }

  private emitStatus(): void {
    this.opts.onStatus?.(this.status);
  }

  private onRelayState(state: RelayState): void {
    if (this.ended) return;
    if (state.status === 'closed') {
      this.end('relay_refused');
      return;
    }
    if (state.status === 'stopped') return;
    this.relay = state;
    if (state.status === 'open' && state.peer) {
      // The phone (re)connected, or we did: it must handshake again.
      this.session = undefined;
      this.sendChallenge();
    } else {
      this.session = undefined;
    }
    this.emitStatus();
  }

  private sendChallenge(): void {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    this.challenge = { nonce, at: Date.now() };
    this.socket.send(Buffer.concat([Buffer.from([FRAME.challenge]), nonce]));
  }

  private dropSession(): void {
    if (!this.session) return;
    this.session = undefined;
    this.emitStatus();
    // Ask for a new handshake if the phone is still connected.
    if (this.relay.status === 'open' && this.relay.peer) this.sendChallenge();
  }

  private onFrame(frame: Buffer): void {
    if (this.ended || frame.length === 0) return;
    try {
      if (frame[0] === FRAME.hello) this.onHello(frame);
      else if (frame[0] === FRAME.record) this.onRecord(frame);
    } catch (err) {
      this.opts.log?.('companion frame rejected', {
        error: err instanceof ChannelError ? err.message : String(err),
      });
      if (frame[0] === FRAME.record) this.dropSession();
    }
  }

  private onHello(frame: Buffer): void {
    const challenge = this.challenge;
    if (!challenge || Date.now() - challenge.at > CHALLENGE_TTL_MS) {
      throw new ChannelError('No challenge');
    }
    if (frame.length < HELLO_PREFIX_BYTES + 8 + 16) throw new ChannelError('Short hello');
    const keyEnd = 1 + PUBLIC_KEY_BYTES;
    const phoneKey = frame.subarray(1, keyEnd);
    const phoneNonce = frame.subarray(keyEnd, keyEnd + NONCE_BYTES);
    const desktopNonce = frame.subarray(keyEnd + NONCE_BYTES, keyEnd + 2 * NONCE_BYTES);
    if (!desktopNonce.equals(challenge.nonce)) throw new ChannelError('Stale hello');
    const keys = deriveSessionKeys({
      shared: ecdh(this.keys.privateKey, phoneKey),
      secret: this.secret,
      desktopKey: this.keys.publicKey,
      phoneKey,
      desktopNonce,
      phoneNonce,
    });
    const opener = new Opener(keys.phoneToDesktop, 'phoneToDesktop');
    const hello = CompanionHello.safeParse(
      parseSingleRecord(opener.open(frame, HELLO_PREFIX_BYTES)),
    );
    if (!hello.success) throw new ChannelError('Bad hello');
    // One challenge, one session.
    this.challenge = undefined;
    const sealer = new Sealer(keys.desktopToPhone, 'desktopToPhone');
    const compatible = hello.data.protocol === COMPANION_PROTOCOL;
    // The first phone to pair gets the pairing's own secret; the QR's stops working.
    const session = compatible && this.qr ? crypto.randomBytes(SECRET_BYTES) : undefined;
    const welcome: CompanionWelcome = {
      type: 'welcome',
      protocol: COMPANION_PROTOCOL,
      app: this.opts.appVersion,
      expiresAt: new Date(this.expiresAt).toISOString(),
      ...(session ? { session: session.toString('base64') } : {}),
    };
    if (!this.socket.send(sealer.seal(Buffer.from([FRAME.welcome]), singleRecord(welcome)))) {
      return;
    }
    if (!compatible) {
      // The WELCOME tells the phone our version; it shows "update the app" and stops.
      this.opts.log?.('companion protocol mismatch', { phone: hello.data.protocol });
      return;
    }
    if (session) {
      this.secret = session;
      this.qr = undefined;
    }
    this.session = { sealer, opener, assembler: new MessageAssembler() };
    this.phone = hello.data;
    this.emitStatus();
    this.opts.onSession?.();
  }

  private onRecord(frame: Buffer): void {
    const session = this.session;
    if (!session) throw new ChannelError('No session');
    const message = session.assembler.push(session.opener.open(frame, 1));
    if (message === undefined) return;
    const parsed = PhoneToDesktop.safeParse(message);
    if (!parsed.success) {
      this.opts.log?.('companion message rejected', { type: (message as { type?: unknown }).type });
      return;
    }
    if (parsed.data.type === 'bye') {
      this.end('phone_unpaired');
      return;
    }
    this.opts.onMessage?.(parsed.data);
  }
}
