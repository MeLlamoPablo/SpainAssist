/** #17: SHA-1 requests are signed with SHA-256 unless all there is to sign is a SHA-1 hash. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { AfirmaCall, AfirmaHandlerContext } from '@sa/shared';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import { OID, parseCades } from '../src/cades';
import { createAfirmaHandler } from '../src/handler';
import { rsaIdentity, type TestIdentity } from './helpers/pki';
import { pkijsVerify, signedAttributeTypes } from './helpers/verify';
import { DS, first, parse, XADES, xmldsigVerify } from './helpers/xml';

const DATA = Buffer.from('Local test document');
const SHA1_OID = '1.3.14.3.2.26';
const SHA256_OID = '2.16.840.1.101.3.4.2.1';
/** DER of the SHA-256 OID, to find it in the countersignature's unsigned attribute. */
const SHA256_OID_DER = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
const SHA1_URI = 'http://www.w3.org/2000/09/xmldsig#sha1';
const SHA256_URI = 'http://www.w3.org/2001/04/xmlenc#sha256';

function sign(data: Buffer, format: string, params: string | null, algorithm = 'SHA1withRSA') {
  return {
    method: 'sign',
    args: [data.toString('base64'), algorithm, format, params],
    origin: 'https://sede.mock.invalid',
    url: 'https://sede.mock.invalid/firma',
  } satisfies AfirmaCall;
}

function context(id: TestIdentity): AfirmaHandlerContext {
  return {
    procedureId: 'test',
    approveSignature: vi.fn(async () => ({
      kind: 'p12' as const,
      credentialId: 'test',
      p12: id.p12,
      passphrase: id.passphrase,
    })),
    report: vi.fn(),
  };
}

function setup() {
  const id = rsaIdentity();
  const logger = { info: vi.fn() };
  const handler = createAfirmaHandler({ logger });
  return { id, ctx: context(id), logger, handler };
}

async function signed(
  reply: Awaited<ReturnType<ReturnType<typeof createAfirmaHandler>>>,
): Promise<Buffer> {
  if (!reply.ok) throw new Error(reply.errorMessage);
  return Buffer.from(String(reply.callbackArgs[0]), 'base64');
}

function digestOids(der: Buffer): string[] {
  const { signedData } = parseCades(der);
  return [
    ...signedData.digestAlgorithms.map((a) => a.algorithm),
    ...signedData.signerInfos.map((si) => si.digestAlgorithm.algorithm),
  ];
}

/** The CMS in a PAdES signature, and the bytes its ByteRange covers. */
function padesCms(pdf: Buffer): { cms: Buffer; covered: Buffer } {
  const text = pdf.toString('latin1');
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  if (!m) throw new Error('no ByteRange');
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  const covered = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  const cms = Buffer.from(pdf.subarray(b + 1, c - 1).toString('ascii'), 'hex');
  const count = (cms[1] as number) & 0x7f;
  const length =
    (cms[1] as number) < 128 ? (cms[1] as number) + 2 : cms.readUIntBE(2, count) + count + 2;
  return { cms: cms.subarray(0, length), covered };
}

