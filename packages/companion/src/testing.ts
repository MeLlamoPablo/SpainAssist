/**
 * `@sa/companion/testing`: an in-memory stand-in for services/relay-server, for unit tests. Same
 * room rules (the desktop key binds the room, phones need an existing room, one connection per
 * side, presence frames), no network. Pass `relay.WebSocket` as the socket constructor.
 */
import { RELAY_CLOSE } from '@sa/shared';

type Role = 'desktop' | 'phone';

interface Room {
  key: string;
  desktop?: FakeSocket;
  phone?: FakeSocket;
}

export class MemoryRelay {
  readonly rooms = new Map<string, Room>();
  /** Frames forwarded, for assertions. */
  forwarded = 0;
  /** Drop every binary frame while true (a dead network that still looks connected). */
  blackhole = false;

  readonly WebSocket = (() => {
    const relay = this;
    return class extends FakeSocket {
      constructor(url: string, opts?: { headers?: Record<string, string> }) {
        super();
        queueMicrotask(() => relay.accept(this, url, opts?.headers?.authorization));
      }
    } as unknown as typeof WebSocket;
  })();

  /** Closes one side's connection as a network failure would. */
  drop(roomId: string, role: Role): void {
    const socket = this.rooms.get(roomId)?.[role];
    socket?.remoteClose(1006);
  }

  /** Closes one side's connection with a specific close code. */
  closeWithCode(roomId: string, role: Role, code: number): void {
    const socket = this.rooms.get(roomId)?.[role];
    socket?.remoteClose(code);
  }

  private accept(socket: FakeSocket, url: string, auth?: string): void {
    const match = /\/v1\/rooms\/([A-Za-z0-9_-]{22})\/(desktop|phone)$/.exec(url);
    if (!match) {
      socket.remoteClose(1006);
      return;
    }
    const [, id, role] = match as unknown as [string, string, Role];
    let room = this.rooms.get(id);
    if (role === 'desktop') {
      const key = auth?.replace(/^Bearer /, '') ?? '';
      if (!key || (room && room.key !== key)) {
        socket.remoteClose(RELAY_CLOSE.unauthorized);
        return;
      }
      if (!room) {
        room = { key };
        this.rooms.set(id, room);
      }
    } else if (!room) {
      socket.remoteClose(RELAY_CLOSE.notFound);
      return;
    }
    const r = room;
    const other: Role = role === 'desktop' ? 'phone' : 'desktop';
    r[role]?.remoteClose(RELAY_CLOSE.replaced);
    r[role] = socket;
    socket.peer = {
      text: (text) => {
        if (JSON.parse(text).type === 'ping') socket.deliver(JSON.stringify({ type: 'pong' }));
      },
      binary: (data) => {
        if (this.blackhole) return;
        const target = r[other];
        if (!target) return;
        this.forwarded++;
        target.deliver(data);
      },
      closed: () => {
        if (r[role] !== socket) return;
        r[role] = undefined;
        r[other]?.deliver(JSON.stringify({ type: 'peer', present: false }));
      },
    };
    socket.open();
    socket.deliver(JSON.stringify({ type: 'peer', present: Boolean(r[other]) }));
    r[other]?.deliver(JSON.stringify({ type: 'peer', present: true }));
  }
}

class FakeSocket {
  readonly OPEN = 1;
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  peer?: { text(t: string): void; binary(d: ArrayBuffer): void; closed(): void };

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) return;
    queueMicrotask(() => this.readyState === 1 && this.onmessage?.({ data }));
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== 1) throw new Error('not open');
    if (typeof data === 'string') {
      this.peer?.text(data);
      return;
    }
    const copy = new Uint8Array(data).slice().buffer;
    this.peer?.binary(copy);
  }

  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.peer?.closed();
    queueMicrotask(() => this.onclose?.({ code }));
  }

  remoteClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.peer?.closed();
    queueMicrotask(() => this.onclose?.({ code }));
  }
}
