/**
 * Test identities: FNMT-style personal certificates issued by the mock client CA.
 *
 * The client CA (root + "usuarios" intermediate) is committed under `fixtures/client-ca/` so that
 * every mock sede instance trusts the same issuer and `fixtures/demo-identity.p12` keeps working
 * across runs. It is a throwaway test CA: never trust it anywhere else.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type forge from 'node-forge';
import {
  type CertAndKey,
  createCa,
  exportP12,
  issueLeaf,
  loadCertAndKey,
  type P12Encryption,
  readP12,
} from './pki';
import { normalizeDocumentId, validateDocumentId } from './validation';

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export const FIXTURE_PATHS = {
  dir: FIXTURES_DIR,
  clientCaRootCert: `${FIXTURES_DIR}client-ca/root.crt.pem`,
  clientCaRootKey: `${FIXTURES_DIR}client-ca/root.key.pem`,
  clientCaIntermediateCert: `${FIXTURES_DIR}client-ca/intermediate.crt.pem`,
  clientCaIntermediateKey: `${FIXTURES_DIR}client-ca/intermediate.key.pem`,
  demoIdentityP12: `${FIXTURES_DIR}demo-identity.p12`,
  demoIdentityCert: `${FIXTURES_DIR}demo-identity.crt.pem`,
} as const;

/** The demo person used across the mock sede (Cl@ve user and certificate holder). */
export const DEMO_PERSON = {
  dni: '99999999R',
  givenName: 'CARMEN',
  surname1: 'ESPAÑOLA',
  surname2: 'ESPAÑOLA',
} as const;

/** Password of `fixtures/demo-identity.p12`. */
export const DEMO_IDENTITY_PASSPHRASE = '1234';

const CLIENT_CA_ORGANIZATION = 'MOCK-FNMT (entorno de pruebas)';

export interface ClientCa {
  root: CertAndKey;
  intermediate: CertAndKey;
  /** PEMs a TLS server / verifier should trust: [intermediate, root]. */
  trustedPems: string[];
}

/** Generates a brand new client CA (used by `scripts/generate-fixtures.ts`). */
export function generateClientCa(): ClientCa {
  const root = createCa({
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'O', value: CLIENT_CA_ORGANIZATION },
      { name: 'OU', value: 'AC RAIZ MOCK' },
      { name: 'CN', value: 'AC RAIZ MOCK-FNMT' },
    ],
    validDays: 20 * 365,
  });
  const intermediate = createCa({
    issuer: root,
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'O', value: CLIENT_CA_ORGANIZATION },
      { name: 'OU', value: 'Ceres MOCK' },
      { name: 'CN', value: 'AC MOCK-FNMT Usuarios' },
    ],
    validDays: 18 * 365,
    pathLength: 0,
  });
  return { root, intermediate, trustedPems: [intermediate.certPem, root.certPem] };
}

let cachedClientCa: ClientCa | undefined;

/** The committed mock client CA ("FNMT-like"). */
export function loadClientCa(): ClientCa {
  if (!cachedClientCa) {
    const root = loadCertAndKey(
      readFileSync(FIXTURE_PATHS.clientCaRootCert, 'utf8'),
      readFileSync(FIXTURE_PATHS.clientCaRootKey, 'utf8'),
    );
    const intermediate = loadCertAndKey(
      readFileSync(FIXTURE_PATHS.clientCaIntermediateCert, 'utf8'),
      readFileSync(FIXTURE_PATHS.clientCaIntermediateKey, 'utf8'),
    );
    cachedClientCa = { root, intermediate, trustedPems: [intermediate.certPem, root.certPem] };
  }
  return cachedClientCa;
}

export interface TestIdentityOptions {
  givenName: string;
  surname1: string;
  surname2?: string;
  /** DNI or NIE with a valid check letter, e.g. "12345678Z" or "X1234567L". */
  dni: string;
  passphrase: string;
  /**
   * RC2-40 certificates + 3DES key, like old Windows/Firefox exports. Node (OpenSSL 3) rejects
   * these files; the app must convert them (e.g. with node-forge).
   */
  legacyEncryption?: boolean;
  /** Encryption for non-legacy files. Default "aes256" (PBES2); "3des" imports everywhere. */
  encryption?: 'aes256' | '3des';
  email?: string;
  notBefore?: Date;
  notAfter?: Date;
  /** "untrusted": issued by a throwaway CA the sede does not trust (negative tests). */
  issuer?: 'mock' | 'untrusted';
  friendlyName?: string;
}

