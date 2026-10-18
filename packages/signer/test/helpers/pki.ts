/**
 * Throwaway test PKI: an FNMT-like CA and a "persona física" certificate, for RSA (built with
 * node-forge, an independent X.509/PKCS#12 producer) and EC (built with @peculiar/asn1-x509 and
 * Node's crypto, since node-forge cannot handle EC keys). Never use outside tests.
 */
import crypto, { type KeyObject } from 'node:crypto';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import * as x509 from '@peculiar/asn1-x509';
import forge from 'node-forge';
import { encodeP12 } from '../../src/p12';

export const PASSPHRASE = 'contraseña-1234';

export const HOLDER = {
  givenName: 'JUAN',
  surname: 'ESPAÑOL ESPAÑOL',
  id: '12345678Z',
  cn: 'ESPAÑOL ESPAÑOL JUAN - 12345678Z',
};

/** Policy OID of FNMT "persona física" certificates (used to test signing-certificate policies). */
export const FNMT_POLICY_OID = '1.3.6.1.4.1.5734.3.10.1';

export interface TestIdentity {
  keyType: 'rsa' | 'ec';
  privateKey: KeyObject;
  certDer: Buffer;
  caDer: Buffer;
  caKey: KeyObject;
  /** Leaf first. */
  chain: Buffer[];
  /** Modern PKCS#12 written by @sa/signer (AES-256, SHA-256 MAC). */
  p12: Buffer;
  passphrase: string;
}

function forgeCertToDer(cert: forge.pki.Certificate): Buffer {
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

/** UTF8String attribute (node-forge UTF-8-encodes the value itself). */
function utf8Attr(type: string, value: string): forge.pki.CertificateField {
  return {
    type,
    value,
    valueTagClass: forge.asn1.Type.UTF8 as unknown as forge.asn1.Class,
  } as forge.pki.CertificateField;
}

function forgePoliciesExtension(policyOid: string): { id: string; value: string } {
  const value = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
    forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
      forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer(policyOid).getBytes(),
      ),
    ]),
  ]);
  return { id: '2.5.29.32', value: forge.asn1.toDer(value).getBytes() };
}

function randomSerialHex(): string {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return b.toString('hex');
}

/** RSA CA + FNMT-style user certificate made with node-forge. */
export function createRsaIdentity(): TestIdentity & {
  forgeKey: forge.pki.rsa.PrivateKey;
  forgeCert: forge.pki.Certificate;
  forgeCaCert: forge.pki.Certificate;
} {
  const caPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const userPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = (k: KeyObject) => k.export({ type: 'pkcs8', format: 'pem' }).toString();
  const forgeCaKey = forge.pki.privateKeyFromPem(
    pem(caPair.privateKey),
  ) as forge.pki.rsa.PrivateKey;
  const forgeUserKey = forge.pki.privateKeyFromPem(
    pem(userPair.privateKey),
  ) as forge.pki.rsa.PrivateKey;
  const forgeCaPub = forge.pki.publicKeyFromPem(
    caPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );
  const forgeUserPub = forge.pki.publicKeyFromPem(
    userPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  );

  const now = Date.now();
  const caCert = forge.pki.createCertificate();
  caCert.publicKey = forgeCaPub;
  caCert.serialNumber = randomSerialHex();
  caCert.validity.notBefore = new Date(now - 86400_000);
  caCert.validity.notAfter = new Date(now + 5 * 365 * 86400_000);
  const caAttrs = [
    { shortName: 'C', value: 'ES' },
    { shortName: 'O', value: 'FNMT-RCM PRUEBAS' },
    { shortName: 'OU', value: 'Ceres' },
    { shortName: 'CN', value: 'AC FNMT Usuarios PRUEBAS' },
  ];
  caCert.setSubject(caAttrs);
  caCert.setIssuer(caAttrs);
  caCert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  caCert.sign(forgeCaKey, forge.md.sha256.create());

  const userCert = forge.pki.createCertificate();
  userCert.publicKey = forgeUserPub;
  userCert.serialNumber = randomSerialHex();
  userCert.validity.notBefore = new Date(now - 3600_000);
  userCert.validity.notAfter = new Date(now + 4 * 365 * 86400_000);
  userCert.setSubject([
    { shortName: 'C', value: 'ES' },
    { type: '2.5.4.5', value: `IDCES-${HOLDER.id}` },
    utf8Attr('2.5.4.42', HOLDER.givenName),
    utf8Attr('2.5.4.4', HOLDER.surname),
    utf8Attr('2.5.4.3', HOLDER.cn),
  ]);
  userCert.setIssuer(caAttrs);
  userCert.setExtensions([
    { name: 'basicConstraints', cA: false },
    {
      name: 'keyUsage',
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      critical: true,
    },
    { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
    forgePoliciesExtension(FNMT_POLICY_OID),
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes(),
    },
  ]);
  userCert.sign(forgeCaKey, forge.md.sha256.create());

  const certDer = forgeCertToDer(userCert);
  const caDer = forgeCertToDer(caCert);
  const chain = [certDer, caDer];
  return {
    keyType: 'rsa',
    privateKey: userPair.privateKey,
    certDer,
    caDer,
    caKey: caPair.privateKey,
    chain,
    p12: encodeP12({
      privateKey: userPair.privateKey,
      certificates: chain,
      passphrase: PASSPHRASE,
    }),
    passphrase: PASSPHRASE,
    forgeKey: forgeUserKey,
    forgeCert: userCert,
    forgeCaCert: caCert,
  };
}

