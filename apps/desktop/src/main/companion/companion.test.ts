import crypto from 'node:crypto';
import { PhoneClient } from '@sa/companion';
import { MemoryRelay } from '@sa/companion/testing';
import type {
  AfirmaSignatureSummary,
  CompanionErrorCode,
  DesktopToPhone,
  ExternalSigningKey,
} from '@sa/shared';
import type { RemoteKey } from '@sa/sidecar';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  description: 'Firmar un texto (19 bytes) en formato CAdES.',
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

describe('DNIe signatures with the phone', () => {
  it('pairs on demand, shows the phone progress and signs through the phone', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    await a.waitFor(() => a.services.companion!.status().state === 'waiting');
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
  });

  it('cancels on the desktop, and tells the phone', async () => {
    const { relay, app: a, procedureId } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
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

  it('explains a blocked PIN, and a procedure stop cancels the request', async () => {
    const { relay, app: a, procedureId } = await setup();
    const approval = a.services.browser.approveSignature(procedureId, summary);
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

    const stopped = a.services.browser.approveSignature(procedureId, summary);
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
    await a.invoke('procedures.stop', procedureId);
    expect(await stopped).toBeNull();
  });

  it('sends the DNI CAN from Mis datos inside the request, only when it is valid', async () => {
    const { relay, app: a, procedureId, dnie } = await setup();
    const sign = async () => {
      const approval = a.services.browser.approveSignature(procedureId, summary);
      await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'dnie_signature');
      const request = await new Promise<DesktopToPhone>((resolve) => {
        phone(relay, a.services.companion!.status().link as string, (m, send) => {
          if (m.type !== 'sign.request') return;
          resolve(m);
          send({ type: 'sign.error', requestId: m.requestId, code: 'rejected' });
        });
      });
      expect(await approval).toBeNull();
      for (const p of phones.splice(0)) p.close();
      return request;
    };
    expect(await sign()).not.toHaveProperty('can');
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: '12345' }], 'manual');
    expect(await sign()).not.toHaveProperty('can');
    await a.vault.setPersonal([{ key: 'dniAccessNumber', value: '123456' }], 'manual');
    expect(await sign()).toMatchObject({ type: 'sign.request', can: '123456' });
    // The QR link never carries it.
    expect(a.services.companion!.status().link).not.toContain('123456');

    // Logins too.
    const login = a.services.companion!.login(procedureId, dnie, summary.origin);
    const request = await new Promise<DesktopToPhone>((resolve) => {
      phone(relay, a.services.companion!.status().link as string, (m, send) => {
        if (m.type !== 'sign.request') return;
        resolve(m);
        send({ type: 'sign.error', requestId: m.requestId, code: 'rejected' });
      });
    });
    expect(request).toMatchObject({ purpose: 'login', can: '123456' });
    expect(await login).toBeNull();
  });

  it('tells agents how the DNIe logs in and signs instead of typing it', async () => {
    const { app: a, dnie, token } = await setup();
    const fill = await a.rpc(
      'browser.fillFromVault',
      { ref: 'e1', value: { source: 'credential', credentialId: dnie.id, field: 'password' } },
      token,
    );
    expect(fill.body.error).toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('call browser_use_certificate with this credential'),
    });
    expect(fill.body.error?.message).not.toContain('cannot log in');
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

