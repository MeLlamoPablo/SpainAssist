/**
 * A small public-key world for long-term signature tests, served by a fake `fetch` (tests never
 * reach real TSAs or CAs): a root, the signer's CA, a TSA under its own CA, OCSP responders
 * (one delegated, with id-pkix-ocsp-nocheck), CRLs and CA-issuers downloads. Answers are built
 * with pkijs, independently of the code under test.
 */
import crypto, { type KeyObject } from 'node:crypto';
import { OctetString } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/asn1-x509';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { extension, issueCertificate } from './pki';

pkijs.setEngine(
  'node',
  new pkijs.CryptoEngine({ name: 'node', crypto: crypto.webcrypto as Crypto }),
);

const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_KP_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
const OID_KP_OCSP_SIGNING = '1.3.6.1.5.5.7.3.9';
const OID_OCSP_NOCHECK = '1.3.6.1.5.5.7.48.1.5';

function ab(buf: Uint8Array): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

interface Party {
  name: string;
  der: Buffer;
  key: KeyObject;
}

function ecKeys() {
  return crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
}

function aia(ocsp?: string, caIssuers?: string): x509.Extension {
  const descriptions: x509.AccessDescription[] = [];
  if (ocsp) {
    descriptions.push(
      new x509.AccessDescription({
        accessMethod: '1.3.6.1.5.5.7.48.1',
        accessLocation: new x509.GeneralName({ uniformResourceIdentifier: ocsp }),
      }),
    );
  }
  if (caIssuers) {
    descriptions.push(
      new x509.AccessDescription({
        accessMethod: '1.3.6.1.5.5.7.48.2',
        accessLocation: new x509.GeneralName({ uniformResourceIdentifier: caIssuers }),
      }),
    );
  }
  return extension(
    x509.id_pe_authorityInfoAccess,
    new x509.AuthorityInfoAccessSyntax(descriptions),
  );
}

function crlPoint(url: string): x509.Extension {
  return extension(
    x509.id_ce_cRLDistributionPoints,
    new x509.CRLDistributionPoints([
      new x509.DistributionPoint({
        distributionPoint: new x509.DistributionPointName({
          fullName: [new x509.GeneralName({ uniformResourceIdentifier: url })],
        }),
      }),
    ]),
  );
}

function eku(...usages: string[]): x509.Extension {
  return extension(x509.id_ce_extKeyUsage, new x509.ExtendedKeyUsage(usages), true);
}

async function webKey(key: KeyObject): Promise<CryptoKey> {
  const der = key.export({ type: 'pkcs8', format: 'der' });
  const algorithm =
    key.asymmetricKeyType === 'ec'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const imported = await crypto.webcrypto.subtle.importKey('pkcs8', der, algorithm, false, [
    'sign',
  ]);
  return imported as unknown as CryptoKey;
}

function pkiCert(der: Buffer): pkijs.Certificate {
  return pkijs.Certificate.fromBER(ab(der));
}

export interface TrustWorldOptions {
  /** Signer's leaf key type (default RSA, as most Spanish certificates). */
  signerKey?: 'rsa' | 'ec';
}

export interface TrustWorld {
  root: Party;
  signerCa: Party;
  tsaCa: Party;
  tsa: Party;
  responder: Party;
  signer: Party;
  tsaUrl: string;
  fetch: typeof fetch;
  /** Every URL requested, in order. */
  calls: string[];
  /** Serial numbers (hex) to report as revoked. */
  revoked: Set<string>;
  /** URLs that answer HTTP 503. */
  down: Set<string>;
  /** Shifts the TSA's clock (ms). */
  tsaClockOffset: number;
}

function serialHex(der: Buffer): string {
  return new crypto.X509Certificate(der).serialNumber.toUpperCase();
}

