import type { LicenceCategory } from '@sa/shared';

/** Desktop-only scanner API; the shared renderer/agent contracts stay unchanged. */
export const SCANNER_CHANNEL = 'sa:scanner';
/** Personal fields describe the person; document fields describe one particular document. */
export const SCAN_PERSONAL_KEYS = [
  'givenName',
  'surname1',
  'surname2',
  'birthDate',
  'birthPlace',
  'sex',
  'nationality',
  'fatherName',
  'motherName',
  'addressStreet',
  'addressPostalCode',
  'addressMunicipality',
  'addressProvince',
  'addressCountry',
] as const;
export const SCAN_COMMON_PERSONAL_KEYS = [
  'givenName',
  'surname1',
  'surname2',
  'birthDate',
  'birthPlace',
] as const;
const identity = [...SCAN_COMMON_PERSONAL_KEYS, 'sex', 'nationality'] as const;
const address = [
  'addressStreet',
  'addressMunicipality',
  'addressProvince',
  'addressCountry',
] as const;
const documentBasics = ['documentNumber', 'documentIssueDate', 'documentExpiry'] as const;

export const SCAN_PERSONAL_KEYS_BY_TYPE = {
  DNI: [...identity, 'fatherName', 'motherName', ...address],
  TIE: [...identity, ...address, 'addressPostalCode'],
  PASSPORT: identity,
  DRIVING_LICENCE: SCAN_COMMON_PERSONAL_KEYS,
} as const;
export const SCAN_DOCUMENT_KEYS_BY_TYPE = {
  DNI: [...documentBasics, 'documentSupportNumber', 'dniIssuingTeam', 'dniAccessNumber'],
  TIE: [...documentBasics, 'documentSupportNumber', 'residencePermitType', 'documentRemarks'],
  PASSPORT: [...documentBasics, 'documentIssuingAuthority', 'passportPersonalNumber'],
  DRIVING_LICENCE: [
    ...documentBasics,
    'documentIssuingAuthority',
    'documentRemarks',
    'drivingCategories',
  ],
} as const;
export type ScanDocumentType = keyof typeof SCAN_DOCUMENT_KEYS_BY_TYPE;
export const SCAN_KEYS = [
  ...SCAN_PERSONAL_KEYS,
  'documentType',
  ...new Set(Object.values(SCAN_DOCUMENT_KEYS_BY_TYPE).flat()),
] as const;
export type ScanFieldKey = (typeof SCAN_KEYS)[number];
type FieldValue<Key extends ScanFieldKey> = Key extends 'drivingCategories'
  ? LicenceCategory[]
  : string;
/** Partial checkpoints may arrive before the document type is known. */
export type DocumentFields = { [Key in ScanFieldKey]?: FieldValue<Key> };
type AllowedField<Type extends ScanDocumentType> =
  | (typeof SCAN_PERSONAL_KEYS_BY_TYPE)[Type][number]
  | (typeof SCAN_DOCUMENT_KEYS_BY_TYPE)[Type][number];
/** A completed result cannot mix fields from different document types. */
export type CompletedDocumentFields = {
  [Type in ScanDocumentType]: {
    documentType: Type;
    documentNumber: string;
    givenName: string;
  } & { [Key in AllowedField<Type>]?: FieldValue<Key> } & Partial<
      Record<Exclude<ScanFieldKey, AllowedField<Type> | 'documentType'>, never>
    >;
}[ScanDocumentType];

export function scanFieldKeys(type: ScanDocumentType): readonly ScanFieldKey[] {
  return [...SCAN_PERSONAL_KEYS_BY_TYPE[type], ...SCAN_DOCUMENT_KEYS_BY_TYPE[type]];
}
export interface ScannerStatus {
  available: boolean;
  reason?: 'no_provider' | 'no_vision' | 'no_fast_mode';
  provider?: string;
  model?: string;
}
export interface CameraAccess {
  granted: boolean;
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';
  settingsAvailable: boolean;
}
export interface CameraEvent {
  stage: 'starting' | 'ready' | 'failed' | 'timeout';
  errorName?: string;
}
export type ScanGuidance =
  | { state: 'positioning' | 'legibility' | 'reading' }
  | { state: 'feedback'; reason: string; success: boolean };

export type ScannerEvent =
  | { sessionId: string; type: 'capture'; requestId: string }
  | { sessionId: string; type: 'guidance'; guidance: ScanGuidance }
  | { sessionId: string; type: 'retain_guidance' }
  | { sessionId: string; type: 'complete'; fields: DocumentFields; permanent: boolean }
  | { sessionId: string; type: 'error'; message: string };

/** @public Used by `renderer/env.d.ts` through an inline `import()` type. */
export interface ScannerApi {
  start(sessionId: string, source?: 'camera' | 'photo'): Promise<void>;
  frames(sessionId: string, requestId: string, images: string[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  on(listener: (event: ScannerEvent) => void): () => void;
  requestCamera(): Promise<CameraAccess>;
  openCameraSettings(): Promise<void>;
  cameraEvent(event: CameraEvent): Promise<void>;
  status(): Promise<ScannerStatus>;
  read(dataUrl: string): Promise<DocumentFields>;
}
