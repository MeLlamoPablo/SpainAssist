import { z } from 'zod';
import { COUNTRIES } from './countries';
import { SPANISH_PROVINCES } from './provinces';

/**
 * Local, encrypted data vault: personal data, documents and credentials.
 * Everything here stays on the device. Secrets (passwords, .p12 files, API keys)
 * are never sent to the renderer or to the agent; only the summaries below are.
 */

// ---------------------------------------------------------------------------------------------
// Personal data
// ---------------------------------------------------------------------------------------------

export const PersonalFieldGroup = z.enum([
  'identity',
  'dni',
  'tie',
  'passport',
  'drivingLicence',
  'contact',
  'address',
  'other',
]);
export type PersonalFieldGroup = z.infer<typeof PersonalFieldGroup>;

/**
 * One choice of a `select` personal field. `value` is the stable key the vault stores; `aliases`
 * are other written forms (lowercase, without accents) that saves and old data map to it.
 */
export const PersonalFieldOption = z
  .object({
    value: z.string().min(1).max(40),
    label: z.object({ es: z.string().min(1).max(80), en: z.string().min(1).max(80) }),
    aliases: z
      .array(
        z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-z0-9 ]+$/),
      )
      .max(20)
      .optional(),
  })
  .strict();
export type PersonalFieldOption = z.infer<typeof PersonalFieldOption>;

export interface PersonalFieldDef {
  key: string;
  group: PersonalFieldGroup;
  input: 'text' | 'date' | 'email' | 'phone' | 'select' | 'licenceCategories';
  label: { es: string; en: string };
  /** Required for `select`: the only values the vault accepts. */
  options?: readonly PersonalFieldOption[];
}

/** Lowercase, trimmed, without accents or extra spaces: how option matching compares text. */
function foldOptionText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The option of a `select` field that `text` names: its stored value, either label or an alias,
 * ignoring case, accents and extra spaces. No fuzzy matching.
 */
export function matchPersonalOption(
  def: PersonalFieldDef,
  text: string,
): PersonalFieldOption | undefined {
  const folded = foldOptionText(text);
  if (!folded) return undefined;
  return def.options?.find((option) =>
    [option.value, option.label.es, option.label.en, ...(option.aliases ?? [])].some(
      (candidate) => foldOptionText(candidate) === folded,
    ),
  );
}

/**
 * Civil statuses as the Civil Registry records them and administration forms list them (Código
 * Civil; Ley 20/2011 del Registro Civil): single, married, legally separated, divorced, widowed.
 * A registered partnership (pareja de hecho) is not a civil status: it lives in regional
 * registries and sits alongside one of these (a partner is still single, divorced or widowed),
 * so forms that ask for it need their own field.
 */
export const MARITAL_STATUS_OPTIONS: readonly PersonalFieldOption[] = [
  {
    value: 'single',
    label: { es: 'Soltero/a', en: 'Single' },
    aliases: ['soltero', 'soltera', 'unmarried'],
  },
  {
    value: 'married',
    label: { es: 'Casado/a', en: 'Married' },
    aliases: ['casado', 'casada'],
  },
  {
    value: 'separated',
    label: { es: 'Separado/a', en: 'Legally separated' },
    aliases: ['separado', 'separada', 'separated', 'separado legalmente', 'separada legalmente'],
  },
  {
    value: 'divorced',
    label: { es: 'Divorciado/a', en: 'Divorced' },
    aliases: ['divorciado', 'divorciada'],
  },
  {
    value: 'widowed',
    label: { es: 'Viudo/a', en: 'Widowed' },
    aliases: ['viudo', 'viuda', 'widow', 'widower'],
  },
];

/** Document-specific keys allow several documents to coexist without overwriting each other. */
export const DOCUMENT_FIELD_GROUPS = ['dni', 'tie', 'passport', 'drivingLicence'] as const;
export type DocumentFieldGroup = (typeof DOCUMENT_FIELD_GROUPS)[number];

/**
 * How long before its expiry date each document can be renewed, in the unit its rule uses:
 * DNI 180 days (Interior), TIE 2 months (RD 1155/2024, residence renewals), driving licence
 * 3 months (DGT). A passport can be renewed any time; 180 days is when it's worth suggesting it.
 */
