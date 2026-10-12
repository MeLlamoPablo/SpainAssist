export type PiiType =
  | 'dni' // DNI, NIF K/L/M and DNI support numbers
  | 'nie'
  | 'cif'
  | 'passport'
  | 'nuss' // Social Security number (NUSS / NAF)
  | 'iban'
  | 'ccc' // 20-digit Spanish bank account (código cuenta cliente)
  | 'card' // payment card numbers (Luhn)
  | 'phone'
  | 'email'
  | 'address' // street addresses ("Calle Mayor 5, 3ºB")
  | 'postal_code'
  | 'plate' // vehicle license plates
  | 'cadastral_ref' // referencia catastral
  | 'date_of_birth'
  | 'case_number' // expediente, registro, justificante, localizador, CSV… numbers
  | 'name' // person names in explicit context ("me llamo …", "Sr. …", "a nombre de …")
  | 'url_params' // query strings / fragments that may carry ids or tokens
  | 'ip'
  | 'known_value'; // exact match against values supplied by the caller (e.g. the user's vault)

export const PII_TYPES: readonly PiiType[] = [
  'dni',
  'nie',
  'cif',
  'passport',
  'nuss',
  'iban',
  'ccc',
  'card',
  'phone',
  'email',
  'address',
  'postal_code',
  'plate',
  'cadastral_ref',
  'date_of_birth',
  'case_number',
  'name',
  'url_params',
  'ip',
  'known_value',
];

export interface PiiFinding {
  type: PiiType;
  start: number;
  end: number;
  /** The matched text. Never log it. */
  match: string;
}

export interface ScrubOptions {
  /** Values that must be removed wherever they appear (case/accent/space-insensitive). */
  knownValues?: string[];
  /** Types to leave untouched (e.g. keep postal codes). */
  allow?: PiiType[];
  /** Replacement for each type; default "[DNI]", "[EMAIL]", ... */
  placeholder?: (type: PiiType) => string;
}

export interface ScrubResult {
  text: string;
  findings: Omit<PiiFinding, 'match'>[];
}

/** A detection before overlaps are merged. */
export interface Span {
  type: PiiType;
  start: number;
  end: number;
}