export interface TestIdentity {
  /** PKCS#12 bytes (leaf + intermediate + root, private key). */
  p12: Buffer;
  passphrase: string;
  encryption: P12Encryption;
  certPem: string;
  /** PKCS#8 PEM of the private key (test material). */
  keyPem: string;
  certDer: Buffer;
  /** Issuer chain PEMs: [intermediate, root]. */
  chainPem: string[];
  dni: string;
  givenName: string;
  /** Both surnames, space separated (X.509 `surname`). */
  surname: string;
  commonName: string;
  /** X.509 serialNumber attribute, e.g. "IDCES-12345678Z". */
  serialNumber: string;
}

const upper = (s: string) => s.trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-ES');

/** Issues a personal certificate with an FNMT-style subject and exports it as `.p12`. */
export function createTestIdentity(opts: TestIdentityOptions): TestIdentity {
  const dni = normalizeDocumentId(opts.dni);
  const problem = validateDocumentId(dni);
  if (problem) throw new Error(`createTestIdentity: invalid DNI/NIE "${opts.dni}": ${problem}`);
  const givenName = upper(opts.givenName);
  const surname = [opts.surname1, opts.surname2]
    .filter(Boolean)
    .map((s) => upper(s!))
    .join(' ');
  const commonName = `${surname} ${givenName} - ${dni}`;
  const serialNumber = `IDCES-${dni}`;

  const ca = opts.issuer === 'untrusted' ? untrustedCa() : loadClientCa();
  const leaf = issueLeaf({
    issuer: ca.intermediate,
    subject: [
      { name: 'C', value: 'ES', printable: true },
      { name: 'serialNumber', value: serialNumber, printable: true },
      { name: 'surname', value: surname },
      { name: 'givenName', value: givenName },
      { name: 'CN', value: commonName },
    ],
    notBefore: opts.notBefore,
    notAfter: opts.notAfter ?? new Date(Date.now() + 4 * 365 * 86_400_000),
    personal: { email: opts.email },
  });
  const encryption: P12Encryption = opts.legacyEncryption
    ? 'legacy-rc2-40'
    : (opts.encryption ?? 'aes256');
  const certs: forge.pki.Certificate[] = [leaf.cert, ca.intermediate.cert, ca.root.cert];
  const p12 = exportP12({
    key: leaf.key,
    certs,
    passphrase: opts.passphrase,
    encryption,
    friendlyName: opts.friendlyName ?? commonName,
  });
  return {
    p12,
    passphrase: opts.passphrase,
    encryption,
    certPem: leaf.certPem,
    keyPem: leaf.keyPem,
    certDer: leaf.certDer,
    chainPem: [ca.intermediate.certPem, ca.root.certPem],
    dni,
    givenName,
    surname,
    commonName,
    serialNumber,
  };
}

let cachedUntrusted: ClientCa | undefined;
function untrustedCa(): ClientCa {
  if (!cachedUntrusted) {
    const root = createCa({
      subject: [
        { name: 'C', value: 'ES', printable: true },
        { name: 'O', value: 'Autoridad desconocida (pruebas)' },
        { name: 'CN', value: 'AC RAIZ DESCONOCIDA' },
      ],
      validDays: 3650,
    });
    const intermediate = createCa({
      issuer: root,
      subject: [
        { name: 'C', value: 'ES', printable: true },
        { name: 'O', value: 'Autoridad desconocida (pruebas)' },
        { name: 'CN', value: 'AC DESCONOCIDA Usuarios' },
      ],
      validDays: 3650,
      pathLength: 0,
    });
    cachedUntrusted = { root, intermediate, trustedPems: [intermediate.certPem, root.certPem] };
  }
  return cachedUntrusted;
}

/** Loads `fixtures/demo-identity.p12` (passphrase "1234"). */
export function loadDemoIdentity(): TestIdentity {
  const p12 = readFileSync(FIXTURE_PATHS.demoIdentityP12);
  const contents = readP12(p12, DEMO_IDENTITY_PASSPHRASE);
  const surname = `${DEMO_PERSON.surname1} ${DEMO_PERSON.surname2}`;
  return {
    p12,
    passphrase: DEMO_IDENTITY_PASSPHRASE,
    encryption: '3des',
    certPem: contents.certPem,
    keyPem: contents.keyPem,
    certDer: contents.certDer,
    chainPem: contents.chainPem,
    dni: DEMO_PERSON.dni,
    givenName: DEMO_PERSON.givenName,
    surname,
    commonName: `${surname} ${DEMO_PERSON.givenName} - ${DEMO_PERSON.dni}`,
    serialNumber: `IDCES-${DEMO_PERSON.dni}`,
  };
}
