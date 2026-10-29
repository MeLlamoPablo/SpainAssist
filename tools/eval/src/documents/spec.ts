/**
 * The documents a persona holds (the paper contract of a car sale, the vehicle's papers, the
 * receipts of the taxes and fees it paid), described as plain data. A fixture keeps the spec, not
 * the bytes: the spec is part of the fixture's digest, and `renderDocument` draws the same file from
 * it every time. Every value is synthetic.
 */

/** A person or a company as a document names it. */
export interface DocumentParty {
  /** As printed: "DELGADO PEÑA, ROCÍO" or "AUTOMOVILES GUADAIRA SL". */
  name: string;
  /** DNI, NIE or CIF. */
  nif: string;
  /** One line: street, number, floor. */
  street: string;
  postalCode: string;
  municipality: string;
  province: string;
}

/** The vehicle as its papers describe it. */
export interface DocumentVehicle {
  plate: string;
  /** `turismo` (M1) or `ciclomotor` (L1e). */
  category: 'turismo' | 'ciclomotor';
  make: string;
  model: string;
  /** Commercial version, as the ficha técnica prints it. */
  version: string;
  vin: string;
  /** YYYY-MM-DD. */
  firstRegistration: string;
  fuel: 'GASOLINA' | 'DIESEL';
  cc: number;
  kw: number;
  seats: number;
  /** Kilograms. */
  mass: number;
  /** The ITV inspections stamped on the ficha: date (YYYY-MM-DD) and the next one due. */
  inspections?: { date: string; result: 'FAVORABLE' | 'DESFAVORABLE'; nextDue: string }[];
}

/**
 * How a photographed paper looks: a phone picture on a table, slightly turned. `seed` drives the
 * small irregularities (ink, signature strokes, noise), so the same spec is the same picture.
 */
export interface PhotoLook {
  seed: number;
  /** Degrees, small (the paper is a bit askew). */
  angle: number;
}

/** A contract of sale between private persons, printed form filled in by hand, signed by both. */
export interface ContratoSpec {
  kind: 'contrato';
  /** Where and when it was signed: YYYY-MM-DD and HH:MM. */
  place: string;
  date: string;
  time: string;
  seller: DocumentParty;
  buyer: DocumentParty;
  vehicle: DocumentVehicle;
  /** Euros. */
  price: number;
  km: number;
  photo: PhotoLook;
}

/** The permiso de circulación (EU-harmonised codes), in the seller's name. */
export interface PermisoSpec {
  kind: 'permiso';
  holder: DocumentParty;
  vehicle: DocumentVehicle;
  /** YYYY-MM-DD: when this permiso was issued (the seller's transfer). */
  issued: string;
  photo: PhotoLook;
}

/** The ficha técnica (tarjeta ITV) with its inspection stamps. */
export interface FichaSpec {
  kind: 'ficha';
  vehicle: DocumentVehicle;
  photo: PhotoLook;
}

/** The receipt of a modelo 621 (ITP on a used vehicle) presented and paid online in Andalucía. */
export interface Modelo621Spec {
  kind: 'modelo621';
  /** The 13-digit document number (621 + 10 digits). */
  number: string;
  buyer: DocumentParty;
  seller: DocumentParty;
  vehicle: DocumentVehicle;
  /** YYYY-MM-DD: the contract (devengo). */
  accrual: string;
  /** Euros: the declared value, the taxable base, the rate in percent. */
  declaredValue: number;
  base: number;
  rate: number;
  /** YYYY-MM-DDTHH:MM: presentation and payment. */
  paidAt: string;
  /** Número de Referencia Completo of the bank payment. */
  nrc: string;
}

/** The receipt of a DGT fee (modelo 791) bought online; its last page lists the fee number. */
export interface Tasa791Spec {
  kind: 'tasa791';
  payer: DocumentParty;
  /** The 12-digit fee number. */
  number: string;
  /** `1.5` (transferencia), `1.2` (ciclomotor), `4.1` (informes). */
  tasa: '1.5' | '1.2' | '4.1';
  /** Euros. */
  amount: number;
  /** YYYY-MM-DDTHH:MM. */
  paidAt: string;
}

/** A dealer's invoice for a used car (VAT included: no ITP). */
export interface FacturaSpec {
  kind: 'factura';
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  dealer: DocumentParty & { phone: string; email: string };
  buyer: DocumentParty;
  vehicle: DocumentVehicle;
  km: number;
  /** Euros, VAT included. */
  total: number;
  /** Percent. */
  vatRate: number;
}

export type DocumentSpec =
  | ContratoSpec
  | PermisoSpec
  | FichaSpec
  | Modelo621Spec
  | Tasa791Spec
  | FacturaSpec;

/** One document of a persona (`FixtureSeed.documents`). */
export interface FixtureDocument {
  /** What the rules call it: `contrato`, `itp`, `tasa`, ... Unique in a fixture. */
  key: string;
  /** The file's name, as the user has it ("WhatsApp Image ... .jpeg", "Justificante_621.pdf"). */
  name: string;
  /**
   * Saved in the user's documents before the run. Otherwise the user has it at hand and uploads
   * it when a form asks for it.
   */
  saved: boolean;
  /**
   * Case-insensitive regex (source) tested against a document field's label and key: the fields
   * this document answers ("contrato|compraventa").
   */
  match: string;
  spec: DocumentSpec;
}

/** What `spec` renders to: a photo or a PDF. */
export function documentMimeType(spec: DocumentSpec): 'image/jpeg' | 'application/pdf' {
  return spec.kind === 'contrato' || spec.kind === 'permiso' || spec.kind === 'ficha'
    ? 'image/jpeg'
    : 'application/pdf';
}
