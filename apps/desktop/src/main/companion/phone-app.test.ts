import crypto from 'node:crypto';
import { encodePairingLink, PhoneClient } from '@sa/companion';
import { MemoryRelay } from '@sa/companion/testing';
import {
  type AfirmaSignatureSummary,
  COMPANION_PROTOCOL_MIN,
  type DesktopToPhone,
  type ExternalSigningKey,
} from '@sa/shared';
import type { RemoteKey } from '@sa/sidecar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../core/i18n';
import { createFakeFetch, createTestApp, jsonResponse, type TestApp } from '../testing/harness';
import {
  PHONE_APP_REFRESH_MS,
  PHONE_APP_RETRY_MS,
  phoneAppBehind,
  readLatestPhoneApp,
} from './phone-app';

const LATEST = {
  version: '0.3.5',
  url: 'https://github.com/MeLlamoPablo/SpainAssist/releases/download/android/v0.3.5/spain-assist-0.3.5.apk',
  sha256: 'ab'.repeat(32),
  page: 'https://relay.example.test/android',
};
const PHONE_APP = { version: LATEST.version, page: LATEST.page };
const STORE = { store: 'https://play.google.com/store/apps/details?id=es.spainassist.firma' };

const summary: AfirmaSignatureSummary = {
  method: 'sign',
  format: 'CAdES',
  algorithm: 'SHA256withRSA',
  origin: 'https://sede.example.gob.es',
  description: 'Firmar un texto.',
  dataSize: 4,
  documents: [{ mimeType: 'text/plain', data: Buffer.from('hola') }],
  verifiable: true,
};

/** A relay whose `/android/latest.json` answers with `answer()`; any other request fails. */
function fakeRelay(answer: () => Response) {
  const fetch = createFakeFetch((req) => {
    if (req.url.href === 'https://relay.example.test/android/latest.json') return answer();
    throw new TypeError('fetch failed');
  });
  const reads = () => fetch.requests.filter((r) => r.url.host === 'relay.example.test').length;
  return { fetch, reads };
}

describe("the relay's latest phone app", () => {
  it('reads the version and the download page from /android/latest.json', async () => {
    const { fetch } = fakeRelay(() => jsonResponse(200, LATEST));
    expect(await readLatestPhoneApp(fetch, 'wss://relay.example.test')).toEqual(PHONE_APP);
    expect(fetch.requests[0]?.method).toBe('GET');
    // A development relay speaks plain HTTP.
    const local = createFakeFetch(() =>
      jsonResponse(200, { ...LATEST, page: 'http://192.168.1.20:8794/android' }),
    );
    await readLatestPhoneApp(local, 'ws://192.168.1.20:8794');
    expect(local.requests[0]?.url.href).toBe('http://192.168.1.20:8794/android/latest.json');
  });

  it('knows of none while the relay sends to the store, or answers something else', async () => {
    for (const body of [
      STORE,
      { version: '0.3.5' },
      { ...LATEST, page: 'javascript:alert(1)' },
      { ...LATEST, version: 7 },
      'nonsense',
    ]) {
      const { fetch } = fakeRelay(() => jsonResponse(200, body));
      expect(await readLatestPhoneApp(fetch, 'wss://relay.example.test')).toBeUndefined();
    }
  });

  it('fails when the relay cannot be read', async () => {
    const down = fakeRelay(() => {
      throw new TypeError('fetch failed');
    });
    await expect(readLatestPhoneApp(down.fetch, 'wss://relay.example.test')).rejects.toThrow();
    const old = fakeRelay(() => jsonResponse(404, {}));
    await expect(readLatestPhoneApp(old.fetch, 'wss://relay.example.test')).rejects.toThrow();
  });

  it('compares versions as semver and ignores the ones that do not parse', () => {
    expect(phoneAppBehind('0.3.4', '0.3.5')).toBe(true);
    expect(phoneAppBehind('0.3.9', '0.3.10')).toBe(true);
    expect(phoneAppBehind('0.9.9', '1.0.0')).toBe(true);
    expect(phoneAppBehind('0.3.5', '0.3.5')).toBe(false);
    expect(phoneAppBehind('0.4.0', '0.3.5')).toBe(false);
    expect(phoneAppBehind('0.3.5-beta.2', '0.3.5')).toBe(true);
    expect(phoneAppBehind('0.3.5-beta.2', '0.3.5-beta.10')).toBe(true);
    expect(phoneAppBehind('0.3.5', '0.3.5-beta.1')).toBe(false);
    expect(phoneAppBehind('0.3.5+12', '0.3.5')).toBe(false);
    for (const [app, latest] of [
      ['dev', '0.3.5'],
      ['0.3', '0.3.5'],
      ['0.3.4', 'latest'],
      ['', '0.3.5'],
    ] as const)
      expect(phoneAppBehind(app, latest)).toBe(false);
  });
});

