/** X.509 helpers: display names, FNMT/DNIe holder parsing and `CertificateInfo`. */
import crypto from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  type AttributeTypeAndValue,
  Certificate,
  CertificatePolicies,
  id_ce_certificatePolicies,
  Name,
} from '@peculiar/asn1-x509';
import type { CertificateInfo } from '@sa/shared';
import { asBuffer, toArrayBuffer } from './util/base64';

/** Short names used for display (RFC 4514 + the usual extras). */
const SHORT_NAMES: Record<string, string> = {
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
  '2.5.4.42': 'GIVENNAME',
  '2.5.4.43': 'INITIALS',
  '2.5.4.97': 'ORGANIZATIONIDENTIFIER',
  '1.2.840.113549.1.9.1': 'E',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
};

/** Keywords Java's `X500Principal.getName()` (RFC 2253) knows; other types print as OID=#hex. */
const JAVA_RFC2253_KEYWORDS: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.9': 'STREET',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '0.9.2342.19200300.100.1.1': 'UID',
  '0.9.2342.19200300.100.1.25': 'DC',
};

export const OID_SERIAL_NUMBER = '2.5.4.5';
export const OID_GIVEN_NAME = '2.5.4.42';
export const OID_SURNAME = '2.5.4.4';
export const OID_COMMON_NAME = '2.5.4.3';

export function parseCertificate(der: Uint8Array): Certificate {
  return AsnConvert.parse(toArrayBuffer(der), Certificate);
}

function attributeText(atv: AttributeTypeAndValue): string {
  const v = atv.value;
  if (v.anyValue) return `#${Buffer.from(v.anyValue).toString('hex')}`;
  return v.toString();
}

