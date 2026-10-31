import crypto from 'node:crypto';
import { PAIRING_LIFETIME_MS, PhoneClient } from '@sa/companion';
import { MemoryRelay } from '@sa/companion/testing';
import {
  type AfirmaSignatureSummary,
  COMPANION_PROTOCOL,
  COMPANION_STALLED_MS,
  type DesktopToPhone,
  type ExternalSigningKey,
  RELAY_CLOSE,
} from '@sa/shared';
import type { RemoteKey } from '@sa/sidecar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../core/i18n';
import type { Biometric } from '../ports';
import { createTestApp, type TestApp } from '../testing/harness';
import { DNIE_LOGIN_IDLE_MS } from './service';

let app: TestApp | undefined;
const phones: PhoneClient[] = [];
afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close();
  await app?.close();
  app = undefined;
  vi.useRealTimers();
});

const DOCUMENT = Buffer.from('Solicitud de prueba');
const summary: AfirmaSignatureSummary = {
  method: 'sign',
  format: 'CAdES',
  algorithm: 'SHA256withRSA',
  origin: 'https://sede.example.gob.es',
  description: 'Firmar un texto (19 bytes).',
  dataSize: DOCUMENT.length,
  documents: [{ mimeType: 'text/plain', data: DOCUMENT }],
  verifiable: true,
};

async function setup(biometric?: Biometric) {
  const relay = new MemoryRelay();
  app = await createTestApp({
    env: { relayServerUrl: 'wss://relay.example.test' },
    relaySocket: relay.WebSocket,
    ...(biometric ? { biometric } : {}),
  });
  const { procedureId, token } = await app.procedureWithToken();
  const dnie = await app.invoke('vault.addDnie');
  return { relay, app, procedureId, token, dnie };
}

/** A phone that does what `script` says with each request. */
function phone(
  relay: MemoryRelay,
  link: string,
  script: (m: DesktopToPhone, send: PhoneClient['send']) => void,
) {
  const received: DesktopToPhone[] = [];
  const client: PhoneClient = new PhoneClient({
    link,
    hello: { app: '1.0.0', platform: 'test', device: 'Phone under test' },
    socket: { WebSocket: relay.WebSocket, backoffMs: () => 5 },
    onMessage: (m) => {
      received.push(m);
      script(m, (reply) => client.send(reply));
    },
  });
  phones.push(client);
  return { client, received };
}

const CERT = crypto.randomBytes(256);
const CAN = '123456';
const PIN = 'Abcd1234';

/** Waits for the DNI card's `unlock` stage and types what it asks for. */
async function typeUnlock(
  a: TestApp,
  procedureId: string,
  values: { can?: string; pin?: string } = { can: CAN, pin: PIN },
) {
  await a.waitFor(() => {
    const p = a.pendingPrompt(procedureId)?.prompt;
    return p?.kind === 'dnie_signature' && p.stage === 'unlock';
  });
  const item = a.pendingPrompt(procedureId)!;
  await a.invoke('companion.unlock', item.id, values);
  return item.prompt;
}

