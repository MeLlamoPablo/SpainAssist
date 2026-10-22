import crypto from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { DesktopPairing, encodePairingLink, PhoneClient, PhoneSigner } from '@sa/companion';
import { type DesktopToPhone, RELAY_CLOSE } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApp,
  createRelay,
  loadConfig,
  type Peer,
  type Relay,
  type RelayOptions,
  RoomRegistry,
} from '../src';

const relays: Relay[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  await Promise.all(relays.splice(0).map((r) => r.close()));
});

async function start(options: RelayOptions = {}) {
  const relay = createRelay(options);
  relays.push(relay);
  await new Promise<void>((resolve) => relay.server.listen(0, '127.0.0.1', resolve));
  const { port } = relay.server.address() as AddressInfo;
  return { relay, url: `ws://127.0.0.1:${port}` };
}

const room = () => crypto.randomBytes(16).toString('base64url');

interface Client {
  ws: WebSocket;
  texts: unknown[];
  frames: Buffer[];
  closed: Promise<number>;
  opened: Promise<void>;
}

function connect(url: string, id: string, role: 'desktop' | 'phone', key?: string): Client {
  const ws = key
    ? new WebSocket(`${url}/v1/rooms/${id}/${role}`, {
        headers: { authorization: `Bearer ${key}` },
      } as never)
    : new WebSocket(`${url}/v1/rooms/${id}/${role}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  const client: Client = {
    ws,
    texts: [],
    frames: [],
    closed: new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code))),
    opened: new Promise((resolve) => ws.addEventListener('open', () => resolve())),
  };
  ws.addEventListener('message', (e) => {
    if (typeof e.data === 'string') client.texts.push(JSON.parse(e.data));
    else client.frames.push(Buffer.from(e.data as ArrayBuffer));
  });
  return client;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('relay rooms', () => {
  it('needs the desktop to create a room before a phone can join', async () => {
    const { url } = await start();
    const phone = connect(url, room(), 'phone');
    expect(await phone.closed).toBe(RELAY_CLOSE.notFound);
  });

  it('survives an invalid frame on a refused socket', async () => {
    const { url } = await start();
    const { port } = new URL(url);
    const raw = net.connect(Number(port), '127.0.0.1');
    raw.on('error', () => {});
    let response = '';
    raw.on('data', (chunk) => {
      response += chunk.toString('latin1');
    });
    raw.write(
      `GET /v1/rooms/${room()}/phone HTTP/1.1\r\nHost: relay\r\nUpgrade: websocket\r\n` +
        'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n' +
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`,
    );
    await until(() => response.startsWith('HTTP/1.1 101'));
    // A reserved opcode makes ws emit 'error' while the refusal's closing handshake is pending.
    raw.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0]));
    await new Promise<void>((resolve) => raw.on('close', () => resolve()));
    const phone = connect(url, room(), 'phone');
    expect(await phone.closed).toBe(RELAY_CLOSE.notFound);
  });

  it('binds a room to the desktop key', async () => {
    const { url } = await start();
    const id = room();
    expect(await connect(url, id, 'desktop').closed).toBe(RELAY_CLOSE.unauthorized);
    const desktop = connect(url, id, 'desktop', 'key-1');
    await until(() => desktop.texts.length === 1);
    expect(await connect(url, id, 'desktop', 'key-2').closed).toBe(RELAY_CLOSE.unauthorized);
    // The same key takes the place of the old connection.
    const again = connect(url, id, 'desktop', 'key-1');
    expect(await desktop.closed).toBe(RELAY_CLOSE.replaced);
    await again.opened;
  });

  it('reports presence and forwards binary frames both ways', async () => {
    const { url } = await start();
    const id = room();
    const desktop = connect(url, id, 'desktop', 'k');
    await until(() => desktop.texts.length === 1);
    expect(desktop.texts[0]).toEqual({ type: 'peer', present: false });
    const phone = connect(url, id, 'phone');
    await until(() => phone.texts.length === 1 && desktop.texts.length === 2);
    expect(phone.texts[0]).toEqual({ type: 'peer', present: true });
    expect(desktop.texts[1]).toEqual({ type: 'peer', present: true });
    desktop.ws.send(Buffer.from([1, 2, 3]));
    phone.ws.send(Buffer.from([4, 5]));
    await until(() => phone.frames.length === 1 && desktop.frames.length === 1);
    expect([...(phone.frames[0] as Buffer)]).toEqual([1, 2, 3]);
    expect([...(desktop.frames[0] as Buffer)]).toEqual([4, 5]);
    phone.ws.send(JSON.stringify({ type: 'ping' }));
    await until(() => phone.texts.length === 2);
    expect(phone.texts[1]).toEqual({ type: 'pong' });
    phone.ws.close();
    await until(() => desktop.texts.length === 3);
    expect(desktop.texts[2]).toEqual({ type: 'peer', present: false });
  });

  it('replaces an older phone connection', async () => {
    const { url } = await start();
    const id = room();
    connect(url, id, 'desktop', 'k');
    const first = connect(url, id, 'phone');
    await first.opened;
    const second = connect(url, id, 'phone');
    expect(await first.closed).toBe(RELAY_CLOSE.replaced);
    await second.opened;
  });

  it('enforces frame, room and address limits', async () => {
    const { url } = await start({
      maxFrameBytes: 1024,
      limits: { roomsPerAddress: 1, roomBytes: 4096 },
    });
    const id = room();
    const desktop = connect(url, id, 'desktop', 'k');
    await desktop.opened;
    expect(await connect(url, room(), 'desktop', 'k').closed).toBe(RELAY_CLOSE.limited);
    const phone = connect(url, id, 'phone');
    await phone.opened;
    for (let i = 0; i < 5; i++) phone.ws.send(Buffer.alloc(1000));
    expect(await phone.closed).toBe(RELAY_CLOSE.limited);
    expect(await desktop.closed).toBe(RELAY_CLOSE.limited);

    const { url: url2 } = await start({ maxFrameBytes: 1024 });
    const d2 = connect(url2, room(), 'desktop', 'k');
    await d2.opened;
    d2.ws.send(Buffer.alloc(2048));
    expect(await d2.closed).toBe(1009);
  });

  it('enforces the global connection limit from different addresses', async () => {
    const { url } = await start({ limits: { maxConnections: 2 } });
    const id1 = room();
    const id2 = room();
    const d1 = connect(url, id1, 'desktop', 'k');
    await d1.opened;
    const p1 = connect(url, id1, 'phone');
    await p1.opened;
    // Both connections from different addresses filled the limit (2), HTTP upgrade refused
    const d2 = connect(url, id2, 'desktop', 'k');
    expect(await d2.closed).toBe(1006);
  });

  it('allows new connections after one closes under the global limit', async () => {
    const { url } = await start({ limits: { maxConnections: 2 } });
    const id1 = room();
    const id2 = room();
    const d1 = connect(url, id1, 'desktop', 'k');
    await d1.opened;
    const p1 = connect(url, id1, 'phone');
    await p1.opened;
    // Capacity exhausted, HTTP upgrade refused
    expect(await connect(url, id2, 'desktop', 'k').closed).toBe(1006);
    // Close one connection to free capacity
    d1.ws.close();
    await d1.closed;
    // Now we can connect again
    const d2 = connect(url, id2, 'desktop', 'k');
    await d2.opened;
  });

  it('expires rooms after their lifetime', async () => {
    let now = 1_000_000;
    const { url, relay } = await start({ now: () => now, limits: { roomTtlMs: 1000 } });
    const id = room();
    const desktop = connect(url, id, 'desktop', 'k');
    const phone = connect(url, id, 'phone');
    await Promise.all([desktop.opened, phone.opened]);
    now += 2000;
    relay.registry.sweep();
    expect(await desktop.closed).toBe(RELAY_CLOSE.expired);
    expect(await phone.closed).toBe(RELAY_CLOSE.expired);
    expect(relay.registry.size).toBe(0);
  });

  it('refuses bad paths', async () => {
    const { url } = await start();
    const bad = new WebSocket(`${url}/v1/rooms/short/phone`);
    sockets.push(bad);
    const code = await new Promise<number>((resolve) =>
      bad.addEventListener('close', (e) => resolve(e.code)),
    );
    expect(code).toBe(1006);
  });
});

