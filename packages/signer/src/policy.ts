/**
 * Signature policies. `expPolicy=FirmaAGE` is expanded like AutoFirma's ExtraParamsProcessor
 * (AGE policy v1.9, the one sedes ask for); explicit `policyIdentifier`/`policyIdentifierHash`/
 * `policyIdentifierHashAlgorithm`/`policyQualifier` params are honoured as AdESPolicy does.
 */
import { type DigestName, digestFromAny } from './algorithms';
import { AfirmaError } from './errors';
import type { ExtraParams } from './extra-params';

export type PolicyFormat = 'CAdES' | 'XAdES' | 'PAdES';

export interface SignaturePolicy {
  /** OID without the "urn:oid:" prefix. */
  oid: string;
  /** Identifier as configured (XAdES writes it as "urn:oid:..."). */
  identifier: string;
  hash: Buffer;
  hashAlgorithm: DigestName;
  qualifier?: string;
}

/** AGE signature policy v1.9 (hash verified against the published PDF). */
export const FIRMA_AGE = {
  oid: '2.16.724.1.3.1.1.2.1.9',
  hash: 'G7roucf600+f03r/o0bAOQ6WAs0=',
  hashAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
  qualifier: 'https://sede.administracion.gob.es/politica_de_firma_anexo_1.pdf',
} as const;

/** Data below this size gets `mode=implicit` under FirmaAGE when no mode was given. */
const IMPLICIT_THRESHOLD = 1_048_576;

/**
 * Applies `expPolicy` to a copy of the params, as AutoFirma does before signing.
 * Only "FirmaAGE" (v1.9) is supported; other names fail like AutoFirma's unsupported policies.
 */
export function expandPolicy(
  params: ExtraParams,
  format: PolicyFormat,
  dataSize: number | null,
): ExtraParams {
  const name = params.expPolicy;
  if (!name) return { ...params };
  if (name !== 'FirmaAGE') {
    throw AfirmaError.invalidParameter(`Politica de firma no soportada: ${name}`);
  }
  const out: ExtraParams = { ...params };
  delete out.expPolicy;
  out.policyIdentifier = format === 'XAdES' ? `urn:oid:${FIRMA_AGE.oid}` : FIRMA_AGE.oid;
  out.policyIdentifierHash = FIRMA_AGE.hash;
  out.policyIdentifierHashAlgorithm = FIRMA_AGE.hashAlgorithm;
  out.policyQualifier = FIRMA_AGE.qualifier;
  if (format === 'CAdES') {
    if (!out.mode && dataSize != null) {
      out.mode = dataSize < IMPLICIT_THRESHOLD ? 'implicit' : 'explicit';
    }
    out.profile = 'advanced';
  } else if (format === 'XAdES') {
    if (out.format !== 'XAdES Detached' && out.format !== 'XAdES Enveloped') {
      out.format = 'XAdES Detached';
    }
    out.profile = 'advanced';
  } else {
    const sub = out.signatureSubFilter;
    if (sub && sub !== 'ETSI.CAdES.detached') {
      throw AfirmaError.invalidParameter(
        `La politica FirmaAGE requiere el subfiltro ETSI.CAdES.detached (indicado: ${sub})`,
      );
    }
    out.signatureSubFilter = 'ETSI.CAdES.detached';
  }
  return out;
}

/** Reads the policy from (already expanded) params, or null if none is configured. */
export function readPolicy(params: ExtraParams): SignaturePolicy | null {
  const identifier = params.policyIdentifier?.trim();
  if (!identifier) return null;
  const oid = identifier.replace(/^urn:oid:/i, '');
  if (!/^\d+(\.\d+)+$/.test(oid)) {
    throw AfirmaError.invalidParameter(`Identificador de politica no valido: ${identifier}`);
  }
  const hashText = params.policyIdentifierHash?.trim();
  if (!hashText || hashText === '0') {
    // AutoFirma would download the policy document and hash it; not supported here.
    throw AfirmaError.invalidParameter('La politica de firma debe indicar su huella digital');
  }
  const algorithmText = params.policyIdentifierHashAlgorithm?.trim();
  const hashAlgorithm = algorithmText ? digestFromAny(algorithmText) : null;
  if (!hashAlgorithm) {
    throw AfirmaError.invalidParameter(
      `Algoritmo de huella de la politica no soportado: ${algorithmText ?? '(ninguno)'}`,
    );
  }
  const hash = Buffer.from(hashText, 'base64');
  const qualifier = params.policyQualifier?.trim() || undefined;
  return { oid, identifier, hash, hashAlgorithm, qualifier };
}
