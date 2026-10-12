/**
 * Phone side of the channel, in TypeScript: the reference the Kotlin app follows, and the
 * transport of the mock phone used by tests (`tools/mock-phone`).
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
}

interface Pending {
  opener: Opener;
  sealer: Sealer;
}

interface Session extends Pending {
  assembler: MessageAssembler;
}

export class PhoneClient {
  readonly pairing: PairingLink;
  private readonly socket: RelaySocket;
  private pending?: Pending;
  private session?: Session;
  private status: PhoneStatus = { state: 'connecting' };

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
      this.finish({
        state: 'ended',
        reason: state.reason === 'expired' ? 'expired' : 'not_found',
      });
      return;
    }
    if (state.status === 'stopped') return;
    this.session = undefined;
    this.pending = undefined;
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
