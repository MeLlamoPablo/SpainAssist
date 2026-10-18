/**
 * AutoFirma's certificate filters (`filters=`, `filters.1=`…, `filter=` in the operation's
 * params; `CertFilterManager` in afirma-keystores-filters, docs/research/autofirma.md §3.3):
 *
 * - `filters=a;b` — one group: a certificate must pass every filter (`;` is AND);
 * - `filters.1=…`, `filters.2=…` — several groups: it must pass one of them (OR);
 * - `filter=` — the same as `filters=`.
 *
 * The filters only narrow the certificates the approved credential offers (for the DNIe: FIRMA,
 * then AUTENTICACIÓN). Which one is used among those that pass is the caller's choice: FIRMA
 * whenever it passes. A filter we don't know is ignored (it passes everything) with a warning,
 * so a site's new filter never blocks a signature.
 */
import crypto from 'node:crypto';
import { AsnConvert } from '@peculiar/asn1-schema';
import {
  type Certificate,
  id_ce_keyUsage,
  KeyUsage,
  KeyUsageFlags,
  type Name,
} from '@peculiar/asn1-x509';
import { certificatePolicies, parseCertificate } from './certificate';
import type { ExtraParams } from './extra-params';
import { asBuffer } from './util/base64';

/** One certificate, as the filters see it. */
interface Candidate {
  der: Buffer;
  cert: Certificate;
  /** Uppercase hex without leading zeros. */
  serial: string;
  usage: KeyUsageFlags | null;
}

/** `filters.N`: AND within a group, OR between groups. */
export interface CertificateFilters {
  groups: Filter[][];
}

type Filter =
  | { kind: 'nonexpired' }
  | { kind: 'authcert' }
  | { kind: 'signingcert' }
  | { kind: 'dnie' }
  | { kind: 'sscd' }
  | { kind: 'pair'; serial: string }
  | { kind: 'thumbprint'; algorithm: string; hex: string }
  | { kind: 'encodedcert'; der: Buffer }
  | { kind: 'contains'; field: 'subject' | 'issuer'; text: string }
  | { kind: 'rfc2254'; field: 'subject' | 'issuer'; expr: LdapFilter }
  | { kind: 'keyusage'; flag: KeyUsageFlags; value: boolean }
  | { kind: 'policyid'; oids: string[] }
  | { kind: 'pseudonym' }
  | { kind: 'never' };

export interface FilterLogger {
  warn(message: string, data?: unknown): void;
}

const KEY_USAGES: Record<string, KeyUsageFlags> = {
  digitalsignature: KeyUsageFlags.digitalSignature,
  nonrepudiation: KeyUsageFlags.nonRepudiation,
  contentcommitment: KeyUsageFlags.nonRepudiation,
  keyencipherment: KeyUsageFlags.keyEncipherment,
  dataencipherment: KeyUsageFlags.dataEncipherment,
  keyagreement: KeyUsageFlags.keyAgreement,
  keycertsign: KeyUsageFlags.keyCertSign,
  crlsign: KeyUsageFlags.cRLSign,
  encipheronly: KeyUsageFlags.encipherOnly,
  decipheronly: KeyUsageFlags.decipherOnly,
};

const THUMBPRINT_ALGORITHMS: Record<string, string> = {
  sha1: 'sha1',
  'sha-1': 'sha1',
  sha256: 'sha256',
  'sha-256': 'sha256',
  sha384: 'sha384',
  'sha-384': 'sha384',
  sha512: 'sha512',
  'sha-512': 'sha512',
  md5: 'md5',
};

/** qcStatements (RFC 3739). */
const id_pe_qcStatements = '1.3.6.1.5.5.7.1.3';
/** ETSI EN 319 412-5 QcSSCD: the key is in a qualified signature creation device. */
const QC_SSCD_OID = Buffer.from([0x06, 0x06, 0x04, 0x00, 0x8e, 0x46, 0x01, 0x04]);
/** id-at-pseudonym. */
const OID_PSEUDONYM = '2.5.4.65';
const OID_ORGANIZATIONAL_UNIT = '2.5.4.11';
const OID_COMMON_NAME = '2.5.4.3';

/**
 * The filters in `params`, or null when the page gave none. `filters` wins over the numbered
 * groups, which win over `filter` (CertFilterManager's order).
 */
export function readCertificateFilters(
  params: ExtraParams,
  logger?: FilterLogger,
): CertificateFilters | null {
  const texts: string[] = [];
  if (params.filters?.trim()) texts.push(params.filters);
  else if (params['filters.1']?.trim()) {
    for (let i = 1; params[`filters.${i}`]?.trim(); i++)
      texts.push(params[`filters.${i}`] as string);
  } else if (params.filter?.trim()) texts.push(params.filter);
  if (texts.length === 0) return null;
  const groups = texts
    .map((text) =>
      text
        .split(';')
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => parseFilter(f, logger))
        .filter((f): f is Filter => f !== null),
    )
    .filter((group) => group.length > 0);
  // Only unknown filters: nothing narrows the certificates.
  return groups.length === texts.length ? { groups } : null;
}

