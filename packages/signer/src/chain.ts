/**
 * Certificate paths for keys whose source gives only the signing certificate (the DNIe in the
 * paired phone sends its leaf alone): the app completes the path from CA certificates it ships.
 */
import crypto from 'node:crypto';

/** `child` was issued by `parent`: names match and `parent`'s key verifies the signature. */
export function issuedBy(child: crypto.X509Certificate, parent: crypto.X509Certificate): boolean {
  try {
    return child.checkIssued(parent) && child.verify(parent.publicKey);
  } catch {
    return false;
  }
}

export interface CompleteChainOptions {
  /**
   * Also append the self-signed root when the path reaches one. TLS leaves it out (the server
   * has its own trust anchors); signatures conventionally carry it.
   */
  root?: boolean;
}

const MAX_DEPTH = 10;

/**
 * Extends `chain` (leaf first) with the `authorities` that issued its last certificate, then
 * theirs, each verified by signature. Stops at a root or at a certificate no authority issued:
 * an unknown CA leaves `chain` as it was. Returns new DER buffers; the input is not modified.
 */
export function completeChain(
  chain: Uint8Array[],
  authorities: Uint8Array[],
  options: CompleteChainOptions = {},
): Buffer[] {
  const out: Buffer[] = chain.map((c) => Buffer.from(c));
  const last = out.at(-1);
  if (!last) return out;
  let current: crypto.X509Certificate;
  let pool: { der: Buffer; cert: crypto.X509Certificate }[];
  try {
    current = new crypto.X509Certificate(last);
    pool = authorities
      .map((a) => Buffer.from(a))
      .filter((der) => !out.some((c) => c.equals(der)))
      .map((der) => ({ der, cert: new crypto.X509Certificate(der) }));
  } catch {
    return out;
  }
  for (let depth = out.length; depth < MAX_DEPTH; depth++) {
    if (current.subject === current.issuer && issuedBy(current, current)) {
      // `chain` itself ended in a root it should not carry: keep what the caller gave.
      break;
    }
    const idx = pool.findIndex((p) => issuedBy(current, p.cert));
    if (idx < 0) break;
    const [next] = pool.splice(idx, 1);
    if (!next) break;
    const selfSigned = next.cert.subject === next.cert.issuer && issuedBy(next.cert, next.cert);
    if (selfSigned && !options.root) break;
    out.push(next.der);
    current = next.cert;
  }
  return out;
}
