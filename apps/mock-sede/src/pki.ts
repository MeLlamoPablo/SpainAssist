/**
 * Small PKI toolkit for the mock sede: CAs, TLS server certificates, FNMT-style personal
 * certificates and PKCS#12 export (modern AES, 3DES, and legacy RC2-40 that OpenSSL 3 rejects).
 *
 * RSA keys are generated with node:crypto (fast, native) and handled with node-forge for
 * certificate building and PKCS#12 encoding. Everything here is TEST MATERIAL ONLY.
 */
import { createHash, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import forge from 'node-forge';

const { pki, asn1 } = forge;

interface DnAttribute {
  /** forge short name (CN, C, O, OU...) or long name (serialNumber, surname, givenName). */
  name: string;
  value: string;
  /** Encode as PrintableString instead of UTF8String (C and serialNumber, as FNMT does). */
  printable?: boolean;
}

export interface CertAndKey {
  cert: forge.pki.Certificate;
  key: forge.pki.rsa.PrivateKey;
  certPem: string;
  /** PKCS#8 PEM. */
  keyPem: string;
  certDer: Buffer;
}

const SHORT_NAMES = new Set(['CN', 'C', 'O', 'OU', 'L', 'ST', 'E']);

function toForgeAttrs(attrs: DnAttribute[]): forge.pki.CertificateField[] {
  return attrs.map((a) => {
    const field: forge.pki.CertificateField = SHORT_NAMES.has(a.name)
      ? { shortName: a.name, value: a.value }
      : { name: a.name, value: a.value };
    if (!a.printable) {
      // forge's typings declare valueTagClass as asn1.Class, but it is a universal tag (asn1.Type).
      field.valueTagClass = asn1.Type.UTF8 as unknown as forge.asn1.Class;
    }
    return field;
  });
}

function randomSerialHex(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 0x10; // positive, no leading zero byte
  return bytes.toString('hex');
}

/** forge emits CRLF line endings; normalize to LF. */
function certToPem(cert: forge.pki.Certificate): string {
  return pki.certificateToPem(cert).replace(/\r\n/g, '\n');
}

function certToDer(cert: forge.pki.Certificate): Buffer {
  return Buffer.from(asn1.toDer(pki.certificateToAsn1(cert)).getBytes(), 'binary');
}

function finish(cert: forge.pki.Certificate, key: forge.pki.rsa.PrivateKey, keyPem: string) {
  return {
    cert,
    key,
    certPem: certToPem(cert),
    keyPem,
    certDer: certToDer(cert),
  } satisfies CertAndKey;
}

function newRsaKey(bits = 2048): {
  key: forge.pki.rsa.PrivateKey;
  publicKey: forge.pki.rsa.PublicKey;
  keyPem: string;
} {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: bits,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const key = pki.privateKeyFromPem(privateKey);
  return { key, publicKey: pki.setRsaPublicKey(key.n, key.e), keyPem: privateKey };
}

export function loadCertAndKey(certPem: string, keyPem: string): CertAndKey {
  const cert = pki.certificateFromPem(certPem);
  const key = pki.privateKeyFromPem(keyPem);
  return finish(cert, key, keyPem);
}

function daysFromNow(days: number, from = new Date()): Date {
  return new Date(from.getTime() + days * 86_400_000);
}

export interface CaOptions {
  subject: DnAttribute[];
  /** Issuer CA; omit for a self-signed root. */
  issuer?: CertAndKey;
  validDays: number;
  pathLength?: number;
}

/** Creates a CA certificate (self-signed root, or intermediate when `issuer` is given). */
export function createCa(opts: CaOptions): CertAndKey {
  const { key, publicKey, keyPem } = newRsaKey();
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = daysFromNow(-1);
  cert.validity.notAfter = daysFromNow(opts.validDays);
  const subject = toForgeAttrs(opts.subject);
  cert.setSubject(subject);
  cert.setIssuer(opts.issuer ? opts.issuer.cert.subject.attributes : subject);
  const extensions: unknown[] = [
    {
      name: 'basicConstraints',
      cA: true,
      critical: true,
      ...(opts.pathLength !== undefined ? { pathLenConstraint: opts.pathLength } : {}),
    },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ];
  if (opts.issuer) {
    extensions.push({
      name: 'authorityKeyIdentifier',
      keyIdentifier: opts.issuer.cert.generateSubjectKeyIdentifier().getBytes(),
    });
  }
  cert.setExtensions(extensions as forge.pki.CertificateField[]);
  cert.sign(opts.issuer?.key ?? key, forge.md.sha256.create());
  return finish(cert, key, keyPem);
}

export interface LeafOptions {
  issuer: CertAndKey;
  subject: DnAttribute[];
  notBefore?: Date;
  notAfter?: Date;
  /** TLS server: DNS names and IPs for subjectAltName. */
  server?: { dnsNames: string[]; ips: string[] };
  /** Personal certificate (TLS client auth + signature), FNMT style. */
  personal?: { email?: string };
}

/** Issues an end-entity certificate signed by `issuer`. */
export function issueLeaf(opts: LeafOptions): CertAndKey {
  const { key, publicKey, keyPem } = newRsaKey();
  const cert = pki.createCertificate();
  cert.publicKey = publicKey;
  cert.serialNumber = randomSerialHex();
  cert.validity.notBefore = opts.notBefore ?? daysFromNow(-1);
  cert.validity.notAfter = opts.notAfter ?? daysFromNow(365);
  cert.setSubject(toForgeAttrs(opts.subject));
  cert.setIssuer(opts.issuer.cert.subject.attributes);
  const extensions: unknown[] = [
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'subjectKeyIdentifier' },
    {
      name: 'authorityKeyIdentifier',
      keyIdentifier: opts.issuer.cert.generateSubjectKeyIdentifier().getBytes(),
    },
  ];
  if (opts.server) {
    extensions.push(
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...opts.server.dnsNames.map((value) => ({ type: 2, value })),
          ...opts.server.ips.map((ip) => ({ type: 7, ip })),
        ],
      },
    );
  }
  if (opts.personal) {
    extensions.push(
      {
        name: 'keyUsage',
        digitalSignature: true,
        nonRepudiation: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: 'extKeyUsage', clientAuth: true, emailProtection: true },
    );
    if (opts.personal.email) {
      extensions.push({
        name: 'subjectAltName',
        altNames: [{ type: 1, value: opts.personal.email }],
      });
    }
  }
  cert.setExtensions(extensions as forge.pki.CertificateField[]);
  cert.sign(opts.issuer.key, forge.md.sha256.create());
  return finish(cert, key, keyPem);
}

