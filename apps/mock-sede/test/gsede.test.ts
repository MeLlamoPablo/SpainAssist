/**
 * The gsede-like AutoFirma login (an XML batch signature, not a TLS client certificate) with the
 * real browser service, AutoScript shim and signer: with a .p12 and with an external key like the
 * DNIe in the paired phone.
 */
import { sign as cryptoSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserService, createBrowserService } from '@sa/browser';
import type {
  AfirmaSignatureSummary,
  BrowserObservation,
  ExternalSigningKey,
  SigningKey,
} from '@sa/shared';
import { AUTOSCRIPT_SHIM_SOURCE, afirmaHandler } from '@sa/signer';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pemToDer } from '../src/cades-build';
import { loadDemoIdentity, type MockSede, startMockSede } from '../src/index';

const demo = loadDemoIdentity();

function p12Key(): SigningKey {
  return { kind: 'p12', credentialId: 'cert', p12: demo.p12, passphrase: demo.passphrase };
}

/** The DNIe in the phone: the app never holds the key, it asks the phone to sign each hash. */
function phoneKey(log: { signed: number; released: boolean[] }): ExternalSigningKey {
  return {
    kind: 'external',
    credentialId: 'dnie',
    certificates: [pemToDer(demo.certPem), ...demo.chainPem.map(pemToDer)],
    sign: async (data, digest) => {
      log.signed += 1;
      return cryptoSign(digest, data, demo.keyPem);
    },
    release: (ok) => log.released.push(ok),
  };
}

let sede: MockSede;
let dir: string;
beforeAll(async () => {
  sede = await startMockSede({ publicHost: '127.0.0.1' });
  dir = await mkdtemp(join(tmpdir(), 'sa-gsede-'));
});
afterAll(async () => {
  await sede?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function loginWith(key: () => SigningKey) {
  const approvals: AfirmaSignatureSummary[] = [];
  const browser: BrowserService = createBrowserService({
    headless: true,
    ignoreHTTPSErrors: true,
    executablePath: chromium.executablePath(),
    downloadsDir: join(dir, 'downloads'),
    onDownload: async () => {
      throw new Error('no downloads expected');
    },
    afirma: {
      shimSource: AUTOSCRIPT_SHIM_SOURCE,
      handler: afirmaHandler,
      context: () => ({
        approveSignature: async (summary) => {
          approvals.push(summary);
          return key();
        },
        fetch: sede.fetch,
      }),
    },
  });
  const seen: BrowserObservation[] = [];
  try {
    let obs = await browser.open('gsede', `${sede.url}/gsede/acceso`);
    seen.push(obs);
    const line = obs.snapshot.split('\n').find((l) => l.includes('button "Acceder"'));
    const ref = line?.match(/\[ref=([^\]]+)\]/)?.[1];
    if (!ref) throw new Error(`No Acceder button: ${obs.snapshot}`);
    obs = await browser.click('gsede', ref);
    seen.push(obs);
    if (!obs.url.endsWith('/gsede/carpeta')) {
      obs = await browser.wait('gsede', { text: 'Has accedido', seconds: 20 });
      seen.push(obs);
    }
    return { obs, seen, approvals };
  } finally {
    await browser.closeAll();
  }
}

describe('gsede AutoFirma login (XML signBatch)', () => {
  it('logs in with a .p12 through BatchPresigner/BatchPostsigner', async () => {
    const { obs, seen, approvals } = await loginWith(p12Key);
    expect(obs.url).toBe(`${sede.url}/gsede/carpeta`);
    expect(obs.snapshot).toContain('Has accedido con tu certificado electrónico');
    expect(sede.test.snapshot().sessions.at(-1)).toMatchObject({
      dni: demo.dni,
      method: 'certificado',
      loa: 'high',
    });
    expect(approvals).toEqual([
      expect.objectContaining({
        method: 'signBatch',
        format: 'CAdES',
        algorithm: 'SHA256withRSA',
        origin: sede.url,
        signatures: 1,
        verifiable: false,
        description: expect.stringContaining(
          'Firmar un código corto del sitio (normalmente, para identificarte).',
        ),
      }),
    ]);
    const all = {
      signatures: seen.flatMap((o) => o.signatures),
      pageErrors: seen.flatMap((o) => o.pageErrors),
      dialogs: seen.flatMap((o) => o.dialogs),
      notes: seen.flatMap((o) => o.notes),
    };
    expect(all.signatures).toEqual([{ status: 'signed', format: 'lote', origin: sede.url }]);
    expect(all.pageErrors).toEqual([]);
    expect(all.dialogs).toEqual([]);
    expect(all.notes.some((n) => n.includes('uses AutoFirma'))).toBe(true);
    expect(all.notes.some((n) => n.includes('does not implement'))).toBe(false);
  }, 60_000);

  it('logs in with an external key (the DNIe in the phone), released once', async () => {
    const log = { signed: 0, released: [] as boolean[] };
    const { obs } = await loginWith(() => phoneKey(log));
    expect(obs.url).toBe(`${sede.url}/gsede/carpeta`);
    expect(log).toEqual({ signed: 1, released: [true] });
  }, 60_000);

  it('reports a declined approval to the page and the agent', async () => {
    const browser = createBrowserService({
      headless: true,
      ignoreHTTPSErrors: true,
      executablePath: chromium.executablePath(),
      downloadsDir: join(dir, 'downloads'),
      onDownload: async () => {
        throw new Error('no downloads expected');
      },
      afirma: {
        shimSource: AUTOSCRIPT_SHIM_SOURCE,
        handler: afirmaHandler,
        context: () => ({ approveSignature: async () => null }),
      },
    });
    try {
      let obs = await browser.open('gsede-no', `${sede.url}/gsede/acceso`);
      const ref = obs.snapshot
        .split('\n')
        .find((l) => l.includes('button "Acceder"'))
        ?.match(/\[ref=([^\]]+)\]/)?.[1];
      obs = await browser.click('gsede-no', ref!);
      const signatures = [...obs.signatures];
      const dialogs = [...obs.dialogs];
      if (!signatures.length) {
        obs = await browser.wait('gsede-no', { seconds: 3 });
        signatures.push(...obs.signatures);
        dialogs.push(...obs.dialogs);
      }
      expect(signatures).toEqual([
        {
          status: 'rejected',
          format: 'lote',
          origin: sede.url,
          message: 'Operacion cancelada por el usuario',
        },
      ]);
      // clientSigner.js reports AutoFirma errors with alert().
      expect(dialogs.join(' ')).toContain('Ha ocurrido un error al firmar');
    } finally {
      await browser.closeAll();
    }
  }, 60_000);
});