class FakePeer implements Peer {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | Buffer)[] = [];
  terminated = false;
  send(data: string | Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
  }
  get frames(): Buffer[] {
    return this.sent.filter((d): d is Buffer => typeof d !== 'string');
  }
}

/** A room with a fake desktop and phone; returns what the desktop sends through. */
function pair(registry: RoomRegistry, address = '10.0.0.1') {
  const id = room();
  const desktop = new FakePeer();
  const phone = new FakePeer();
  const fromDesktop = registry.attach(desktop, { room: id, role: 'desktop', key: 'k', address });
  const fromPhone = registry.attach(phone, { room: id, role: 'phone', address });
  if (!fromDesktop || !fromPhone) throw new Error('not attached');
  return { desktop, phone, fromDesktop, fromPhone };
}

describe('relay memory limits', () => {
  it('disconnects a receiver further behind than maxBuffered', () => {
    const registry = new RoomRegistry({ maxBuffered: 1000 });
    const { phone, fromDesktop } = pair(registry);
    phone.bufferedAmount = 1000;
    fromDesktop.onMessage(Buffer.alloc(10), true);
    expect(phone.frames).toHaveLength(1);
    phone.bufferedAmount = 1001;
    fromDesktop.onMessage(Buffer.alloc(10), true);
    expect(phone.terminated).toBe(true);
    expect(phone.frames).toHaveLength(1);
  });

  it('disconnects the receivers furthest behind when all backlogs together pass the cap', () => {
    const registry = new RoomRegistry({ maxBuffered: 1000, maxBufferedTotal: 600 });
    const a = pair(registry);
    const b = pair(registry);
    const c = pair(registry);
    a.phone.bufferedAmount = 300;
    b.phone.bufferedAmount = 200;
    c.phone.bufferedAmount = 100;
    // 600 + 0 fits; one byte more doesn't.
    c.fromDesktop.onMessage(Buffer.alloc(0), true);
    expect(c.phone.frames).toHaveLength(1);
    c.fromDesktop.onMessage(Buffer.alloc(50), true);
    expect(a.phone.terminated).toBe(true);
    expect(b.phone.terminated).toBe(false);
    expect(c.phone.terminated).toBe(false);
    expect(c.phone.frames).toHaveLength(2);
    // A terminated socket no longer counts, even before its close event.
    c.phone.bufferedAmount = 350;
    c.fromDesktop.onMessage(Buffer.alloc(50), true);
    expect(b.phone.terminated).toBe(false);
    expect(c.phone.frames).toHaveLength(3);
  });

  it('drops the frame when its own receiver is the one furthest behind', () => {
    const registry = new RoomRegistry({ maxBuffered: 1000, maxBufferedTotal: 600 });
    const a = pair(registry);
    const b = pair(registry);
    a.phone.bufferedAmount = 500;
    b.desktop.bufferedAmount = 100;
    a.fromDesktop.onMessage(Buffer.alloc(50), true);
    expect(a.phone.terminated).toBe(true);
    expect(a.phone.frames).toHaveLength(0);
    expect(b.desktop.terminated).toBe(false);
  });

  it('stops counting a socket once it closes', () => {
    const registry = new RoomRegistry({ maxBuffered: 1000, maxBufferedTotal: 600 });
    const a = pair(registry);
    const b = pair(registry);
    a.phone.bufferedAmount = 590;
    a.fromPhone.onClose();
    b.fromDesktop.onMessage(Buffer.alloc(50), true);
    expect(a.phone.terminated).toBe(false);
    expect(b.phone.frames).toHaveLength(1);
  });

  it('counts text frames toward the room bytes', () => {
    const registry = new RoomRegistry({ roomBytes: 1000 });
    const { desktop, phone, fromPhone } = pair(registry);
    const text = Buffer.from(JSON.stringify({ type: 'hello', pad: 'x'.repeat(280) }));
    for (let i = 0; i < 3; i++) fromPhone.onMessage(text, false);
    expect(phone.readyState).toBe(1);
    fromPhone.onMessage(text, false);
    expect(phone.readyState).toBe(3);
    expect(desktop.readyState).toBe(3);
    // A ping still gets its pong.
    const other = pair(registry);
    other.fromPhone.onMessage(Buffer.from('{"type":"ping"}'), false);
    expect(other.phone.sent.at(-1)).toBe('{"type":"pong"}');
  });

  it('reads the limits from the environment', () => {
    const { limits } = loadConfig({ BUFFERED_MEGABYTES: '8', MAX_BUFFERED_MEGABYTES: '256' });
    expect(limits.maxBuffered).toBe(8 * 1024 * 1024);
    expect(limits.maxBufferedTotal).toBe(256 * 1024 * 1024);
    expect(loadConfig({}).limits.maxBufferedTotal).toBe(512 * 1024 * 1024);
  });
});

