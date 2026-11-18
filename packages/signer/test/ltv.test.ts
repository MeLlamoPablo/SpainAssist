import crypto from 'node:crypto';
import { inflateSync } from 'node:zlib';
import * as asn1js from 'asn1js';
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFRawStream, type PDFRef } from 'pdf-lib';
import * as pkijs from 'pkijs';
import { beforeAll, describe, expect, it } from 'vitest';
import { resolveAlgorithm } from '../src/algorithms';
import { keyObjectSigner } from '../src/key';
import { upgradePades } from '../src/ltv';
import { createPades } from '../src/pades';
import { pdfSignatures } from '../src/pdf-signatures';
import { createTrustWorld, type TrustWorld } from './helpers/trust-services';
import { pkijsVerify } from './helpers/verify';

const OID_SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14';

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function onePage(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function signWith(world: TrustWorld, pdf: Buffer): Promise<Buffer> {
  return createPades({
    pdf,
    algorithm: resolveAlgorithm('SHA256', 'rsa'),
    signer: keyObjectSigner(world.signer.key, 'rsa'),
    chain: [world.signer.der, world.signerCa.der],
    params: {},
  });
}

/** Each signature's byte range, signed data and CMS, in file order. */
function signatures(pdf: Buffer) {
  const text = pdf.toString('latin1');
  return [...text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)].map((m) => {
    const [a, b, c, d] = m.slice(1).map(Number);
    const data = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
    const contents = Buffer.from(pdf.subarray(b + 1, c - 1).toString('latin1'), 'hex');
    const parsed = asn1js.fromBER(contents);
    return { range: [a, b, c, d], data, cms: contents.subarray(0, parsed.offset) };
  });
}

function signedData(cms: Uint8Array): pkijs.SignedData {
  return new pkijs.SignedData({ schema: pkijs.ContentInfo.fromBER(ab(cms)).content });
}

function timestampToken(cms: Uint8Array): Buffer | undefined {
  const attr = signedData(cms).signerInfos[0].unsignedAttrs?.attributes.find(
    (a) => a.type === OID_SIGNATURE_TIMESTAMP,
  );
  return attr ? Buffer.from(attr.values[0].toBER()) : undefined;
}

/** The imprint and genTime a token states, with pkijs. */
function tokenInfo(token: Uint8Array) {
  const sd = signedData(token);
  const content = sd.encapContentInfo.eContent as asn1js.OctetString;
  const info = pkijs.TSTInfo.fromBER(ab(Buffer.from(content.getValue())));
  return {
    hash: Buffer.from(info.messageImprint.hashedMessage.valueBlock.valueHexView),
    genTime: info.genTime,
    /** pkijs checks the imprint against `data` (the timestamped bytes) and the signature. */
    verify: (data: Uint8Array) => sd.verify({ signer: 0, data: ab(data), checkChain: false }),
  };
}

async function dss(pdf: Buffer) {
  const doc = await PDFDocument.load(pdf);
  const dict = doc.catalog.lookupMaybe(PDFName.of('DSS'), PDFDict);
  if (!dict) return undefined;
  const streams = (name: string) => {
    const arr = dict.lookupMaybe(PDFName.of(name), PDFArray);
    return (arr?.asArray() ?? []).map((r) =>
      inflateSync(Buffer.from((doc.context.lookup(r as PDFRef) as PDFRawStream).contents)),
    );
  };
  const vri = dict.lookupMaybe(PDFName.of('VRI'), PDFDict);
  return {
    certs: streams('Certs'),
    ocsps: streams('OCSPs'),
    crls: streams('CRLs'),
    vriKeys: vri ? [...vri.keys()].map((k) => k.asString().slice(1)) : [],
    adbe: doc.catalog
      .lookup(PDFName.of('Extensions'), PDFDict)
      .lookupMaybe(PDFName.of('ADBE'), PDFDict)
      ?.toString(),
  };
}

function subjectsOf(certs: Buffer[]): string[] {
  return certs.map((c) => new crypto.X509Certificate(c).subject.split('\n').at(-1) ?? '').sort();
}

let world: TrustWorld;
let signed: Buffer;

beforeAll(async () => {
  world = createTrustWorld();
  signed = await signWith(world, await onePage());
});