export const DOCUMENT_RENEWAL_WINDOW: Record<
  DocumentFieldGroup,
  { days: number } | { months: number }
> = {
  dni: { days: 180 },
  tie: { months: 2 },
  passport: { days: 180 },
  drivingLicence: { months: 3 },
};

const DOCUMENT_TYPE_GROUPS: Record<string, DocumentFieldGroup> = {
  DNI: 'dni',
  TIE: 'tie',
  PASSPORT: 'passport',
  DRIVING_LICENCE: 'drivingLicence',
};

/** Scanner field -> key suffix: `documentNumber` on a TIE is stored as `tieNumber`. */
const DOCUMENT_SCAN_FIELDS = {
  documentNumber: 'Number',
  documentSupportNumber: 'SupportNumber',
  documentIssueDate: 'IssueDate',
  documentExpiry: 'Expiry',
  documentIssuingAuthority: 'IssuingAuthority',
  residencePermitType: 'PermitType',
  passportPersonalNumber: 'PersonalNumber',
  dniIssuingTeam: 'IssuingTeam',
  dniAccessNumber: 'AccessNumber',
  drivingCategories: 'Categories',
  documentRemarks: 'Remarks',
} as const;
type DocumentFieldSuffix = (typeof DOCUMENT_SCAN_FIELDS)[keyof typeof DOCUMENT_SCAN_FIELDS];

const DOCUMENT_NUMBER_LABELS: Record<
  Exclude<DocumentFieldGroup, 'drivingLicence'>,
  { es: string; en: string }
> = {
  dni: { es: 'Número de DNI', en: 'DNI number' },
  tie: { es: 'NIE', en: 'NIE' },
  passport: { es: 'Número de pasaporte', en: 'Passport number' },
};

const DOCUMENT_SUFFIX_DEFS: Record<
  Exclude<DocumentFieldSuffix, 'Number'>,
  Pick<PersonalFieldDef, 'input' | 'label'>
> = {
  SupportNumber: { input: 'text', label: { es: 'Número de soporte', en: 'Support number' } },
  IssueDate: { input: 'date', label: { es: 'Fecha de expedición', en: 'Issue date' } },
  Expiry: { input: 'date', label: { es: 'Fecha de validez', en: 'Expiry date' } },
  IssuingAuthority: {
    input: 'text',
    label: { es: 'Autoridad de expedición', en: 'Issuing authority' },
  },
  IssuingTeam: { input: 'text', label: { es: 'Equipo de expedición', en: 'Issuing team' } },
  AccessNumber: { input: 'text', label: { es: 'Número CAN', en: 'CAN number' } },
  PermitType: { input: 'text', label: { es: 'Tipo de permiso', en: 'Permit type' } },
  PersonalNumber: { input: 'text', label: { es: 'Número personal', en: 'Personal number' } },
  Categories: { input: 'licenceCategories', label: { es: 'Categorías', en: 'Categories' } },
  Remarks: { input: 'text', label: { es: 'Observaciones', en: 'Remarks' } },
};

/**
 * The printed fields each document keeps, in display order. DNI/TIE always come from the Spanish
 * police, so only passports and driving licences keep an issuing authority; the DNI keeps the code
 * of the police team that issued it (EQUIPO). The DNI also keeps its CAN for the phone app, which
 * needs it to read the chip (see AGENT_HIDDEN_PERSONAL_KEYS). A Spanish driving licence number is
 * its holder's DNI/NIE, so the licence keeps no number.
 */
const DOCUMENT_GROUP_FIELDS: Record<DocumentFieldGroup, readonly DocumentFieldSuffix[]> = {
  dni: ['Number', 'SupportNumber', 'IssueDate', 'Expiry', 'IssuingTeam', 'AccessNumber'],
  tie: ['Number', 'SupportNumber', 'IssueDate', 'Expiry', 'PermitType', 'Remarks'],
  passport: ['Number', 'IssueDate', 'Expiry', 'IssuingAuthority', 'PersonalNumber'],
  drivingLicence: ['IssueDate', 'Expiry', 'IssuingAuthority', 'Categories', 'Remarks'],
};

