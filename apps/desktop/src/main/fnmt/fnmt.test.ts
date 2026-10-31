/**
 * An FNMT certificate, end to end, against the mock sede's FNMT-like pages: the real browser
 * service and FnmtCertRequest shim, the broker and the real vault. Request (the key goes to the
 * vault, the PKCS#10 to the sede), the identity check (the test API), the download (the
 * certificate becomes a vault credential with its path), and the TEMPORARY debug log.
 */
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import {
  checkCertificateRequest,
  installCertData,
  issueFromRequest,
  loadClientCa,
  type MockSede,
  startMockSede,
} from '@sa/mock-sede';
import {
  FNMT_ERROR,
  type FnmtCall,
  type Prompt,
  type PromptResponse,
  setExtraTrustedHosts,
} from '@sa/shared';
import { FNMT_SHIM_SOURCE, openP12 } from '@sa/signer';
import { createTestKeyProvider, Vault } from '@sa/vault';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { createLogger } from '../core/logger';
import { FnmtBroker } from './broker';
import { createFnmtDebugLog, type FnmtDebugLog } from './debug-log';

const DNI = '99999999R';
const FNMT_URL = 'https://apus20.sede.fnmt.gob.es/SolicitudWebCert/presolicitar.do';

let sede: MockSede;
let dir: string;
let vault: Vault;
let broker: FnmtBroker;
let debug: FnmtDebugLog;
const asked: Prompt[] = [];
const notices: string[] = [];
let approve = true;
/** The prompt is cancelled under the broker (the procedure stopped, the app quit). */
let cancelPrompt = false;

function refOf(snapshot: string, pattern: string): string {
  const line = snapshot.split('\n').find((l) => l.includes(pattern) && l.includes('[ref='));
  const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
  if (!ref) throw new Error(`No ${pattern} in:\n${snapshot}`);
  return ref;
}

async function debugLines(): Promise<{ event: string; [key: string]: unknown }[]> {
  // Writes are queued: this one lands after every earlier one.
  await debug.write('test.flush', {});
  const logDir = join(dir, 'fnmt-debug');
  const files = await readdir(logDir);
  const text = (await Promise.all(files.map((f) => readFile(join(logDir, f), 'utf8')))).join('');
  return text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  sede = await startMockSede({ publicHost: '127.0.0.1' });
  setExtraTrustedHosts(['127.0.0.1']);
  dir = await mkdtemp(join(tmpdir(), 'sa-fnmt-'));
  vault = await Vault.open(join(dir, 'vault'), createTestKeyProvider('fnmt'));
  const logger = createLogger({ level: 'debug', sinks: [() => {}] });
  debug = createFnmtDebugLog(join(dir, 'fnmt-debug'), logger);
  broker = new FnmtBroker({
    vault: () => vault,
    prompts: {
      ask: async (_owner: string, prompt: Prompt): Promise<PromptResponse> => {
        asked.push(prompt);
        if (cancelPrompt) throw new Error('Prompt cancelled');
        return { kind: 'confirm', approved: approve };
      },
    },
    procedures: {
      has: (id: string) => id.startsWith('proc'),
      addNotice: (_id: string, _level: unknown, text: string) => {
        notices.push(text);
        return undefined;
      },
    },
    events: new EventBus(),
    logger,
    lang: () => 'es',
    debug,
  });
});

afterAll(async () => {
  setExtraTrustedHosts([]);
  await debug?.write('test.end', {});
  await sede?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  asked.length = 0;
  notices.length = 0;
  approve = true;
  cancelPrompt = false;
});