/** PKCS#12 written by node-forge (`algorithm`: 'aes256' or legacy '3des'). */
export function forgeP12(
  identity: ReturnType<typeof createRsaIdentity>,
  algorithm: 'aes256' | '3des',
): Buffer {
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    identity.forgeKey,
    [identity.forgeCert, identity.forgeCaCert],
    identity.passphrase,
    { algorithm, friendlyName: 'test' },
  );
  return Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');
}

// ---------------------------------------------------------------------------------------------
// EC (and generic) certificates with @peculiar/asn1-x509
// ---------------------------------------------------------------------------------------------

function attr(type: string, value: string): x509.RelativeDistinguishedName {
  const printable = type === '2.5.4.6' || type === '2.5.4.5';
  return new x509.RelativeDistinguishedName([
    new x509.AttributeTypeAndValue({
      type,
      value: new x509.AttributeValue(
        printable ? { printableString: value } : { utf8String: value },
      ),
    }),
  ]);
}

function signatureAlgorithm(key: KeyObject): { alg: x509.AlgorithmIdentifier; hash: string } {
  if (key.asymmetricKeyType === 'rsa') {
    return {
      alg: new x509.AlgorithmIdentifier({ algorithm: '1.2.840.113549.1.1.11', parameters: null }),
      hash: 'sha256',
    };
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  return curve === 'secp384r1'
    ? { alg: new x509.AlgorithmIdentifier({ algorithm: '1.2.840.10045.4.3.3' }), hash: 'sha384' }
    : { alg: new x509.AlgorithmIdentifier({ algorithm: '1.2.840.10045.4.3.2' }), hash: 'sha256' };
}

function extension(extnID: string, value: unknown, critical = false): x509.Extension {
  return new x509.Extension({
    extnID,
    critical,
    extnValue: new OctetString(AsnConvert.serialize(value)),
  });
}

interface IssueOptions {
  subject: [string, string][];
  publicKey: KeyObject;
  /** Issuer certificate (DER) + its key; omit for a self-signed CA. */
  issuer?: { certDer: Buffer; key: KeyObject };
  signingKey?: KeyObject;
  ca?: boolean;
  notBefore?: Date;
  notAfter?: Date;
  policies?: string[];
  /** Key usage flags of an end-entity certificate (default digitalSignature | nonRepudiation). */
  keyUsage?: number;
  /** Adds qcStatements with QcCompliance and QcSSCD (DNIe FIRMA). */
  qcSscd?: boolean;
}

function issueCertificate(opts: IssueOptions): Buffer {
  const subject = new x509.Name(opts.subject.map(([t, v]) => attr(t, v)));
  const issuerCert = opts.issuer
    ? AsnConvert.parse(opts.issuer.certDer, x509.Certificate)
    : undefined;
  const signingKey = opts.issuer?.key ?? opts.signingKey;
  if (!signingKey) throw new Error('signing key required');
  const { alg, hash } = signatureAlgorithm(signingKey);
  const spki = opts.publicKey.export({ type: 'spki', format: 'der' });
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;
  const keyId = crypto.createHash('sha1').update(spki).digest();
  const extensions = [
    extension(x509.id_ce_basicConstraints, new x509.BasicConstraints({ cA: !!opts.ca }), true),
    extension(
      x509.id_ce_keyUsage,
      new x509.KeyUsage(
        opts.ca
          ? x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign
          : (opts.keyUsage ??
              x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation),
      ),
      true,
    ),
    extension(x509.id_ce_subjectKeyIdentifier, new x509.SubjectKeyIdentifier(keyId)),
  ];
  if (issuerCert) {
    const issuerSpki = AsnConvert.serialize(issuerCert.tbsCertificate.subjectPublicKeyInfo);
    extensions.push(
      extension(
        x509.id_ce_authorityKeyIdentifier,
        new x509.AuthorityKeyIdentifier({
          keyIdentifier: new x509.KeyIdentifier(
            crypto.createHash('sha1').update(Buffer.from(issuerSpki)).digest(),
          ),
        }),
      ),
    );
  }
  if (opts.policies?.length) {
    extensions.push(
      extension(
        x509.id_ce_certificatePolicies,
        new x509.CertificatePolicies(
          opts.policies.map((p) => new x509.PolicyInformation({ policyIdentifier: p })),
        ),
      ),
    );
  }
  if (opts.qcSscd) {
    // SEQUENCE { SEQUENCE { QcCompliance }, SEQUENCE { QcSSCD } }
    const qc = Buffer.from('30143008060604008e4601013008060604008e460104', 'hex');
    extensions.push(
      new x509.Extension({
        extnID: '1.3.6.1.5.5.7.1.3',
        critical: false,
        extnValue: new OctetString(qc),
      }),
    );
  }
  const tbs = new x509.TBSCertificate({
    version: x509.Version.v3,
    serialNumber: serial.buffer.slice(serial.byteOffset, serial.byteOffset + serial.byteLength),
    signature: alg,
    issuer: issuerCert ? issuerCert.tbsCertificate.subject : subject,
    subject,
    validity: new x509.Validity({
      notBefore: opts.notBefore ?? new Date(Date.now() - 3600_000),
      notAfter: opts.notAfter ?? new Date(Date.now() + 3 * 365 * 86400_000),
    }),
    subjectPublicKeyInfo: AsnConvert.parse(spki, x509.SubjectPublicKeyInfo),
    extensions: new x509.Extensions(extensions),
  });
  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const signature = crypto.sign(hash, tbsDer, { key: signingKey, dsaEncoding: 'der' });
  const cert = new x509.Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm: alg,
    signatureValue: signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ),
  });
  return Buffer.from(AsnConvert.serialize(cert));
}