describe('SHA-1 requests with the data are signed with SHA-256', () => {
  it('CAdES: SHA-256 digests, rsa-sha256, signing-certificate-v2; nothing logged', async () => {
    const { ctx, logger, handler } = setup();
    for (const algorithm of ['SHA1withRSA', 'SHA1', 'SHA-1']) {
      const der = await signed(await handler(sign(DATA, 'CAdES', 'mode=implicit', algorithm), ctx));
      expect(await pkijsVerify(der)).toBe(true);
      expect(new Set(digestOids(der))).toEqual(new Set([SHA256_OID]));
      expect(signedAttributeTypes(der)).toContain(OID.signingCertificateV2);
      expect(signedAttributeTypes(der)).not.toContain(OID.signingCertificate);
    }
    expect(ctx.approveSignature).toHaveBeenCalledWith(
      expect.objectContaining({ algorithm: 'SHA256withRSA' }),
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('CAdES detached, countersign and cosign of an attached signature', async () => {
    const { ctx, handler } = setup();
    const detached = await signed(await handler(sign(DATA, 'CAdES', 'mode=explicit'), ctx));
    expect(await pkijsVerify(detached, 0, DATA)).toBe(true);
    expect(new Set(digestOids(detached))).toEqual(new Set([SHA256_OID]));

    const attached = await signed(
      await handler(sign(DATA, 'CAdES', 'mode=implicit', 'SHA512withRSA'), ctx),
    );
    const cosigned = await signed(
      await handler(
        {
          ...sign(attached, 'CAdES', null),
          method: 'coSign',
          args: [attached.toString('base64'), null, 'SHA1withRSA', 'CAdES', null],
        },
        ctx,
      ),
    );
    const sis = parseCades(cosigned).signedData.signerInfos;
    expect(sis.map((si) => si.digestAlgorithm.algorithm)).toEqual([
      '2.16.840.1.101.3.4.2.3',
      SHA256_OID,
    ]);
    expect(await pkijsVerify(cosigned, 1)).toBe(true);

    const countersigned = await signed(
      await handler(
        {
          ...sign(attached, 'CAdES', null),
          method: 'counterSign',
          args: [attached.toString('base64'), 'SHA1withRSA', 'CAdES', null],
        },
        ctx,
      ),
    );
    expect(digestOids(countersigned)).not.toContain(SHA1_OID);
    expect(countersigned.includes(Buffer.from(SHA256_OID_DER))).toBe(true);
  });

  it('XAdES: rsa-sha256 signature method, and sha1 references become sha256', async () => {
    const { ctx, handler } = setup();
    const xml = Buffer.from('<solicitud><nombre>Ana</nombre></solicitud>');
    for (const params of [
      null,
      `referencesDigestMethod=${SHA1_URI}`,
      'referencesDigestMethod=SHA1',
    ]) {
      const out = await signed(await handler(sign(xml, 'XAdES', params), ctx));
      expect(await xmldsigVerify(out)).toBe(true);
      const doc = parse(out);
      expect(first(doc, DS, 'SignatureMethod').getAttribute('Algorithm')).toBe(
        'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      );
      expect(out.toString('utf8')).not.toContain(SHA1_URI);
      if (params) {
        const methods = Array.from(doc.getElementsByTagNameNS(DS, 'DigestMethod')).map((e) =>
          e.getAttribute('Algorithm'),
        );
        expect(new Set(methods)).toEqual(new Set([SHA256_URI]));
      }
      const certDigest = first(first(doc, XADES, 'CertDigest'), DS, 'DigestMethod');
      expect(certDigest.getAttribute('Algorithm')).not.toBe(SHA1_URI);
    }
  });

  it('XAdES with the AGE policy: only the published policy hash stays SHA-1', async () => {
    const { ctx, handler } = setup();
    const xml = Buffer.from('<solicitud/>');
    const out = await signed(await handler(sign(xml, 'XAdES', 'expPolicy=FirmaAGE'), ctx));
    expect(await xmldsigVerify(out)).toBe(true);
    const doc = parse(out);
    const sha1Uses = Array.from(doc.getElementsByTagNameNS(DS, 'DigestMethod')).filter(
      (e) => e.getAttribute('Algorithm') === SHA1_URI,
    );
    expect(sha1Uses).toHaveLength(1);
    expect((sha1Uses[0]?.parentNode as Element | undefined)?.localName).toBe('SigPolicyHash');
  });

  it('PAdES: the CMS over the byte range uses SHA-256 and verifies', async () => {
    const { ctx, handler } = setup();
    const doc = await PDFDocument.create();
    doc.addPage();
    const pdf = Buffer.from(await doc.save());
    const out = await signed(await handler(sign(pdf, 'PAdES', null), ctx));
    const { cms, covered } = padesCms(out);
    expect(await pkijsVerify(cms, 0, covered)).toBe(true);
    expect(new Set(digestOids(cms))).toEqual(new Set([SHA256_OID]));
    expect(signedAttributeTypes(cms)).toContain(OID.signingCertificateV2);
  });

  it('NONE: a raw SHA-256 signature', async () => {
    const { id, ctx, handler } = setup();
    const sig = await signed(await handler(sign(DATA, 'NONE', null), ctx));
    const key = createPublicKey(id.privateKey);
    expect(verify('sha256', DATA, key, sig)).toBe(true);
    expect(verify('sha1', DATA, key, sig)).toBe(false);
  });

  it('a local batch upgrades each document except a precalculated SHA-1 hash', async () => {
    const { ctx, logger, handler } = setup();
    const precalc = Buffer.from('precalculatedHashAlgorithm=SHA-1').toString('base64');
    const reply = await handler(
      {
        ...sign(DATA, 'CAdES', null),
        method: 'signBatchProcess',
        args: [
          false,
          null,
          null,
          null,
          {
            algorithm: 'SHA1withRSA',
            format: 'CAdES',
            suboperation: 'sign',
            singlesigns: [
              { id: 'doc', datareference: DATA.toString('base64') },
              {
                id: 'hash',
                datareference: createHash('sha1').update(DATA).digest('base64'),
                extraparams: precalc,
              },
            ],
          },
          true,
        ],
      },
      ctx,
    );
    if (!reply.ok) throw new Error(reply.errorMessage);
    const signs = (reply.callbackArgs[0] as { signs: { id: string; signature: string }[] }).signs;
    const doc = Buffer.from(signs[0]?.signature ?? '', 'base64');
    const hash = Buffer.from(signs[1]?.signature ?? '', 'base64');
    expect(await pkijsVerify(doc, 0, DATA)).toBe(true);
    expect(new Set(digestOids(doc))).toEqual(new Set([SHA256_OID]));
    expect(await pkijsVerify(hash, 0, DATA)).toBe(true);
    expect(new Set(digestOids(hash))).toEqual(new Set([SHA1_OID]));
    expect(logger.info).toHaveBeenCalledOnce();
  });
});

describe('SHA-1 is kept when only a SHA-1 hash is available', () => {
  it('a precalculated SHA-1 hash is signed with SHA-1, logging only the host', async () => {
    const { ctx, logger, handler } = setup();
    const hash = createHash('sha1').update(DATA).digest();
    const der = await signed(
      await handler(sign(hash, 'CAdES', 'precalculatedHashAlgorithm=SHA-1'), ctx),
    );
    expect(await pkijsVerify(der, 0, DATA)).toBe(true);
    expect(new Set(digestOids(der))).toEqual(new Set([SHA1_OID]));
    expect(signedAttributeTypes(der)).toContain(OID.signingCertificate);
    expect(ctx.approveSignature).toHaveBeenCalledWith(
      expect.objectContaining({ algorithm: 'SHA1withRSA' }),
    );
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.any(String), {
      host: 'sede.mock.invalid',
      reason: 'precalculated-hash',
    });
    const logged = JSON.stringify(logger.info.mock.calls);
    for (const secret of [hash.toString('hex'), hash.toString('base64'), DATA.toString('utf8')])
      expect(logged).not.toContain(secret);
  });

  it('a precalculated SHA-256 hash with a SHA-256 algorithm logs nothing', async () => {
    const { ctx, logger, handler } = setup();
    const hash = createHash('sha256').update(DATA).digest();
    const der = await signed(
      await handler(
        sign(hash, 'CAdES', 'precalculatedHashAlgorithm=SHA-256', 'SHA256withRSA'),
        ctx,
      ),
    );
    expect(await pkijsVerify(der, 0, DATA)).toBe(true);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('cosigning a detached SHA-1 signature without the data stays SHA-1', async () => {
    const { ctx, logger, handler } = setup();
    const hash = createHash('sha1').update(DATA).digest();
    const detached = await signed(
      await handler(sign(hash, 'CAdES', 'precalculatedHashAlgorithm=SHA-1'), ctx),
    );
    const cosigned = await signed(
      await handler(
        {
          ...sign(DATA, 'CAdES', null),
          method: 'coSign',
          args: [detached.toString('base64'), null, 'SHA1withRSA', 'CAdES', null],
        },
        ctx,
      ),
    );
    expect(parseCades(cosigned).signedData.signerInfos).toHaveLength(2);
    expect(new Set(digestOids(cosigned))).toEqual(new Set([SHA1_OID]));
    expect(await pkijsVerify(cosigned, 1, DATA)).toBe(true);
    expect(logger.info).toHaveBeenLastCalledWith(expect.any(String), {
      host: 'sede.mock.invalid',
      reason: 'detached-cosign',
    });
  });
});