describe('DNI signatures with the phone', () => {
  it('pairs on demand, shows the phone progress and signs through the phone', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
    // The desktop asks for the CAN and the PIN first.
    expect(await typeUnlock(a, procedureId)).toMatchObject({
      stage: 'unlock',
      unlock: { can: true, pin: true },
    });
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
    expect(a.pendingPrompt(procedureId)?.prompt).toMatchObject({ stage: 'phone' });
    expect(a.pendingPrompt(procedureId)?.prompt).not.toHaveProperty('unlock');
    const status = await a.invoke('companion.status');
    expect(status.link).toMatch(/^https:\/\/relay\.example\.test\/p#/);
    // The QR link never goes into the saved prompt.
    expect(JSON.stringify(a.services.procedures.transcript(procedureId))).not.toContain(
      status.link,
    );

    const { received } = phone(relay, status.link as string, (m, send) => {
      if (m.type === 'sign.request') {
        send({ type: 'sign.progress', requestId: m.requestId, stage: 'card' });
        send({
          type: 'sign.certificate',
          requestId: m.requestId,
          certificates: [CERT.toString('base64')],
        });
      } else if (m.type === 'sign.toBeSigned') {
        send({
          type: 'sign.signature',
          requestId: m.requestId,
          seq: m.seq,
          signature: Buffer.alloc(256, 7).toString('base64'),
        });
      }
    });
    const key = (await approval) as ExternalSigningKey;
    expect(key.kind).toBe('external');
    expect(Buffer.from(key.certificates[0] as Uint8Array).equals(CERT)).toBe(true);
    expect(a.pendingPrompt(procedureId)?.prompt).toMatchObject({ stage: 'card' });
    expect((await a.invoke('companion.status')).state).toBe('connected');

    const request = received.find((m) => m.type === 'sign.request');
    expect(request).toMatchObject({
      origin: 'https://sede.example.gob.es',
      can: CAN,
      pin: PIN,
      verifiable: true,
      documents: [{ mimeType: 'text/plain', data: DOCUMENT.toString('base64') }],
    });

    const signature = await key.sign(Buffer.from('attrs'), 'sha256', { kind: 'cms', document: 0 });
    expect(Buffer.from(signature)).toEqual(Buffer.alloc(256, 7));
    expect(received.find((m) => m.type === 'sign.toBeSigned')).toMatchObject({
      algorithm: 'SHA256withRSA',
      check: { kind: 'cms', document: 0 },
    });
    key.release(true);
    await a.waitFor(() => received.some((m) => m.type === 'sign.done'));
    const item = a.services.procedures
      .transcript(procedureId)
      .find((i) => i.type === 'prompt' && i.prompt.kind === 'dnie_signature');
    expect(item).toMatchObject({
      status: 'answered',
      response: { kind: 'dnie_signature', outcome: 'signed' },
    });
    expect(a.vault.getCredential(dnie.id)?.lastUsedAt).toBeDefined();
    // Never in prompts, transcripts, events, logs or the QR link.
    const seen = JSON.stringify([
      a.services.procedures.transcript(procedureId),
      a.events,
      a.logLines,
      await a.invoke('vault.overview'),
      await a.invoke('companion.status'),
    ]);
    expect(seen).not.toContain(PIN);
    expect(seen).not.toContain(CAN);
  });

  it("hands over the card's other certificate and explains a refusal by the site's filters", async () => {
    const { relay, app: a, procedureId } = await setup();
    const other = crypto.randomBytes(240);
    const first = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId);
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
    let sendOther = true;
    const { received } = phone(
      relay,
      (await a.invoke('companion.status')).link as string,
      (m, send) => {
        if (m.type !== 'sign.request') return;
        if (sendOther)
          send({
            type: 'sign.otherCertificate',
            requestId: m.requestId,
            certificate: other.toString('base64'),
          });
        send({
          type: 'sign.certificate',
          requestId: m.requestId,
          certificates: [CERT.toString('base64')],
        });
      },
    );
    const key = (await first) as ExternalSigningKey;
    expect(key.otherCertificates?.map((c) => Buffer.from(c).equals(other))).toEqual([true]);
    // The signer refuses it: only AUTENTICACIÓN passes the site's filters.
    key.release(false, 'authentication_only');
    await a.waitFor(() => received.some((m) => m.type === 'sign.cancel'));
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
      text: t('es', 'dnieError_authentication_only', { host: 'sede.example.gob.es' }),
    });

    // An older phone sends only the certificate.
    sendOther = false;
    const approval = a.services.browser.approveSignature(procedureId, summary);
    // The CAN stays; the PIN is saved only once the card has signed with it.
    await typeUnlock(a, procedureId, { pin: PIN });
    const second = (await approval) as ExternalSigningKey;
    expect(second.otherCertificates).toBeUndefined();
    second.release(false, 'no_match');
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      text: t('es', 'dnieError_filter_no_match', { host: 'sede.example.gob.es' }),
    });
  });

  it('cancels on the desktop, and tells the phone', async () => {
    const { relay, app: a, procedureId } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId);
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    const { link } = await a.invoke('companion.status');
    const { received } = phone(relay, link as string, () => {});
    await a.waitFor(() => received.some((m) => m.type === 'sign.request'));
    const prompt = a.pendingPrompt(procedureId);
    // Only the app says "signed"; the user can only cancel.
    await expect(
      a.invoke('chat.respond', prompt?.id as string, {
        kind: 'dnie_signature',
        outcome: 'signed',
      }),
    ).rejects.toThrow();
    await a.invoke('chat.respond', prompt?.id as string, {
      kind: 'dnie_signature',
      outcome: 'cancelled',
    });
    expect(await approval).toBeNull();
    await a.waitFor(() => received.some((m) => m.type === 'sign.cancel'));
  });

  it('explains a blocked PIN, forgets the saved one, and a procedure stop cancels', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    await a.invoke('vault.setDniePin', dnie.id, PIN);
    const approval = a.services.browser.approveSignature(procedureId, summary);
    expect(await typeUnlock(a, procedureId, { can: CAN })).toMatchObject({
      unlock: { can: true, pin: false },
    });
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    const { link } = await a.invoke('companion.status');
    phone(relay, link as string, (m, send) => {
      if (m.type === 'sign.request')
        send({ type: 'sign.error', requestId: m.requestId, code: 'pin_blocked' });
    });
    expect(await approval).toBeNull();
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
      text: expect.stringContaining('PIN'),
    });

    // A blocked card forgets the PIN: asked again (not the CAN, which the card accepted).
    expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(false);
    const stopped = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    expect(a.pendingPrompt(procedureId)?.prompt).toMatchObject({
      stage: 'unlock',
      unlock: { can: false, pin: true },
    });
    await a.invoke('procedures.stop', procedureId);
    expect(await stopped).toBeNull();
  });

  it('uses the CAN from Mis datos when valid, and asks only for what it lacks', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    /** One phone that declines every request: it pairs with the QR once and stays. */
    const requests: { m: DesktopToPhone; send: PhoneClient['send'] }[] = [];
    const refuseNext = async () => {
      if (phones.length === 0) {
        await a.waitFor(() => !!a.services.companion!.status().link);
        phone(relay, a.services.companion!.status().link as string, (m, send) => {
          if (m.type === 'sign.request') requests.push({ m, send });
        });
      }
      await a.waitFor(() => requests.length > 0);
      const { m, send } = requests.shift()!;
      if (m.type === 'sign.request')
        send({ type: 'sign.error', requestId: m.requestId, code: 'rejected' });
      return m;
    };
    const sign = async (values?: { can?: string; pin?: string }) => {
      const approval = a.services.browser.approveSignature(procedureId, summary);
      await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
      const shown = a.pendingPrompt(procedureId)!.prompt;
      if (values) await typeUnlock(a, procedureId, values);
      const request = await refuseNext();
      expect(await approval).toBeNull();
      return { shown, request };
    };
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: '12345' }], 'manual');
    const invalid = await sign({ can: '654321', pin: PIN });
    expect(invalid.shown).toMatchObject({ unlock: { can: true, pin: true } });
    expect(invalid.request).toMatchObject({ can: '654321', pin: PIN });
    // The CAN typed is kept while the app runs. The PIN is saved only once the card accepts it.
    expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(false);
    const again = await sign({ pin: 'Nuevo5678' });
    expect(again.shown).toMatchObject({ unlock: { can: false, pin: true } });
    expect(again.request).toMatchObject({ can: '654321', pin: 'Nuevo5678' });

    // The PIN saved in Mis datos goes without asking; Mis datos' CAN isn't preferred over the
    // typed one.
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: CAN }], 'manual');
    await a.invoke('vault.setDniePin', dnie.id, 'Nuevo5678');
    const saved = await sign();
    expect(saved.shown).toMatchObject({ stage: 'phone' });
    expect(saved.request).toMatchObject({ can: '654321', pin: 'Nuevo5678' });
    expect(JSON.stringify(a.services.companion!.status())).not.toContain('654321');

    // Reading the certificate needs no PIN.
    const read = a.services.browser.approveSignature(procedureId, {
      ...summary,
      method: 'selectCertificate',
      documents: [],
    });
    const request = await refuseNext();
    expect(await read).toBeNull();
    expect(request).toMatchObject({ purpose: 'certificate', can: '654321' });
    expect(request).not.toHaveProperty('pin');

    // Logins too.
    const login = a.services.companion!.login(procedureId, dnie, summary.origin);
    const loginRequest = await refuseNext();
    expect(loginRequest).toMatchObject({ purpose: 'login', can: '654321', pin: 'Nuevo5678' });
    expect(await login).toBeNull();
  });

  it('takes only what the card asks for, validated, and only while it asks', async () => {
    const { app: a, procedureId } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    const item = a.pendingPrompt(procedureId)!;
    for (const bad of [
      { can: '12345', pin: PIN },
      { can: CAN, pin: '1234567' },
      { can: CAN, pin: '12345678901234567' },
      { can: CAN, pin: PIN, extra: 1 },
    ])
      await expect(a.invoke('companion.unlock', item.id, bad as never)).rejects.toThrow(
        t('es', 'invalidRequest'),
      );
    await expect(a.invoke('companion.unlock', item.id, { can: CAN })).rejects.toThrow(
      t('es', 'dnieUnlockMissing'),
    );
    await expect(a.invoke('companion.unlock', 'q-missing', { can: CAN, pin: PIN })).rejects.toThrow(
      t('es', 'promptNotPending'),
    );
    await a.invoke('companion.unlock', item.id, { can: CAN, pin: PIN });
    await expect(a.invoke('companion.unlock', item.id, { can: CAN, pin: PIN })).rejects.toThrow(
      t('es', 'promptNotPending'),
    );
    await a.invoke('chat.respond', item.id, { kind: 'dnie_signature', outcome: 'cancelled' });
    expect(await approval).toBeNull();
  });

  it('asks again when the card refuses the CAN or the PIN, and never offers them again', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: '111111' }], 'manual');
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId, { pin: 'Malo1234' });
    const { received } = phone(relay, a.services.companion!.status().link as string, (m, send) => {
      if (m.type === 'sign.request')
        send({ type: 'sign.need', requestId: m.requestId, what: 'can', refused: true });
      else if (m.type === 'sign.unlock' && m.can)
        send({
          type: 'sign.certificate',
          requestId: m.requestId,
          certificates: [CERT.toString('base64')],
        });
      else if (
        m.type === 'sign.toBeSigned' &&
        !received.some((r) => r.type === 'sign.unlock' && r.pin)
      )
        send({
          type: 'sign.need',
          requestId: m.requestId,
          what: 'pin',
          refused: true,
          triesLeft: 2,
        });
      else if (m.type === 'sign.unlock' && m.pin)
        send({
          type: 'sign.signature',
          requestId: m.requestId,
          seq: 1,
          signature: Buffer.alloc(256, 7).toString('base64'),
        });
    });
    expect(await typeUnlock(a, procedureId, { can: CAN })).toMatchObject({
      unlock: { can: true, pin: false, refused: 'can' },
    });
    const key = (await approval) as ExternalSigningKey;
    const signing = key.sign(Buffer.from('attrs'), 'sha256', { kind: 'cms', document: 0 });
    expect(await typeUnlock(a, procedureId, { pin: PIN })).toMatchObject({
      unlock: { can: false, pin: true, refused: 'pin', triesLeft: 2 },
    });
    expect(Buffer.from(await signing)).toEqual(Buffer.alloc(256, 7));
    key.release(true);
    expect(received.filter((m) => m.type === 'sign.unlock')).toMatchObject([
      { can: CAN },
      { pin: PIN },
    ]);
    expect(received.find((m) => m.type === 'sign.request')).toMatchObject({
      can: '111111',
      pin: 'Malo1234',
    });

    // The PIN the card accepted is saved in the vault (not the refused one).
    expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(true);
    expect(await a.vault.getCredentialSecret(dnie.id)).toEqual({ kind: 'dnie', pin: PIN });
    // The next request carries what the card accepted, without asking.
    const next = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => received.filter((m) => m.type === 'sign.request').length === 2);
    expect(received.filter((m) => m.type === 'sign.request').at(-1)).toMatchObject({
      can: CAN,
      pin: PIN,
    });
    await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
      kind: 'dnie_signature',
      outcome: 'cancelled',
    });
    expect(await next).toBeNull();
  });

  it('forgets a saved PIN the card refuses, and asks for a new one', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: CAN }], 'manual');
    await a.invoke('vault.setDniePin', dnie.id, 'Viejo1234');
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => !!a.services.companion!.status().link);
    phone(relay, a.services.companion!.status().link as string, (m, send) => {
      if (m.type === 'sign.request')
        send({ type: 'sign.need', requestId: m.requestId, what: 'pin', refused: true });
    });
    expect(await typeUnlock(a, procedureId, { pin: PIN })).toMatchObject({
      unlock: { can: false, pin: true, refused: 'pin' },
    });
    expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(false);
    await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
      kind: 'dnie_signature',
      outcome: 'cancelled',
    });
    expect(await approval).toBeNull();
    // Not accepted by the card yet: not saved.
    expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(false);
  });

  it('is unavailable without a relay, and unpairs on request', async () => {
    app = await createTestApp();
    const { procedureId } = await app.procedureWithToken();
    await app.invoke('vault.addDnie');
    expect(await app.invoke('companion.status')).toEqual({ state: 'unavailable' });
    expect(await app.services.browser.approveSignature(procedureId, summary)).toBeNull();
    expect(app.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
    });
    await app.close();

    const { app: a } = await setup();
    expect((await a.invoke('companion.pair')).state).not.toBe('off');
    expect(await a.invoke('companion.unpair')).toEqual({ state: 'off' });
    expect(a.events.some((e) => e.type === 'companion.changed')).toBe(true);
  });
});

