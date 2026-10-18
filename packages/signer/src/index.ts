/**
 * @sa/signer — built-in replacement for AutoFirma.
 *
 *  - AUTOSCRIPT_SHIM_SOURCE / buildAutoscriptShimSource(): in-page script (injected by
 *    @sa/browser into every frame before site scripts run) that traps the site's `AutoScript` /
 *    `MiniApplet` globals and forwards signing calls to the AFIRMA_BINDING exposed by the browser.
 *  - afirmaHandler / createAfirmaHandler(): Node-side implementation of those calls (sign,
 *    coSign, counterSign, signAndSaveToFile, selectCertificate, signBatchProcess, signBatch...),
 *    including triphase and batch signing against the site's servers, using the user's .p12 after explicit approval.
 *  - Low-level signers: CAdES, XAdES, PAdES, PKCS#1 producing AutoFirma-compatible output with
 *    RSA or EC keys, through a `KeySigner`: a .p12 key in memory, or an external key (the DNIe
 *    in the paired phone).
 *  - readP12 / openP12: PKCS#12 reading (RSA + EC, legacy RC2/3DES).
 *
 * Plain Node library; no Electron imports.
 */
export type { DigestName, ResolvedAlgorithm, SignatureAlgorithm } from './algorithms';
export { resolveAlgorithm } from './algorithms';
export {
  type CadesSignOptions,
  type CountersignTarget,
  cosignCades,
  countersignCades,
  createCades,
} from './cades';
export { certificateInfo, parseHolder } from './certificate';
export { type CompleteChainOptions, completeChain } from './chain';
export { AfirmaError, CANCELLED_TYPE, GENERIC_TYPE } from './errors';
export { type ExtraParams, parseExtraParams, storeExtraParams } from './extra-params';
export {
  type AfirmaHandlerOptions,
  afirmaHandler,
  createAfirmaHandler,
  type FilePickRequest,
  type FileSaveRequest,
  type PickedFile,
} from './handler';
export {
  externalIdentity,
  type KeySigner,
  type KeySignOptions,
  keyObjectSigner,
  p12Identity,
  type SignerIdentity,
} from './key';
export {
  type EncodeP12Options,
  encodeP12,
  type KeyType,
  openP12,
  type P12Contents,
  P12Error,
  type P12ErrorCode,
  type P12Identity,
  readP12,
} from './p12';
export { createPades, type PadesSignOptions } from './pades';
export { expandPolicy, FIRMA_AGE, readPolicy, type SignaturePolicy } from './policy';
export {
  AUTOSCRIPT_SHIM_SOURCE,
  type AutoscriptShimConfig,
  type AutoscriptShimHandle,
  type AutoscriptShimOptions,
  buildAutoscriptShimSource,
  DEFAULT_AUTOSCRIPT_VERSION,
  installAutoscriptShim,
} from './shim';
export { batchSign, type TriphaseOptions, triphaseSign } from './triphase';
export { createXades, type XadesSignOptions, xadesVariant } from './xades';