describe('PAdES-B-LT', () => {
  it('timestamps the signature and stores what validates it, keeping it valid', async () => {
    world.calls.length = 0;
    const { pdf, level, tsa, missing } = await upgradePades(signed, {
      fetch: world.fetch,
      tsas: [{ url: world.tsaUrl }],
    });
    expect({ level, tsa, missing }).toEqual({ level: 'B-LT', tsa: world.tsaUrl, missing: [] });

    // The signature still verifies over the same bytes; only /Contents changed.
    const [sig] = signatures(pdf);
    const [before] = signatures(signed);
    expect(sig.data.equals(before.data)).toBe(true);
    expect(await pkijsVerify(sig.cms, 0, sig.data)).toBe(true);
    expect(pdf.subarray(0, signed.length).length).toBe(signed.length);

    // B-T: a token over the signature value, from our TSA, that pkijs accepts.
    const token = timestampToken(sig.cms);
    expect(token).toBeDefined();
    const info = tokenInfo(token as Buffer);
    const value = Buffer.from(signedData(sig.cms).signerInfos[0].signature.valueBlock.valueHexView);
    expect(info.hash).toEqual(crypto.createHash('sha256').update(value).digest());
    expect(await info.verify(value)).toBe(true);

    // B-LT: both chains up to the root, OCSP for the leaves, the root's CRL for the CAs.
    const store = await dss(pdf);
    expect(subjectsOf(store?.certs ?? [])).toEqual(
      [
        'CN=AC Sellado de pruebas',
        'CN=AC Usuarios de pruebas',
        'CN=ESPAÑOLA ESPAÑOLA CARMEN - 99999999R',
        'CN=OCSP de AC Sellado de pruebas',
        'CN=Raíz de pruebas',
        'CN=Sellos de tiempo de pruebas',
      ].sort(),
    );
    expect(store?.ocsps).toHaveLength(2);
    expect(store?.crls).toHaveLength(1);
    const crl = pkijs.CertificateRevocationList.fromBER(ab(store?.crls[0] as Buffer));
    expect(crl.issuer.typesAndValues.at(-1)?.value.valueBlock.value).toBe('Raíz de pruebas');
    expect(store?.adbe).toContain('/ExtensionLevel 8');
    // VRI: the SHA-1 of the signature's /Contents, padding included.
    const contents = Buffer.from(
      pdf.subarray(sig.range[1] + 1, sig.range[2] - 1).toString('latin1'),
      'hex',
    );
    expect(store?.vriKeys).toEqual([
      crypto.createHash('sha1').update(contents).digest('hex').toUpperCase(),
    ]);
    // The root came from the CA-issuers URL; the delegated responder needed no check.
    expect(world.calls).toContain('http://ca.test/root.cer');
    expect(world.calls).not.toContain('http://crl.test/tsaCa.crl');

    // Mis documentos reads the TSA's time.
    const [listed] = await pdfSignatures(pdf);
    expect(listed.signedAt).toBe(info.genTime.toISOString());
  });

  it('tries the next TSA when one fails', async () => {
    world.down.add('http://down.test/tsr');
    const warnings: unknown[] = [];
    const { level, tsa } = await upgradePades(signed, {
      fetch: world.fetch,
      tsas: [{ url: 'http://down.test/tsr' }, { url: world.tsaUrl }],
      logger: { warn: (msg, data) => warnings.push({ msg, data }) },
    });
    expect({ level, tsa }).toEqual({ level: 'B-LT', tsa: world.tsaUrl });
    expect(warnings).toContainEqual({
      msg: 'timestamp authority failed',
      data: { url: 'http://down.test/tsr', error: 'HTTP 503' },
    });
  });

  it('leaves the signature as it was when no TSA answers', async () => {
    world.down.add(world.tsaUrl);
    try {
      const { pdf, level } = await upgradePades(signed, {
        fetch: world.fetch,
        tsas: [{ url: world.tsaUrl }],
      });
      expect(level).toBe('B-B');
      expect(pdf).toBe(signed);
    } finally {
      world.down.delete(world.tsaUrl);
    }
  });

  it('refuses a timestamp for other data', async () => {
    // A TSA that replays an earlier answer: valid signature, wrong imprint and nonce.
    const first = await world.fetch(world.tsaUrl, {
      method: 'POST',
      body: new Uint8Array(
        Buffer.from(
          new pkijs.TimeStampReq({
            version: 1,
            messageImprint: new pkijs.MessageImprint({
              hashAlgorithm: new pkijs.AlgorithmIdentifier({
                algorithmId: '2.16.840.1.101.3.4.2.1',
              }),
              hashedMessage: new asn1js.OctetString({ valueHex: new Uint8Array(32) }),
            }),
            certReq: true,
          })
            .toSchema()
            .toBER(),
        ),
      ),
    });
    const replay = Buffer.from(await first.arrayBuffer());
    const replaying = (async () => new Response(new Uint8Array(replay))) as unknown as typeof fetch;
    const { level } = await upgradePades(signed, {
      fetch: replaying,
      tsas: [{ url: world.tsaUrl }],
    });
    expect(level).toBe('B-B');
  });

  it('falls back to the CRL when OCSP is down', async () => {
    world.down.add('http://ocsp.test/signerCa');
    try {
      const { pdf, level } = await upgradePades(signed, {
        fetch: world.fetch,
        tsas: [{ url: world.tsaUrl }],
      });
      expect(level).toBe('B-LT');
      const store = await dss(pdf);
      expect(store?.ocsps).toHaveLength(1);
      expect(store?.crls).toHaveLength(2);
    } finally {
      world.down.delete('http://ocsp.test/signerCa');
    }
  });

  it('stays B-T when no revocation data can be had', async () => {
    const all = [
      'http://ocsp.test/signerCa',
      'http://ocsp.test/tsaCa',
      'http://crl.test/root.crl',
      'http://crl.test/signerCa.crl',
      'http://crl.test/tsaCa.crl',
    ];
    for (const u of all) world.down.add(u);
    try {
      const { pdf, level, missing } = await upgradePades(signed, {
        fetch: world.fetch,
        tsas: [{ url: world.tsaUrl }],
      });
      expect(level).toBe('B-T');
      expect(missing.length).toBeGreaterThan(0);
      expect(await dss(pdf)).toBeUndefined();
      expect(timestampToken(signatures(pdf)[0].cms)).toBeDefined();
    } finally {
      for (const u of all) world.down.delete(u);
    }
  });

  it('refuses to go on with a revoked signing certificate', async () => {
    const revoked = createTrustWorld();
    revoked.revoked.add(new crypto.X509Certificate(revoked.signer.der).serialNumber.toUpperCase());
    const pdf = await signWith(revoked, await onePage());
    await expect(
      upgradePades(pdf, { fetch: revoked.fetch, tsas: [{ url: revoked.tsaUrl }] }),
    ).rejects.toMatchObject({
      errorCode: 'AF501001',
      message: expect.stringContaining('revocado'),
    });
  });

  it('adds a document timestamp on request (B-LTA)', async () => {
    const { pdf, level } = await upgradePades(signed, {
      fetch: world.fetch,
      tsas: [{ url: world.tsaUrl }],
      documentTimestamp: true,
    });
    expect(level).toBe('B-LTA');
    const [sig, docTs] = signatures(pdf);
    expect(await pkijsVerify(sig.cms, 0, sig.data)).toBe(true);
    const info = tokenInfo(docTs.cms);
    expect(info.hash).toEqual(crypto.createHash('sha256').update(docTs.data).digest());
    expect(await info.verify(docTs.data)).toBe(true);
    expect(pdf.toString('latin1')).toMatch(
      /\/Type \/DocTimeStamp\s+\/Filter \/Adobe\.PPKLite\s+\/SubFilter \/ETSI\.RFC3161/,
    );
    // Not a signer: Mis documentos lists only the signature.
    expect(await pdfSignatures(pdf)).toHaveLength(1);
  });

  it('keeps the validation data of earlier signatures', async () => {
    const first = (
      await upgradePades(signed, { fetch: world.fetch, tsas: [{ url: world.tsaUrl }] })
    ).pdf;
    const second = (
      await upgradePades(await signWith(world, first), {
        fetch: world.fetch,
        tsas: [{ url: world.tsaUrl }],
      })
    ).pdf;
    const [one, two] = signatures(second);
    expect(await pkijsVerify(one.cms, 0, one.data)).toBe(true);
    expect(await pkijsVerify(two.cms, 0, two.data)).toBe(true);
    const store = await dss(second);
    expect(store?.vriKeys).toHaveLength(2);
    expect(store?.ocsps.length).toBeGreaterThanOrEqual(4);
  });
});
