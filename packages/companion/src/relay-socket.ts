/**
 * One side's connection to the relay: reconnects with backoff, reports whether the other side is
 * there, and keeps the connection alive (`ping` every 20 s; no `pong` within 10 s = reconnect).
 * Uses the global WebSocket (Node ≥ 22, Electron).
 */
import { RELAY_CLOSE, RelayControl } from '@sa/shared';

export type RelayRole = 'desktop' | 'phone';

export type RelayState =
  | { status: 'connecting' }
  | { status: 'open'; peer: boolean }
  /** Gave up: the room is gone or the key was refused. `stop()` was not called. */
  | { status: 'closed'; reason: 'not_found' | 'expired' | 'unauthorized' | 'replaced' }
  | { status: 'stopped' };

export interface RelaySocketOptions {
  /** ws:// or wss:// base URL. */
  relayUrl: string;
  room: string;
  role: RelayRole;
  /** Desktop only: the room's key (Authorization: Bearer). */
  key?: string;
  onState(state: RelayState): void;
  onFrame(frame: Buffer): void;
  /** Test hooks. */
  WebSocket?: typeof WebSocket;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  backoffMs?: (attempt: number) => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const FATAL: Record<number, Extract<RelayState, { status: 'closed' }>['reason']> = {
  [RELAY_CLOSE.notFound]: 'not_found',
  [RELAY_CLOSE.expired]: 'expired',
  [RELAY_CLOSE.unauthorized]: 'unauthorized',
  [RELAY_CLOSE.replaced]: 'replaced',
};

function defaultBackoff(attempt: number): number {
  const base = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5));
  return base / 2 + Math.random() * (base / 2);
}

export class RelaySocket {
  private ws?: WebSocket;
  private stopped = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private pongTimer?: ReturnType<typeof setTimeout>;
  private state: RelayState = { status: 'connecting' };

  constructor(private readonly opts: RelaySocketOptions) {}

  /** Connects on the next microtask, so callers finish constructing before the first state. */
  start(): void {
    this.stopped = false;
    queueMicrotask(() => this.connect());
  }

  get current(): RelayState {
    return this.state;
  }

  /** False when there is no open connection (the frame is dropped). */
  send(frame: Uint8Array): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    // Our frames are Buffers over plain ArrayBuffers (never shared memory).
    ws.send(frame as Uint8Array<ArrayBuffer>);
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close(1000);
    } catch {
      // already closing
    }
    this.setState({ status: 'stopped' });
  }

  private setState(state: RelayState): void {
    this.state = state;
    this.opts.onState(state);
  }

  private clearTimers(): void {
    clearTimeout(this.timer);
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearTimers();
    this.setState({ status: 'connecting' });
    const Ctor = this.opts.WebSocket ?? WebSocket;
    const url = `${this.opts.relayUrl}/v1/rooms/${this.opts.room}/${this.opts.role}`;
    let ws: WebSocket;
    try {
      // Node's WebSocket (undici) accepts headers in an options object.
      ws = this.opts.key
        ? new Ctor(url, { headers: { authorization: `Bearer ${this.opts.key}` } } as never)
        : new Ctor(url);
    } catch (err) {
      this.opts.log?.('relay connect failed', { error: String(err) });
      this.retry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.pingTimer = setInterval(() => this.ping(ws), this.opts.pingIntervalMs ?? 20_000);
    };
    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      if (typeof event.data === 'string') {
        this.onControl(event.data);
        return;
      }
      const data = event.data as ArrayBuffer;
      this.opts.onFrame(Buffer.from(data));
    };
    ws.onerror = () => {
      // onclose follows
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      this.clearTimers();
      if (this.stopped) return;
      const fatal = FATAL[event.code];
      if (fatal) {
        this.opts.log?.('relay closed', { code: event.code });
        this.stopped = true;
        this.setState({ status: 'closed', reason: fatal });
        return;
      }
      this.retry(event.code === RELAY_CLOSE.limited ? 30_000 : undefined);
    };
  }

  private onControl(text: string): void {
    let parsed: ReturnType<typeof RelayControl.safeParse>;
    try {
      parsed = RelayControl.safeParse(JSON.parse(text));
    } catch {
      return;
    }
    if (!parsed.success) return;
    if (parsed.data.type === 'pong') {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
      return;
    }
    this.setState({ status: 'open', peer: parsed.data.present });
  }

  private ping(ws: WebSocket): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.opts.log?.('relay pong timeout');
      try {
        ws.close(4000);
      } catch {
        // ignore
      }
      // Some runtimes never fire onclose for a dead socket: reconnect now.
      if (this.ws === ws) {
        this.ws = undefined;
        this.retry();
      }
    }, this.opts.pongTimeoutMs ?? 10_000);
  }

  private retry(delay?: number): void {
    if (this.stopped) return;
    this.clearTimers();
    this.setState({ status: 'connecting' });
    const wait = delay ?? (this.opts.backoffMs ?? defaultBackoff)(this.attempt++);
    this.timer = setTimeout(() => this.connect(), wait);
  }
}