it('shows the QR only until a phone pairs, and pairs another phone without failing a signature', async () => {
  const { relay, app: a, procedureId } = await setup();
  const approval = a.services.browser.approveSignature(procedureId, summary);
  await typeUnlock(a, procedureId);
  await a.waitFor(() => a.services.companion!.status().state === 'waiting');
  const first = (await a.invoke('companion.status')).link as string;
  const old = phone(relay, first, () => {});
  await a.waitFor(() => old.received.some((m) => m.type === 'sign.request'));
  old.client.close();
  await a.waitFor(() => a.services.companion!.status().state === 'away');
  // The phone reconnects on its own: the QR, which no longer works, isn't shown again.
  expect(await a.invoke('companion.status')).toEqual({
    state: 'away',
    device: 'Phone under test',
    expiresAt: expect.any(String),
  });

  const next = await a.invoke('companion.pairAnother');
  expect(next.link).toMatch(/^https:\/\/relay\.example\.test\/p#/);
  expect(next.link).not.toBe(first);
  // The signature waiting for the old phone goes to the new one.
  const { received } = phone(relay, next.link as string, (m, send) => {
    if (m.type === 'sign.request')
      send({ type: 'sign.error', requestId: m.requestId, code: 'rejected' });
  });
  await a.waitFor(() => received.some((m) => m.type === 'sign.request'));
  expect(await approval).toBeNull();
});

describe('a pairing that ends on its own', () => {
  /**
   * A signature waiting on a paired phone that only acknowledges the request, or (`need`) asks
   * the user for a new PIN, which stops the signature's own timers.
   */
  async function signing(need = false) {
    const ctx = await setup();
    const { relay, app: a, procedureId } = ctx;
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId);
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
    const { link } = await a.invoke('companion.status');
    const p = phone(relay, link as string, (m, send) => {
      if (m.type !== 'sign.request') return;
      send({ type: 'sign.progress', requestId: m.requestId, stage: 'reviewing' });
      if (need) send({ type: 'sign.need', requestId: m.requestId, what: 'pin', refused: true });
    });
    await a.waitFor(() => p.received.some((m) => m.type === 'sign.request'));
    await a.waitFor(() => a.services.companion!.status().state === 'connected');
    return { ...ctx, approval, phone: p };
  }

  /** The procedure's last notice, the one the failed signature left. */
  function lastNotice(a: TestApp, procedureId: string) {
    return a.services.procedures.transcript(procedureId).at(-1);
  }

  it('says the phone unpaired, fails the signature with it, and forgets it on a new pairing', async () => {
    const { app: a, procedureId, approval, phone: p } = await signing();
    p.client.unpair();
    expect(await approval).toBeNull();
    expect(await a.invoke('companion.status')).toEqual({ state: 'off', reason: 'phone_unpaired' });
    expect(a.events).toContainEqual({
      type: 'companion.changed',
      status: { state: 'off', reason: 'phone_unpaired' },
    });
    expect(lastNotice(a, procedureId)).toMatchObject({
      type: 'notice',
      text: t('es', 'dnieError_unpaired'),
    });
    // It stays until the user pairs again; a new pairing has no reason.
    expect((await a.invoke('companion.status')).reason).toBe('phone_unpaired');
    const next = await a.invoke('companion.pair');
    expect(next.state).not.toBe('off');
    expect(next).not.toHaveProperty('reason');
    // Unpairing on the desktop says nothing: the user did it.
    expect(await a.invoke('companion.unpair')).toEqual({ state: 'off' });
  });

  it('says the relay refused, and fails the signature with that reason', async () => {
    const { relay, app: a, procedureId, approval } = await signing();
    const [room] = [...relay.rooms.values()];
    room?.desktop?.remoteClose(RELAY_CLOSE.unauthorized);
    expect(await approval).toBeNull();
    expect(await a.invoke('companion.status')).toEqual({ state: 'off', reason: 'relay_refused' });
    expect(lastNotice(a, procedureId)).toMatchObject({
      type: 'notice',
      level: 'warning',
      text: t('es', 'dnieError_relay_refused'),
    });
  });

  it('says the pairing expired after 72 hours, and fails the signature with that reason', async () => {
    // Real time still runs (the relay, the phone), and the 72 hours can be skipped.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { app: a, procedureId, approval } = await signing(true);
    // The phone waits for the user to type a new PIN: the signature's own timers are stopped.
    await a.waitFor(() => {
      const p = a.pendingPrompt(procedureId)?.prompt;
      return p?.kind === 'dnie_signature' && p.stage === 'unlock';
    });
    await vi.advanceTimersByTimeAsync(PAIRING_LIFETIME_MS);
    vi.useRealTimers();
    expect(await approval).toBeNull();
    expect(await a.invoke('companion.status')).toEqual({ state: 'off', reason: 'expired' });
    expect(lastNotice(a, procedureId)).toMatchObject({
      type: 'notice',
      text: t('es', 'dnieError_expired'),
    });
  });
});

