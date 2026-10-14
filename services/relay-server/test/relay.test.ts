import crypto from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { DesktopPairing, encodePairingLink, PhoneClient, PhoneSigner } from '@sa/companion';
import { type DesktopToPhone, RELAY_CLOSE } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, createRelay, type Relay, type RelayOptions } from '../src';

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

describe('relay HTTP', () => {
  it('serves health, the landing page and asset links', async () => {
    const app = createApp({ androidCertFingerprints: [`${'AB:'.repeat(31)}AB`] });
    expect((await app.request('/health')).status).toBe(200);
    const page = await app.request('/p');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('scheme=sa-firma;package=es.spainassist.firma');
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
