/** Reads the identity out of a personal certificate (FNMT-style subject). */
import { createHash, X509Certificate } from 'node:crypto';

export interface CertificateHolder {
  /** DNI/NIE taken from serialNumber ("IDCES-12345678Z") or, failing that, from the CN. */
  dni?: string;
  givenName?: string;
  /** Both surnames as in the certificate. */
  surname?: string;
  commonName?: string;
  serialNumberAttribute?: string;
  issuerCommonName?: string;
  issuerOrganization?: string;
  /** Certificate serial number (hex, uppercase). */
  serial: string;
  validFrom: Date;
  validTo: Date;
  sha256: string;
  pem: string;
}

/** Parses Node's multi-line X509Certificate subject/issuer ("C=ES\nCN=..."). */
function parseDistinguishedName(dn: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dn.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const DOCUMENT_ID = /\b(\d{8}[A-Z]|[XYZ]\d{7}[A-Z])\b/;

export function describeCertificate(cert: X509Certificate | Buffer | string): CertificateHolder {
  const x509 = cert instanceof X509Certificate ? cert : new X509Certificate(cert);
  const subject = parseDistinguishedName(x509.subject);
  const issuer = parseDistinguishedName(x509.issuer);
  const serialAttr = subject.serialNumber;
  const dni =
    (serialAttr ? DOCUMENT_ID.exec(serialAttr)?.[1] : undefined) ??
    (subject.CN ? DOCUMENT_ID.exec(subject.CN)?.[1] : undefined);
  return {
    dni,
    givenName: subject.GN ?? subject.givenName,
    surname: subject.SN ?? subject.surname,
    commonName: subject.CN,
    serialNumberAttribute: serialAttr,
    issuerCommonName: issuer.CN,
    issuerOrganization: issuer.O,
    serial: x509.serialNumber.toUpperCase(),
    validFrom: new Date(x509.validFrom),
    validTo: new Date(x509.validTo),
    sha256: createHash('sha256').update(x509.raw).digest('hex'),
    pem: x509.toString(),
  };
}
