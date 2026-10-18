/**
 * Rooms: one desktop and one phone exchanging opaque binary frames (end-to-end encrypted by
 * `@sa/companion`; the relay can't read them).
 *
 * - The desktop's first connection creates the room and binds it to its key (we keep only the
 *   SHA-256); later desktop connections must present the same key. A relay restart loses the
 *   rooms, and the desktop's next connection simply creates its room again.
 * - Phones may only join an existing room. The room id is the only thing they present: it is
 *   random (128 bits) and travels in the QR, with the secret that protects the content.
 * - One connection per side: a new one replaces the old (4409), so a phone whose old socket is
 *   half-dead can reconnect at once.
 * - Both sides get `{"type":"peer","present":…}` on connect and whenever the other side comes
 *   or goes; `{"type":"ping"}` gets `{"type":"pong"}`.
 * - Limits: room lifetime, idle expiry, bytes per room, rooms and connections per address, and
 *   total open connections.
 */
import crypto from 'node:crypto';
import { RELAY_CLOSE } from '@sa/shared';

export type Role = 'desktop' | 'phone';

/** The parts of a `ws` WebSocket the registry uses (tests pass fakes). */
export interface Peer {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string | Buffer): void;
  close(code: number, reason?: string): void;
  terminate(): void;
}

export interface RoomLimits {
  /** Lifetime of a room from its creation (default 72 h + 10 min of grace). */
  roomTtlMs: number;
  /** A room nobody is connected to disappears after this (default 30 min). */
  idleMs: number;
  /** Bytes a room may forward in its lifetime (default 512 MiB). */
  roomBytes: number;
  /** Rooms one address may hold at once (default 20). */
  roomsPerAddress: number;
  /** Open connections per address (default 40). */
  connectionsPerAddress: number;
  /** Open connections in total, across all addresses (default 300). */
  maxConnections: number;
  /** A receiver further behind than this is disconnected (default 16 MiB). */
  maxBuffered: number;
}

export const DEFAULT_LIMITS: RoomLimits = {
  roomTtlMs: (72 * 60 + 10) * 60_000,
  idleMs: 30 * 60_000,
  roomBytes: 512 * 1024 * 1024,
  roomsPerAddress: 20,
  connectionsPerAddress: 40,
  maxConnections: 300,
  maxBuffered: 16 * 1024 * 1024,
};

interface Room {
  id: string;
  keyHash: Buffer;
  /** Address that created it (counts against its room limit). */
  owner: string;
  createdAt: number;
  lastActivity: number;
  bytes: number;
  desktop?: Peer;
  phone?: Peer;
}

const OPEN = 1;

function hashKey(key: string): Buffer {
  return crypto.createHash('sha256').update(key, 'utf8').digest();
}

export interface Attached {
  /** Feed every message the socket receives. */
  onMessage(data: Buffer, isBinary: boolean): void;
  /** Call once when the socket closes. */
  onClose(): void;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, number>();
  private totalConnections = 0;
  private readonly limits: RoomLimits;

