import crypto from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import { PhoneClient } from '@sa/companion';
import { MemoryRelay } from '@sa/companion/testing';
import { type MockSede, startMockSede } from '@sa/mock-sede';
import { Sidecar, type SidecarIdentity } from '@sa/sidecar';
import { buildSidecar } from '@sa/sidecar/build';
import { openP12 } from '@sa/signer';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestApp } from '../testing/harness';

let sede: MockSede;
let sidecar: Sidecar;
let browser: BrowserService;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-login-'));
  sede = await startMockSede({ publicHost: '127.0.0.1' });
  sidecar = await Sidecar.start({
    binaryPath: await buildSidecar({ outDir: dir }),
    roots: [sede.caCertPem],
  });
  browser = createBrowserService({
    headless: true,
    certificates: sidecar,
    launchArgs: [
      `--ignore-certificate-errors-spki-list=${sidecar.spki},${sede.serverCertSpkiSha256}`,
    ],
    downloadsDir: dir,
    onDownload: async (_id, file) => ({
      downloadId: 'test',
      name: file.suggestedName,
      mimeType: file.mimeType,
    }),
  });
}, 120_000);

// Closing a real Chromium takes well under a second when idle but can take tens of seconds on a
// loaded machine (parallel suites), past Vitest's 10 s default hook timeout.
afterAll(async () => {
  await browser?.closeAll();
  await sidecar?.close();
  await sede?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
}, 120_000);

async function login(id: string, identity: SidecarIdentity) {
  // biome-ignore lint/correctness/useHookAtTopLevel: This configures TLS on the browser service.
  await browser.useClientCertificate(id, { origins: [sede.certUrl], identity });
  const observation = await browser.open(
    id,
    `${sede.url}/tramites/residencia/solicitud/datos-personales`,
  );
  const line = observation.snapshot
    .split('\n')
    .find((l) => l.includes('Acceso DNIe / Certificado electrónico'));
  const ref = line?.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
  expect(ref, observation.snapshot).toBeTruthy();
  const result = await browser.click(id, ref!);
  expect(result.snapshot).toContain('99999999R');
  expect(sede.test.snapshot().sessions.some((s) => s.method === 'certificado')).toBe(true);
}

it('logs in to the mock certificate IdP with a p12 through Chromium and the sidecar', async () => {
  const p12 = openP12(
    await readFile(sede.demo.certificateP12Path),
    sede.demo.certificatePassphrase,
  );
  await login('p12', { id: 'p12', chain: p12.chainDer, key: p12.privateKey });
}, 60_000);

it('logs in with the phone companion and signs each TLS digest without hashing it again', async () => {
  const relay = new MemoryRelay();
  const app = await createTestApp({
    env: { relayServerUrl: 'wss://relay.example.test' },
    relaySocket: relay.WebSocket,
  });
  let phone: PhoneClient | undefined;
  try {
    const { procedureId } = await app.procedureWithToken();
    const credential = await app.invoke('vault.addDnie');
    const p12 = openP12(
      await readFile(sede.demo.certificateP12Path),
      sede.demo.certificatePassphrase,
    );
    // The CAN from the scanned DNI; the PIN the user types on the desktop.
    await app.vault.setPersonal([{ key: 'dniAccessNumber', value: '123456' }], 'manual');
    const signing = app.services.companion!.login(procedureId, credential, sede.certUrl);
    await app.waitFor(() => {
      const prompt = app.pendingPrompt(procedureId)?.prompt;
      return prompt?.kind === 'dnie_signature' && prompt.stage === 'unlock';
    });
    await app.invoke('companion.unlock', app.pendingPrompt(procedureId)!.id, { pin: 'Abcd1234' });
    await app.waitFor(() => app.services.companion!.status().state === 'waiting');
    const status = app.services.companion!.status();
    expect(status.state).toBe('waiting');
    const requests = new Set<string>();
    const handshakes = new Set<number>();
    phone = new PhoneClient({
      link: 'link' in status ? (status.link ?? '') : '',
      hello: { app: 'test', platform: 'test', device: 'Simulated NFC phone' },
      socket: { WebSocket: relay.WebSocket },
      onMessage: (m) => {
        if (m.type === 'sign.request') {
          requests.add(m.requestId);
          expect(m.purpose).toBe('login');
          expect(m.documents).toEqual([]);
          phone!.send({
            type: 'sign.certificate',
            requestId: m.requestId,
            certificates: p12.chainDer.map((c) => c.toString('base64')),
          });
        } else if (m.type === 'sign.toBeSigned') {
          handshakes.add(m.seq);
          expect(m.prehashed).toBe(true);
          const prefix = {
            SHA1withRSA: '3021300906052b0e03021a05000414',
            SHA256withRSA: '3031300d060960864801650304020105000420',
            SHA384withRSA: '3041300d060960864801650304020205000430',
            SHA512withRSA: '3051300d060960864801650304020305000440',
          }[m.algorithm];
          const signature = crypto.privateEncrypt(
            { key: p12.privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.concat([Buffer.from(prefix, 'hex'), Buffer.from(m.data, 'base64')]),
          );
          phone!.send({
            type: 'sign.signature',
            requestId: m.requestId,
            seq: m.seq,
            signature: signature.toString('base64'),
          });
        }
      },
    });
    const identity = await signing;
    expect(identity).toBeTruthy();
    await login('dnie', identity!);
    expect(requests.size).toBe(1);
    expect(handshakes.size).toBe(1);
  } finally {
    phone?.close();
    await app.close();
  }
}, 60_000);
