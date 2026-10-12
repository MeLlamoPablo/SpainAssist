/**
 * Certificate import: passphrase check, parsing (RSA and ECDSA keys), expiry check,
 * `CertificateInfo` extraction (with FNMT holder name/ID parsing) and normalization to a
 * modern PKCS#12 (PBES2/AES-256-CBC + SHA-256 MAC) that Node, Playwright and Electron accept.
 */
import { createHash, randomBytes, type X509Certificate } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import type { CertificateInfo } from '@sa/shared';
import { type Asn1Node, isContext, parseAsn1, readOid, readString, sequence, TAG } from './der';
import { VaultError } from './errors';
import { isSpanishId } from './ids';
import { Pkcs12Error, readPkcs12, writePkcs12 } from './pkcs12';

export interface DnAttribute {
  oid: string;
  /** Short name (CN, SN, GN, SERIALNUMBER, O, ...) or the dotted OID when unknown. */
  name: string;
  value: string;
}

const DN_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.4': 'SN',
  '2.5.4.5': 'SERIALNUMBER',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '2.5.4.12': 'T',
  '2.5.4.13': 'DESCRIPTION',
  '2.5.4.42': 'GN',
  '2.5.4.43': 'INITIALS',
  '2.5.4.46': 'DNQUALIFIER',
  '2.5.4.65': 'PSEUDONYM',
  '2.5.4.97': 'ORGANIZATIONIDENTIFIER',
  '1.2.840.113549.1.9.1': 'E',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
};

/** Issuer and subject attributes, in DER order (most general first), with decoded values. */
export function certificateNames(cert: X509Certificate): {
  issuer: DnAttribute[][];
  subject: DnAttribute[][];
} {
  const certificate = sequence(parseAsn1(cert.raw), 'Certificate');
  const tbs = sequence(certificate[0], 'TBSCertificate');
  const offset = isContext(tbs[0], 0) ? 1 : 0; // optional [0] version
  // serialNumber, signature, issuer, validity, subject
  return { issuer: readName(tbs[offset + 2]), subject: readName(tbs[offset + 4]) };
}

function readName(node: Asn1Node | undefined): DnAttribute[][] {
  return sequence(node, 'Name').map((rdn) =>
    sequence(rdn, 'RelativeDistinguishedName', TAG.SET).map((atv) => {
      const [typeNode, valueNode] = sequence(atv, 'AttributeTypeAndValue');
      const oid = readOid(typeNode);
      let value: string;
      try {
        value = readString(valueNode);
      } catch {
        value = `#${valueNode?.raw.toString('hex') ?? ''}`;
      }
      return { oid, name: DN_NAMES[oid] ?? oid, value };
    }),
  );
}