describe('FNMT certificate request and download through the app', () => {
  it('requests, downloads and stores the certificate, logging everything for repair', async () => {
    const browser: BrowserService = createBrowserService({
      headless: true,
      ignoreHTTPSErrors: true,
      executablePath: chromium.executablePath(),
      downloadsDir: join(dir, 'downloads'),
      onDownload: async () => {
        throw new Error('no downloads expected');
      },
      fnmt: { shimSource: FNMT_SHIM_SOURCE, handler: broker.handle },
    });
    try {
      const id = 'proc-fnmt';
      let obs = await browser.open(id, `${sede.url}/fnmt/solicitud`);
      expect(obs.notes.some((n) => n.includes("replaces FNMT's Configurador"))).toBe(true);
      obs = await browser.type(id, refOf(obs.snapshot, 'textbox "Nº del documento'), DNI);
      obs = await browser.type(id, refOf(obs.snapshot, 'textbox "Primer apellido'), 'Española');
      obs = await browser.type(
        id,
        refOf(obs.snapshot, 'textbox "Correo electrónico'),
        'c@example.com',
      );
      obs = await browser.type(
        id,
        refOf(obs.snapshot, 'textbox "Confirma tu correo'),
        'c@example.com',
      );
      obs = await browser.check(id, refOf(obs.snapshot, 'checkbox'), true);
      obs = await browser.click(id, refOf(obs.snapshot, 'button "Enviar petición"'));
      if (!obs.snapshot.includes('Solicitud registrada')) {
        obs = await browser.wait(id, { text: 'Solicitud registrada', seconds: 20 });
      }
      expect(obs.dialogs).toEqual([]);
      const code = sede.test.fnmtRequests()[0]?.code;
      expect(code).toMatch(/^\d{9}$/);
      expect(obs.snapshot).toContain(code);

      // The key is in the vault, under the hash of the key the sede got.
      const [request] = sede.test.fnmtRequests();
      const [pending] = vault.listCertificateRequests();
      expect(pending).toMatchObject({
        publicKeyHash: request?.publicKeyHash,
        keyDescription: 'rsa 2048',
        origin: sede.url,
        procedureId: id,
      });
      expect(asked.map((p) => p.title)).toEqual(['¿Solicitar tu certificado digital?']);

      // Downloading before the identity check: the sede refuses, nothing changes.
      obs = await browser.open(id, `${sede.url}/fnmt/descarga`);
      const fill = async () => {
        obs = await browser.type(id, refOf(obs.snapshot, 'textbox "Nº del documento'), DNI);
        obs = await browser.type(id, refOf(obs.snapshot, 'textbox "Primer apellido'), 'ESPAÑOLA');
        obs = await browser.type(id, refOf(obs.snapshot, 'textbox "Código de solicitud'), code!);
        obs = await browser.check(id, refOf(obs.snapshot, 'checkbox'), true);
        obs = await browser.click(id, refOf(obs.snapshot, 'button "Descargar certificado"'));
      };
      await fill();
      expect(obs.snapshot).toContain('todavía no está acreditada');

      sede.test.accreditFnmt(code);
      obs = await browser.open(id, `${sede.url}/fnmt/descarga`);
      await fill();
      if (!obs.snapshot.includes('instalado correctamente')) {
        obs = await browser.wait(id, { text: 'instalado correctamente', seconds: 20 });
      }
      expect(obs.dialogs).toEqual([]);
      expect(obs.notes.some((n) => n.includes("is now in the user's vault"))).toBe(true);
      expect(asked.at(-1)?.title).toBe('¿Guardar tu certificado digital?');

      // A certificate credential with its key and path; the pending key is gone.
      expect(vault.listCertificateRequests()).toEqual([]);
      const [credential] = vault.listCredentials();
      expect(credential).toMatchObject({
        kind: 'certificate',
        label: 'Certificado de CARMEN ESPAÑOLA ESPAÑOLA',
      });
      const secret = await vault.getCredentialSecret(credential!.id);
      if (secret.kind !== 'certificate') throw new Error('unexpected');
      // openP12 also checks that the key matches the certificate.
      const identity = openP12(secret.p12, secret.passphrase);
      const ca = loadClientCa();
      expect(identity.chainDer.map((c) => new X509Certificate(c).subject)).toEqual([
        expect.stringContaining('CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'),
        expect.stringContaining('AC MOCK-FNMT Usuarios'),
      ]);
      expect(identity.chainDer[1]!.equals(ca.intermediate.certDer)).toBe(true);
      expect(notices).toEqual([
        expect.stringContaining('Clave creada y guardada'),
        'Certificado digital guardado en Mis datos: Certificado de CARMEN ESPAÑOLA ESPAÑOLA.',
      ]);

      // TEMPORARY debug log: the key in clear, the request, the certificate data, the replies.
      const lines = await debugLines();
      const events = lines.map((l) => l.event);
      for (const event of [
        'call',
        'consent',
        'key',
        'pending',
        'reply',
        'certificates',
        'path',
        'credential',
      ]) {
        expect(events).toContain(event);
      }
      const key = lines.find((l) => l.event === 'key') as
        | { privateKeyPem: string; pkcs10: string }
        | undefined;
      if (!key) throw new Error('no key event');
      expect(key.privateKeyPem).toContain('-----BEGIN PRIVATE KEY-----');
      expect(checkCertificateRequest(key.pkcs10).publicKeyHash).toBe(request?.publicKeyHash);
      const install = lines.find(
        (l) => l.event === 'call' && (l.call as FnmtCall).method === 'installCert',
      );
      expect(typeof (install?.call as FnmtCall | undefined)?.args[0]).toBe('string');
    } finally {
      await browser.closeAll();
    }
  }, 90_000);

  it('keeps nothing when the user declines the request, and keeps the key when they decline the download', async () => {
    approve = false;
    const call = (method: FnmtCall['method'], args: unknown[]): FnmtCall => ({
      method,
      args,
      origin: 'https://apus20.sede.fnmt.gob.es',
      url: FNMT_URL,
    });
    expect(await broker.handle(call('requestCert', ['RSA', null, null, false]), 'proc-2')).toEqual({
      ok: false,
      errorType: FNMT_ERROR.cancelled,
      errorMessage: expect.any(String),
    });
    expect(vault.listCertificateRequests().filter((r) => r.procedureId === 'proc-2')).toEqual([]);
    cancelPrompt = true;
    expect(
      await broker.handle(call('requestCert', ['RSA', null, null, false]), 'proc-2'),
    ).toMatchObject({ ok: false, errorType: FNMT_ERROR.cancelled });
    expect(vault.listCertificateRequests().filter((r) => r.procedureId === 'proc-2')).toEqual([]);
    cancelPrompt = false;

    approve = true;
    const made = await broker.handle(call('requestCert', ['RSA', null, null, false]), 'proc-2');
    if (!made.ok || !made.result) throw new Error('no request');
    const checked = checkCertificateRequest(made.result);
    const leaf = issueFromRequest({
      spki: checked.spki,
      dni: DNI,
      givenName: 'Carmen',
      surname: 'Española Española',
      now: new Date(),
    });
    approve = false;
    const declined = await broker.handle(call('installCert', [installCertData(leaf)]), 'proc-2');
    expect(declined).toMatchObject({ ok: false, errorType: FNMT_ERROR.cancelled });
    expect(vault.findCertificateRequest(checked.publicKeyHash)).toBeDefined();

    approve = true;
    expect(await broker.handle(call('installCert', [installCertData(leaf)]), 'proc-2')).toEqual({
      ok: true,
    });
    // The page installs the same certificate again (a reload): already stored, fine.
    expect(await broker.handle(call('installCert', [installCertData(leaf)]), 'proc-2')).toEqual({
      ok: true,
    });
    const fingerprint = createHash('sha256').update(leaf).digest('hex');
    expect(
      vault.listCredentials().filter((c) => c.certificate?.fingerprint === fingerprint),
    ).toHaveLength(1);
  }, 30_000);

  it('refuses pages that are not FNMT, smart cards, and certificates it has no key for', async () => {
    const refused = await broker.handle(
      {
        method: 'requestCert',
        args: [],
        origin: 'https://evil.example',
        url: 'https://evil.example/',
      },
      'proc-3',
    );
    expect(refused).toMatchObject({ ok: false, errorType: FNMT_ERROR.generic });
    const card = await broker.handle(
      { method: 'requestCert', args: ['RSA', null, null, true], origin: '', url: FNMT_URL },
      'proc-3',
    );
    expect(card).toMatchObject({ ok: false, errorType: FNMT_ERROR.cardNotSupported });
    const unknown = await broker.handle(
      {
        method: 'installCert',
        args: [installCertData(loadClientCa().intermediate.certDer)],
        origin: '',
        url: FNMT_URL,
      },
      'proc-3',
    );
    expect(unknown).toMatchObject({ ok: false, errorType: FNMT_ERROR.keyNotFound });
    const garbage = await broker.handle(
      { method: 'installCert', args: ['no es un certificado'], origin: '', url: FNMT_URL },
      'proc-3',
    );
    expect(garbage).toMatchObject({ ok: false, errorType: FNMT_ERROR.generic });
    expect(asked).toEqual([]);
  });
});
