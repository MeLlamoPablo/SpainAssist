import crypto from 'node:crypto';
import { DesktopToPhone, PhoneToDesktop } from '@sa/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelError,
  DesktopPairing,
  decodePairingLink,
  encodePairingLink,
  FRAGMENT_BYTES,
  hkdfSha256,
  MessageAssembler,
  Opener,
  type PairingStatus,
  PhoneClient,
  type PhoneSignError,
  PhoneSigner,
  type PhoneStatus,
  roomId,
  Sealer,
  sealMessage,
} from '../src';
import { MemoryRelay } from '../src/testing';

const RELAY = 'wss://relay.example.test';
const fast = (relay: MemoryRelay) => ({
  WebSocket: relay.WebSocket,
  backoffMs: () => 5,
  pingIntervalMs: 60_000,
});

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup(relay = new MemoryRelay()) {
  const desktopMessages: PhoneToDesktop[] = [];
  const statuses: PairingStatus[] = [];
  let signer: PhoneSigner | undefined;
  const pairing = new DesktopPairing({
    relayUrl: RELAY,
    appVersion: '0.1.0',
    socket: fast(relay),
    onStatus: (s) => statuses.push(s),
    onMessage: (m) => {
      desktopMessages.push(m);
      signer?.onMessage(m);
    },
    onSession: () => signer?.onSession(),
  });
  signer = new PhoneSigner(pairing);
  cleanups.push(() => pairing.unpair());
  // The QR's link: the pairing shows it only until a phone pairs.
  const qr = pairing.link as string;
  const phoneMessages: DesktopToPhone[] = [];
  const phoneStatuses: PhoneStatus[] = [];
  const connectPhone = (link = qr) => {
    const phone = new PhoneClient({
      link,
      hello: { app: '1.0.0', platform: 'test', device: 'Test phone' },
      socket: fast(relay),
      onStatus: (s) => phoneStatuses.push(s),
      onMessage: (m) => phoneMessages.push(m),
    });
    cleanups.push(() => phone.close());
    return phone;
  };
  return {
    relay,
    pairing,
    qr,
    signer,
    statuses,
    desktopMessages,
    phoneMessages,
    phoneStatuses,
    connectPhone,
  };
}

describe('pairing link', () => {
  it('round-trips and keeps the payload in the fragment', () => {
    const link = {
      relayUrl: 'wss://relay.example.test',
      room: crypto.randomBytes(16),
      secret: crypto.randomBytes(32),
      desktopKey: crypto.createECDH('prime256v1').generateKeys(),
    };
    const text = encodePairingLink(link);
    expect(text.startsWith('https://relay.example.test/p#')).toBe(true);
    const back = decodePairingLink(text);
    expect(Buffer.from(back.room).equals(link.room)).toBe(true);
    expect(Buffer.from(back.secret).equals(link.secret)).toBe(true);
    expect(Buffer.from(back.desktopKey).equals(link.desktopKey)).toBe(true);
    expect(back.relayUrl).toBe('wss://relay.example.test');
  });

  it('uses http for a local ws relay and rejects other links', () => {
    const text = encodePairingLink({
      relayUrl: 'http://192.168.1.20:8794/',
      room: crypto.randomBytes(16),
      secret: crypto.randomBytes(32),
      desktopKey: crypto.createECDH('prime256v1').generateKeys(),
    });
    expect(text.startsWith('http://192.168.1.20:8794/p#')).toBe(true);
    expect(decodePairingLink(text).relayUrl).toBe('ws://192.168.1.20:8794');
    expect(() => decodePairingLink('https://example.com/p#abc')).toThrow();
    expect(() => decodePairingLink('https://example.com/p')).toThrow();
  });
});