function escapeDnValue(value: string): string {
  let out = value.replace(/[\\,+"<>;=]/g, (c) => `\\${c}`);
  if (out.startsWith('#') || out.startsWith(' ')) out = `\\${out}`;
  if (out.endsWith(' ') && out.length > 1) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/** RFC 4514-style string, most specific attribute first: "CN=..., SERIALNUMBER=..., C=ES". */
export function formatDn(name: DnAttribute[][]): string {
  return [...name]
    .reverse()
    .map((rdn) => rdn.map((a) => `${a.name}=${escapeDnValue(a.value)}`).join('+'))
    .join(', ');
}

function firstValue(name: DnAttribute[][], short: string): string | undefined {
  for (const rdn of name)
    for (const a of rdn) if (a.name === short && a.value.trim()) return a.value.trim();
  return undefined;
}

const ID_IN_TEXT = /(?:^|[^0-9A-Z])([0-9]{8}[A-Z]|[XYZ][0-9]{7}[A-Z])(?![0-9A-Z])/;

/**
 * Holder name and ID from a personal certificate subject. FNMT examples:
 *  - CN "ESPAÑOLA ESPAÑOLA CARMEN - 99999999R", SERIALNUMBER "IDCES-99999999R", GN, SN
 *  - CN "NOMBRE ESPAÑOLA ESPAÑOLA CARMEN - NIF 99999999R" (older certificates)
 *  - CN "99999999R CARMEN ESPAÑOLA (R: B12345678)" (representative certificates)
 * With GN and SN the name is "GN SN" ("CARMEN ESPAÑOLA ESPAÑOLA"); otherwise it comes from the
 * CN in its original order.
 */
export function parseHolder(subject: DnAttribute[][]): { holderName?: string; holderId?: string } {
  const cn = firstValue(subject, 'CN');
  const serial = firstValue(subject, 'SERIALNUMBER');
  const gn = firstValue(subject, 'GN');
  const sn = firstValue(subject, 'SN');

  let holderId: string | undefined;
  let fallbackId: string | undefined;
  if (serial) {
    // ETSI EN 319 412-1 semantics identifiers: IDCES-, PASES-, PNOES-, TINES-.
    const id = serial
      .toUpperCase()
      .replace(/^(IDC|PAS|PNO|TIN)[A-Z]{2}-/, '')
      .replace(/^NIF[\s:-]*/, '')
      .trim();
    if (isSpanishId(id)) holderId = id;
    else if (/^[A-Z0-9-]{5,24}$/.test(id)) fallbackId = id;
  }
  if (!holderId && cn) {
    const match = ID_IN_TEXT.exec(cn.toUpperCase());
    if (match && isSpanishId(match[1]!)) holderId = match[1];
  }
  holderId ??= fallbackId;

  let holderName: string | undefined;
  if (gn && sn) {
    holderName = `${gn} ${sn}`;
  } else if (cn) {
    let name = cn
      .replace(/\s*\(R:[^)]*\)\s*$/i, '')
      .replace(/\s+-\s+(NIF\s*)?[0-9A-Z]{6,}\s*$/i, '')
      .replace(/^NOMBRE\s+/i, '');
    if (holderId) name = name.replace(new RegExp(`^${holderId}\\s+`, 'i'), '');
    name = name.trim();
    if (name) holderName = name;
  }
  return { holderName, holderId };
}

export function certificateInfo(cert: X509Certificate): CertificateInfo {
  const { issuer, subject } = certificateNames(cert);
  return {
    subject: formatDn(subject),
    issuer: formatDn(issuer),
    serialNumber: cert.serialNumber.toUpperCase(),
    validFrom: cert.validFromDate.toISOString(),
    validTo: cert.validToDate.toISOString(),
    ...parseHolder(subject),
    fingerprint: createHash('sha256').update(cert.raw).digest('hex'),
  };
}

export interface ImportedCertificate {
  info: CertificateInfo;
  /** Normalized PKCS#12 (PBES2/AES-256-CBC, SHA-256 MAC). */
  p12: Buffer;
  /** Random passphrase protecting `p12` (the user's passphrase is not kept). */
  passphrase: string;
  /** e.g. "rsa 2048", "ec prime256v1". */
  keyDescription: string;
  /** The friendly name stored in the original file, if any. */
  friendlyName?: string;
}

/** Maximum accepted size of a .p12 file. Personal certificates are a few KB. */
export const MAX_P12_SIZE = 256 * 1024;

/**
 * Validates and normalizes a user-provided PKCS#12 file. Throws `VaultError` with codes
 * `invalid_passphrase`, `invalid_certificate` or `expired_certificate`.
 */
export async function importCertificate(
  p12: Uint8Array,
  passphrase: string,
  now: Date,
): Promise<ImportedCertificate> {
  if (p12.byteLength === 0 || p12.byteLength > MAX_P12_SIZE) {
    throw new VaultError('invalid_certificate', 'This file is not a certificate (.p12/.pfx)');
  }
  let contents: Awaited<ReturnType<typeof readPkcs12>>;
  try {
    contents = await readPkcs12(p12, passphrase);
  } catch (e) {
    if (e instanceof Pkcs12Error) {
      if (e.code === 'invalid_passphrase') {
        throw new VaultError('invalid_passphrase', 'Wrong certificate password', { cause: e });
      }
      throw new VaultError('invalid_certificate', certificateErrorMessage(e), { cause: e });
    }
    throw new VaultError('invalid_certificate', 'Could not read the certificate', { cause: e });
  }
  const { certificate, privateKey, chain } = contents;
  if (certificate.validFromDate.getTime() > now.getTime()) {
    throw new VaultError('invalid_certificate', 'The certificate is not valid yet');
  }
  if (certificate.validToDate.getTime() <= now.getTime()) {
    throw new VaultError(
      'expired_certificate',
      `The certificate expired on ${certificate.validToDate.toISOString().slice(0, 10)}`,
    );
  }
  const info = certificateInfo(certificate);
  const normalizedPassphrase = randomBytes(24).toString('base64url');
  const normalized = await writePkcs12({
    privateKey,
    certificate,
    chain,
    passphrase: normalizedPassphrase,
    friendlyName: contents.friendlyName ?? info.holderName,
  });
  verifyNormalized(normalized, normalizedPassphrase);
  const details = privateKey.asymmetricKeyDetails;
  const keyDescription = [
    privateKey.asymmetricKeyType,
    details?.modulusLength ?? details?.namedCurve ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return {
    info,
    p12: normalized,
    passphrase: normalizedPassphrase,
    keyDescription,
    friendlyName: contents.friendlyName,
  };
}

function certificateErrorMessage(e: Pkcs12Error): string {
  switch (e.code) {
    case 'no_private_key':
      return 'The file has no private key: export the certificate again including the private key';
    case 'no_certificate':
      return 'The file has no certificate';
    case 'key_mismatch':
      return 'The private key does not match the certificate';
    case 'unsupported':
      return `Unsupported certificate file: ${e.message}`;
    default:
      return 'This file is not a valid certificate (.p12/.pfx)';
  }
}

/**
 * PEM material from a PKCS#12 file (any key type), e.g. for Playwright `clientCertificates`
 * `{ cert, key }` or for signing code that wants a KeyObject/PEM instead of a .p12.
 */
export async function pkcs12ToPem(
  p12: Uint8Array,
  passphrase: string,
): Promise<{ key: string; cert: string; ca: string[] }> {
  const contents = await readPkcs12(p12, passphrase);
  return {
    key: contents.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: contents.certificate.toString(),
    ca: contents.chain.map((c) => c.toString()),
  };
}

/** The normalized copy must load in Node's TLS stack (OpenSSL in Node, BoringSSL in Electron). */
function verifyNormalized(pfx: Buffer, passphrase: string): void {
  try {
    createSecureContext({ pfx, passphrase });
  } catch (e) {
    throw new VaultError('invalid_certificate', 'The certificate could not be prepared for use', {
      cause: e,
    });
  }
}