describe('a phone app that speaks another protocol version', () => {
  /** A phone whose app speaks `protocol`: the desktop answers its handshake but won't use it. */
  function phoneWith(relay: MemoryRelay, link: string, protocol: number) {
    const hello = { app: '0.9.0', platform: 'test', device: 'Old phone', protocol } as const;
    const client = new PhoneClient({
      link,
      hello,
      socket: { WebSocket: relay.WebSocket, backoffMs: () => 5 },
    });
    phones.push(client);
    return client;
  }

  it('says the phone app is out of date and fails a waiting signature at once', async () => {
    const { relay, app: a, procedureId } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId);
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
    const { link } = await a.invoke('companion.status');
    phoneWith(relay, link as string, COMPANION_PROTOCOL - 1);
    // Without waiting for the phone (10 minutes) or for its review (5 minutes).
    expect(await approval).toBeNull();
    const outdated = { phone: COMPANION_PROTOCOL - 1, desktop: COMPANION_PROTOCOL };
    const status = await a.invoke('companion.status');
    // The QR still works: the phone can pair once its app is updated.
    expect(status).toMatchObject({ state: 'waiting', outdated });
    expect(status.link).toBe(link);
    expect(a.events).toContainEqual({
      type: 'companion.changed',
      status: expect.objectContaining({ outdated }),
    });
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
      text: t('es', 'dnieError_phone_outdated'),
    });

    // The updated app pairs with the same QR: the warning goes.
    for (const p of phones.splice(0)) p.close();
    phone(relay, link as string, () => {});
    await a.waitFor(() => a.services.companion!.status().state === 'connected');
    expect(await a.invoke('companion.status')).not.toHaveProperty('outdated');
  });

  it('asks to update the desktop for a newer phone app, and fails a new request at once', async () => {
    const { relay, app: a, procedureId } = await setup();
    const { link } = await a.invoke('companion.pair');
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
    phoneWith(relay, link as string, COMPANION_PROTOCOL + 1);
    await a.waitFor(() => !!a.services.companion!.status().outdated);
    expect(await a.invoke('companion.status')).toMatchObject({
      outdated: { phone: COMPANION_PROTOCOL + 1, desktop: COMPANION_PROTOCOL },
    });
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await typeUnlock(a, procedureId);
    expect(await approval).toBeNull();
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      text: t('es', 'dnieError_desktop_outdated'),
    });
    // A new pairing starts clean.
    expect(await a.invoke('companion.pairAnother')).not.toHaveProperty('outdated');
  });
});