/** EC P-384 CA + EC P-256 "persona física" certificate (FNMT's newer hierarchy style). */
function createEcIdentity(curve: 'P-256' | 'P-384' = 'P-256'): TestIdentity {
  const ca = crypto.generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const user = crypto.generateKeyPairSync('ec', { namedCurve: curve });
  const caDer = issueCertificate({
    subject: [
      ['2.5.4.6', 'ES'],
      ['2.5.4.10', 'FNMT-RCM PRUEBAS'],
      ['2.5.4.11', 'Ceres'],
      ['2.5.4.3', 'AC FNMT Usuarios ECC PRUEBAS'],
    ],
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    ca: true,
  });
  const certDer = issueCertificate({
    subject: [
      ['2.5.4.6', 'ES'],
      ['2.5.4.5', `IDCES-${HOLDER.id}`],
      ['2.5.4.42', HOLDER.givenName],
      ['2.5.4.4', HOLDER.surname],
      ['2.5.4.3', HOLDER.cn],
    ],
    publicKey: user.publicKey,
    issuer: { certDer: caDer, key: ca.privateKey },
    policies: [FNMT_POLICY_OID],
  });
  const chain = [certDer, caDer];
  return {
    keyType: 'ec',
    privateKey: user.privateKey,
    certDer,
    caDer,
    caKey: ca.privateKey,
    chain,
    p12: encodeP12({ privateKey: user.privateKey, certificates: chain, passphrase: PASSPHRASE }),
    passphrase: PASSPHRASE,
  };
}