function escapeRfc4514(value: string): string {
  let out = value.replace(/([\\,+"<>;=])/g, '\\$1');
  if (out.startsWith(' ') || out.startsWith('#')) out = `\\${out}`;
  if (out.endsWith(' ') && out.length > 1) out = `${out.slice(0, -1)}\\ `;
  return out;
}

/** Most-specific-first display string, e.g. "CN=JUAN ESPAÑOL - 12345678Z, SERIALNUMBER=..., C=ES". */
export function formatName(name: Name): string {
  return [...name]
    .reverse()
    .map((rdn) =>
      [...rdn]
        .map((atv) => `${SHORT_NAMES[atv.type] ?? atv.type}=${escapeRfc4514(attributeText(atv))}`)
        .join('+'),
    )
    .join(', ');
}

export function parseName(nameDer: Uint8Array): Name {
  return AsnConvert.parse(toArrayBuffer(nameDer), Name);
}

/**
 * RFC 2253 string as produced by Java's `X500Principal.getName()` (used by AutoFirma inside
 * XAdES `X509IssuerName`): reverse order, no spaces after commas, attribute types without a
 * standard keyword printed as `OID=#<hex of the DER value>`.
 */
export function formatNameJava(name: Name): string {
  return [...name]
    .reverse()
    .map((rdn) =>
      [...rdn]
        .map((atv) => {
          const keyword = JAVA_RFC2253_KEYWORDS[atv.type];
          if (!keyword || atv.value.anyValue) {
            return `${atv.type}=#${Buffer.from(AsnConvert.serialize(atv.value)).toString('hex')}`;
          }
          return `${keyword}=${escapeRfc2253(attributeText(atv))}`;
        })
        .join('+'),
    )
    .join(',');
}

function escapeRfc2253(value: string): string {
  let out = value.replace(/([\\,+"<>;=])/g, '\\$1');
  if (out.startsWith(' ') || out.startsWith('#')) out = `\\${out}`;
  if (out.endsWith(' ') && out.length > 1) out = `${out.slice(0, -1)}\\ `;
  return out;
}

export function nameAttribute(name: Name, oid: string): string | undefined {
  for (const rdn of name) {
    for (const atv of rdn) {
      if (atv.type === oid) return attributeText(atv);
    }
  }
  return undefined;
}

const SPANISH_ID = /^([0-9XYZKLM][0-9]{7}[A-Z])$/;
const ID_IN_TEXT = /(?:^|[\s:-])((?:[0-9]{8}|[XYZKLM][0-9]{7})[A-Z])\b/;

/**
 * Holder name and national ID from a Spanish certificate subject:
 *  - FNMT persona física: GN/SN attributes, SERIALNUMBER "IDCES-12345678Z",
 *    CN "ESPAÑOL ESPAÑOL JUAN - 12345678Z";
 *  - legacy FNMT: CN "NOMBRE ESPAÑOL ESPAÑOL JUAN - NIF 12345678Z";
 *  - DNIe: CN "ESPAÑOL ESPAÑOL, JUAN (FIRMA)", SERIALNUMBER "12345678Z";
 *  - representative: CN "12345678Z JUAN ESPAÑOL (R: B12345678)".
 */
export function parseHolder(subject: Name): { holderName?: string; holderId?: string } {
  const cn = nameAttribute(subject, OID_COMMON_NAME);
  const given = nameAttribute(subject, OID_GIVEN_NAME);
  const surname = nameAttribute(subject, OID_SURNAME);
  const serial = nameAttribute(subject, OID_SERIAL_NUMBER);

  let holderId: string | undefined;
  if (serial) {
    // ETSI EN 319 412-1 semantics identifiers: IDCES-, PASES-, TINES-, PNOES-...
    const stripped = serial.replace(/^(?:IDC|PAS|TIN|PNO|NIE|CPI)[A-Z]{2}-/, '').trim();
    holderId = stripped || undefined;
  }
  if ((!holderId || !SPANISH_ID.test(holderId)) && cn) {
    const m = cn.match(ID_IN_TEXT);
    if (m && !holderId) holderId = m[1];
  }

  let holderName: string | undefined;
  if (given && surname) {
    holderName = `${given} ${surname}`.trim();
  } else if (cn) {
    let n = cn
      .replace(/\s*\((?:FIRMA|AUTENTICACI[ÓO]N|R:[^)]*)\)\s*$/i, '')
      .replace(/^NOMBRE\s+/i, '')
      .replace(/\s+-\s+(?:NIF\s+)?[0-9A-Z]+$/i, '');
    if (holderId) n = n.replace(holderId, '').trim();
    const comma = n.split(/\s*,\s*/);
    if (comma.length === 2 && comma[0] && comma[1]) n = `${comma[1]} ${comma[0]}`;
    holderName = n.trim() || undefined;
  }
  return { holderName, holderId };
}

/** `CertificateInfo` (as shown in the vault and the signature prompt) for a DER certificate. */
export function certificateInfo(der: Uint8Array): CertificateInfo {
  const cert = parseCertificate(der);
  const tbs = cert.tbsCertificate;
  const x509 = new crypto.X509Certificate(asBuffer(der));
  const { holderName, holderId } = parseHolder(tbs.subject);
  const info: CertificateInfo = {
    subject: formatName(tbs.subject),
    issuer: formatName(tbs.issuer),
    serialNumber: x509.serialNumber.toUpperCase(),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    fingerprint: crypto.createHash('sha256').update(asBuffer(der)).digest('hex'),
  };
  if (holderName) info.holderName = holderName;
  if (holderId) info.holderId = holderId;
  return info;
}

/** Certificate policies (OIDs + raw PolicyInformation DER) from the certificatePolicies extension. */
export function certificatePolicies(cert: Certificate): CertificatePolicies | undefined {
  const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_certificatePolicies);
  if (!ext) return undefined;
  return AsnConvert.parse(ext.extnValue.buffer, CertificatePolicies);
}

export function isSelfIssued(cert: Certificate): boolean {
  return Buffer.from(AsnConvert.serialize(cert.tbsCertificate.subject)).equals(
    Buffer.from(AsnConvert.serialize(cert.tbsCertificate.issuer)),
  );
}