  constructor(
    limits: Partial<RoomLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size(): number {
    return this.rooms.size;
  }

  /** Whether an address may open one more connection (checked before the upgrade). */
  canConnect(address: string): boolean {
    return (
      (this.connections.get(address) ?? 0) < this.limits.connectionsPerAddress &&
      this.totalConnections < this.limits.maxConnections
    );
  }

  /**
   * Takes an upgraded socket. Returns undefined when the socket was refused (and closed with a
   * RELAY_CLOSE code).
   */
  attach(
    socket: Peer,
    info: { room: string; role: Role; key?: string; address: string },
  ): Attached | undefined {
    const now = this.now();
    let room = this.rooms.get(info.room);
    if (room && now - room.createdAt > this.limits.roomTtlMs) {
      this.expire(room);
      room = undefined;
    }
    if (info.role === 'desktop') {
      if (!info.key) {
        socket.close(RELAY_CLOSE.unauthorized, 'key required');
        return undefined;
      }
      const keyHash = hashKey(info.key);
      if (room && !crypto.timingSafeEqual(room.keyHash, keyHash)) {
        socket.close(RELAY_CLOSE.unauthorized, 'wrong key');
        return undefined;
      }
      if (!room) {
        if (this.roomsOf(info.address) >= this.limits.roomsPerAddress) {
          socket.close(RELAY_CLOSE.limited, 'too many rooms');
          return undefined;
        }
        room = {
          id: info.room,
          keyHash,
          owner: info.address,
          createdAt: now,
          lastActivity: now,
          bytes: 0,
        };
        this.rooms.set(room.id, room);
      }
    } else if (!room) {
      socket.close(RELAY_CLOSE.notFound, 'no such room');
      return undefined;
    }

    const r = room;
    const role = info.role;
    const other: Role = role === 'desktop' ? 'phone' : 'desktop';
    const previous = r[role];
    r[role] = socket;
    if (previous) previous.close(RELAY_CLOSE.replaced, 'replaced');
    r.lastActivity = now;
    this.connections.set(info.address, (this.connections.get(info.address) ?? 0) + 1);
    this.totalConnections++;

    this.control(socket, { type: 'peer', present: this.isOpen(r[other]) });
    this.control(r[other], { type: 'peer', present: true });

    let closed = false;
    return {
      onMessage: (data, isBinary) => {
        if (closed || r[role] !== socket) return;
        r.lastActivity = this.now();
        if (!isBinary) {
          this.onText(socket, data);
          return;
        }
        r.bytes += data.length;
        if (r.bytes > this.limits.roomBytes) {
          r.desktop?.close(RELAY_CLOSE.limited, 'room limit');
          r.phone?.close(RELAY_CLOSE.limited, 'room limit');
          return;
        }
        const target = r[other];
        if (!target || target.readyState !== OPEN) return;
        if (target.bufferedAmount > this.limits.maxBuffered) {
          // The receiver can't keep up (or its connection is dead): it will reconnect.
          target.terminate();
          return;
        }
        target.send(data);
      },
      onClose: () => {
        if (closed) return;
        closed = true;
        const count = (this.connections.get(info.address) ?? 1) - 1;
        if (count > 0) this.connections.set(info.address, count);
        else this.connections.delete(info.address);
        this.totalConnections--;
        if (r[role] !== socket) return;
        r[role] = undefined;
        r.lastActivity = this.now();
        this.control(r[other], { type: 'peer', present: false });
      },
    };
  }

  /** Removes expired and idle rooms; call every minute. */
  sweep(): void {
    const now = this.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.createdAt > this.limits.roomTtlMs) this.expire(room);
      else if (!room.desktop && !room.phone && now - room.lastActivity > this.limits.idleMs) {
        this.rooms.delete(room.id);
      }
    }
  }

  /** Closes every connection (shutdown). */
  closeAll(): void {
    for (const room of this.rooms.values()) {
      room.desktop?.close(1001, 'shutting down');
      room.phone?.close(1001, 'shutting down');
    }
    this.rooms.clear();
  }

  private expire(room: Room): void {
    this.rooms.delete(room.id);
    const desktop = room.desktop;
    const phone = room.phone;
    room.desktop = undefined;
    room.phone = undefined;
    desktop?.close(RELAY_CLOSE.expired, 'expired');
    phone?.close(RELAY_CLOSE.expired, 'expired');
  }

  private roomsOf(address: string): number {
    let n = 0;
    for (const room of this.rooms.values()) if (room.owner === address) n++;
    return n;
  }

  private isOpen(peer: Peer | undefined): boolean {
    return peer !== undefined && peer.readyState === OPEN;
  }

  private control(peer: Peer | undefined, message: object): void {
    if (peer && peer.readyState === OPEN) peer.send(JSON.stringify(message));
  }

  private onText(socket: Peer, data: Buffer): void {
    if (data.length > 256) return;
    try {
      const message = JSON.parse(data.toString('utf8')) as { type?: unknown };
      if (message.type === 'ping') this.control(socket, { type: 'pong' });
    } catch {
      // ignore
    }
  }
}