/** Filter names (never values) for logs. */
export function describeFilters(filters: CertificateFilters): string {
  return filters.groups.map((g) => g.map((f) => f.kind).join(';')).join(' | ');
}

function parseFilter(text: string, logger?: FilterLogger): Filter | null {
  const colon = text.indexOf(':');
  const name = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
  const value = colon < 0 ? '' : text.slice(colon + 1).trim();
  const unknown = (why: string): null => {
    logger?.warn('AutoFirma: certificate filter ignored', { filter: name, why });
    return null;
  };
  switch (name) {
    case 'nonexpired':
      return value.toLowerCase() === 'false' ? null : { kind: 'nonexpired' };
    case 'authcert':
      return { kind: 'authcert' };
    case 'signingcert':
      return { kind: 'signingcert' };
    case 'dnie':
      return { kind: 'dnie' };
    case 'sscd':
      return { kind: 'sscd' };
    case 'ssl':
    case 'qualified': {
      const serial = normalizeSerial(value);
      return serial ? { kind: 'pair', serial } : unknown('not a hexadecimal serial number');
    }
    case 'thumbprint': {
      const sep = value.indexOf(':');
      const algorithm = THUMBPRINT_ALGORITHMS[value.slice(0, sep).trim().toLowerCase()];
      const hex = value
        .slice(sep + 1)
        .replace(/[\s:]/g, '')
        .toLowerCase();
      // A thumbprint we can't compute matches nothing, as in AutoFirma.
      if (sep < 0 || !algorithm || !/^[0-9a-f]+$/.test(hex)) return { kind: 'never' };
      return { kind: 'thumbprint', algorithm, hex };
    }
    case 'encodedcert': {
      const der = Buffer.from(value.replace(/\s/g, ''), 'base64');
      return der.length ? { kind: 'encodedcert', der } : { kind: 'never' };
    }
    case 'subject.contains':
      return { kind: 'contains', field: 'subject', text: value };
    case 'issuer.contains':
      return { kind: 'contains', field: 'issuer', text: value };
    case 'subject.rfc2254':
    case 'issuer.rfc2254':
    // The issuer's own issuers are not at hand for every credential: the leaf's issuer only.
    case 'issuer.rfc2254.recurse': {
      const expr = parseLdapFilter(value);
      if (!expr) return unknown('malformed RFC 2254 expression');
      return { kind: 'rfc2254', field: name.startsWith('subject') ? 'subject' : 'issuer', expr };
    }
    case 'policyid': {
      const oids = value
        .split(',')
        .map((o) => o.trim())
        .filter((o) => /^\d+(\.\d+)+$/.test(o));
      return oids.length ? { kind: 'policyid', oids } : unknown('no policy OID');
    }
    case 'pseudonym':
      // `andothers` keeps every certificate; `only` keeps pseudonym certificates.
      return value.toLowerCase() === 'only' ? { kind: 'pseudonym' } : null;
    // Not a filter: whether the certificate dialog may open other stores.
    case 'disableopeningexternalstores':
      return null;
  }
  if (name.startsWith('keyusage.')) {
    const flag = KEY_USAGES[name.slice('keyusage.'.length)];
    const v = value.toLowerCase();
    if (flag === undefined) return unknown('unknown key usage');
    // AutoFirma: anything but true/false leaves the usage unchecked.
    if (v !== 'true' && v !== 'false') return null;
    return { kind: 'keyusage', flag, value: v === 'true' };
  }
  return unknown('unknown filter');
}

function normalizeSerial(text: string): string | null {
  const hex = text.replace(/[\s:]/g, '').replace(/^0x/i, '');
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  return hex.replace(/^0+(?=.)/, '').toUpperCase();
}

function candidate(der: Uint8Array): Candidate | null {
  try {
    const buffer = asBuffer(der);
    const cert = parseCertificate(buffer);
    const x509 = new crypto.X509Certificate(buffer);
    const ext = cert.tbsCertificate.extensions?.find((e) => e.extnID === id_ce_keyUsage);
    const usage = ext ? AsnConvert.parse(ext.extnValue.buffer, KeyUsage).toNumber() : null;
    return {
      der: buffer,
      cert,
      serial: normalizeSerial(x509.serialNumber) ?? x509.serialNumber.toUpperCase(),
      usage,
    };
  } catch {
    return null;
  }
}