describe('a relay that cannot be reached', () => {
  /** A WebSocket that never connects (no internet, server down). */
  class Unreachable {
    readonly OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onclose?.({ code: 1006 }));
    }
    send(): void {
      throw new Error('not open');
    }
    close(): void {}
  }

  it('says so after a while of trying, and a new pairing starts counting again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    app = await createTestApp({
      env: { relayServerUrl: 'wss://relay.example.test' },
      relaySocket: Unreachable as unknown as typeof WebSocket,
    });
    const a = app;
    expect(await a.invoke('companion.pair')).toMatchObject({ state: 'connecting' });
    await vi.advanceTimersByTimeAsync(COMPANION_STALLED_MS - 1000);
    expect(await a.invoke('companion.status')).toMatchObject({ state: 'connecting' });
    expect(await a.invoke('companion.status')).not.toHaveProperty('stalled');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await a.invoke('companion.status')).toMatchObject({
      state: 'connecting',
      stalled: true,
    });
    expect(a.events).toContainEqual({
      type: 'companion.changed',
      status: expect.objectContaining({ state: 'connecting', stalled: true }),
    });
    // "Reintentar": a new pairing, counted from zero.
    expect(await a.invoke('companion.pairAnother')).not.toHaveProperty('stalled');
    await vi.advanceTimersByTimeAsync(COMPANION_STALLED_MS);
    expect((await a.invoke('companion.status')).stalled).toBe(true);
    expect(await a.invoke('companion.unpair')).toEqual({ state: 'off' });
  });
});