const DOCUMENT_PERSONAL_FIELDS: PersonalFieldDef[] = DOCUMENT_FIELD_GROUPS.flatMap((group) =>
  DOCUMENT_GROUP_FIELDS[group].map((suffix) => ({
    key: `${group}${suffix}`,
    group,
    ...(suffix === 'Number'
      ? {
          input: 'text' as const,
          label: DOCUMENT_NUMBER_LABELS[group as keyof typeof DOCUMENT_NUMBER_LABELS],
        }
      : DOCUMENT_SUFFIX_DEFS[suffix]),
  })),
);

/**
 * Convert the scanner's single-document extraction into persistent document-specific keys.
 * Document fields this document type doesn't keep (a DNI's issuing authority) are dropped.
 */
export function documentPersonalInputs<T extends PersonalDataInput>(items: T[]): T[] {
  const type = items.find((item) => item.key === 'documentType')?.value;
  const group =
    type && Object.hasOwn(DOCUMENT_TYPE_GROUPS, type) ? DOCUMENT_TYPE_GROUPS[type] : undefined;
  return items
    .filter((item) => item.key !== 'documentType')
    .flatMap((item) => {
      if (!Object.hasOwn(DOCUMENT_SCAN_FIELDS, item.key)) return [item];
      const suffix = DOCUMENT_SCAN_FIELDS[item.key as keyof typeof DOCUMENT_SCAN_FIELDS];
      if (!group) throw new Error('Document fields require a document type');
      return DOCUMENT_GROUP_FIELDS[group].includes(suffix)
        ? [{ ...item, key: `${group}${suffix}` }]
        : [];
    });
}

/** Well-known personal data keys. The agent may also save "custom.<slug>" keys. */
export const PERSONAL_FIELDS: readonly PersonalFieldDef[] = [
  { key: 'givenName', group: 'identity', input: 'text', label: { es: 'Nombre', en: 'First name' } },
  {
    key: 'surname1',
    group: 'identity',
    input: 'text',
    label: { es: 'Primer apellido', en: 'First surname' },
  },
  {
    key: 'surname2',
    group: 'identity',
    input: 'text',
    label: { es: 'Segundo apellido', en: 'Second surname' },
  },
  {
    key: 'birthDate',
    group: 'identity',
    input: 'date',
    label: { es: 'Fecha de nacimiento', en: 'Date of birth' },
  },
  {
    key: 'sex',
    group: 'identity',
    input: 'select',
    label: { es: 'Sexo', en: 'Sex' },
    options: [
      { value: 'F', label: { es: 'Mujer', en: 'Female' } },
      { value: 'M', label: { es: 'Hombre', en: 'Male' } },
      { value: 'X', label: { es: 'No especificado', en: 'Unspecified' } },
    ],
  },
  {
    key: 'nationality',
    group: 'identity',
    input: 'select',
    label: { es: 'Nacionalidad', en: 'Nationality' },
    options: [...COUNTRIES],
  },
  {
    key: 'birthPlace',
    group: 'identity',
    input: 'text',
    label: { es: 'Lugar de nacimiento', en: 'Place of birth' },
  },
  {
    key: 'fatherName',
    group: 'identity',
    input: 'text',
    label: { es: 'Nombre del padre', en: "Father's name" },
  },
  {
    key: 'motherName',
    group: 'identity',
    input: 'text',
    label: { es: 'Nombre de la madre', en: "Mother's name" },
  },
  {
    key: 'maritalStatus',
    group: 'identity',
    input: 'select',
    label: { es: 'Estado civil', en: 'Marital status' },
    options: MARITAL_STATUS_OPTIONS,
  },
  ...DOCUMENT_PERSONAL_FIELDS,
  {
    key: 'email',
    group: 'contact',
    input: 'email',
    label: { es: 'Correo electrónico', en: 'Email' },
  },
  {
    key: 'phone',
    group: 'contact',
    input: 'phone',
    label: { es: 'Teléfono móvil', en: 'Mobile phone' },
  },
  {
    key: 'addressStreet',
    group: 'address',
    input: 'text',
    label: { es: 'Dirección (calle, número, piso)', en: 'Address (street, number, floor)' },
  },
  {
    key: 'addressPostalCode',
    group: 'address',
    input: 'text',
    label: { es: 'Código postal', en: 'Postal code' },
  },
  {
    key: 'addressMunicipality',
    group: 'address',
    input: 'text',
    label: { es: 'Municipio', en: 'Municipality' },
  },
  {
    key: 'addressProvince',
    group: 'address',
    input: 'select',
    label: { es: 'Provincia', en: 'Province' },
    options: SPANISH_PROVINCES.map((p) => ({
      value: p.value,
      label: { es: p.label, en: p.label },
    })),
  },
  { key: 'addressCountry', group: 'address', input: 'text', label: { es: 'País', en: 'Country' } },
  {
    key: 'nuss',
    group: 'other',
    input: 'text',
    label: { es: 'Nº de la Seguridad Social', en: 'Social Security number' },
  },
  {
    key: 'iban',
    group: 'other',
    input: 'text',
    label: { es: 'Cuenta bancaria (IBAN)', en: 'Bank account (IBAN)' },
  },
] as const;