/** TLS server PKI for the sede: a throwaway root plus a leaf for localhost / 127.0.0.1 / ::1. */
export interface ServerPki {
  ca: CertAndKey;
  server: CertAndKey;
}

export function createServerCa(): CertAndKey {
  return createCa({
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'O', value: 'SpainAssist pruebas' },
      { name: 'CN', value: 'Mock Sede TLS CA (solo pruebas)' },
    ],
    validDays: 3650,
    pathLength: 0,
  });
}

export function issueServerCert(ca: CertAndKey): CertAndKey {
  return issueLeaf({
    issuer: ca,
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'O', value: 'SpainAssist pruebas' },
      { name: 'CN', value: 'localhost' },
    ],
    notAfter: daysFromNow(365),
    server: { dnsNames: ['localhost'], ips: ['127.0.0.1', '::1'] },
  });
}

/** True while a certificate is inside its validity window (with a one-day safety margin). */
export function stillValid(cert: forge.pki.Certificate, now = new Date()): boolean {
  return (
    cert.validity.notBefore.getTime() <= now.getTime() &&
    cert.validity.notAfter.getTime() > now.getTime() + 86_400_000
  );
}

/** Base64 SHA-256 of the certificate's SubjectPublicKeyInfo (Chromium's SPKI pin format). */
export function spkiSha256Base64(certPem: string): string {
  const spki = createPublicKey(certPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

// ---------------------------------------------------------------------------------------------
// PKCS#12
// ---------------------------------------------------------------------------------------------

export type P12Encryption = 'aes256' | '3des' | 'legacy-rc2-40';

export interface P12Options {
  key: forge.pki.rsa.PrivateKey;
  /** Leaf first, then the chain. */
  certs: forge.pki.Certificate[];
  passphrase: string;
  encryption: P12Encryption;
  friendlyName?: string;
}

export function exportP12(opts: P12Options): Buffer {
  if (opts.encryption === 'legacy-rc2-40') return exportLegacyP12(opts);
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(opts.key, opts.certs, opts.passphrase, {
    algorithm: opts.encryption,
    count: 2048,
    ...(opts.friendlyName ? { friendlyName: opts.friendlyName } : {}),
  });
  return Buffer.from(asn1.toDer(p12Asn1).getBytes(), 'binary');
}

const { Class, Type } = asn1;
const seq = (value: forge.asn1.Asn1[]) => asn1.create(Class.UNIVERSAL, Type.SEQUENCE, true, value);
const set = (value: forge.asn1.Asn1[]) => asn1.create(Class.UNIVERSAL, Type.SET, true, value);
const oid = (name: string) =>
  asn1.create(Class.UNIVERSAL, Type.OID, false, asn1.oidToDer(pki.oids[name]!).getBytes());
const octets = (bytes: string) => asn1.create(Class.UNIVERSAL, Type.OCTETSTRING, false, bytes);
const integer = (n: number) =>
  asn1.create(Class.UNIVERSAL, Type.INTEGER, false, asn1.integerToDer(n).getBytes());
const explicit0 = (value: forge.asn1.Asn1[]) => asn1.create(Class.CONTEXT_SPECIFIC, 0, true, value);

/**
 * Classic "openssl pkcs12 -export -legacy" layout: certificates in an EncryptedData encrypted
 * with pbeWithSHAAnd40BitRC2-CBC, key in a pkcs8ShroudedKeyBag with
 * pbeWithSHAAnd3-KeyTripleDES-CBC, HMAC-SHA1 MAC. Node/OpenSSL 3 refuse these files without the
 * legacy provider; forge, Windows, macOS and Electron (BoringSSL) read them fine.
 */
function exportLegacyP12(opts: P12Options): Buffer {
  const count = 2048;
  const leafDer = asn1.toDer(pki.certificateToAsn1(opts.certs[0]!)).getBytes();
  const localKeyId = forge.md.sha1.create().update(leafDer).digest().getBytes();
  const bagAttrs: forge.asn1.Asn1[] = [seq([oid('localKeyId'), set([octets(localKeyId)])])];
  if (opts.friendlyName) {
    bagAttrs.push(
      seq([
        oid('friendlyName'),
        set([asn1.create(Class.UNIVERSAL, Type.BMPSTRING, false, opts.friendlyName)]),
      ]),
    );
  }

  const certBags = opts.certs.map((cert, i) => {
    const bag: forge.asn1.Asn1[] = [
      oid('certBag'),
      explicit0([
        seq([
          oid('x509Certificate'),
          explicit0([octets(asn1.toDer(pki.certificateToAsn1(cert)).getBytes())]),
        ]),
      ]),
    ];
    if (i === 0) bag.push(set(bagAttrs));
    return seq(bag);
  });
  const certSafeContents = asn1.toDer(seq(certBags)).getBytes();

  // RC2-40-CBC with the PKCS#12 KDF (id 1 = key, id 2 = IV).
  const salt = forge.random.getBytesSync(8);
  const rc2Key = forge.pkcs12.generateKey(
    opts.passphrase,
    forge.util.createBuffer(salt),
    1,
    count,
    5,
  );
  const rc2Iv = forge.pkcs12.generateKey(
    opts.passphrase,
    forge.util.createBuffer(salt),
    2,
    count,
    8,
  );
  const cipher = forge.rc2.createEncryptionCipher(rc2Key, 40);
  cipher.start(rc2Iv);
  cipher.update(forge.util.createBuffer(certSafeContents));
  cipher.finish();
  const encryptedCerts = cipher.output.getBytes();

  const encryptedDataCi = seq([
    oid('encryptedData'),
    explicit0([
      seq([
        integer(0),
        seq([
          oid('data'),
          seq([oid('pbewithSHAAnd40BitRC2-CBC'), seq([octets(salt), integer(count)])]),
          asn1.create(Class.CONTEXT_SPECIFIC, 0, false, encryptedCerts),
        ]),
      ]),
    ]),
  ]);

  const shroudedKey = pki.encryptPrivateKeyInfo(
    pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(opts.key)),
    opts.passphrase,
    { algorithm: '3des', count, saltSize: 8 },
  );
  const keySafeContents = seq([
    seq([oid('pkcs8ShroudedKeyBag'), explicit0([shroudedKey]), set(bagAttrs)]),
  ]);
  const keyCi = seq([oid('data'), explicit0([octets(asn1.toDer(keySafeContents).getBytes())])]);

  const authSafeDer = asn1.toDer(seq([encryptedDataCi, keyCi])).getBytes();

  const macSalt = forge.random.getBytesSync(8);
  const macKey = forge.pkcs12.generateKey(
    opts.passphrase,
    forge.util.createBuffer(macSalt),
    3,
    count,
    20,
  );
  const hmac = forge.hmac.create();
  hmac.start('sha1', macKey);
  hmac.update(authSafeDer);
  const macData = seq([
    seq([
      seq([oid('sha1'), asn1.create(Class.UNIVERSAL, Type.NULL, false, '')]),
      octets(hmac.digest().getBytes()),
    ]),
    octets(macSalt),
    integer(count),
  ]);

  const pfx = seq([integer(3), seq([oid('data'), explicit0([octets(authSafeDer)])]), macData]);
  return Buffer.from(asn1.toDer(pfx).getBytes(), 'binary');
}

export interface P12Contents {
  /** Leaf certificate (PEM). */
  certPem: string;
  /** PKCS#8 PEM of the private key. */
  keyPem: string;
  certDer: Buffer;
  /** CA certificates found in the file (PEM), leaf excluded. */
  chainPem: string[];
}

/**
 * Reads a PKCS#12 with node-forge (works for AES, 3DES and legacy RC2-40 files alike).
 * Throws on a wrong passphrase.
 */
export function readP12(p12: Buffer | Uint8Array, passphrase: string): P12Contents {
  const der = Buffer.from(p12).toString('binary');
  const pfx = forge.pkcs12.pkcs12FromAsn1(asn1.fromDer(der), passphrase);
  const keyBag =
    pfx.getBags({ bagType: pki.oids.pkcs8ShroudedKeyBag! })[pki.oids.pkcs8ShroudedKeyBag!]?.[0] ??
    pfx.getBags({ bagType: pki.oids.keyBag! })[pki.oids.keyBag!]?.[0];
  if (!keyBag?.key) throw new Error('The PKCS#12 file has no private key');
  const certs = (pfx.getBags({ bagType: pki.oids.certBag! })[pki.oids.certBag!] ?? [])
    .map((b) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  const isCa = (c: forge.pki.Certificate) =>
    Boolean((c.getExtension('basicConstraints') as { cA?: boolean } | undefined)?.cA);
  const leaf = certs.find((c) => !isCa(c)) ?? certs[0];
  if (!leaf) throw new Error('The PKCS#12 file has no certificate');
  const keyPem = pki
    .privateKeyInfoToPem(
      pki.wrapRsaPrivateKey(pki.privateKeyToAsn1(keyBag.key as forge.pki.rsa.PrivateKey)),
    )
    .replace(/\r\n/g, '\n');
  return {
    certPem: certToPem(leaf),
    keyPem,
    certDer: certToDer(leaf),
    chainPem: certs.filter((c) => c !== leaf).map((c) => certToPem(c)),
  };
}
