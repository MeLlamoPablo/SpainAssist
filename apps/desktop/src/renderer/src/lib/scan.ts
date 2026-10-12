/** Fields extracted by scanning. Values are vault personal-data values. */
export { SCAN_KEYS as SCAN_FIELD_KEYS } from '../../../scanner';

import type { DocumentFields } from '../../../scanner';
export type ScannedFields = DocumentFields;

export interface ScanOutcome {
  fields: ScannedFields;
  /** The document never expires (Spanish DNI "permanente"). */
  permanent: boolean;
}