describe('the phone app of the paired phone', () => {
  let app: TestApp | undefined;
  const phones: PhoneClient[] = [];
  afterEach(async () => {
    for (const phone of phones.splice(0)) phone.close();
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  async function setup(answer: () => Response) {
    const relay = new MemoryRelay();
    const { fetch, reads } = fakeRelay(answer);
    app = await createTestApp({
      env: { relayServerUrl: 'wss://relay.example.test' },
      relaySocket: relay.WebSocket,
      fetch,
    });
    return { relay, app, reads, companion: app.services.companion! };
  }

  function phone(
    relay: MemoryRelay,
    link: string,
    version: string,
    protocol?: number,
    received: DesktopToPhone[] = [],
  ) {
    const hello = { app: version, platform: 'test', device: 'Pixel 8' } as const;
    // Reads the card and signs whatever it is sent.
    const client: PhoneClient = new PhoneClient({
      link,
      hello: protocol === undefined ? hello : ({ ...hello, protocol } as typeof hello),
      socket: { WebSocket: relay.WebSocket, backoffMs: () => 5 },
      onMessage: (m) => {
        received.push(m);
        if (m.type === 'sign.request')
          client.send({
            type: 'sign.certificate',
            requestId: m.requestId,
            certificates: [Buffer.alloc(256, 1).toString('base64')],
          });
      },
    });
    phones.push(client);
    return client;
  }

  /** The stage of the DNI card that is waiting, if any. */
  const stage = (a: TestApp, procedureId: string) => {
    const prompt = a.pendingPrompt(procedureId)?.prompt;
    return prompt?.kind === 'dnie_signature' ? prompt.stage : undefined;
  };

  /** A paired, connected phone whose app is `version`, and a saved DNI to sign with. */
  async function paired(version: string, answer: () => Response = () => jsonResponse(200, LATEST)) {
    const s = await setup(answer);
    const { procedureId } = await s.app.procedureWithToken();
    await s.app.invoke('vault.addDnie');
    await s.app.waitFor(() => s.reads() === 1);
    const { link } = await s.app.invoke('companion.pair');
    const received: DesktopToPhone[] = [];
    const client = phone(s.relay, link as string, version, undefined, received);
    await s.app.waitFor(() => s.companion.status().state === 'connected');
    return { ...s, procedureId, client, received };
  }

  /** Types the CAN and the PIN the DNI card asks for before it reaches the phone. */
  async function typeUnlock(a: TestApp, procedureId: string) {
    await a.waitFor(() => {
      const p = a.pendingPrompt(procedureId)?.prompt;
      return p?.kind === 'dnie_signature' && p.stage === 'unlock';
    });
    await a.invoke('companion.unlock', a.pendingPrompt(procedureId)!.id, {
      can: '123456',
      pin: 'Abcd1234',
    });
  }

  it('tells a connected phone whose app is older than the one the relay offers', async () => {
    const { relay, app: a, reads, companion } = await setup(() => jsonResponse(200, LATEST));
    // Read when the service starts, before any pairing.
    await a.waitFor(() => reads() === 1);
    const { link } = await a.invoke('companion.pair');
    await a.waitFor(() => companion.status().state === 'waiting');
    expect(companion.status()).toMatchObject({ phoneApp: PHONE_APP });
    expect(companion.status()).not.toHaveProperty('phoneUpdate');

    phone(relay, link as string, '0.3.4');
    await a.waitFor(() => companion.status().state === 'connected');
    expect(await a.invoke('companion.status')).toMatchObject({
      state: 'connected',
      device: 'Pixel 8',
      phoneApp: PHONE_APP,
      phoneUpdate: true,
    });
    // It is only a notice: the phone is connected and not out of date.
    expect(companion.status()).not.toHaveProperty('outdated');

    // The same version, a newer one or one that doesn't parse: nothing to say.
    for (const version of ['0.3.5', '0.4.0', 'dev']) {
      for (const p of phones.splice(0)) p.close();
      const again = await a.invoke('companion.pairAnother');
      phone(relay, again.link as string, version);
      await a.waitFor(() => companion.status().state === 'connected');
      expect(companion.status()).toMatchObject({ phoneApp: PHONE_APP });
      expect(companion.status()).not.toHaveProperty('phoneUpdate');
    }
  });

  it('says nothing while the relay sends to the store or cannot be reached', async () => {
    for (const answer of [
      () => jsonResponse(200, STORE),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const { relay, app: a, reads, companion } = await setup(answer);
      await a.waitFor(() => reads() === 1);
      const { link } = await a.invoke('companion.pair');
      phone(relay, link as string, '0.3.4');
      await a.waitFor(() => companion.status().state === 'connected');
      const status = await a.invoke('companion.status');
      expect(status).not.toHaveProperty('phoneApp');
      expect(status).not.toHaveProperty('phoneUpdate');
      for (const p of phones.splice(0)) p.close();
      await a.close();
      app = undefined;
    }
  });

  it('reads the relay again only after some hours, or sooner after a failed read', async () => {
    let answer = (): Response => {
      throw new TypeError('fetch failed');
    };
    const { relay, app: a, reads, companion } = await setup(() => answer());
    await a.waitFor(() => reads() === 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    answer = () => jsonResponse(200, LATEST);
    // Too soon after the failure: pairing doesn't read again.
    await a.invoke('companion.pair');
    expect(reads()).toBe(1);
    vi.setSystemTime(start + PHONE_APP_RETRY_MS + 1000);
    const { link } = await a.invoke('companion.pairAnother');
    expect(reads()).toBe(2);
    // The renderer hears once the answer is in, without asking.
    await a.waitFor(() =>
      a.events.some((e) => e.type === 'companion.changed' && !!e.status.phoneApp),
    );

    // A phone that comes and goes within the hours a read lasts doesn't ask the relay again.
    vi.setSystemTime(start + PHONE_APP_RETRY_MS + PHONE_APP_REFRESH_MS - 60_000);
    phone(relay, link as string, '0.3.4');
    await a.waitFor(() => companion.status().state === 'connected');
    expect(reads()).toBe(2);
    // Later it does, and the relay now sends to Google Play: no notice any more.
    answer = () => jsonResponse(200, STORE);
    vi.setSystemTime(start + PHONE_APP_RETRY_MS + PHONE_APP_REFRESH_MS + 60_000);
    for (const p of phones.splice(0)) p.close();
    await a.waitFor(() => reads() === 3);
    await a.waitFor(() => !companion.status().phoneApp);
    expect(companion.status()).not.toHaveProperty('phoneUpdate');
  });

  it('offers the update before a DNI request, and goes on without it when the user says so', async () => {
    const { app: a, companion, procedureId, received } = await paired('0.3.4');
    const approval = a.signWithDnie(procedureId, summary);
    await a.waitFor(() => stage(a, procedureId) === 'update');
    // Nothing goes to the phone, and nothing is asked, until the update is settled.
    expect(received).toEqual([]);
    expect(a.pendingPrompt(procedureId)?.prompt).not.toHaveProperty('unlock');
    expect(companion.status()).toMatchObject({ phoneApp: PHONE_APP, phoneUpdate: true });

    await a.invoke('companion.skipUpdate', a.pendingPrompt(procedureId)!.id);
    await typeUnlock(a, procedureId);
    const key = (await approval) as ExternalSigningKey;
    expect(key.kind).toBe('external');
    expect(received.filter((m) => m.type === 'sign.request')).toHaveLength(1);
    key.release(true);
    await a.waitFor(() => stage(a, procedureId) === undefined);
    // Skipping twice is refused: the card has moved on.
    await expect(a.invoke('companion.skipUpdate', 'no-such-prompt')).rejects.toThrow();

    // The version the user went on without isn't offered again while the app runs.
    const again = a.signWithDnie(procedureId, summary);
    await a.waitFor(() => stage(a, procedureId) !== undefined);
    expect(stage(a, procedureId)).not.toBe('update');
    ((await again) as ExternalSigningKey).release(true);
    // Mis datos still says there is a newer version.
    expect(companion.status()).toMatchObject({ phoneUpdate: true });
  });

  it('goes on by itself once the updated phone app connects', async () => {
    const { relay, app: a, companion, procedureId, client } = await paired('0.3.4');
    const approval = a.signWithDnie(procedureId, summary);
    await a.waitFor(() => stage(a, procedureId) === 'update');
    // The phone installs the update: its app closes (the offer stays), then opens as 0.3.5.
    const pairing = encodePairingLink(client.pairing);
    for (const p of phones.splice(0)) p.close();
    await a.waitFor(() => companion.status().state === 'away');
    expect(companion.status()).toMatchObject({ phoneUpdate: true });
    expect(stage(a, procedureId)).toBe('update');
    const received: DesktopToPhone[] = [];
    phone(relay, pairing, '0.3.5', undefined, received);
    await a.waitFor(() => stage(a, procedureId) === 'unlock');
    expect(companion.status()).not.toHaveProperty('phoneUpdate');
    await typeUnlock(a, procedureId);
    const key = (await approval) as ExternalSigningKey;
    expect(key.kind).toBe('external');
    expect(received.filter((m) => m.type === 'sign.request')).toHaveLength(1);
    key.release(true);
  });

  it('cancels a request that waits for the update', async () => {
    const { app: a, procedureId, received } = await paired('0.3.4');
    const approval = a.signWithDnie(procedureId, summary);
    await a.waitFor(() => stage(a, procedureId) === 'update');
    await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
      kind: 'dnie_signature',
      outcome: 'cancelled',
    });
    expect(await approval).toBeNull();
    expect(received).toEqual([]);
    // Nothing is left to skip.
    await expect(
      a.invoke('companion.skipUpdate', a.pendingPrompt(procedureId)?.id ?? 'gone'),
    ).rejects.toThrow();
  });

  it('asks for nothing first when the phone app is current or the relay offers none', async () => {
    for (const [version, answer] of [
      ['0.3.5', LATEST],
      ['0.3.4', STORE],
    ] as const) {
      const { app: a, procedureId } = await paired(version, () => jsonResponse(200, answer));
      const approval = a.signWithDnie(procedureId, summary);
      await a.waitFor(() => stage(a, procedureId) !== undefined);
      expect(stage(a, procedureId)).toBe('unlock');
      await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
        kind: 'dnie_signature',
        outcome: 'cancelled',
      });
      expect(await approval).toBeNull();
      for (const p of phones.splice(0)) p.close();
      await a.close();
      app = undefined;
    }
  });

  it('sends an out-of-date phone app to the QR instead of Google Play', async () => {
    for (const [answer, notice, why] of [
      [LATEST, 'dnieError_phone_outdated_download', /Spain Assist shows a QR to download it/],
      [STORE, 'dnieError_phone_outdated', /update it from Google Play/],
    ] as const) {
      const { relay, app: a, reads, companion } = await setup(() => jsonResponse(200, answer));
      const { procedureId } = await a.procedureWithToken();
      const dnie = await a.invoke('vault.addDnie');
      await a.waitFor(() => reads() === 1);
      const { link } = await a.invoke('companion.pair');
      await a.waitFor(() => companion.status().state === 'waiting');
      phone(relay, link as string, '0.2.0', COMPANION_PROTOCOL_MIN - 1);
      await a.waitFor(() => !!companion.status().outdated);
      const status = await a.invoke('companion.status');
      if (answer === LATEST) expect(status).toMatchObject({ phoneApp: PHONE_APP });
      else expect(status).not.toHaveProperty('phoneApp');

      // What the user reads when a signature fails for it.
      const approval = a.signWithDnie(procedureId, summary);
      await typeUnlock(a, procedureId);
      expect(await approval).toBeNull();
      expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
        type: 'notice',
        text: t('es', notice),
      });
      // What the agent reads when a login does.
      const login = companion.login(procedureId, dnie, {
        session: crypto.randomUUID(),
        origins: ['https://idp.seg-social.es'],
      }).key as RemoteKey;
      await expect(
        login.prepare('idp.seg-social.es', new AbortController().signal),
      ).rejects.toThrow('not approved');
      expect(companion.takeLoginNotes(procedureId).join('\n')).toMatch(why);
      for (const p of phones.splice(0)) p.close();
      await a.close();
      app = undefined;
    }
  });
});
