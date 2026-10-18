/**
 * The phone sends only the DNIe's leaf certificate. Strict TLS servers and PAdES validators
 * (Adobe) want the issuing intermediate too, so the paths given to the sidecar and the signer are
 * completed here from the DNIe CA certificates the app ships (`dnie-ca/README.md`).
 */
import { X509Certificate } from 'node:crypto';
import { completeChain } from '@sa/signer';
import { AC_DNIE_004, AC_DNIE_005, AC_DNIE_006, AC_RAIZ_DNIE_2 } from './dnie-ca/certificates';

/** DER of the DNIe CAs: the intermediates, then the root. */
export const DNIE_AUTHORITIES: readonly Uint8Array[] = [
  AC_DNIE_004,
  AC_DNIE_005,
  AC_DNIE_006,
  AC_RAIZ_DNIE_2,
].map((pem) => new X509Certificate(pem).raw);

/**
 * `certificates` (leaf first) followed by the DNIe CA that issued the leaf, verified by
 * signature. `signature` (CAdES, XAdES, PAdES) also ends with the root, so the signature
 * carries the whole path; `tls` leaves it out, as TLS does. A leaf from an unknown CA comes
 * back alone.
 */
export function dnieChain(
  certificates: Uint8Array[],
  use: 'tls' | 'signature',
  authorities: readonly Uint8Array[] = DNIE_AUTHORITIES,
): Uint8Array[] {
  return completeChain(certificates, [...authorities], { root: use === 'signature' });
}