describe('channel', () => {
  it('implements HKDF-SHA256 (RFC 5869, case 1)', () => {
    const okm = hkdfSha256(
      Buffer.from('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b', 'hex'),
      Buffer.from('000102030405060708090a0b0c', 'hex'),
      Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'),
      42,
    );
    expect(okm.toString('hex')).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('rejects replayed, reordered and tampered records', () => {
    const key = crypto.randomBytes(32);
    const sealer = new Sealer(key, 'desktopToPhone');
    const a = sealer.seal(Buffer.from([0x10]), Buffer.from('\x01a'));
    const b = sealer.seal(Buffer.from([0x10]), Buffer.from('\x01b'));
    const opener = new Opener(key, 'desktopToPhone');
    expect(() => opener.open(b, 1)).toThrow(ChannelError);
    expect(opener.open(a, 1).toString()).toBe('\x01a');
    expect(() => opener.open(a, 1)).toThrow(ChannelError);
    const tampered = Buffer.from(b);
    tampered[tampered.length - 1] ^= 1;
    expect(() => opener.open(tampered, 1)).toThrow(ChannelError);
    // The other direction's key and nonce space never open these frames.
    expect(() => new Opener(key, 'phoneToDesktop').open(a, 1)).toThrow(ChannelError);
  });

  it('splits large messages into fragments', () => {
    const key = crypto.randomBytes(32);
    const message = { type: 'big', data: 'x'.repeat(FRAGMENT_BYTES * 2 + 10) };
    const frames = sealMessage(new Sealer(key, 'phoneToDesktop'), message);
    expect(frames.length).toBe(3);
    const opener = new Opener(key, 'phoneToDesktop');
    const assembler = new MessageAssembler();
    const results = frames.map((f) => assembler.push(opener.open(f, 1)));
    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    expect(results[2]).toEqual(message);
  });
});

describe('DesktopPairing + PhoneClient', () => {
  it('pairs through the relay and carries messages both ways', async () => {
    const t = setup();
    await until(() => t.pairing.status.state === 'waiting');
    const phone = t.connectPhone();
    await until(() => t.pairing.status.state === 'connected' && phone.connected);
    expect(t.pairing.status).toMatchObject({ phone: { device: 'Test phone' } });
    expect(phone.current).toMatchObject({ state: 'connected', welcome: { app: '0.1.0' } });
    const id = crypto.randomUUID();
    expect(t.pairing.send({ type: 'sign.done', requestId: id })).toBe(true);
    phone.send({ type: 'sign.progress', requestId: id, stage: 'reviewing' });
    await until(() => t.phoneMessages.length === 1 && t.desktopMessages.length === 1);
    expect(t.phoneMessages[0]).toEqual({ type: 'sign.done', requestId: id });
  });

  it('handshakes again after the phone reconnects, and reports it as away meanwhile', async () => {
    const t = setup();
    const phone = t.connectPhone();
    await until(() => t.pairing.connected && phone.connected);
    t.relay.drop(roomId(phone.pairing.room), 'phone');
    await until(() => t.pairing.status.state === 'away');
    // It reconnects with the pairing's own secret; the QR is gone.
    expect(t.pairing.link).toBeUndefined();
    await until(() => t.pairing.connected && phone.connected);
    const id = crypto.randomUUID();
    expect(t.pairing.send({ type: 'sign.done', requestId: id })).toBe(true);
    await until(() => t.phoneMessages.length === 1);
  });

  it('lets the QR pair one phone: a later phone with it gets no session', async () => {
    const t = setup();
    const phone = t.connectPhone();
    await until(() => t.pairing.connected && phone.connected);
    expect(t.pairing.link).toBeUndefined();
    // The phone now holds the pairing's own secret, not the QR's.
    expect(Buffer.from(phone.pairing.secret).equals(decodePairingLink(t.qr).secret)).toBe(false);

    // Someone with a screenshot of the QR takes the phone's place in the relay room.
    const intruder = t.connectPhone(t.qr);
    await until(() => t.pairing.status.state === 'away');
    await new Promise((r) => setTimeout(r, 50));
    expect(intruder.connected).toBe(false);
    expect(t.pairing.connected).toBe(false);
    expect(t.pairing.status).toMatchObject({ state: 'away', phone: { device: 'Test phone' } });
    expect(t.pairing.send({ type: 'sign.done', requestId: crypto.randomUUID() })).toBe(false);
    expect(t.phoneMessages).toEqual([]);
  });

  it('refuses a phone that does not know the secret', async () => {
    const t = setup();
    const link = decodePairingLink(t.qr);
    const forged = encodePairingLink({ ...link, secret: crypto.randomBytes(32) });
    const phone = t.connectPhone(forged);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.pairing.connected).toBe(false);
    expect(phone.connected).toBe(false);
    expect(t.pairing.status.state).toBe('waiting');
  });

  it('tells the phone a link whose room is gone', async () => {
    const relay = new MemoryRelay();
    const t = setup(relay);
    relay.rooms.clear();
    relay.drop('x'.repeat(22), 'desktop');
    const link = decodePairingLink(t.qr);
    const other = encodePairingLink({ ...link, room: crypto.randomBytes(16) });
    t.connectPhone(other);
    await until(() => t.phoneStatuses.some((s) => s.state === 'ended'));
    expect(t.phoneStatuses.at(-1)).toEqual({ state: 'ended', reason: 'not_found' });
  });

  it('ends on either side when the other unpairs', async () => {
    const t = setup();
    const phone = t.connectPhone();
    await until(() => t.pairing.connected && phone.connected);
    phone.unpair();
    await until(() => t.pairing.status.state === 'ended');
    expect(t.pairing.status).toEqual({ state: 'ended', reason: 'phone_unpaired' });

    const u = setup();
    const phone2 = u.connectPhone();
    await until(() => u.pairing.connected && phone2.connected);
    u.pairing.unpair();
    await until(() => phone2.current.state === 'ended');
    expect(phone2.current).toEqual({ state: 'ended', reason: 'desktop_unpaired' });
  });
});

describe('PhoneSigner', () => {
  const cert = crypto.randomBytes(300);

  /** A phone that approves and signs (with a fake signature = sha256 of the data). */
  function autoPhone(t: ReturnType<typeof setup>) {
    const phone = t.connectPhone();
    const signed: number[] = [];
    const seen: DesktopToPhone[] = [];
    let skip = 0;
    const handle = () => {
      for (const m of t.phoneMessages.splice(0)) {
        seen.push(m);
        if (m.type === 'sign.request') {
          phone.send({ type: 'sign.progress', requestId: m.requestId, stage: 'reviewing' });
          phone.send({
            type: 'sign.certificate',
            requestId: m.requestId,
            certificates: [cert.toString('base64')],
          });
        } else if (m.type === 'sign.toBeSigned') {
          if (skip > 0) {
            skip--;
            continue;
          }
          signed.push(m.seq);
          const signature = crypto.createHash('sha256').update(m.data, 'base64').digest();
          phone.send({
            type: 'sign.signature',
            requestId: m.requestId,
            seq: m.seq,
            signature: signature.toString('base64'),
          });
        }
      }
    };
    const timer = setInterval(handle, 2);
    cleanups.push(() => clearInterval(timer));
    return {
      phone,
      signed,
      seen,
      skipNext: () => {
        skip++;
      },
    };
  }

  const request = {
    purpose: 'document' as const,
    origin: 'https://sede.example.gob.es',
    description: 'Firmar solicitud.pdf',
    format: 'CAdES',
    documents: [{ name: 'solicitud.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF') }],
    verifiable: true,
    can: '123456',
  };

  it('requests, signs and finishes', async () => {
    const t = setup();
    const { phone, seen } = autoPhone(t);
    const stages: string[] = [];
    const key = await t.signer.request({ ...request, onStage: (s) => stages.push(s) });
    expect(key.certificates[0]?.equals(cert)).toBe(true);
    expect(stages).toEqual(['reviewing']);
    const data = Buffer.from('signed attributes');
    const signature = await key.sign(data, 'SHA256withRSA', { kind: 'cms', document: 0 });
    expect(signature.equals(crypto.createHash('sha256').update(data).digest())).toBe(true);
    key.finish(true);
    await until(() => seen.some((m) => m.type === 'sign.done'));
    expect(t.signer.busy).toBe(false);
    expect(phone.connected).toBe(true);
  });

  it('carries the CAN, and the PIN when given, in the encrypted request only', async () => {
    const t = setup();
    const { seen } = autoPhone(t);
    (await t.signer.request(request)).finish(true);
    (await t.signer.request({ ...request, pin: 'Abcd1234' })).finish(true);
    await until(() => seen.filter((m) => m.type === 'sign.request').length === 2);
    const [plain, withPin] = seen.filter((m) => m.type === 'sign.request');
    expect(plain).toMatchObject({ can: '123456' });
    expect(plain).not.toHaveProperty('pin');
    expect(withPin).toMatchObject({ can: '123456', pin: 'Abcd1234' });
    expect(t.qr).not.toContain('123456');
    expect(t.qr).not.toContain('Abcd1234');
    const base = { ...withPin, requestId: crypto.randomUUID() };
    const { can: _can, ...noCan } = base;
    expect(DesktopToPhone.safeParse(noCan).success).toBe(false);
    for (const can of ['12345', '1234567', 'abcdef', 123456])
      expect(DesktopToPhone.safeParse({ ...base, can }).success, String(can)).toBe(false);
    // 8 to 16 characters.
    for (const pin of ['1234567', '12345678901234567', 12345678])
      expect(DesktopToPhone.safeParse({ ...base, pin }).success, String(pin)).toBe(false);
    expect(DesktopToPhone.safeParse({ ...base, pin: '1234567890123456' }).success).toBe(true);
  });

  it('asks for a new PIN when the card refuses it, and sends it once', async () => {
    const t = setup();
    const phone = t.connectPhone();
    const needs: unknown[] = [];
    let answer: (value: string | null) => void = () => {};
    const pending = t.signer.request({
      ...request,
      pin: 'Abcd1234',
      reviewTimeoutMs: 60,
      onNeed: (need) => {
        needs.push(need);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'));
    const requestId = (t.phoneMessages[0] as { requestId: string }).requestId;
    const need = {
      type: 'sign.need',
      requestId,
      what: 'pin',
      refused: true,
      triesLeft: 2,
    } as const;
    phone.send(need);
    phone.send(need);
    await until(() => needs.length > 0);
    // Asking the user: the request's timers wait.
    await new Promise((r) => setTimeout(r, 120));
    expect(t.signer.busy).toBe(true);
    expect(needs).toEqual([{ what: 'pin', refused: true, triesLeft: 2 }]);
    answer('Nuevo5678');
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.unlock'));
    expect(t.phoneMessages.find((m) => m.type === 'sign.unlock')).toMatchObject({
      requestId,
      pin: 'Nuevo5678',
    });
    expect(t.phoneMessages.find((m) => m.type === 'sign.unlock')).not.toHaveProperty('can');
    // Re-sent while it's on its way: not asked again.
    phone.send(need);
    await new Promise((r) => setTimeout(r, 20));
    expect(needs).toHaveLength(1);
    // Answered: neither the PIN nor the unlock goes again after a reconnect.
    phone.send({ type: 'sign.progress', requestId, stage: 'card' });
    phone.send({ type: 'sign.certificate', requestId, certificates: [cert.toString('base64')] });
    const key = await pending;
    const sent = t.phoneMessages.length;
    t.relay.drop(roomId(phone.pairing.room), 'phone');
    await until(() => t.phoneMessages.length > sent);
    expect(t.phoneMessages.slice(sent).map((m) => m.type)).toEqual(['sign.request']);
    expect(t.phoneMessages.at(-1)).not.toHaveProperty('pin');
    key.finish(true);
    // The report has no room for a PIN.
    expect(PhoneToDesktop.safeParse({ ...need, pin: 'Abcd1234' }).success).toBe(false);
  });

  it('cancels when the user gives no new CAN, or nobody can ask', async () => {
    const t = setup();
    const phone = t.connectPhone();
    const asking = t.signer.request({ ...request, onNeed: async () => null });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'));
    const first = (t.phoneMessages.at(-1) as { requestId: string }).requestId;
    phone.send({ type: 'sign.need', requestId: first, what: 'can', refused: true });
    await expect(asking).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.cancel'));

    const silent = t.signer.request(request);
    await until(() => t.phoneMessages.filter((m) => m.type === 'sign.request').length === 2);
    const second = (t.phoneMessages.at(-1) as { requestId: string }).requestId;
    phone.send({ type: 'sign.need', requestId: second, what: 'pin', refused: false });
    await expect(silent).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('sends the PIN once: after the phone answers, a re-sent request leaves it out', async () => {
    const t = setup();
    const phone = t.connectPhone();
    const requests = () => t.phoneMessages.filter((m) => m.type === 'sign.request');
    const pending = t.signer.request({ ...request, pin: 'Abcd1234' });
    await until(() => requests().length === 1);
    // Not answered yet (it may not have arrived): sent again with the PIN.
    t.relay.drop(roomId(phone.pairing.room), 'phone');
    await until(() => requests().length === 2);
    expect(requests()[1]).toMatchObject({ pin: 'Abcd1234' });
    // Answered: a phone that connects from now on doesn't get it.
    const requestId = requests()[0]!.requestId;
    phone.send({ type: 'sign.progress', requestId, stage: 'reviewing' });
    await until(() => t.desktopMessages.some((m) => m.type === 'sign.progress'));
    t.relay.drop(roomId(phone.pairing.room), 'phone');
    await until(() => requests().length === 3);
    expect(requests()[2]).toMatchObject({ requestId });
    expect(requests()[2]).not.toHaveProperty('pin');
    t.signer.onEnded('unpaired');
    await expect(pending).rejects.toThrow('unpaired');
  });

  it('waits for a phone that is not there yet', async () => {
    const t = setup();
    const pending = t.signer.request(request);
    await new Promise((r) => setTimeout(r, 30));
    autoPhone(t);
    const key = await pending;
    expect(key.certificates).toHaveLength(1);
  });

  it('re-sends what the phone missed when the connection comes back', async () => {
    const t = setup();
    const auto = autoPhone(t);
    const key = await t.signer.request(request);
    auto.skipNext(); // the phone "loses" the first toBeSigned
    const signing = key.sign(Buffer.from('a'), 'SHA256withRSA');
    await new Promise((r) => setTimeout(r, 30));
    t.relay.drop(roomId(auto.phone.pairing.room), 'phone');
    const signature = await signing;
    expect(signature).toHaveLength(32);
    expect(auto.signed).toEqual([1]);
  });

  it('is busy while a request runs, and cancels on abort', async () => {
    const t = setup();
    t.connectPhone();
    const abort = new AbortController();
    const pending = t.signer.request({ ...request, signal: abort.signal });
    await expect(t.signer.request(request)).rejects.toMatchObject({ code: 'busy' });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'));
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.cancel'));
    expect(t.signer.busy).toBe(false);
  });

  it('reports phone errors and timeouts', async () => {
    const t = setup();
    const phone = t.connectPhone();
    const failing = t.signer.request(request);
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'));
    const req = t.phoneMessages.find((m) => m.type === 'sign.request') as { requestId: string };
    phone.send({ type: 'sign.error', requestId: req.requestId, code: 'pin_blocked' });
    await expect(failing).rejects.toMatchObject({ code: 'pin_blocked' });

    const timing = t.signer.request({ ...request, reviewTimeoutMs: 20 });
    const error = (await timing.catch((e) => e)) as PhoneSignError;
    expect(error.code).toBe('timeout');
    await until(() =>
      t.phoneMessages.some((m) => m.type === 'sign.cancel' && m.reason === 'timeout'),
    );
  });

  it('drops the document data and the checks when the document is too large', async () => {
    const t = setup();
    t.connectPhone();
    const big = Buffer.alloc(13 * 1024 * 1024);
    const pending = t.signer.request({
      ...request,
      documents: [{ mimeType: 'application/pdf', data: big }],
    });
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'), 5000);
    const sent = t.phoneMessages.find((m) => m.type === 'sign.request');
    expect(sent).toMatchObject({ verifiable: false, documents: [{ size: big.length }] });
    expect((sent as { documents: { data?: string }[] }).documents[0]?.data).toBeUndefined();
    t.signer.onEnded('unpaired');
    await expect(pending).rejects.toMatchObject({ code: 'unpaired' });
  });

  it('fails when a reconnected phone answers with another card', async () => {
    const t = setup();
    const phone = t.connectPhone();
    const pending = t.signer.request(request);
    await until(() => t.phoneMessages.some((m) => m.type === 'sign.request'));
    const { requestId } = t.phoneMessages.find((m) => m.type === 'sign.request') as {
      requestId: string;
    };
    phone.send({ type: 'sign.certificate', requestId, certificates: [cert.toString('base64')] });
    const key = await pending;
    const signing = key.sign(Buffer.from('a'), 'SHA256withRSA');
    phone.send({
      type: 'sign.certificate',
      requestId,
      certificates: [crypto.randomBytes(300).toString('base64')],
    });
    await expect(signing).rejects.toMatchObject({ code: 'wrong_card' });
  });
});

describe('PhoneSigner timing', () => {
  const request = {
    purpose: 'login' as const,
    origin: 'https://sede.example.gob.es',
    description: 'Acceder',
    format: '',
    documents: [],
    verifiable: false,
    can: '123456',
  };
  const REVIEW = 5 * 60_000;
  const AWAY = 10 * 60_000;

  /** A link the test connects and disconnects, as the pairing would. */
  function fakeLink() {
    const sent: DesktopToPhone[] = [];
    const link = {
      connected: false,
      sent,
      send: (m: DesktopToPhone) => {
        if (link.connected) sent.push(m);
        return link.connected;
      },
    };
    const signer = new PhoneSigner(link);
    const connect = () => {
      link.connected = true;
      signer.onSession();
    };
    const away = () => {
      link.connected = false;
      signer.onAway();
    };
    const requestOf = () => sent.find((m) => m.type === 'sign.request');
    return { link, signer, connect, away, requestOf };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits longer for an away phone, and starts the review time once it has the request', async () => {
    vi.useFakeTimers();
    const t = fakeLink();
    const pending = t.signer.request(request);
    let settled = false;
    pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Away for longer than the review time: the request still waits.
    await vi.advanceTimersByTimeAsync(REVIEW + 60_000);
    expect(settled).toBe(false);
    expect(t.requestOf()).toBeUndefined();
    t.connect();
    const sent = t.requestOf();
    expect(sent).toBeDefined();
    // Its deadline counts from when the phone gets it, not from when it was asked.
    const expiresAt = Date.parse((sent as { expiresAt: string }).expiresAt);
    expect(expiresAt).toBe(Date.now() + REVIEW);
    // The away wait is over: only the review time runs now.
    await vi.advanceTimersByTimeAsync(AWAY);
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
    expect(t.link.sent.at(-1)).toMatchObject({ type: 'sign.cancel', reason: 'timeout' });
  });

  it('ends with phone_away when the app is never opened', async () => {
    vi.useFakeTimers();
    const t = fakeLink();
    const pending = t.signer.request(request);
    const failed = expect(pending).rejects.toMatchObject({ code: 'phone_away' });
    await vi.advanceTimersByTimeAsync(AWAY - 1);
    expect(t.signer.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(t.signer.busy).toBe(false);
    expect(t.link.sent).toEqual([]);
  });

  it('times out as before when the phone is connected, and honours the given times', async () => {
    vi.useFakeTimers();
    const t = fakeLink();
    t.link.connected = true;
    const pending = t.signer.request({ ...request, reviewTimeoutMs: 1000, awayTimeoutMs: 50 });
    const failed = expect(pending).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(999);
    expect(t.signer.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
  });

  it('goes back to waiting when the phone leaves before answering, not after', async () => {
    vi.useFakeTimers();
    const t = fakeLink();
    t.link.connected = true;
    const pending = t.signer.request(request);
    let error: PhoneSignError | undefined;
    pending.catch((e) => {
      error = e;
    });
    await vi.advanceTimersByTimeAsync(REVIEW - 1000);
    // The app closed before it showed the request: the review time doesn't run out meanwhile.
    t.away();
    await vi.advanceTimersByTimeAsync(AWAY - 1000);
    expect(error).toBeUndefined();
    t.connect();
    const requests = t.link.sent.filter((m) => m.type === 'sign.request');
    expect(requests).toHaveLength(2);
    expect(Date.parse((requests[1] as { expiresAt: string }).expiresAt)).toBe(Date.now() + REVIEW);
    // The phone shows it: from now on a disconnect doesn't pause the review time.
    const { requestId } = requests[1] as { requestId: string };
    t.signer.onMessage({ type: 'sign.progress', requestId, stage: 'reviewing' });
    t.away();
    await vi.advanceTimersByTimeAsync(REVIEW);
    expect(error?.code).toBe('timeout');
  });

  it('resolves when the phone answers', async () => {
    const t = fakeLink();
    const pending = t.signer.request(request);
    t.connect();
    const { requestId } = t.requestOf() as { requestId: string };
    t.signer.onMessage({
      type: 'sign.certificate',
      requestId,
      certificates: [Buffer.from('cert').toString('base64')],
    });
    await expect(pending).resolves.toMatchObject({ certificates: [Buffer.from('cert')] });
    t.away();
  });
});