/**
 * Personal data agents never read, save, type or ask for. The DNI's CAN (card access number) only
 * unlocks the card's chip for the phone app, and forms never ask for it.
 */
export const AGENT_HIDDEN_PERSONAL_KEYS: ReadonlySet<string> = new Set(['dniAccessNumber']);

/** Well-known keys agents may use. */
export const AGENT_PERSONAL_FIELD_KEYS = PERSONAL_FIELDS.map((f) => f.key).filter(
  (key) => !AGENT_HIDDEN_PERSONAL_KEYS.has(key),
);

/** The DNI's CAN: the 6 digits printed at the bottom right of its front, labelled CAN. */
export const DniAccessNumber = z.string().regex(/^[0-9]{6}$/);

/**
 * One row of a driving licence's category table: category code (column 9), first issue date
 * (column 10), expiry date (column 11) and restriction codes (column 12).
 * `drivingLicenceCategories` stores these rows as JSON.
 */
/** EU driving licence categories (Directive 2006/126/EC, art. 4; RD 818/2009, art. 4). */
const LICENCE_CATEGORY_CODES = new Set('AM A1 A2 A B1 B BE C1 C1E C CE D1 D1E D DE'.split(' '));
export const LicenceCategory = z
  .object({
    category: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9+]{1,5}$/)
      // Older cards print trailer categories as "B+E".
      .refine((code) => LICENCE_CATEGORY_CODES.has(code.replace('+', '')), {
        message: 'category must be an EU driving licence category (AM, A1, A2, A, B, BE, C1…)',
      }),
    // One day of slack covers time zones.
    issueDate: z.iso
      .date()
      .refine((date) => date <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), {
        message: 'issueDate cannot be in the future',
      })
      .optional(),
    expiry: z.iso.date().optional(),
    restrictions: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type LicenceCategory = z.infer<typeof LicenceCategory>;
export const LicenceCategories = z.array(LicenceCategory).min(1).max(20);
export type LicenceCategories = z.infer<typeof LicenceCategories>;

/** Valid keys: a well-known key or "custom.<slug>". */
export const PersonalFieldKey = z
  .string()
  .regex(/^([a-zA-Z][a-zA-Z0-9]*|custom\.[a-z0-9][a-z0-9_-]{0,48})$/);

export const PersonalDataSource = z.enum(['manual', 'scan', 'agent', 'form']);
export type PersonalDataSource = z.infer<typeof PersonalDataSource>;

export const PersonalDataItem = z.object({
  key: PersonalFieldKey,
  /** Display label (well-known keys: from PERSONAL_FIELDS; custom keys: provided when saved). */
  label: z.string(),
  value: z.string().max(2000),
  source: PersonalDataSource,
  updatedAt: z.string(),
});
export type PersonalDataItem = z.infer<typeof PersonalDataItem>;

export const PersonalDataInput = z.object({
  key: PersonalFieldKey,
  value: z.string().max(2000),
  /** Required for custom keys. */
  label: z.string().max(160).optional(),
});
export type PersonalDataInput = z.infer<typeof PersonalDataInput>;

/** A personal data item the vault refused to save. `reason` is a fixed code, never a value. */
export const PersonalSaveIssue = z.object({
  key: PersonalFieldKey,
  reason: z.string().regex(/^[a-z_]{1,40}$/),
});
export type PersonalSaveIssue = z.infer<typeof PersonalSaveIssue>;

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------

