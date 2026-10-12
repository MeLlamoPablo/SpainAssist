/** AutoScript `format` strings → what we do with them. */
import { isCadesSignature } from './cades';
import { AfirmaError } from './errors';
import { isFacturae, isPdf, looksLikeXml } from './mime';
import type { TriphaseFormat } from './triphase';

export type FormatFamily =
  | 'CAdES'
  | 'XAdES'
  | 'PAdES'
  | 'NONE'
  | 'FacturaE'
  | 'CAdES-ASiC-S'
  | 'XAdES-ASiC-S';

export interface FormatSpec {
  /** As the page sent it. */
  requested: string;
  /** null for "AUTO" until resolved from the data. */
  family: FormatFamily | null;
  /** `*tri` formats: the site's server builds the signature. */
  triphase: boolean;
}

/** Families we can produce locally (others need the site's triphase server). */
export const LOCAL_FAMILIES: ReadonlySet<FormatFamily> = new Set([
  'CAdES',
  'XAdES',
  'PAdES',
  'NONE',
]);

const FORMATS: Record<string, { family: FormatFamily; triphase?: boolean }> = {
  cades: { family: 'CAdES' },
  'cms/pkcs#7': { family: 'CAdES' },
  cms: { family: 'CAdES' },
  cadestri: { family: 'CAdES', triphase: true },
  'cades-asic-s': { family: 'CAdES-ASiC-S' },
  'cades-asic-s-tri': { family: 'CAdES-ASiC-S', triphase: true },
  xades: { family: 'XAdES' },
  'xades detached': { family: 'XAdES' },
  'xades enveloping': { family: 'XAdES' },
  'xades enveloped': { family: 'XAdES' },
  'xades externally detached': { family: 'XAdES' },
  xmldsig: { family: 'XAdES' },
  'xmldsig detached': { family: 'XAdES' },
  'xmldsig enveloping': { family: 'XAdES' },
  'xmldsig enveloped': { family: 'XAdES' },
  'xmldsig externally detached': { family: 'XAdES' },
  xadestri: { family: 'XAdES', triphase: true },
  'xades-asic-s': { family: 'XAdES-ASiC-S' },
  'xades-asic-s-tri': { family: 'XAdES-ASiC-S', triphase: true },
  pades: { family: 'PAdES' },
  'adobe pdf': { family: 'PAdES' },
  padestri: { family: 'PAdES', triphase: true },
  'adobe pdf triphase': { family: 'PAdES', triphase: true },
  none: { family: 'NONE' },
  pkcs1: { family: 'NONE' },
  'pkcs#1': { family: 'NONE' },
  nonetri: { family: 'NONE', triphase: true },
  facturae: { family: 'FacturaE' },
  'factura-e': { family: 'FacturaE' },
  facturaetri: { family: 'FacturaE', triphase: true },
};

export function parseFormat(format: string | null | undefined): FormatSpec {
  const requested =
    format == null || String(format).trim() === '' ? 'CAdES' : String(format).trim();
  const key = requested.toLowerCase();
  if (key === 'auto') return { requested, family: null, triphase: false };
  const f = FORMATS[key];
  if (!f) throw AfirmaError.unsupportedFormat(requested);
  return { requested, family: f.family, triphase: !!f.triphase };
}

export function triphaseFormatOf(family: FormatFamily): TriphaseFormat {
  return family;
}

/** AutoFirma's AUTO for sign: PDF → PAdES, FacturaE, XML → XAdES, anything else → CAdES. */
export function detectFormatForSign(data: Uint8Array): FormatFamily {
  if (isPdf(data)) return 'PAdES';
  if (isFacturae(data)) return 'FacturaE';
  if (looksLikeXml(data)) return 'XAdES';
  return 'CAdES';
}

/** AUTO for cosign / countersign: the format of the existing signature. */
export function detectFormatForSignature(signature: Uint8Array): FormatFamily {
  if (isPdf(signature)) return 'PAdES';
  if (isCadesSignature(signature)) return 'CAdES';
  if (looksLikeXml(signature)) {
    const text = Buffer.from(signature).toString('utf8');
    if (text.includes('http://www.w3.org/2000/09/xmldsig#')) return 'XAdES';
  }
  throw AfirmaError.notSignature();
}
