/**
 * Signing a PDF of the user's own (Mis documentos) with no site involved: always a visible
 * PAdES signature with our handwritten appearance, where the user placed it (or where
 * `defaultPlacement` puts it), made long-term (B-LT) when `longTerm` is given. The approval,
 * with its box, is the app's.
 */
import type { SignaturePlacement, SigningKey } from '@sa/shared';
import { resolveAlgorithm } from './algorithms';
import { checkValidity, openCertificate } from './handler';
import { createPades } from './pades';
import { type LongTermOptions, makeLongTerm } from './timestamping';
import { signatureAppearance } from './visible';

export interface SignPdfOptions {
  pdf: Uint8Array;
  /** The approved key; released here, whatever happens. */
  key: SigningKey;
  placement: SignaturePlacement;
  /** The script font of the signature (TrueType). */
  signatureFont?: Uint8Array;
  /** Makes the signature long-term (B-LT); without it, PAdES-B-B. */
  longTerm?: LongTermOptions;
  now?: Date;
}

export async function signPdf(o: SignPdfOptions): Promise<Buffer> {
  const now = o.now ?? new Date();
  let identity: ReturnType<typeof openCertificate>;
  try {
    identity = openCertificate(o.key);
    checkValidity(identity, now);
  } catch (e) {
    if (o.key.kind === 'external') o.key.release(false);
    throw e;
  }
  let signed: Buffer;
  try {
    signed = await createPades({
      pdf: Buffer.from(o.pdf),
      algorithm: resolveAlgorithm('SHA256withRSA', identity.keyType),
      signer: identity.signer,
      chain: identity.chainDer,
      params: {},
      signingTime: now,
      visible: {
        pages: [o.placement.page],
        rect: o.placement.rect,
        appearance: signatureAppearance({
          certificateDer: identity.certificateDer,
          ...(o.key.displayName ? { displayName: o.key.displayName } : {}),
          params: {},
          date: now,
          ...(o.signatureFont ? { scriptFont: o.signatureFont } : {}),
        }),
      },
    });
    identity.release(true);
  } catch (e) {
    identity.release(false);
    throw e;
  }
  // After the release: the network never holds up the approval.
  return o.longTerm ? (await makeLongTerm(signed, {}, o.longTerm)).pdf : signed;
}