it('ends login after inactivity and asks again for the next handshake', async () => {
  const { relay, app: a, procedureId, dnie } = await setup();
  const approval = a.services.companion!.login(procedureId, dnie, summary.origin);
  await typeUnlock(a, procedureId);
  await a.waitFor(() => a.services.companion!.status().state === 'waiting');
  const status = await a.invoke('companion.status');
  const { received } = phone(relay, status.link as string, (m, send) => {
    if (m.type === 'sign.request')
      send({
        type: 'sign.certificate',
        requestId: m.requestId,
        certificates: [CERT.toString('base64')],
      });
    if (m.type === 'sign.toBeSigned')
      send({
        type: 'sign.signature',
        requestId: m.requestId,
        seq: m.seq,
        signature: Buffer.alloc(256).toString('base64'),
      });
  });
  const identity = await approval;
  const key = identity!.key as RemoteKey;
  const signal = new AbortController().signal;
  await key.sign(Buffer.alloc(32), 'SHA-256', 'sede.example.gob.es', signal);
  // The card accepted the PIN: the next approval doesn't ask for it.
  expect(a.vault.getCredential(dnie.id)?.hasPin).toBe(true);
  vi.useFakeTimers();
  await key.prepare('sede.example.gob.es', signal);
  await vi.advanceTimersByTimeAsync(DNIE_LOGIN_IDLE_MS + 1);
  vi.useRealTimers();
  await a.waitFor(() => received.some((m) => m.type === 'sign.done'));
  await key.prepare('sede.example.gob.es', signal);
  const requests = received.filter((m) => m.type === 'sign.request');
  expect(new Set(requests.map((m) => m.requestId)).size).toBe(2);
  await key.sign(Buffer.alloc(32), 'SHA-256', 'sede.example.gob.es', signal);
  expect(received.filter((m) => m.type === 'sign.toBeSigned').at(-1)).toMatchObject({
    prehashed: true,
  });
  const prompt = a.pendingPrompt(procedureId)!;
  await a.invoke('chat.respond', prompt.id, { kind: 'dnie_signature', outcome: 'cancelled' });
  await a.waitFor(() => received.some((m) => m.type === 'sign.cancel'));
  await expect(
    key.sign(Buffer.alloc(32), 'SHA-256', 'sede.example.gob.es', signal),
  ).rejects.toThrow();
});

it('keeps one phone approval across the hosts of one organisation, and tells the agent', async () => {
  const { relay, app: a, procedureId, token, dnie } = await setup();
  const companion = a.services.companion!;
  const approval = companion.login(procedureId, dnie, 'https://idp.seg-social.es');
  const prompt = await typeUnlock(a, procedureId);
  expect(prompt).toMatchObject({ purpose: 'login' });
  expect(prompt.kind === 'dnie_signature' && prompt.details).toEqual([
    {
      label: 'Para',
      value: 'Seguridad Social (idp.seg-social.es, ipce.seg-social.es, w2.seg-social.es)',
    },
  ]);
  await a.waitFor(() => companion.status().state === 'waiting');
  const status = await a.invoke('companion.status');
  let held: string | undefined;
  const { client, received } = phone(relay, status.link as string, (m, send) => {
    if (m.type === 'sign.request' && m.origin.includes('agenciatributaria')) held = m.requestId;
    else if (m.type === 'sign.request')
      send({
        type: 'sign.certificate',
        requestId: m.requestId,
        certificates: [CERT.toString('base64')],
      });
    if (m.type === 'sign.toBeSigned')
      send({
        type: 'sign.signature',
        requestId: m.requestId,
        seq: m.seq,
        signature: Buffer.alloc(256).toString('base64'),
      });
  });
  const key = (await approval)!.key as RemoteKey;
  const signal = new AbortController().signal;
  // Importass: idp → ipce → idp, all with the first approval.
  for (const host of ['idp.seg-social.es', 'ipce.seg-social.es', 'idp.seg-social.es']) {
    await key.prepare(host, signal);
    await key.sign(Buffer.alloc(32), 'SHA-256', host, signal);
  }
  expect(received.filter((m) => m.type === 'sign.request')).toHaveLength(1);
  expect(received.filter((m) => m.type === 'sign.toBeSigned')).toHaveLength(3);
  const observation = await a.rpc('browser.snapshot', {}, token);
  expect(observation.body.result.notes).toContain(
    'The user approved the DNI login for Seguridad Social (idp.seg-social.es, ipce.seg-social.es, w2.seg-social.es) on their phone.',
  );
  expect(companion.takeLoginNotes(procedureId)).toEqual([]);

  // Another organisation asks again, and the agent knows the login waits for the user.
  const other = key.prepare('www1.agenciatributaria.gob.es', signal);
  await a.waitFor(() => held !== undefined);
  expect(companion.takeLoginNotes(procedureId)).toEqual([
    expect.stringMatching(
      /^Waiting for the user to approve the DNI login for Agencia Tributaria \(.*\) on their phone\./,
    ),
  ]);
  client.send({ type: 'sign.error', requestId: held!, code: 'rejected' });
  await expect(other).rejects.toThrow();
  expect(companion.takeLoginNotes(procedureId)).toEqual([
    expect.stringMatching(
      /Agencia Tributaria .* was not approved: the user declined it on the phone\.$/,
    ),
  ]);
  await expect(
    key.sign(Buffer.alloc(32), 'SHA-256', 'idp.seg-social.es', signal),
  ).rejects.toThrow();
});

it('waits for the user to open the phone app, then gives up with its own explanation', async () => {
  const { app: a, procedureId, dnie } = await setup();
  const companion = a.services.companion!;
  // Real time keeps flowing for the harness; the 10 minutes are skipped below.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const approval = companion.login(procedureId, dnie, 'https://idp.seg-social.es');
  await typeUnlock(a, procedureId);
  await a.waitFor(() => {
    const p = a.pendingPrompt(procedureId)?.prompt;
    return p?.kind === 'dnie_signature' && p.stage === 'phone';
  });
  // No phone connected: the agent knows the login waits for the app to be opened.
  expect(companion.takeLoginNotes(procedureId)).toEqual([
    expect.stringMatching(/^Waiting for the user to open the Spain Assist app on their phone/),
  ]);
  // Longer than the review time: still waiting.
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(a.pendingPrompt(procedureId)?.prompt.kind).toBe('dnie_signature');
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(await approval).toBeNull();
  expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
    type: 'notice',
    level: 'warning',
    text: t('es', 'dnieError_phone_away'),
  });
  expect(companion.takeLoginNotes(procedureId)).toEqual([
    expect.stringMatching(/was not approved: the user did not open the phone app in time/),
  ]);
});

