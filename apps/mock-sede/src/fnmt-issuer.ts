/**
 * The mock's FNMT-like issuing side: checks a PKCS#10 the way a CA does (its signature, with its
 * own key) and issues a personal certificate for that key from the mock client CA, with the
 * subject taken from the request form, as FNMT does (it ignores the request's placeholder
 * subject). The download page gets the certificate as FNMT's does: a certificates-only PKCS#7,
 * gzipped, in base64url (docs/research/fnmt.md §4.3). TEST MATERIAL ONLY.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as asn1js from 'asn1js';
import forge from 'node-forge';
import { loadClientCa } from './identities';
import { issueLeafForKey } from './pki';

const OID_SHA256_WITH_RSA = '1.2.840.113549.1.1.11';
const OID_ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';

export interface CheckedRequest {
  /** DER SubjectPublicKeyInfo of the requester's key. */
  spki: Buffer;
  /** base64url(SHA-256(spki)). */
  publicKeyHash: string;
  keyType: 'rsa' | 'ec';
}

/** Parses and verifies a base64 PKCS#10. Throws with a Spanish message when it isn't valid. */
export function checkCertificateRequest(b64: string): CheckedRequest {
  const der = Buffer.from(b64.replace(/\s/g, ''), 'base64');
  const parsed = asn1js.fromBER(new Uint8Array(der).buffer);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new Error('La petición de certificado no es válida.');
  }
  const [info, algorithm, signature] = parsed.result.valueBlock.value;
  if (
    !(info instanceof asn1js.Sequence) ||
    !(algorithm instanceof asn1js.Sequence) ||
    !(signature instanceof asn1js.BitString)
  ) {
    throw new Error('La petición de certificado no es válida.');
  }
  const spkiNode = info.valueBlock.value[2];
  const oid = algorithm.valueBlock.value[0];
  if (!spkiNode || !(oid instanceof asn1js.ObjectIdentifier)) {
    throw new Error('La petición de certificado no es válida.');
  }
  const algOid = oid.valueBlock.toString();
  if (algOid !== OID_SHA256_WITH_RSA && algOid !== OID_ECDSA_WITH_SHA256) {
    throw new Error('El algoritmo de firma de la petición no está admitido.');
  }
  const spki = Buffer.from(spkiNode.toBER(false));
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const ok = verify(
    'sha256',
    Buffer.from(info.valueBeforeDecodeView),
    key,
    Buffer.from(signature.valueBlock.valueHexView),
  );
  if (!ok) throw new Error('La firma de la petición de certificado no es correcta.');
  return {
    spki,
    publicKeyHash: createHash('sha256').update(spki).digest('base64url'),
    keyType: key.asymmetricKeyType === 'ec' ? 'ec' : 'rsa',
  };
}

export interface IssueOptions {
  spki: Buffer;
  dni: string;
  givenName: string;
  /** Both surnames, space separated. */
  surname: string;
  email?: string;
  now: Date;
}

/** A certificate for the request's key, FNMT style, from the mock client CA (RSA keys only). */
export function issueFromRequest(opts: IssueOptions): Buffer {
  const key = createPublicKey({ key: opts.spki, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa') {
    throw new Error('La sede de pruebas solo emite certificados con claves RSA.');
  }
  const ca = loadClientCa();
  const surname = opts.surname.toLocaleUpperCase('es-ES');
  const givenName = opts.givenName.toLocaleUpperCase('es-ES');
  const leaf = issueLeafForKey({
    issuer: ca.intermediate,
    publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'serialNumber', value: `IDCES-${opts.dni}`, printable: true },
      { name: 'surname', value: surname },
      { name: 'givenName', value: givenName },
      { name: 'CN', value: `${surname} ${givenName} - ${opts.dni}` },
    ],
    notBefore: new Date(opts.now.getTime() - 60_000),
    notAfter: new Date(opts.now.getTime() + 4 * 365 * 86_400_000),
    personal: { email: opts.email },
  });
  return leaf.certDer;
}

/** What FNMT's download page hands to `installCert`: base64url(gzip(PKCS#7 [leaf, chain])). */
export function installCertData(leaf: Buffer): string {
  const ca = loadClientCa();
  const p7 = forge.pkcs7.createSignedData();
  for (const der of [leaf, ca.intermediate.certDer]) {
    p7.addCertificate(forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString('binary'))));
  }
  const bundle = Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
  return gzipSync(bundle).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}
