/**
 * Phone side of the channel, in TypeScript: the reference the Kotlin app follows, and the
 * transport of the mock phone used by tests.
 */
import crypto from 'node:crypto';
import {
  COMPANION_PROTOCOL,
  type CompanionHello,
  CompanionWelcome,
  DesktopToPhone,
  type PhoneToDesktop,
} from '@sa/shared';
import {
  ChannelError,
  deriveSessionKeys,
  ecdh,
  FRAME,
  generateKeyPair,
  MessageAssembler,
  NONCE_BYTES,
  Opener,
  parseSingleRecord,
  Sealer,
  sealMessage,
  singleRecord,
} from './channel';
import { decodePairingLink, type PairingLink, roomId } from './link';
import { RelaySocket, type RelaySocketOptions, type RelayState } from './relay-socket';

export type PhoneStatus =
  | { state: 'connecting' }
  /** Connected to the relay; the desktop isn't. */
  | { state: 'desktop_away' }
  | { state: 'connected'; welcome: CompanionWelcome }
  /** The desktop speaks another protocol version. */
  | { state: 'outdated'; desktopProtocol: number }
  | { state: 'ended'; reason: 'not_found' | 'expired' | 'desktop_unpaired' | 'unpaired' };

export interface PhoneClientOptions {
  link: string;
  hello: Omit<CompanionHello, 'type' | 'protocol'>;
  onStatus?(status: PhoneStatus): void;
  onMessage?(message: DesktopToPhone): void;
  onSession?(): void;
  log?: (message: string, fields?: Record<string, unknown>) => void;
  socket?: Pick<RelaySocketOptions, 'WebSocket' | 'pingIntervalMs' | 'pongTimeoutMs' | 'backoffMs'>;
  /** Clock for timeouts (default: Date.now). */
  now?: () => number;
  /** Pairing expiry time in ms since epoch. If not provided, pairing never expires. */
  expiresAt?: number;
  /** Backoff for retrying a missing room (longer than normal backoff; default: missingBackoff). */
  missingBackoffMs?: (attempt: number) => number;
  /** Max time to wait for a missing room before ending (default: 24 hours). */
  roomMissingMaxMs?: number;
}

interface Pending {
  opener: Opener;
  sealer: Sealer;
}

interface Session extends Pending {
  assembler: MessageAssembler;
}

export class PhoneClient {
  /** The scanned link; its secret becomes the pairing's own once the desktop sends it. */
  pairing: PairingLink;
  private readonly socket: RelaySocket;
  private pending?: Pending;
  private session?: Session;
  private status: PhoneStatus = { state: 'connecting' };
  private roomMissingStart?: number;
  private roomMissingAttempt = 0;

  constructor(private readonly opts: PhoneClientOptions) {
    this.pairing = decodePairingLink(opts.link);
    this.socket = new RelaySocket({
      ...opts.socket,
      relayUrl: this.pairing.relayUrl,
      room: roomId(this.pairing.room),
      role: 'phone',
      onState: (state) => this.onRelayState(state),
      onFrame: (frame) => this.onFrame(frame),
      log: opts.log,
    });
    this.socket.start();
  }

  get current(): PhoneStatus {
    return this.status;
  }

  get connected(): boolean {
    return this.session !== undefined;
  }

  send(message: PhoneToDesktop): boolean {
    const session = this.session;
    if (!session) return false;
    for (const frame of sealMessage(session.sealer, message)) {
      if (!this.socket.send(frame)) return false;
    }
    return true;
  }

  unpair(): void {
    this.send({ type: 'bye' });
    this.finish({ state: 'ended', reason: 'unpaired' });
  }

  /** Closes the connection without ending the pairing (like the app being killed). */
  close(): void {
    this.session = undefined;
    this.socket.stop();
  }

  private setStatus(status: PhoneStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }

  private finish(status: PhoneStatus): void {
    this.session = undefined;
    this.pending = undefined;
    this.setStatus(status);
    setTimeout(() => this.socket.stop(), 100).unref?.();
  }

