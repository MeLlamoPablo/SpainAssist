/**
 * The relay: HTTP routes (Hono) plus WebSocket rooms on `/v1/rooms/{roomId}/{desktop|phone}`.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { createAdaptorServer } from '@hono/node-server';
import { RELAY_ROOM_ID } from '@sa/shared';
import { type WebSocket, WebSocketServer } from 'ws';
import { type AppOptions, createApp } from './app';
import { type Role, type RoomLimits, RoomRegistry } from './rooms';

export interface RelayOptions extends AppOptions {
  limits?: Partial<RoomLimits>;
  /** Largest binary frame (default 1 MiB; the channel's fragments are 256 KiB). */
  maxFrameBytes?: number;
  /** Trust X-Forwarded-For (only behind our own reverse proxy). */
  trustProxy?: boolean;
  /** Ping interval; a socket that misses one pong is dropped (default 20 s). */
  heartbeatMs?: number;
  now?: () => number;
  /** Connection log: role, outcome and close code only (never room ids or addresses). */
  log?: (line: string) => void;
}

export interface Relay {
  server: Server;
  registry: RoomRegistry;
  close(): Promise<void>;
}

const ROOM_PATH = /^\/v1\/rooms\/([^/]+)\/(desktop|phone)$/;

function refuse(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createRelay(options: RelayOptions = {}): Relay {
  const registry = new RoomRegistry(options.limits, options.now);
  const app = createApp(options);
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxFrameBytes ?? 1024 * 1024,
    perMessageDeflate: false,
  });
  const alive = new WeakMap<WebSocket, boolean>();

  const address = (req: IncomingMessage): string => {
    if (options.trustProxy) {
      const forwarded = req.headers['x-forwarded-for'];
      const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const match = ROOM_PATH.exec(path);
    if (!match || !RELAY_ROOM_ID.test(match[1] as string)) {
      refuse(socket, 404, 'Not Found');
      return;
    }
    const room = match[1] as string;
    const role = match[2] as Role;
    const from = address(req);
    if (!registry.canConnect(from)) {
      refuse(socket, 429, 'Too Many Requests');
      return;
    }
    const auth = req.headers.authorization;
    const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Refused sockets stay open until the closing handshake ends, so they need this too.
      ws.on('error', () => ws.terminate());
      const attached = registry.attach(ws, { room, role, key, address: from });
      if (!attached) {
        options.log?.(`${role} refused`);
        return;
      }
      options.log?.(`${role} connected`);
      alive.set(ws, true);
      ws.on('pong', () => alive.set(ws, true));
      ws.on('message', (data, isBinary) => {
        const buffer = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        attached.onMessage(buffer, isBinary);
      });
      ws.on('close', (code) => {
        options.log?.(`${role} closed ${code}`);
        attached.onClose();
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, options.heartbeatMs ?? 20_000);
  const sweeper = setInterval(() => registry.sweep(), 60_000);
  heartbeat.unref();
  sweeper.unref();

  return {
    server,
    registry,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clearInterval(sweeper);
        registry.closeAll();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
