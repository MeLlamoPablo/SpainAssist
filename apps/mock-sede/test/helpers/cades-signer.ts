/**
 * Minimal CAdES-BES signer for tests: CMS SignedData with content-type, signing-time,
 * message-digest and ESS signing-certificate-v2 signed attributes, RSA PKCS#1 v1.5 + SHA-256,
 * signer certificate and chain embedded. Stands in for AutoFirma in the browser tests.
 */
import { createHash, sign as cryptoSign } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { CMS_OIDS } from '../../src/cades';

export interface CadesSignInput {
  data: Uint8Array;
  certPem: string;
  /** PKCS#8 or PKCS#1 PEM. */
  keyPem: string;
  chainPem?: string[];
  /** Embed the data (AutoFirma "mode=implicit"). Default true. */
  implicit?: boolean;
  /** Add ESS signing-certificate-v2 (CAdES-BES). Default true. */
  signingCertificateV2?: boolean;
  signingTime?: Date;
}

export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'),
  );
}

const SHA256 = '2.16.840.1.101.3.4.2.1';
const SHA256_WITH_RSA = '1.2.840.113549.1.1.11';

export function signCadesBes(input: CadesSignInput): Buffer {
  const certDer = pemToDer(input.certPem);
  const cert = pkijs.Certificate.fromBER(certDer);
  const chain = (input.chainPem ?? []).map((pem) => pkijs.Certificate.fromBER(pemToDer(pem)));

  const attributes = [
    new pkijs.Attribute({
      type: CMS_OIDS.contentType,
      values: [new asn1js.ObjectIdentifier({ value: CMS_OIDS.data })],
    }),
    new pkijs.Attribute({
      type: CMS_OIDS.signingTime,
      values: [new asn1js.UTCTime({ valueDate: input.signingTime ?? new Date() })],
    }),
    new pkijs.Attribute({
      type: CMS_OIDS.messageDigest,
      values: [
        new asn1js.OctetString({ valueHex: createHash('sha256').update(input.data).digest() }),
      ],
    }),
  ];
  if (input.signingCertificateV2 ?? true) {
    // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
    // ESSCertIDv2 ::= SEQUENCE { certHash (sha256 by default), issuerSerial IssuerSerial }
    const issuerSerial = new asn1js.Sequence({
      value: [
        new asn1js.Sequence({
          value: [
            new asn1js.Constructed({
              idBlock: { tagClass: 3, tagNumber: 4 }, // [4] directoryName
              value: [cert.issuer.toSchema()],
            }),
          ],
        }),
        new asn1js.Integer({ valueHex: cert.serialNumber.valueBlock.valueHexView }),
      ],
    });
    attributes.push(
      new pkijs.Attribute({
        type: CMS_OIDS.signingCertificateV2,
        values: [
          new asn1js.Sequence({
            value: [
              new asn1js.Sequence({
                value: [
                  new asn1js.Sequence({
                    value: [
                      new asn1js.OctetString({
                        valueHex: createHash('sha256').update(certDer).digest(),
                      }),
                      issuerSerial,
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
  }

  // The signature covers the DER encoding of the attributes as a SET OF.
  const toBeSigned = new asn1js.Set({ value: attributes.map((a) => a.toSchema()) }).toBER(false);
  const signature = cryptoSign('sha256', Buffer.from(toBeSigned), input.keyPem);

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: SHA256_WITH_RSA,
      algorithmParams: new asn1js.Null(),
    }),
    signature: new asn1js.OctetString({ valueHex: signature }),
  });

  const encapContentInfo = new pkijs.EncapsulatedContentInfo({ eContentType: CMS_OIDS.data });
  if (input.implicit ?? true) {
    // Assigned after construction so it stays a primitive (DER) OCTET STRING, as AutoFirma emits.
    encapContentInfo.eContent = new asn1js.OctetString({ valueHex: input.data });
  }
  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: SHA256 })],
    encapContentInfo,
    certificates: [cert, ...chain],
    signerInfos: [signerInfo],
  });
  const contentInfo = new pkijs.ContentInfo({
    contentType: CMS_OIDS.signedData,
    content: signedData.toSchema(true),
  });
  return Buffer.from(contentInfo.toSchema().toBER(false));
}