  private onRelayState(state: RelayState): void {
    if (this.status.state === 'ended') return;
    if (state.status === 'closed') {
      // Handle not_found specially: keep retrying until pairing expires or 24h timeout if expiresAt is provided.
      if (state.reason === 'not_found' && this.opts.expiresAt !== undefined) {
        const now = this.opts.now?.() ?? Date.now();
        // Check if pairing has expired.
        if (now > this.opts.expiresAt) {
          this.finish({ state: 'ended', reason: 'expired' });
          return;
        }
        // Check if we've been missing this room for too long.
        const roomMissingMaxMs = this.opts.roomMissingMaxMs ?? 24 * 60 * 60 * 1000;
        if (this.roomMissingStart === undefined) {
          this.roomMissingStart = now;
        }
        if (now - this.roomMissingStart > roomMissingMaxMs) {
          this.finish({ state: 'ended', reason: 'not_found' });
          return;
        }
        // Keep retrying: schedule a reconnect with the missing backoff.
        const missingBackoff = this.opts.missingBackoffMs ?? defaultMissingBackoff;
        const delay = missingBackoff(this.roomMissingAttempt++);
        setTimeout(() => {
          if (this.status.state !== 'ended') {
            this.socket.start();
          }
        }, delay).unref?.();
        this.setStatus({ state: 'desktop_away' });
        return;
      }
      // Other close reasons end the pairing immediately.
      this.finish({
        state: 'ended',
        reason: state.reason === 'expired' ? 'expired' : 'not_found',
      });
      return;
    }
    if (state.status === 'stopped') return;
    this.session = undefined;
    this.pending = undefined;
    // Reset the missing room timer when the relay is back.
    if (state.status === 'open') {
      this.roomMissingStart = undefined;
      this.roomMissingAttempt = 0;
    }
    if (state.status === 'connecting') this.setStatus({ state: 'connecting' });
    else if (!state.peer) this.setStatus({ state: 'desktop_away' });
    // With the desktop present, wait for its CHALLENGE.
  }

  private onFrame(frame: Buffer): void {
    if (frame.length === 0 || this.status.state === 'ended') return;
    try {
      if (frame[0] === FRAME.challenge) this.onChallenge(frame);
      else if (frame[0] === FRAME.welcome) this.onWelcome(frame);
      else if (frame[0] === FRAME.record) this.onRecord(frame);
    } catch (err) {
      this.opts.log?.('companion frame rejected', {
        error: err instanceof ChannelError ? err.message : String(err),
      });
      // A broken session: wait for the desktop's next CHALLENGE.
      this.session = undefined;
    }
  }

  private onChallenge(frame: Buffer): void {
    if (frame.length !== 1 + NONCE_BYTES) throw new ChannelError('Bad challenge');
    const desktopNonce = frame.subarray(1);
    const mine = generateKeyPair();
    const phoneNonce = crypto.randomBytes(NONCE_BYTES);
    const keys = deriveSessionKeys({
      shared: ecdh(mine.privateKey, this.pairing.desktopKey),
      secret: this.pairing.secret,
      desktopKey: this.pairing.desktopKey,
      phoneKey: mine.publicKey,
      desktopNonce,
      phoneNonce,
    });
    const sealer = new Sealer(keys.phoneToDesktop, 'phoneToDesktop');
    const hello: CompanionHello = {
      type: 'hello',
      protocol: COMPANION_PROTOCOL,
      ...this.opts.hello,
    };
    const prefix = Buffer.concat([
      Buffer.from([FRAME.hello]),
      mine.publicKey,
      phoneNonce,
      desktopNonce,
    ]);
    this.session = undefined;
    this.pending = { sealer, opener: new Opener(keys.desktopToPhone, 'desktopToPhone') };
    this.socket.send(sealer.seal(prefix, singleRecord(hello)));
  }

  private onWelcome(frame: Buffer): void {
    const pending = this.pending;
    if (!pending) throw new ChannelError('Unexpected welcome');
    const welcome = CompanionWelcome.safeParse(parseSingleRecord(pending.opener.open(frame, 1)));
    if (!welcome.success) throw new ChannelError('Bad welcome');
    this.pending = undefined;
    if (welcome.data.protocol !== COMPANION_PROTOCOL) {
      this.setStatus({ state: 'outdated', desktopProtocol: welcome.data.protocol });
      return;
    }
    if (welcome.data.session) {
      this.pairing = { ...this.pairing, secret: Buffer.from(welcome.data.session, 'base64') };
    }
    this.session = { ...pending, assembler: new MessageAssembler() };
    this.setStatus({ state: 'connected', welcome: welcome.data });
    this.opts.onSession?.();
  }

  private onRecord(frame: Buffer): void {
    const session = this.session;
    if (!session) throw new ChannelError('No session');
    const message = session.assembler.push(session.opener.open(frame, 1));
    if (message === undefined) return;
    const parsed = DesktopToPhone.safeParse(message);
    if (!parsed.success) {
      this.opts.log?.('companion message rejected');
      return;
    }
    if (parsed.data.type === 'bye') {
      this.finish({ state: 'ended', reason: 'desktop_unpaired' });
      return;
    }
    this.opts.onMessage?.(parsed.data);
  }
}

/** Default backoff for retrying a missing room: 1–2 s, 2–4 s… up to 30–60 s. */
function defaultMissingBackoff(attempt: number): number {
  const base = Math.min(60_000, 2_000 << Math.min(attempt, 5));
  return base / 2 + Math.random() * (base / 2);
}
