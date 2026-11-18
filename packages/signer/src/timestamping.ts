/**
 * Which timestamp authorities sign our PDF signatures, and the step that makes a fresh PAdES
 * signature long-term (B-LT) without ever failing the signature itself.
 *
 * The defaults are free TSAs that Acrobat trusts out of the box (docs/research/pades-ltv.md):
 *  1. DigiCert: chains to DigiCert Trusted Root G4, in Adobe's AATL without policy restrictions.
 *  2. Sectigo's qualified TSA: a qualified timestamp service on Spain's EU trusted list (Acrobat
 *     loads the EU lists). Sectigo asks scripts to wait 15 s between requests; one per signature
 *     is far from that.
 *  3. Izenpe: a Spanish qualified service on the EU list; free up to a monthly quota.
 * Sectigo's plain timestamp.sectigo.com, GlobalSign's public TSAs, SSL.com and Entrust were left
 * out: their chains don't satisfy Acrobat's trust list.
 *
 * A site that asks AutoFirma for a timestamp (tsaURL and friends) gets its TSA first, configured
 * the way AutoFirma configures it; ours follow as fallbacks.
 */
import { digestFromAny } from './algorithms';
import { AfirmaError } from './errors';
import type { ExtraParams } from './extra-params';
import { type PadesLevel, upgradePades } from './ltv';
import type { TsaEndpoint } from './tsp';

export const DEFAULT_TSAS: readonly TsaEndpoint[] = [
  { url: 'http://timestamp.digicert.com' },
  { url: 'http://timestamp.sectigo.com/qualified' },
  { url: 'http://tsa.izenpe.com' },
];

/** AutoFirma's TSA policy when the site gives a tsaURL and no tsaPolicy (TsaParams). */
const AUTOFIRMA_TSA_POLICY = '0.4.0.2023.1.1';

export interface Timestamping {
  tsas: TsaEndpoint[];
  /** AutoFirma's tsType 2 (document) or 3 (signature and document). */
  documentTimestamp: boolean;
}

/** The TSAs for a signature, the site's (AutoFirma's parameters) before `defaults`. */
export function timestampingFor(
  params: ExtraParams,
  defaults: readonly TsaEndpoint[] = DEFAULT_TSAS,
): Timestamping {
  const url = params.tsaURL?.trim();
  const site: TsaEndpoint[] = [];
  if (url && /^https?:\/\//i.test(url)) {
    site.push({
      url,
      policy: params.tsaPolicy?.trim() || AUTOFIRMA_TSA_POLICY,
      // AutoFirma hashes with SHA-512 unless told otherwise.
      digest: digestFromAny(params.tsaHashAlgorithm ?? '') ?? 'sha512',
      ...(params.tsaUsr ? { username: params.tsaUsr, password: params.tsaPwd ?? '' } : {}),
    });
  }
  const tsType = params.tsType?.trim();
  return {
    tsas: [...site, ...defaults.filter((d) => d.url !== url)],
    documentTimestamp: tsType === '2' || tsType === '3',
  };
}

export interface LongTermOptions {
  /** The network for TSAs, OCSP responders and CRLs. */
  fetch: typeof fetch;
  /** Our TSAs, in order (default DEFAULT_TSAS). */
  tsas?: readonly TsaEndpoint[];
  /** CA certificates to complete chains with (the DNIe's, which the card doesn't send). */
  authorities?: readonly Uint8Array[];
  /** Per network request. */
  timeoutMs?: number;
  logger?: {
    info?(msg: string, data?: unknown): void;
    warn?(msg: string, data?: unknown): void;
  };
}

/**
 * Makes a just-signed PDF long-term (B-LT; B-LTA when the site asked for a document timestamp).
 * Whatever goes wrong on the network leaves the signature as it was, still valid; only a signing
 * certificate its CA declares revoked stops it (AfirmaError).
 */
export async function makeLongTerm(
  pdf: Buffer,
  params: ExtraParams,
  o: LongTermOptions,
): Promise<{ pdf: Buffer; level: PadesLevel }> {
  const { tsas, documentTimestamp } = timestampingFor(params, o.tsas ?? DEFAULT_TSAS);
  try {
    const upgraded = await upgradePades(pdf, {
      fetch: o.fetch,
      tsas,
      documentTimestamp,
      ...(o.authorities ? { authorities: [...o.authorities] } : {}),
      ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
      ...(o.logger ? { logger: o.logger } : {}),
    });
    return { pdf: upgraded.pdf, level: upgraded.level };
  } catch (e) {
    if (e instanceof AfirmaError && e.revoked) throw e;
    o.logger?.warn?.('long-term signature failed; kept as signed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { pdf, level: 'B-B' };
  }
}