function hasUsage(c: Candidate, flag: KeyUsageFlags): boolean {
  return c.usage !== null && (c.usage & flag) !== 0;
}

/**
 * An authentication certificate (AuthCertificateFilter): digitalSignature without
 * nonRepudiation, like the DNIe's AUTENTICACIÓN.
 */
function isAuthentication(c: Candidate): boolean {
  return hasUsage(c, KeyUsageFlags.digitalSignature) && !hasUsage(c, KeyUsageFlags.nonRepudiation);
}

function isDnie(c: Candidate): boolean {
  const issuer = c.cert.tbsCertificate.issuer;
  return (
    attributes(issuer, OID_ORGANIZATIONAL_UNIT).some((v) => v.toUpperCase() === 'DNIE') ||
    attributes(issuer, OID_COMMON_NAME).some((v) => /^AC DNIE\b/i.test(v))
  );
}

function attributes(name: Name, oid: string): string[] {
  const out: string[] = [];
  for (const rdn of name)
    for (const atv of rdn) if (atv.type === oid) out.push(atv.value.toString());
  return out;
}

const SHORT_NAMES: Record<string, string> = {
  '2.5.4.3': 'cn',
  '2.5.4.4': 'sn',
  '2.5.4.5': 'serialnumber',
  '2.5.4.6': 'c',
  '2.5.4.7': 'l',
  '2.5.4.8': 'st',
  '2.5.4.9': 'street',
  '2.5.4.10': 'o',
  '2.5.4.11': 'ou',
  '2.5.4.12': 't',
  '2.5.4.42': 'givenname',
  '2.5.4.65': 'pseudonym',
  '2.5.4.97': 'organizationidentifier',
  '1.2.840.113549.1.9.1': 'emailaddress',
  '0.9.2342.19200300.100.1.1': 'uid',
  '0.9.2342.19200300.100.1.25': 'dc',
};
const ALIASES: Record<string, string> = {
  e: 'emailaddress',
  email: 'emailaddress',
  surname: 'sn',
  gn: 'givenname',
  serial: 'serialnumber',
};

/** Attribute name (lowercase, also the OID) → values. */
function nameMap(name: Name): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rdn of name) {
    for (const atv of rdn) {
      const value = atv.value.toString();
      for (const key of [atv.type, SHORT_NAMES[atv.type]]) {
        if (!key) continue;
        map.set(key, [...(map.get(key) ?? []), value]);
      }
    }
  }
  return map;
}

/** "CN=…, OU=…, C=ES" (most specific first, like Java's X500Principal). */
function nameText(name: Name): string {
  return [...name]
    .reverse()
    .map((rdn) =>
      [...rdn]
        .map((atv) => `${(SHORT_NAMES[atv.type] ?? atv.type).toUpperCase()}=${atv.value}`)
        .join('+'),
    )
    .join(', ');
}

function passes(f: Filter, c: Candidate, all: Candidate[], now: Date): boolean {
  const tbs = c.cert.tbsCertificate;
  switch (f.kind) {
    case 'nonexpired':
      return now >= tbs.validity.notBefore.getTime() && now <= tbs.validity.notAfter.getTime();
    case 'authcert':
      return isAuthentication(c);
    case 'signingcert':
      return !isAuthentication(c);
    case 'dnie':
      return isDnie(c) && !isAuthentication(c);
    case 'sscd': {
      const ext = tbs.extensions?.find((e) => e.extnID === id_pe_qcStatements);
      return !!ext && Buffer.from(ext.extnValue.buffer).includes(QC_SSCD_OID);
    }
    case 'pair':
      // ssl:/qualified: the signing certificate with that serial number, or the one paired
      // with the certificate that has it (the same DNIe's AUTENTICACIÓN).
      return !isAuthentication(c) && all.some((o) => o.serial === f.serial);
    case 'thumbprint':
      return crypto.createHash(f.algorithm).update(c.der).digest('hex') === f.hex;
    case 'encodedcert':
      return c.der.equals(f.der);
    case 'contains':
      return nameText(f.field === 'subject' ? tbs.subject : tbs.issuer)
        .toLowerCase()
        .includes(f.text.toLowerCase());
    case 'rfc2254':
      return evaluateLdap(f.expr, nameMap(f.field === 'subject' ? tbs.subject : tbs.issuer));
    case 'keyusage':
      return hasUsage(c, f.flag) === f.value;
    case 'policyid': {
      const policies = certificatePolicies(c.cert);
      return !!policies?.some((p) => f.oids.includes(p.policyIdentifier));
    }
    case 'pseudonym':
      return attributes(tbs.subject, OID_PSEUDONYM).length > 0;
    case 'never':
      return false;
  }
}

/**
 * Which of `certificates` (DER; one credential's, in order of preference) pass `filters`: their
 * indexes, in the same order.
 */