export const DocumentSource = z.enum(['user', 'scan', 'download', 'agent']);
export type DocumentSource = z.infer<typeof DocumentSource>;

export const DocumentMeta = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  source: DocumentSource,
  /** Procedure that produced or uses this document, if any. */
  procedureId: z.string().optional(),
  createdAt: z.string(),
});
export type DocumentMeta = z.infer<typeof DocumentMeta>;

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

export const CredentialKind = z.enum([
  'clave_permanente', // username (DNI/NIE) + password (+ SMS code at login time)
  'clave_movil', // no stored secret: the user approves on their phone (Cl@ve app)
  'certificate', // X.509 certificate in a .p12/.pfx file + passphrase (e.g. FNMT Persona Física)
  'dnie', // the DNIe, read by the paired phone app over NFC (stored secret: its PIN)
]);
export type CredentialKind = z.infer<typeof CredentialKind>;

/**
 * The DNIe PIN: 8 to 16 characters. Typed on the desktop (Mis datos, or when a DNIe signature or
 * login needs it), kept in the vault on the DNIe credential and sent only to the paired phone,
 * inside the encrypted channel. Never shown to the renderer or the agent.
 */
export const DniePin = z.string().min(8).max(16);

export const CredentialPolicy = z.enum(['auto', 'ask']);
export type CredentialPolicy = z.infer<typeof CredentialPolicy>;

export const DEFAULT_CREDENTIAL_POLICY: Record<CredentialKind, CredentialPolicy> = {
  clave_permanente: 'auto',
  clave_movil: 'auto',
  certificate: 'ask',
  dnie: 'ask',
};

export const CertificateInfo = z.object({
  subject: z.string(),
  issuer: z.string(),
  serialNumber: z.string(),
  validFrom: z.string(),
  validTo: z.string(),
  /** Parsed from the subject when possible (FNMT: "APELLIDOS NOMBRE - 12345678Z"). */
  holderName: z.string().optional(),
  holderId: z.string().optional(),
  /** SHA-256 of the DER certificate, hex. */
  fingerprint: z.string(),
});
export type CertificateInfo = z.infer<typeof CertificateInfo>;

export const CredentialSummary = z.object({
  id: z.string(),
  kind: CredentialKind,
  label: z.string(),
  policy: CredentialPolicy,
  createdAt: z.string(),
  lastUsedAt: z.string().optional(),
  /** Masked username for Cl@ve Permanente, e.g. "•••••678Z". */
  usernameHint: z.string().optional(),
  /** `.p12` certificates; for the DNIe, its signing certificate once the phone has read it. */
  certificate: CertificateInfo.optional(),
  /** DNIe: whether the vault holds its PIN (the PIN itself never leaves main). */
  hasPin: z.boolean().optional(),
});
export type CredentialSummary = z.infer<typeof CredentialSummary>;

// ---------------------------------------------------------------------------------------------
// Overview (transparency screen)
// ---------------------------------------------------------------------------------------------

export const StorageInfo = z.object({
  /** e.g. "macOS Keychain", "Windows DPAPI", "libsecret", "basic_text", "test". */
  backend: z.string(),
  /** False when the OS offers no real protection (e.g. Linux without a keyring). */
  secure: z.boolean(),
  biometricAvailable: z.boolean(),
});
export type StorageInfo = z.infer<typeof StorageInfo>;

export const SecretSummary = z.object({
  id: z.string(),
  /** e.g. "Clave de OpenRouter (bono)". */
  label: z.string(),
  createdAt: z.string(),
});
export type SecretSummary = z.infer<typeof SecretSummary>;

export const VaultOverview = z.object({
  personal: z.array(PersonalDataItem),
  documents: z.array(DocumentMeta),
  credentials: z.array(CredentialSummary),
  storage: StorageInfo,
});
export type VaultOverview = z.infer<typeof VaultOverview>;

export function personalFieldDef(key: string): PersonalFieldDef | undefined {
  return PERSONAL_FIELDS.find((f) => f.key === key);
}

/** Mask all but the last `visible` characters: "12345678Z" -> "•••••678Z". */
export function maskValue(value: string, visible = 4): string {
  if (value.length <= visible) return '•'.repeat(value.length);
  return '•'.repeat(Math.min(5, value.length - visible)) + value.slice(-visible);
}
