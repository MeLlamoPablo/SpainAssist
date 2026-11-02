/**
 * The name people know a certificate's issuer by ("FNMT"), from the distinguished name the vault
 * keeps in `CertificateInfo.issuer` ("CN=AC FNMT Usuarios, OU=Ceres, O=FNMT-RCM, C=ES"). It
 * works on the stored string, so certificates saved before it read the same.
 */

/**
 * Spain's issuers of personal certificates, by the words their CAs' O, OU or CN carry (upper
 * case, without accents). The DN shapes come from Spain's trusted list (tsl.digital.gob.es,
 * 2026-11-02), e.g. "CN=AC Representación, OU=CERES, O=FNMT-RCM, C=ES", "OU=FNMT Clase 2 CA,
 * O=FNMT, C=ES", "CN=AC DNIE 004, OU=DNIE, O=DIRECCION GENERAL DE LA POLICIA, C=ES",
 * "CN=ACCV RSA1 CLIENTE, O=ISTEC, …". The DNIe comes before the Policía's other CAs.
 */
const ISSUERS: readonly { name: string; match: RegExp }[] = [
  { name: 'FNMT', match: /\bFNMT\b|FABRICA NACIONAL DE MONEDA/ },
  { name: 'Policía Nacional (DNI)', match: /\bDNIE\b/ },
  { name: 'Policía Nacional', match: /DIRECCION GENERAL DE LA POLICIA/ },
  { name: 'ACCV', match: /\bACCV|\bPKIGVA\b/ },
  { name: 'Camerfirma', match: /CAMERFIRMA/ },
  { name: 'Firmaprofesional', match: /FIRMAPROFESIONAL/ },
  { name: 'Izenpe', match: /IZENPE/ },
  { name: 'ANF AC', match: /\bANF\b/ },
  {
    name: 'Consorci AOC',
    match: /ADMINISTRACIO OBERTA DE CATALUNYA|AGENCIA CATALANA DE CERTIFICACIO|\bCATCERT\b/,
  },
  { name: 'ANCERT', match: /\bANCERT\b|AGENCIA NOTARIAL DE CERTIFICACION/ },
  { name: 'Colegio de Registradores', match: /\bREGISTRADORES\b/ },
  { name: 'Abogacía Española', match: /CONSEJO GENERAL DE LA ABOGACIA/ },
  { name: 'Uanataca', match: /UANATACA/ },
  { name: 'EADTrust', match: /EUROPEAN AGENCY OF DIGITAL TRUST|\bEAD ?TRUST\b/ },
  { name: 'esFIRMA', match: /\bESFIRMA\b/ },
];

/** Tax ID and legal form at the end of an organization: "Validated ID SL", "X S.A. - CIF A1…". */
const TAX_ID = /\s*[-–,(]?\s*\b[CN]IF\b.*$/i;
const LEGAL_FORM =
  /[\s,]+(?:S\.?\s?[AL]\.?(?:\s?U\.?)?|SOCIEDAD AN[OÓ]NIMA|SOCIEDAD LIMITADA|UNIPERSONAL)$/i;

/** Attribute types written as OIDs ("OID.2.5.4.10", "2.5.4.10"). */
const TYPE_NAMES: Record<string, string> = { '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU' };

/**
 * Short name of the issuer whose DN is `dn`: "FNMT" for any FNMT-RCM CA, "Policía Nacional (DNI)"
 * for the DNIe's, the usual name of Spain's other trust service providers, and otherwise the
 * organization (without tax ID or legal form), the common name, or `dn` itself.
 */
export function issuerName(dn: string): string {
  const attributes = parseDn(dn);
  const values = (type: string) =>
    attributes?.filter((a) => a.type === type).map((a) => a.value) ?? [];
  const words = (attributes ? ['O', 'OU', 'CN'].flatMap(values) : [dn])
    .join('\n')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase();
  const known = ISSUERS.find((i) => i.match.test(words));
  if (known) return known.name;
  const organization = values('O').map(withoutLegalForm).find(Boolean);
  return organization ?? values('CN').find(Boolean) ?? values('OU').find(Boolean) ?? clean(dn);
}

function withoutLegalForm(organization: string): string {
  let name = organization.replace(TAX_ID, '');
  for (let previous = ''; previous !== name; ) {
    previous = name;
    name = name.replace(LEGAL_FORM, '');
  }
  return name.trim() || organization;
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The attributes of an RFC 4514 DN, as `formatDn` in @sa/vault and @sa/signer write it
 * ("CN=A\, B, O=C+OU=D": backslash escapes, `+` within an RDN), also with RFC 2253 quoted values
 * (`O="C, D"`), hex escapes (`\C3\A9`) and one attribute per line (Node's `X509Certificate`).
 * Undefined when `dn` is not a DN (a plain "AC DNIE 004").
 */
function parseDn(dn: string): { type: string; value: string }[] | undefined {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i]!;
    if (c === '\\' && i + 1 < dn.length) {
      current += c + dn[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && ',;+\n'.includes(c)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);

  const attributes: { type: string; value: string }[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    const type = part
      .slice(0, eq)
      .trim()
      .toUpperCase()
      .replace(/^OID\./, '');
    if (eq < 0 || !/^[A-Z][A-Z0-9-]*$|^[0-9]+(?:\.[0-9]+)+$/.test(type)) {
      // An unescaped comma in a value ("O=Banco, S.A.").
      const last = attributes.at(-1);
      if (!last) return undefined;
      last.value = clean(`${last.value}, ${unescapeValue(part)}`);
      continue;
    }
    attributes.push({
      type: TYPE_NAMES[type] ?? type,
      value: clean(unescapeValue(part.slice(eq + 1))),
    });
  }
  return attributes.length ? attributes : undefined;
}

function unescapeValue(raw: string): string {
  // Spaces around the value, not an escaped one ("A\ ").
  let value = raw.trimStart().replace(/(?<!\\)\s+$/, '');
  if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  const encoded = value.replace(/\\([0-9a-f]{2})|\\(.)|[^\\]+/gis, (m, hex, char) =>
    hex ? `%${hex}` : encodeURIComponent(char ?? m),
  );
  try {
    return decodeURIComponent(encoded);
  } catch {
    // Hex escapes that are not UTF-8: drop the backslashes.
    return value.replace(/\\(.)/gs, '$1');
  }
}