export function matchingCertificates(
  filters: CertificateFilters,
  certificates: Uint8Array[],
  now: Date = new Date(),
): number[] {
  const parsed = certificates.map(candidate);
  const all = parsed.filter((c): c is Candidate => c !== null);
  const out: number[] = [];
  parsed.forEach((c, i) => {
    if (c && filters.groups.some((group) => group.every((f) => passes(f, c, all, now))))
      out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// RFC 2254 (LDAP search filters) over a distinguished name's attributes
// ---------------------------------------------------------------------------------------------

type LdapFilter =
  | { op: 'and' | 'or'; items: LdapFilter[] }
  | { op: 'not'; item: LdapFilter }
  | { op: 'present'; attr: string }
  | { op: 'equal' | 'approx' | 'ge' | 'le'; attr: string; parts: string[] };

/** Parses `(&(cn=*FIRMA*)(o=…))`; a bare `cn=…` is accepted too. Null when malformed. */
function parseLdapFilter(text: string): LdapFilter | null {
  const source = text.trim();
  if (!source) return null;
  let pos = 0;
  const filter = (): LdapFilter | null => {
    if (source[pos] !== '(') return null;
    pos++;
    let result: LdapFilter | null;
    const c = source[pos];
    if (c === '&' || c === '|') {
      pos++;
      const items: LdapFilter[] = [];
      while (source[pos] === '(') {
        const item = filter();
        if (!item) return null;
        items.push(item);
      }
      result = items.length ? { op: c === '&' ? 'and' : 'or', items } : null;
    } else if (c === '!') {
      pos++;
      const item = filter();
      result = item ? { op: 'not', item } : null;
    } else {
      const start = pos;
      while (pos < source.length && source[pos] !== ')') {
        if (source[pos] === '\\') pos++;
        pos++;
      }
      result = item(source.slice(start, pos));
    }
    if (source[pos] !== ')') return null;
    pos++;
    return result;
  };
  const result = source.startsWith('(') ? filter() : item(source);
  if (source.startsWith('(') && pos !== source.length) return null;
  return result;
}

function item(text: string): LdapFilter | null {
  const m = text.match(/^\s*([A-Za-z][\w.-]*|\d+(?:\.\d+)+)\s*(~=|>=|<=|=)(.*)$/s);
  if (!m) return null;
  const raw = (m[1] as string).toLowerCase();
  const attr = ALIASES[raw] ?? raw;
  const op = m[2] as string;
  const value = m[3] as string;
  if (op === '=' && value === '*') return { op: 'present', attr };
  const parts = splitWildcards(value);
  if (!parts) return null;
  return {
    op: op === '=' ? 'equal' : op === '~=' ? 'approx' : op === '>=' ? 'ge' : 'le',
    attr,
    parts,
  };
}

/** The value between `*` wildcards, with `\XX` escapes decoded. */
function splitWildcards(value: string): string[] | null {
  const parts: string[] = [''];
  for (let i = 0; i < value.length; i++) {
    const c = value[i] as string;
    if (c === '*') parts.push('');
    else if (c === '\\') {
      const hex = value.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        parts[parts.length - 1] += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
      } else if (i + 1 < value.length) {
        parts[parts.length - 1] += value[++i];
      } else return null;
    } else parts[parts.length - 1] += c;
  }
  return parts;
}

function evaluateLdap(f: LdapFilter, attrs: Map<string, string[]>): boolean {
  switch (f.op) {
    case 'and':
      return f.items.every((i) => evaluateLdap(i, attrs));
    case 'or':
      return f.items.some((i) => evaluateLdap(i, attrs));
    case 'not':
      return !evaluateLdap(f.item, attrs);
    case 'present':
      return (attrs.get(f.attr)?.length ?? 0) > 0;
    default: {
      const values = attrs.get(f.attr) ?? [];
      return values.some((v) => compare(f.op, v.trim().toLowerCase(), f.parts));
    }
  }
}

function compare(op: 'equal' | 'approx' | 'ge' | 'le', value: string, parts: string[]): boolean {
  const lower = parts.map((p) => p.trim().toLowerCase());
  if (op === 'ge') return value >= (lower[0] ?? '');
  if (op === 'le') return value <= (lower[0] ?? '');
  if (lower.length === 1) return value === lower[0];
  // Wildcards: initial*any*…*final, case-insensitive.
  const first = lower[0] as string;
  const last = lower[lower.length - 1] as string;
  if (!value.startsWith(first)) return false;
  let at = first.length;
  for (const middle of lower.slice(1, -1)) {
    const found = value.indexOf(middle, at);
    if (found < 0) return false;
    at = found + middle.length;
  }
  return value.length - last.length >= at && value.endsWith(last);
}