export function createTrustWorld(o: TrustWorldOptions = {}): TrustWorld {
  const rootKeys = ecKeys();
  const root: Party = {
    name: 'root',
    key: rootKeys.privateKey,
    der: issueCertificate({
      subject: [
        ['2.5.4.6', 'ES'],
        ['2.5.4.10', 'Pruebas de confianza'],
        ['2.5.4.3', 'Raíz de pruebas'],
      ],
      publicKey: rootKeys.publicKey,
      signingKey: rootKeys.privateKey,
      ca: true,
    }),
  };
  const subCa = (name: string, cn: string): Party => {
    const keys = ecKeys();
    return {
      name,
      key: keys.privateKey,
      der: issueCertificate({
        subject: [
          ['2.5.4.6', 'ES'],
          ['2.5.4.10', 'Pruebas de confianza'],
          ['2.5.4.3', cn],
        ],
        publicKey: keys.publicKey,
        issuer: { certDer: root.der, key: root.key },
        ca: true,
        extensions: [
          aia(undefined, 'http://ca.test/root.cer'),
          crlPoint('http://crl.test/root.crl'),
        ],
      }),
    };
  };
  const signerCa = subCa('signerCa', 'AC Usuarios de pruebas');
  const tsaCa = subCa('tsaCa', 'AC Sellado de pruebas');

  const signerKeys =
    o.signerKey === 'ec' ? ecKeys() : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const signer: Party = {
    name: 'signer',
    key: signerKeys.privateKey,
    der: issueCertificate({
      subject: [
        ['2.5.4.6', 'ES'],
        ['2.5.4.5', 'IDCES-99999999R'],
        ['2.5.4.42', 'CARMEN'],
        ['2.5.4.4', 'ESPAÑOLA ESPAÑOLA'],
        ['2.5.4.3', 'ESPAÑOLA ESPAÑOLA CARMEN - 99999999R'],
      ],
      publicKey: signerKeys.publicKey,
      issuer: { certDer: signerCa.der, key: signerCa.key },
      extensions: [
        aia('http://ocsp.test/signerCa', 'http://ca.test/signerCa.cer'),
        crlPoint('http://crl.test/signerCa.crl'),
      ],
    }),
  };
  const tsaKeys = ecKeys();
  const tsa: Party = {
    name: 'tsa',
    key: tsaKeys.privateKey,
    der: issueCertificate({
      subject: [
        ['2.5.4.6', 'ES'],
        ['2.5.4.10', 'Pruebas de confianza'],
        ['2.5.4.3', 'Sellos de tiempo de pruebas'],
      ],
      publicKey: tsaKeys.publicKey,
      issuer: { certDer: tsaCa.der, key: tsaCa.key },
      keyUsage: x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation,
      extensions: [
        eku(OID_KP_TIME_STAMPING),
        aia('http://ocsp.test/tsaCa', 'http://ca.test/tsaCa.cer'),
        crlPoint('http://crl.test/tsaCa.crl'),
      ],
    }),
  };
  const responderKeys = ecKeys();
  const responder: Party = {
    name: 'responder',
    key: responderKeys.privateKey,
    der: issueCertificate({
      subject: [
        ['2.5.4.6', 'ES'],
        ['2.5.4.3', 'OCSP de AC Sellado de pruebas'],
      ],
      publicKey: responderKeys.publicKey,
      issuer: { certDer: tsaCa.der, key: tsaCa.key },
      keyUsage: x509.KeyUsageFlags.digitalSignature,
      extensions: [
        eku(OID_KP_OCSP_SIGNING),
        // id-pkix-ocsp-nocheck: an ASN.1 NULL.
        new x509.Extension({
          extnID: OID_OCSP_NOCHECK,
          critical: false,
          extnValue: new OctetString(new Uint8Array([5, 0])),
        }),
      ],
    }),
  };

  const cas: Record<string, Party> = { root, signerCa, tsaCa };
  const world: TrustWorld = {
    root,
    signerCa,
    tsaCa,
    tsa,
    responder,
    signer,
    tsaUrl: 'http://tsa.test/tsr',
    calls: [],
    revoked: new Set(),
    down: new Set(),
    tsaClockOffset: 0,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      world.calls.push(url);
      if (world.down.has(url)) return new Response('down', { status: 503 });
      const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
      const reply = (data: ArrayBuffer | Buffer) =>
        new Response(new Uint8Array(data instanceof ArrayBuffer ? data : ab(data)), {
          status: 200,
        });
      let m = /^http:\/\/ca\.test\/(\w+)\.cer$/.exec(url);
      if (m && cas[m[1]]) return reply(cas[m[1]].der);
      m = /^http:\/\/crl\.test\/(\w+)\.crl$/.exec(url);
      if (m && cas[m[1]]) return reply(await crlOf(world, cas[m[1]]));
      m = /^http:\/\/ocsp\.test\/(\w+)$/.exec(url);
      if (m && cas[m[1]]) {
        const delegated = m[1] === 'tsaCa' ? responder : undefined;
        return reply(await ocspAnswer(world, body, cas[m[1]], delegated));
      }
      if (url === world.tsaUrl) return reply(await timestampAnswer(world, body));
      return new Response('not found', { status: 404 });
    }) as typeof fetch,
  };
  return world;
}

