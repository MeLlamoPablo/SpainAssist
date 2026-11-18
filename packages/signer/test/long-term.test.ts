/** B-LT where signatures are made: AutoFirma's PAdES and the user's own PDFs. */
import { X509Certificate } from 'node:crypto';
import type { AfirmaHandlerContext } from '@sa/shared';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { createAfirmaHandler } from '../src/handler';
import { encodeP12 } from '../src/p12';
import { signPdf } from '../src/sign-pdf';
import { DEFAULT_TSAS, makeLongTerm, timestampingFor } from '../src/timestamping';
import { PASSPHRASE } from './helpers/pki';
import { createTrustWorld, type TrustWorld } from './helpers/trust-services';

async function onePage(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function p12Of(world: TrustWorld): Buffer {
  return encodeP12({
    privateKey: world.signer.key,
    certificates: [world.signer.der, world.signerCa.der],
    passphrase: PASSPHRASE,
  });
}

function context(world: TrustWorld): AfirmaHandlerContext {
  return {
    procedureId: 'test',
    approveSignature: vi.fn(async () => ({
      kind: 'p12' as const,
      credentialId: 'test',
      p12: p12Of(world),
      passphrase: PASSPHRASE,
    })),
    report: vi.fn(),
  };
}

const hasTimestamp = (pdf: Buffer) => pdf.toString('latin1').includes('/DSS');

describe('which TSAs', () => {
  it('uses ours when the site names none', () => {
    expect(timestampingFor({})).toEqual({ tsas: [...DEFAULT_TSAS], documentTimestamp: false });
  });

  it("puts the site's TSA first, configured as AutoFirma does", () => {
    expect(
      timestampingFor({
        tsaURL: 'https://tsa.example/tsp',
        tsaUsr: 'user',
        tsaPwd: 'secret',
        tsType: '3',
      }),
    ).toEqual({
      tsas: [
        {
          url: 'https://tsa.example/tsp',
          policy: '0.4.0.2023.1.1',
          digest: 'sha512',
          username: 'user',
          password: 'secret',
        },
        ...DEFAULT_TSAS,
      ],
      documentTimestamp: true,
    });
    expect(
      timestampingFor({
        tsaURL: 'http://timestamp.digicert.com',
        tsaPolicy: '1.2.3',
        tsaHashAlgorithm: 'SHA-256',
        tsType: '1',
      }),
    ).toEqual({
      tsas: [
        { url: 'http://timestamp.digicert.com', policy: '1.2.3', digest: 'sha256' },
        ...DEFAULT_TSAS.slice(1),
      ],
      documentTimestamp: false,
    });
    // AutoFirma's socket:// TSAs aren't supported: ours only.
    expect(timestampingFor({ tsaURL: 'socket://tsa.example:318' }).tsas).toEqual([...DEFAULT_TSAS]);
  });
});

describe('AutoFirma PAdES', () => {
  it("makes it B-LT with the site's TSA", async () => {
    const world = createTrustWorld();
    const handler = createAfirmaHandler({ longTerm: { fetch: world.fetch, tsas: [] } });
    const pdf = await onePage();
    const reply = await handler(
      {
        method: 'sign',
        args: [
          pdf.toString('base64'),
          'SHA256withRSA',
          'PAdES',
          `tsaURL=${world.tsaUrl}\ntsaHashAlgorithm=SHA-256\ntsaPolicy=1.3.6.1.4.1.99999.1`,
        ],
        origin: 'https://sede.example',
        url: 'https://sede.example/firmar',
      },
      context(world),
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const signed = Buffer.from(String(reply.callbackArgs[0]), 'base64');
    expect(hasTimestamp(signed)).toBe(true);
    expect(world.calls[0]).toBe(world.tsaUrl);
  });

  it('adds the document timestamp the site asked for (tsType 3)', async () => {
    const world = createTrustWorld();
    const handler = createAfirmaHandler({
      longTerm: { fetch: world.fetch, tsas: [{ url: world.tsaUrl }] },
    });
    const reply = await handler(
      {
        method: 'sign',
        args: [(await onePage()).toString('base64'), 'SHA256withRSA', 'PAdES', 'tsType=3'],
        origin: 'https://sede.example',
        url: 'https://sede.example/firmar',
      },
      context(world),
    );
    if (!reply.ok) throw new Error(reply.errorMessage);
    const signed = Buffer.from(String(reply.callbackArgs[0]), 'base64').toString('latin1');
    expect(signed).toContain('/DocTimeStamp');
    expect(signed).toContain('/DSS');
  });

  it('fetches nothing without longTerm, and leaves CAdES alone', async () => {
    const world = createTrustWorld();
    const reply = await createAfirmaHandler()(
      {
        method: 'sign',
        args: [(await onePage()).toString('base64'), 'SHA256withRSA', 'PAdES', null],
        origin: 'https://sede.example',
        url: 'https://sede.example/firmar',
      },
      context(world),
    );
    if (!reply.ok) throw new Error(reply.errorMessage);
    expect(hasTimestamp(Buffer.from(String(reply.callbackArgs[0]), 'base64'))).toBe(false);
    const withLongTerm = createAfirmaHandler({ longTerm: { fetch: world.fetch } });
    const cades = await withLongTerm(
      {
        method: 'sign',
        args: [Buffer.from('hola').toString('base64'), 'SHA256withRSA', 'CAdES', null],
        origin: 'https://sede.example',
        url: 'https://sede.example/firmar',
      },
      context(world),
    );
    expect(cades.ok).toBe(true);
    expect(world.calls).toEqual([]);
  });

  it('fails the signature when the certificate is revoked', async () => {
    const world = createTrustWorld();
    world.revoked.add(new X509Certificate(world.signer.der).serialNumber);
    const ctx = context(world);
    const reply = await createAfirmaHandler({
      longTerm: { fetch: world.fetch, tsas: [{ url: world.tsaUrl }] },
    })(
      {
        method: 'sign',
        args: [(await onePage()).toString('base64'), 'SHA256withRSA', 'PAdES', null],
        origin: 'https://sede.example',
        url: 'https://sede.example/firmar',
      },
      ctx,
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) return;
    expect(reply.errorMessage).toContain('revocado');
  });
});

describe('the user’s own PDFs', () => {
  it('signs them B-LT', async () => {
    const world = createTrustWorld();
    const signed = await signPdf({
      pdf: await onePage(),
      key: { kind: 'p12', credentialId: 'c', p12: p12Of(world), passphrase: PASSPHRASE },
      placement: { page: 1, rect: [375, 40, 555, 104] },
      longTerm: { fetch: world.fetch, tsas: [{ url: world.tsaUrl }] },
    });
    expect(hasTimestamp(signed)).toBe(true);
  });

  it('keeps the signature when the network fails', async () => {
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const world = createTrustWorld();
    const pdf = await signPdf({
      pdf: await onePage(),
      key: { kind: 'p12', credentialId: 'c', p12: p12Of(world), passphrase: PASSPHRASE },
      placement: { page: 1, rect: [375, 40, 555, 104] },
    });
    const warn = vi.fn();
    const result = await makeLongTerm(pdf, {}, { fetch: offline, logger: { warn } });
    expect(result).toEqual({ pdf, level: 'B-B' });
    expect(warn).toHaveBeenCalledWith('timestamp authority failed', {
      url: DEFAULT_TSAS[0].url,
      error: 'fetch failed',
    });
  });
});