it('ends login after inactivity and asks again for the next handshake', async () => {
  const { relay, app: a, procedureId, dnie } = await setup();
  const approval = a.services.companion!.login(procedureId, dnie, summary.origin);
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

it('enables DNIe browser login after origin policy, desktop consent and phone approval', async () => {
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
  await a.waitFor(() => a.services.companion!.status().state === 'waiting');
  const status = await a.invoke('companion.status');
  phone(relay, status.link as string, (m, send) => {
    if (m.type === 'sign.request') {
      expect(m.purpose).toBe('login');
      expect(m.origin).toBe(summary.origin);
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

describe('the DNIe PIN saved in Mis datos', () => {
  const PIN = 'Abcd1234';

  /** Touch ID that records its prompts and answers `ok`. */
  function touchId() {
    const bio = {
      ok: true,
      prompts: 0,
      available: () => true,
      prompt: async () => {
        bio.prompts++;
        return bio.ok;
      },
    };
    return bio;
  }

  /**
   * A paired phone that reads the card for every request and signs. `card.refusePin`: the card
   * refuses the request's PIN once (the phone reports it, the user types the right one);
   * `card.error`: the phone answers the request or the signature with this error.
   */
  async function pairedPhone(a: TestApp, relay: MemoryRelay) {
    const card: { refusePin?: boolean; error?: CompanionErrorCode; errorOnSign?: boolean } = {};
    const { link } = await a.invoke('companion.pair');
    const { received } = phone(relay, link as string, (m, send) => {
      if (m.type === 'sign.request') {
        if (card.error && !card.errorOnSign)
          return send({ type: 'sign.error', requestId: m.requestId, code: card.error });
        send({
          type: 'sign.certificate',
          requestId: m.requestId,
          certificates: [CERT.toString('base64')],
        });
      } else if (m.type === 'sign.toBeSigned') {
        if (card.error && card.errorOnSign)
          return send({ type: 'sign.error', requestId: m.requestId, code: card.error });
        if (card.refusePin) send({ type: 'sign.wrongPin', requestId: m.requestId });
        card.refusePin = false;
        send({
          type: 'sign.signature',
          requestId: m.requestId,
          seq: m.seq,
          signature: Buffer.alloc(256, 7).toString('base64'),
        });
      }
    });
    await a.waitFor(() => a.services.companion!.status().state === 'connected');
    const requests = () =>
      received.filter(
        (m): m is Extract<DesktopToPhone, { type: 'sign.request' }> => m.type === 'sign.request',
      );
    return { card, requests };
  }

  /** Answers the desktop's signature confirmation. */
  async function confirm(a: TestApp, procedureId: string, approved: boolean) {
    await a.waitFor(() => a.pendingPrompt(procedureId)?.prompt.kind === 'confirm');
    const prompt = a.pendingPrompt(procedureId)!;
    await a.invoke('chat.respond', prompt.id, { kind: 'confirm', approved });
    return prompt.prompt;
  }

  /** The procedure's latest DNIe progress card. */
  function lastDniePrompt(a: TestApp, procedureId: string) {
    return a.services.procedures
      .transcript(procedureId)
      .flatMap((i) => (i.type === 'prompt' && i.prompt.kind === 'dnie_signature' ? [i.prompt] : []))
      .at(-1);
  }

  /** Signs once with the key the phone gave, and ends the request. */
  async function signWith(approval: Promise<unknown>) {
    const key = (await approval) as ExternalSigningKey;
    expect(key?.kind).toBe('external');
    await key.sign(Buffer.from('attrs'), 'sha256', { kind: 'cms', document: 0 });
    key.release(true);
  }

  it('sends it only after the desktop approval, and never once the card refused it', async () => {
    const bio = touchId();
    const { relay, app: a, procedureId, dnie } = await setup(bio);
    expect(await a.invoke('vault.setDniePin', dnie.id, PIN)).toMatchObject({ pin: 'saved' });
    const { card, requests } = await pairedPhone(a, relay);
    const sign = (s: AfirmaSignatureSummary = summary) =>
      a.services.browser.approveSignature(procedureId, s);

    // The credential's policy is "ask": the desktop asks first, with Touch ID. Declining either
    // sends nothing to the phone.
    let approval = sign();
    expect(await confirm(a, procedureId, false)).toMatchObject({
      confirmKind: 'signature',
      biometric: true,
      message: expect.stringContaining('PIN guardado'),
    });
    expect(await approval).toBeNull();
    bio.ok = false;
    approval = sign();
    await confirm(a, procedureId, true);
    expect(await approval).toBeNull();
    expect(bio.prompts).toBe(1);
    expect(requests()).toHaveLength(0);

    // Approved: the request carries the PIN, and the card refuses it.
    bio.ok = true;
    card.refusePin = true;
    approval = sign();
    await confirm(a, procedureId, true);
    await signWith(approval);
    expect(requests().at(-1)).toMatchObject({ purpose: 'document', pin: PIN });
    // The progress card knows the phone won't ask for the PIN (its step hint leaves it out).
    expect(lastDniePrompt(a, procedureId)).toMatchObject({
      purpose: 'document',
      savedPin: true,
      message: expect.stringContaining('El móvil ya tiene tu PIN guardado.'),
    });
    expect(a.pendingPrompt(procedureId)).toBeUndefined();
    await a.waitFor(() => a.vault.getCredential(dnie.id)?.pin === 'wrong');
    expect((await a.invoke('vault.overview')).credentials).toMatchObject([
      { id: dnie.id, pin: 'wrong' },
    ]);
    expect(a.events.filter((e) => e.type === 'vault.changed').length).toBeGreaterThan(1);

    // Marked wrong: no desktop question, and no PIN, until a new one is saved.
    await signWith(sign());
    expect(requests().at(-1)).not.toHaveProperty('pin');
    expect(lastDniePrompt(a, procedureId)).not.toHaveProperty('savedPin');
    expect(lastDniePrompt(a, procedureId)?.message).toContain('escribe el PIN del DNIe');
    await a.invoke('vault.setDniePin', dnie.id, 'Nuevo5678');
    approval = sign();
    await confirm(a, procedureId, true);
    await signWith(approval);
    expect(requests().at(-1)).toMatchObject({ pin: 'Nuevo5678' });

    // Reading the certificate needs no PIN: no question, no PIN.
    const read = sign({ ...summary, method: 'selectCertificate', documents: [] });
    const key = (await read) as ExternalSigningKey;
    key.release(true);
    expect(requests().at(-1)).toMatchObject({ purpose: 'certificate' });
    expect(requests().at(-1)).not.toHaveProperty('pin');
    expect(lastDniePrompt(a, procedureId)).not.toHaveProperty('savedPin');

    // "Use automatically" (policy auto): no question.
    await a.invoke('vault.setCredentialPolicy', dnie.id, 'auto');
    await signWith(sign());
    expect(requests().at(-1)).toMatchObject({ pin: 'Nuevo5678' });
    expect(bio.prompts).toBe(3);

    // Never in prompts, transcripts, events, logs or the QR link.
    const seen = JSON.stringify([
      a.services.procedures.transcript(procedureId),
      a.services.conversation.transcript(),
      a.events,
      a.logLines,
      await a.invoke('vault.overview'),
      await a.invoke('companion.status'),
    ]);
    for (const pin of [PIN, 'Nuevo5678']) expect(seen).not.toContain(pin);
  });

  it('marks it when the card is blocked', async () => {
    for (const errorOnSign of [false, true]) {
      const { relay, app: a, procedureId, dnie } = await setup();
      await a.invoke('vault.setDniePin', dnie.id, PIN);
      await a.invoke('vault.setCredentialPolicy', dnie.id, 'auto');
      const { card, requests } = await pairedPhone(a, relay);
      Object.assign(card, { error: 'pin_blocked', errorOnSign });
      const approval = a.services.browser.approveSignature(procedureId, summary);
      if (errorOnSign) await expect(signWith(approval)).rejects.toThrow('pin_blocked');
      else expect(await approval).toBeNull();
      expect(requests().at(-1)).toMatchObject({ pin: PIN });
      await a.waitFor(() => a.vault.getCredential(dnie.id)?.pin === 'wrong');
      await a.close();
      for (const p of phones.splice(0)) p.close();
    }
    app = undefined;
  });

  it('goes with logins only after the desktop consent', async () => {
    const bio = touchId();
    const { relay, app: a, procedureId, token, dnie } = await setup(bio);
    await a.invoke('vault.setDniePin', dnie.id, PIN);
    const { requests } = await pairedPhone(a, relay);
    const use = () =>
      a.rpc('browser.useCertificate', { credentialId: dnie.id, origins: [summary.origin] }, token);

    let response = use();
    await confirm(a, procedureId, false);
    expect((await response).body.error?.code).toBe('user_rejected');
    expect(requests()).toHaveLength(0);

    response = use();
    expect(await confirm(a, procedureId, true)).toMatchObject({ confirmKind: 'credential' });
    expect((await response).body.result).toMatchObject({ enabled: true });
    expect(bio.prompts).toBe(1);
    expect(requests()).toMatchObject([{ purpose: 'login', pin: PIN }]);
    expect(a.pendingPrompt(procedureId)?.prompt).toMatchObject({
      purpose: 'login',
      savedPin: true,
    });
    expect(JSON.stringify((await response).body)).not.toContain(PIN);
  });
});

describe('without the dnie-phone feature flag', () => {
  async function setupOff() {
    const relay = new MemoryRelay();
    app = await createTestApp({
      env: { relayServerUrl: 'wss://relay.example.test' },
      relaySocket: relay.WebSocket,
      features: { dniePhone: false },
    });
    // Saved while the flag was on.
    const dnie = await app.vault.addDnie();
    const session = await app.procedureWithToken();
    return { relay, app, dnie, ...session };
  }

  it('never starts the companion and refuses pairing and new DNIe credentials', async () => {
    const { relay, app: a } = await setupOff();
    expect(a.services.companion).toBeUndefined();
    for (const method of ['companion.status', 'companion.pair', 'companion.unpair'] as const)
      await expect(a.invoke(method)).rejects.toThrow('no está disponible');
    await expect(a.invoke('vault.addDnie')).rejects.toThrow('no está disponible');
    const dnie = a.vault.listCredentials().find((c) => c.kind === 'dnie')!;
    await expect(a.invoke('vault.setDniePin', dnie.id, 'Abcd1234')).rejects.toThrow(
      'no está disponible',
    );
    expect(a.vault.pins.size).toBe(0);
    expect(relay.rooms.size).toBe(0);
    expect(a.events.some((e) => e.type === 'companion.changed')).toBe(false);
  });

  it('hides a saved DNIe from Mis datos and agents, and keeps it stored', async () => {
    const { app: a, dnie, token } = await setupOff();
    expect((await a.invoke('vault.overview')).credentials).toEqual([]);
    expect((await a.rpc('vault.read', {}, token)).body.result.credentials).toEqual([]);
    await expect(a.invoke('vault.deleteCredential', dnie.id)).rejects.toThrow();
    await expect(a.invoke('vault.setCredentialPolicy', dnie.id, 'auto')).rejects.toThrow();
    expect(a.vault.getCredential(dnie.id)).toMatchObject({ kind: 'dnie', policy: 'ask' });

    // Flags are read at start-up: the next launch with the flag on shows it again.
    await a.restart({ dniePhone: true });
    expect((await a.invoke('vault.overview')).credentials).toMatchObject([{ id: dnie.id }]);
    expect(a.services.companion).toBeDefined();
  });

  it('refuses DNIe logins with an explanation and leaves the DNIe out of signatures', async () => {
    const { relay, app: a, dnie, procedureId, token } = await setupOff();
    const login = await a.rpc('browser.useCertificate', { credentialId: dnie.id }, token);
    expect(login.body.error).toMatchObject({
      code: 'bad_request',
      message: expect.stringContaining('DNIe through the phone is not available'),
    });
    const fill = await a.rpc(
      'browser.fillFromVault',
      { ref: 'e1', value: { source: 'credential', credentialId: dnie.id, field: 'password' } },
      token,
    );
    expect(fill.body.error?.message).toContain('DNIe through the phone is not available');
    expect(a.pendingPrompt(procedureId)).toBeUndefined();

    // AutoFirma: with only the DNIe saved, there is no certificate to offer.
    expect(await a.services.browser.approveSignature(procedureId, summary)).toBeNull();
    expect(a.pendingPrompt(procedureId)).toBeUndefined();
    expect(a.services.procedures.transcript(procedureId).at(-1)).toMatchObject({
      type: 'notice',
      text: 'sede.example.gob.es te pide firmar, pero no tienes ningún certificado digital guardado. Añádelo en Mis datos.',
    });
    expect(relay.rooms.size).toBe(0);
    expect(a.browser.certificates).toEqual([]);
  });

  it('tells procedure agents the DNIe is off (prompt and tools)', async () => {
    const { app: a } = await setupOff();
    const provider = {
      baseUrl: 'http://127.0.0.1:8789/v1',
      api: 'openai-completions',
      model: 'mock-model',
    } as const;
    expect((await a.invoke('providers.setCustom', provider)).ok).toBe(true);
    const { procedureId } = await a.startProcedure();
    expect(a.agentFor(procedureId)?.launch.config).toMatchObject({ dniePhone: false });
    await a.restart({ dniePhone: true });
    await a.say('Otro trámite');
    const { procedureId: next } = await a.startProcedure('Otro trámite');
    expect(a.agentFor(next)?.launch.config).toMatchObject({ dniePhone: true });
  });
});