it('keeps the login approval when the browser drops a connection', async () => {
  const { relay, app: a, procedureId, dnie } = await setup();
  const companion = a.services.companion!;
  const approval = companion.login(procedureId, dnie, 'https://idp.seg-social.es');
  await typeUnlock(a, procedureId);
  await a.waitFor(() => companion.status().state === 'waiting');
  const status = await a.invoke('companion.status');
  // The phone approves the login, then holds what it is asked until the test answers it.
  const held: DesktopToPhone[] = [];
  let approved = false;
  const { client, received } = phone(relay, status.link as string, (m, send) => {
    if (m.type === 'sign.request' && !approved) {
      approved = true;
      send({
        type: 'sign.certificate',
        requestId: m.requestId,
        certificates: [CERT.toString('base64')],
      });
    } else if (m.type === 'sign.request' || m.type === 'sign.toBeSigned') held.push(m);
  });
  const answer = (m: DesktopToPhone) => {
    if (m.type === 'sign.request')
      client.send({
        type: 'sign.certificate',
        requestId: m.requestId,
        certificates: [CERT.toString('base64')],
      });
    if (m.type === 'sign.toBeSigned')
      client.send({
        type: 'sign.signature',
        requestId: m.requestId,
        seq: m.seq,
        signature: Buffer.alloc(256).toString('base64'),
      });
  };
  const key = (await approval)!.key as RemoteKey;
  const host = 'idp.seg-social.es';

  // A connection dropped while the card signs: only that handshake gives up.
  const dropped = new AbortController();
  const first = key.sign(Buffer.alloc(32), 'SHA-256', host, dropped.signal);
  await a.waitFor(() => held.length === 1);
  dropped.abort();
  await expect(first).rejects.toThrow('dropped');
  answer(held.shift()!);
  const next = key.sign(Buffer.alloc(32), 'SHA-256', host, new AbortController().signal);
  await a.waitFor(() => held.length === 1);
  answer(held.shift()!);
  await expect(next).resolves.toHaveLength(256);
  expect(received.filter((m) => m.type === 'sign.request')).toHaveLength(1);
  expect(received.some((m) => m.type === 'sign.cancel' || m.type === 'sign.done')).toBe(false);

  // Parallel connections to another site share one phone request, which outlives one of them.
  const other = 'www1.agenciatributaria.gob.es';
  const one = new AbortController();
  const two = new AbortController();
  const waits = [key.prepare(other, one.signal), key.prepare(other, two.signal)];
  await a.waitFor(() => held.length === 1);
  one.abort();
  await expect(waits[0]).rejects.toThrow('dropped');
  expect(received.some((m) => m.type === 'sign.cancel')).toBe(false);
  answer(held.shift()!);
  await expect(waits[1]).resolves.toBeUndefined();
  expect(received.filter((m) => m.type === 'sign.request')).toHaveLength(2);

  // The request is cancelled once every connection waiting for it is gone.
  const third = new AbortController();
  const last = key.prepare(host, third.signal);
  await a.waitFor(() => held.length === 1);
  third.abort();
  await expect(last).rejects.toThrow('dropped');
  const request = held.shift()!;
  await a.waitFor(() =>
    received.some(
      (m) =>
        m.type === 'sign.cancel' &&
        request.type === 'sign.request' &&
        m.requestId === request.requestId,
    ),
  );
});

it.each([
  { label: 'omitted', origins: undefined },
  { label: 'empty', origins: [] },
])(
  'rejects a missing DNI login target ($label) before consent, pairing or browser work',
  async ({ origins }) => {
    const { relay, app: a, procedureId, token, dnie } = await setup();
    for (const policy of ['ask', 'auto'] as const) {
      await a.vault.setCredentialPolicy(dnie.id, policy);
      const response = await a.rpc(
        'browser.useCertificate',
        { credentialId: dnie.id, origins },
        token,
      );
      expect(response).toMatchObject({
        status: 400,
        body: {
          ok: false,
          error: { code: 'bad_request', message: expect.stringContaining('origins') },
        },
      });
    }
    expect(a.pendingPrompt(procedureId)).toBeUndefined();
    expect(a.services.procedures.transcript(procedureId)).toEqual([]);
    expect(relay.rooms.size).toBe(0);
    expect(a.browser.calls).toEqual([]);
    expect(a.vault.getCredential(dnie.id)?.lastUsedAt).toBeUndefined();
  },
);

it('enables DNI browser login after origin policy, desktop consent and phone approval', async () => {
  const { relay, app: a, procedureId, token, dnie } = await setup();
  await a.vault.setCredentialPolicy(dnie.id, 'ask');
  const use = a.rpc(
    'browser.useCertificate',
    { credentialId: dnie.id, origins: [summary.origin] },
    token,
  );
  await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'confirm');
  await a.invoke('chat.respond', a.pendingPrompt(procedureId)!.id, {
    kind: 'confirm',
    approved: true,
  });
  // After the desktop consent, the CAN and the PIN.
  expect(await typeUnlock(a, procedureId)).toMatchObject({ purpose: 'login', stage: 'unlock' });
  await a.waitFor(() => a.services.companion!.status().state === 'waiting');
  const status = await a.invoke('companion.status');
  phone(relay, status.link as string, (m, send) => {
    if (m.type === 'sign.request') {
      expect(m.purpose).toBe('login');
      expect(m.origin).toBe(summary.origin);
      expect(m.pin).toBe(PIN);
      send({
        type: 'sign.certificate',
        requestId: m.requestId,
        certificates: [CERT.toString('base64')],
      });
    }
  });
  const response = await use;
  expect(response.body.result).toMatchObject({
    enabled: true,
    origins: ['https://pasarela-ident.clave.gob.es', summary.origin],
  });
  expect(a.browser.calls.at(-1)?.method).toBe('useClientCertificate');
  expect(a.vault.getCredential(dnie.id)?.lastUsedAt).toBeDefined();
  expect(a.pendingPrompt(procedureId)?.prompt).toMatchObject({
    kind: 'dnie_signature',
    purpose: 'login',
  });
});