let rsaCache: ReturnType<typeof createRsaIdentity> | undefined;
let ecCache: TestIdentity | undefined;

/** Shared identities (generated once per test file). */
export function rsaIdentity(): ReturnType<typeof createRsaIdentity> {
  rsaCache ??= createRsaIdentity();
  return rsaCache;
}
export function ecIdentity(): TestIdentity {
  ecCache ??= createEcIdentity();
  return ecCache;
}

/** The DNIe's two certificates and their CA (like `AC DNIE 004`), with their keys. */
export interface DnieTestCard {
  caDer: Buffer;
  firma: { certDer: Buffer; privateKey: KeyObject };
  autenticacion: { certDer: Buffer; privateKey: KeyObject };
}

/**
 * A real-looking DNIe 3.0: FIRMA (nonRepudiation, qualified, QcSSCD) and AUTENTICACIÓN
 * (digitalSignature), issued by "AC DNIE 004, OU=DNIE, O=DIRECCION GENERAL DE LA POLICIA".
 * `expired` makes both certificates expired.
 */
export function createDnieCard(opts: { expired?: boolean } = {}): DnieTestCard {
  const ca = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caDer = issueCertificate({
    subject: [
      ['2.5.4.6', 'ES'],
      ['2.5.4.10', 'DIRECCION GENERAL DE LA POLICIA'],
      ['2.5.4.11', 'DNIE'],
      ['2.5.4.3', 'AC DNIE 004'],
    ],
    publicKey: ca.publicKey,
    signingKey: ca.privateKey,
    ca: true,
    notBefore: new Date(Date.now() - 5 * 365 * 86400_000),
  });
  const validity = opts.expired
    ? {
        notBefore: new Date(Date.now() - 6 * 365 * 86400_000),
        notAfter: new Date(Date.now() - 86400_000),
      }
    : {};
  const holder = (purpose: string): [string, string][] => [
    ['2.5.4.6', 'ES'],
    ['2.5.4.5', HOLDER.id],
    ['2.5.4.4', HOLDER.surname],
    ['2.5.4.42', HOLDER.givenName],
    ['2.5.4.3', `${HOLDER.surname}, ${HOLDER.givenName} (${purpose})`],
  ];
  const issue = (purpose: string, keyUsage: number, extra: Partial<IssueOptions>) => {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      privateKey: pair.privateKey,
      certDer: issueCertificate({
        subject: holder(purpose),
        publicKey: pair.publicKey,
        issuer: { certDer: caDer, key: ca.privateKey },
        keyUsage,
        ...validity,
        ...extra,
      }),
    };
  };
  return {
    caDer,
    firma: issue('FIRMA', x509.KeyUsageFlags.nonRepudiation, {
      policies: ['2.16.724.1.2.2.2.3'],
      qcSscd: true,
    }),
    autenticacion: issue('AUTENTICACIÓN', x509.KeyUsageFlags.digitalSignature, {
      policies: ['2.16.724.1.2.2.2.4'],
    }),
  };
}
