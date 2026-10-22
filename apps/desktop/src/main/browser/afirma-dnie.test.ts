/**
 * An AutoFirma XML batch (the gsede-style login signature) with the DNI in the phone: the
 * signer's handler asks the app's approval, which goes to the phone; the phone signs the
 * presignature of the mock sede's BatchPresigner and its BatchPostsigner builds a valid CAdES.
 */
import crypto from 'node:crypto';
import { PhoneClient } from '@sa/companion';
import { MemoryRelay } from '@sa/companion/testing';
import {
  loadDemoIdentity,
  type MockSede,
  startMockSede,
  verifyCadesSignature,
} from '@sa/mock-sede';
import type { DesktopToPhone } from '@sa/shared';
import { afirmaHandler } from '@sa/signer';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../testing/harness';

let sede: MockSede;
let app: TestApp | undefined;
let phone: PhoneClient | undefined;
beforeAll(async () => {
  sede = await startMockSede({ publicHost: '127.0.0.1' });
});
afterAll(async () => {
  phone?.close();
  await app?.close();
  await sede?.close();
});

const der = (pem: string) =>
  Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

it('signs an AutoFirma XML batch with the DNI in the phone, end to end', async () => {
  const relay = new MemoryRelay();
  app = await createTestApp({
    env: { relayServerUrl: 'wss://relay.example.test' },
    relaySocket: relay.WebSocket,
  });
  const a = app;
  const { procedureId } = await a.procedureWithToken();
  await a.invoke('vault.addDnie');
  const demo = loadDemoIdentity();
  const challenge = Buffer.from('CHALLENGE-0123456789ABCDEF').toString('base64');
  const batch = `<signbatch stoponerror="true" algorithm="SHA256withRSA"><singlesign Id="tx-dnie"><datasource>${challenge}</datasource><format>CAdES</format><suboperation>sign</suboperation><extraparams>${Buffer.from('mode=implicit\n').toString('base64')}</extraparams></singlesign></signbatch>`;

  const reports: unknown[] = [];
  const reply = afirmaHandler(
    {
      method: 'signBatch',
      args: [
        Buffer.from(batch).toString('base64'),
        `${sede.url}/gsede/clientsigner/BatchPresigner/service/ABC`,
        `${sede.url}/gsede/clientsigner/BatchPostsigner/service/ABC`,
        'mode=implicit\n',
      ],
      origin: sede.url,
      url: `${sede.url}/gsede/acceso`,
    },
    {
      procedureId,
      approveSignature: (summary) => a.services.browser.approveSignature(procedureId, summary),
      report: (event) => reports.push(event),
      fetch: sede.fetch,
    },
  );

  // The desktop asks for the card's CAN and PIN first (test values, never real ones).
  await a.waitFor(() => {
    const p = a.pendingPrompt(procedureId)?.prompt;
    return p?.kind === 'dnie_signature' && p.stage === 'unlock';
  });
  await a.invoke('companion.unlock', a.pendingPrompt(procedureId)!.id, {
    can: '123456',
    pin: 'Abcd1234',
  });
  await a.waitFor(() => a.services.companion!.status().state === 'waiting');
  const link = (await a.invoke('companion.status')).link as string;
  const received: DesktopToPhone[] = [];
  const client: PhoneClient = new PhoneClient({
    link,
    hello: { app: '1.0.0', platform: 'test', device: 'Phone under test' },
    socket: { WebSocket: relay.WebSocket, backoffMs: () => 5 },
    onMessage: (m) => {
      received.push(m);
      if (m.type === 'sign.request') {
        client.send({
          type: 'sign.certificate',
          requestId: m.requestId,
          certificates: [demo.certPem, ...demo.chainPem].map((p) => der(p).toString('base64')),
        });
      } else if (m.type === 'sign.toBeSigned') {
        // The card hashes and signs (RSA PKCS#1 v1.5).
        const signature = crypto.sign('sha256', Buffer.from(m.data, 'base64'), demo.keyPem);
        client.send({
          type: 'sign.signature',
          requestId: m.requestId,
          seq: m.seq,
          signature: signature.toString('base64'),
        });
      }
    },
  });
  phone = client;

  const result = await reply;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return;
  expect(Buffer.from(String(result.callbackArgs[0]), 'base64').toString()).toBe(
    '<signs><signresult id="tx-dnie" result="DONE_AND_SAVED" description=""/></signs>',
  );
  expect(reports).toEqual([{ status: 'signed', format: 'lote', origin: sede.url }]);

  // The phone was told what it signs: one signature it can't check, no document.
  expect(received.find((m) => m.type === 'sign.request')).toMatchObject({
    purpose: 'document',
    origin: sede.url,
    verifiable: false,
    signatures: 1,
    documents: [],
  });
  const toBeSigned = received.filter((m) => m.type === 'sign.toBeSigned');
  expect(toBeSigned).toHaveLength(1);
  expect(toBeSigned[0]).toMatchObject({ algorithm: 'SHA256withRSA' });
  expect(toBeSigned[0]).not.toHaveProperty('check');
  await a.waitFor(() => received.some((m) => m.type === 'sign.done'));

  // The sede's postsigner stored a CAdES of the challenge signed by the DNI's certificate.
  const stored = await (
    await sede.fetch(`${sede.url}/gsede/clientsigner/RetrieveService?op=get&v=1_0&id=tx-dnie`)
  ).text();
  const [cert, signature] = stored.split('|');
  const verification = verifyCadesSignature({
    signature: signature!,
    expectedContent: Buffer.from(challenge, 'base64'),
    certificateArgument: cert,
  });
  expect(verification.error).toBeUndefined();
  expect(verification.valid).toBe(true);
  expect(verification.signer?.dni).toBe(demo.dni);
}, 60_000);