describe('without the dnie-phone feature flag', () => {
  async function setupOff() {
    const relay = new MemoryRelay();
    app = await createTestApp({
      env: { relayServerUrl: 'wss://relay.example.test' },
      relaySocket: relay.WebSocket,
      features: { dniePhone: 'off' },
    });
    // Saved while the flag was on.
    const dnie = await app.vault.addDnie();
    const session = await app.procedureWithToken();
    return { relay, app, dnie, ...session };
  }

  it('never starts the companion and refuses pairing and new DNI credentials', async () => {
    const { relay, app: a } = await setupOff();
    expect(a.services.companion).toBeUndefined();
    for (const method of [
      'companion.status',
      'companion.pair',
      'companion.unpair',
      'companion.pairAnother',
    ] as const)
      await expect(a.invoke(method)).rejects.toThrow('no está disponible');
    await expect(a.invoke('vault.addDnie')).rejects.toThrow('no está disponible');
    await expect(a.invoke('companion.unlock', 'q-1', { can: CAN, pin: PIN })).rejects.toThrow(
      'no está disponible',
    );
    expect(relay.rooms.size).toBe(0);
    expect(a.events.some((e) => e.type === 'companion.changed')).toBe(false);
  });

  it('hides a saved DNI from Mis datos and agents, and keeps it stored', async () => {
    const { app: a, dnie, token } = await setupOff();
    expect((await a.invoke('vault.overview')).credentials).toEqual([]);
    expect((await a.rpc('vault.read', {}, token)).body.result.credentials).toEqual([]);
    await expect(a.invoke('vault.deleteCredential', dnie.id)).rejects.toThrow();
    await expect(a.invoke('vault.setCredentialPolicy', dnie.id, 'auto')).rejects.toThrow();
    expect(a.vault.getCredential(dnie.id)).toMatchObject({ kind: 'dnie', policy: 'ask' });

    // Flags are read at start-up: the next launch with the flag on shows it again.
    await a.restart({ dniePhone: 'release' });
    expect((await a.invoke('vault.overview')).credentials).toMatchObject([{ id: dnie.id }]);
    expect(a.services.companion).toBeDefined();
  });

  it('refuses DNI logins with an explanation and leaves the DNI out of signatures', async () => {
    const { relay, app: a, dnie, procedureId, token } = await setupOff();
    const login = await a.rpc('browser.useCertificate', { credentialId: dnie.id }, token);
    expect(login.body.error).toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('DNI through the phone is not available'),
    });
    expect(a.pendingPrompt(procedureId)).toBeUndefined();

    // AutoFirma: with only the DNI saved, there is no certificate to offer.
    expect(await a.services.browser.approveSignature(procedureId, summary)).toBeNull();
    expect(a.pendingPrompt(procedureId)).toBeUndefined();
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      text: 'sede.example.gob.es te pide firmar, pero no tienes ningún certificado digital guardado. Añádelo en Mis datos.',
    });
    expect(relay.rooms.size).toBe(0);
    expect(a.browser.certificates).toEqual([]);
  });

  it('tells procedure agents the DNI is off (prompt and tools)', async () => {
    const { app: a } = await setupOff();
    const provider = {
      baseUrl: 'http://127.0.0.1:8789/v1',
      api: 'openai-completions',
      model: 'mock-model',
    } as const;
    expect((await a.invoke('providers.setCustom', provider)).ok).toBe(true);
    const { procedureId } = await a.startProcedure();
    expect(a.agentFor(procedureId)?.launch.config).toMatchObject({ dniePhone: false });
    await a.restart({ dniePhone: 'release' });
    await a.say('Otro trámite');
    const { procedureId: next } = await a.startProcedure('Otro trámite');
    expect(a.agentFor(next)?.launch.config).toMatchObject({ dniePhone: true });
  });
});

describe('in the prerelease of the dnie-phone feature flag', () => {
  it('starts the companion, and offers the DNI to agents while it is saved', async () => {
    const a = await createTestApp({
      env: { relayServerUrl: 'wss://relay.example.test' },
      relaySocket: new MemoryRelay().WebSocket,
      features: { dniePhone: 'prerelease' },
    });
    app = a;
    expect(a.services.companion).toBeDefined();
    const provider = {
      baseUrl: 'http://127.0.0.1:8789/v1',
      api: 'openai-completions',
      model: 'mock-model',
    } as const;
    expect((await a.invoke('providers.setCustom', provider)).ok).toBe(true);
    const { procedureId } = await a.startProcedure();
    expect(a.agentFor(procedureId)?.launch.config).toMatchObject({ dniePhone: false });

    // "Ya tengo la app, habilitar DNI" saves the DNI.
    const dnie = await a.invoke('vault.addDnie');
    expect((await a.invoke('vault.overview')).credentials).toMatchObject([{ id: dnie.id }]);
    await a.say('Otro trámite');
    const { procedureId: next } = await a.startProcedure('Otro trámite');
    expect(a.agentFor(next)?.launch.config).toMatchObject({ dniePhone: true });

    await a.invoke('vault.deleteCredential', dnie.id);
    await a.say('Un trámite más');
    const { procedureId: last } = await a.startProcedure('Un trámite más');
    expect(a.agentFor(last)?.launch.config).toMatchObject({ dniePhone: false });
  });
});