describe('relay HTTP', () => {
  it('serves health, the landing page and asset links', async () => {
    const app = createApp({ androidCertFingerprints: [`${'AB:'.repeat(31)}AB`] });
    expect((await app.request('/health')).status).toBe(200);
    const page = await app.request('/p');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('https://play.google.com/store/apps/details?id=es.spainassist.firma');
    const fontPaths = [...html.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]!);
    expect(fontPaths).toHaveLength(3);
    for (const path of fontPaths) {
      const font = await app.request(path);
      expect(font.status).toBe(200);
      expect(font.headers.get('content-type')).toMatch(/^font\/(woff2|ttf)$/);
      expect((await font.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    expect((await app.request('/assets/unknown.ttf')).status).toBe(404);
    const links = (await (await app.request('/.well-known/assetlinks.json')).json()) as {
      target: { package_name: string };
    }[];
    expect(links[0]?.target.package_name).toBe('es.spainassist.firma');
    expect((await createApp().request('/.well-known/assetlinks.json')).status).toBe(404);
  });
});

describe('companion through the real relay', () => {
  it('pairs, signs and survives a phone reconnect', async () => {
    const { url, relay } = await start();
    let signer: PhoneSigner | undefined;
    const pairing = new DesktopPairing({
      relayUrl: url,
      appVersion: '0.1.0',
      onMessage: (m) => signer?.onMessage(m),
      onSession: () => signer?.onSession(),
      socket: { backoffMs: () => 20 },
    });
    signer = new PhoneSigner(pairing);
    const cert = crypto.randomBytes(200);
    const received: DesktopToPhone[] = [];
    let phone: PhoneClient | undefined;
    const makePhone = (link = pairing.link as string) =>
      new PhoneClient({
        link,
        hello: { app: '1.0.0', platform: 'test', device: 'Relay test' },
        socket: { backoffMs: () => 20 },
        onMessage: (m) => {
          received.push(m);
          if (m.type === 'sign.request') {
            phone?.send({
              type: 'sign.certificate',
              requestId: m.requestId,
              certificates: [cert.toString('base64')],
            });
          } else if (m.type === 'sign.toBeSigned') {
            phone?.send({
              type: 'sign.signature',
              requestId: m.requestId,
              seq: m.seq,
              signature: Buffer.from(m.data, 'base64').reverse().toString('base64'),
            });
          }
        },
      });
    phone = makePhone();
    try {
      await until(() => pairing.connected && (phone?.connected ?? false));
      const key = await signer.request({
        purpose: 'document',
        origin: 'https://sede.example.gob.es',
        description: 'Firmar',
        format: 'CAdES',
        documents: [{ mimeType: 'text/plain', data: Buffer.from('hola') }],
        verifiable: false,
        can: '123456',
        pin: '12345678',
      });
      expect(key.certificates[0]?.equals(cert)).toBe(true);
      // The phone app is killed and opened again (its stored pairing, new process). The QR's
      // link no longer works: the stored pairing holds the secret the first WELCOME sent.
      expect(pairing.link).toBeUndefined();
      phone.close();
      phone = makePhone(encodePairingLink(phone.pairing));
      await until(() => pairing.connected && (phone?.connected ?? false));
      const signature = await key.sign(Buffer.from([1, 2, 3]), 'SHA256withRSA');
      expect([...signature]).toEqual([3, 2, 1]);
      key.finish(true);
      await until(() => received.some((m) => m.type === 'sign.done'));
      expect(relay.registry.size).toBe(1);
    } finally {
      phone?.close();
      pairing.unpair();
    }
  });
});