async function crlOf(world: TrustWorld, ca: Party): Promise<ArrayBuffer> {
  const now = new Date();
  const issuer = pkiCert(ca.der);
  const revoked = [world.signer, world.signerCa, world.tsaCa, world.tsa]
    .filter((p) => world.revoked.has(serialHex(p.der)))
    .filter((p) =>
      new crypto.X509Certificate(p.der).checkIssued(new crypto.X509Certificate(ca.der)),
    )
    .map(
      (p) =>
        new pkijs.RevokedCertificate({
          userCertificate: pkiCert(p.der).serialNumber,
          revocationDate: new pkijs.Time({ type: 1, value: now }),
        }),
    );
  const crl = new pkijs.CertificateRevocationList({
    version: 1,
    issuer: issuer.subject,
    thisUpdate: new pkijs.Time({ type: 0, value: new Date(now.getTime() - 3600_000) }),
    nextUpdate: new pkijs.Time({ type: 0, value: new Date(now.getTime() + 86400_000) }),
    ...(revoked.length ? { revokedCertificates: revoked } : {}),
  });
  await crl.sign(await webKey(ca.key), 'SHA-256');
  return crl.toSchema().toBER();
}

async function ocspAnswer(
  world: TrustWorld,
  body: Buffer,
  ca: Party,
  delegated?: Party,
): Promise<ArrayBuffer> {
  const now = new Date();
  const request = pkijs.OCSPRequest.fromBER(ab(body));
  const responses = request.tbsRequest.requestList.map((r) => {
    const serial = Buffer.from(r.reqCert.serialNumber.valueBlock.valueHexView)
      .toString('hex')
      .toUpperCase()
      .replace(/^0+(?=.)/, '');
    const isRevoked = [...world.revoked].some((s) => s.replace(/^0+(?=.)/, '') === serial);
    return new pkijs.SingleResponse({
      certID: r.reqCert,
      certStatus: isRevoked
        ? new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 1 },
            value: [new asn1js.GeneralizedTime({ valueDate: now })],
          })
        : new asn1js.Primitive({ idBlock: { tagClass: 3, tagNumber: 0 } }),
      thisUpdate: now,
      nextUpdate: new Date(now.getTime() + 86400_000),
    });
  });
  const signerParty = delegated ?? ca;
  const basic = new pkijs.BasicOCSPResponse({
    tbsResponseData: new pkijs.ResponseData({
      responderID: pkiCert(signerParty.der).subject,
      producedAt: now,
      responses,
    }),
    ...(delegated ? { certs: [pkiCert(delegated.der)] } : {}),
  });
  await basic.sign(await webKey(signerParty.key), 'SHA-256');
  const response = new pkijs.OCSPResponse({
    responseStatus: new asn1js.Enumerated({ value: 0 }),
    responseBytes: new pkijs.ResponseBytes({
      responseType: '1.3.6.1.5.5.7.48.1.1',
      response: new asn1js.OctetString({ valueHex: basic.toSchema().toBER() }),
    }),
  });
  return response.toSchema().toBER();
}

let tsaSerial = 1;

async function timestampAnswer(world: TrustWorld, body: Buffer): Promise<ArrayBuffer> {
  const request = pkijs.TimeStampReq.fromBER(ab(body));
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: '1.3.6.1.4.1.99999.1',
    messageImprint: request.messageImprint,
    serialNumber: new asn1js.Integer({ value: tsaSerial++ }),
    genTime: new Date(Date.now() + world.tsaClockOffset),
    ...(request.nonce ? { nonce: request.nonce } : {}),
  });
  const content = tst.toSchema().toBER();
  const tsaCert = pkiCert(world.tsa.der);
  const digest = crypto.createHash('sha256').update(Buffer.from(content)).digest();
  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new asn1js.OctetString({ valueHex: content }),
    }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({
          issuer: tsaCert.issuer,
          serialNumber: tsaCert.serialNumber,
        }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.3',
              values: [new asn1js.ObjectIdentifier({ value: OID_TST_INFO })],
            }),
            new pkijs.Attribute({
              type: '1.2.840.113549.1.9.4',
              values: [new asn1js.OctetString({ valueHex: digest })],
            }),
          ],
        }),
      }),
    ],
    ...(request.certReq ? { certificates: [tsaCert, pkiCert(world.tsaCa.der)] } : {}),
  });
  await signedData.sign(await webKey(world.tsa.key), 0, 'SHA-256');
  // pkijs writes eContent as a constructed OCTET STRING; TSAs (and validators) use the
  // primitive form. The signature covers the attributes, so re-encoding it changes nothing.
  signedData.encapContentInfo.toSchema = () =>
    new asn1js.Sequence({
      value: [
        new asn1js.ObjectIdentifier({ value: OID_TST_INFO }),
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 0 },
          value: [new asn1js.OctetString({ valueHex: content })],
        }),
      ],
    });
  const response = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: 0 }),
    timeStampToken: new pkijs.ContentInfo({
      contentType: '1.2.840.113549.1.7.2',
      content: signedData.toSchema(true),
    }),
  });
  return response.toSchema().toBER();
}
