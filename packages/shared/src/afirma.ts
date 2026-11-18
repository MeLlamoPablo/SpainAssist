/**
 * Contract between the in-page AutoFirma replacement ("shim", injected into every page of the
 * agent's browser) and the Node side (main process) that performs the signatures.
 *
 * Flow: site JS calls e.g. AutoScript.sign(dataB64, algorithm, format, params, ok, ko)
 *   -> shim serializes the call into an AfirmaCall and invokes the exposed binding
 *      window[AFIRMA_BINDING](call)
 *   -> Node: AfirmaHandler(call, ctx) asks the user for confirmation, signs with the .p12
 *   -> returns AfirmaReply; the shim invokes the site's success / error callback.
 */

/** Name of the Playwright binding exposed to pages. */
export const AFIRMA_BINDING = '__saAfirma';

/**
 * `AfirmaCall.method` of the shim's own diagnostics, sent through the same binding. Never an
 * AutoScript operation and never signs: the browser records it and answers `{ ok: true }`.
 * `args`: `[kind, detail]`, where kind is `'loaded'` (the page created its AutoScript object;
 * detail: its VERSION) or `'ignored'` (the page called an AutoScript method the shim doesn't
 * implement; detail: the method name).
 */
export const AFIRMA_NOTICE = 'shim.notice';

export interface AfirmaCall {
  /** AutoScript method name, e.g. "sign", "coSign", "counterSign", "signBatch", "selectCertificate". */
  method: string;
  /** JSON-serializable arguments without the callbacks (functions are stripped). */
  args: unknown[];
  /** Page origin and URL at call time (filled by the binding source, not trusted from the page). */
  origin: string;
  url: string;
}

export type AfirmaReply =
  | {
      ok: true;
      /** Arguments to pass to the site's success callback, e.g. [signatureB64, certificateB64]. */
      callbackArgs: unknown[];
    }
  | {
      ok: false;
      /** AutoScript-style error type, e.g. "es.gob.afirma.core.AOCancelledOperationException". */
      errorType: string;
      errorMessage: string;
    };

/**
 * Proof, for a key that checks what it signs (the DNIe in the paired phone), that the bytes to
 * sign belong to `AfirmaSignatureSummary.documents[document]`:
 * - `cms`: the bytes are CMS signed attributes whose messageDigest is the document's hash;
 * - `pades`: the signed PDF is the document followed by `update`, and the messageDigest is the
 *   hash of its `byteRange`.
 */
export type SignatureBinding =
  | { kind: 'cms'; document: number }
  | {
      kind: 'pades';
      document: number;
      update: Uint8Array;
      byteRange: [number, number, number, number];
    };

export type SignatureDigest = 'sha1' | 'sha256' | 'sha384' | 'sha512';

/** A `.p12` from the vault, for one operation. */
export interface P12SigningKey {
  kind: 'p12';
  credentialId: string;
  p12: Uint8Array;
  passphrase: string;
}

/** A key the app never holds: the DNIe in the paired phone (RSA, PKCS#1 v1.5). */
export interface ExternalSigningKey {
  kind: 'external';
  credentialId: string;
  /** DER, leaf (the signing certificate) first. */
  certificates: Uint8Array[];
  /**
   * The credential's other certificates (DER leaves), which this key can't sign with: the
   * DNIe's AUTENTICACIÓN certificate, when the phone sent it. Only for certificate filters.
   */
  otherCertificates?: Uint8Array[];
  /** Hashes `data` with `digest` and signs it. */
  sign(data: Uint8Array, digest: SignatureDigest, binding?: SignatureBinding): Promise<Uint8Array>;
  /**
   * The operation ended: `true` signed, `false` failed. Called exactly once. `refusal` says why
   * the signer refused the certificate the user approved (the site's certificate filters).
   */
  release(ok: boolean, refusal?: CertificateRefusal): void;
}

/**
 * Why the site's certificate filters (AutoFirma's `filters=`) refused the approved certificate:
 * - `no_match`: none of the credential's certificates matches;
 * - `authentication_only`: only the DNIe's AUTENTICACIÓN certificate matches, and documents are
 *   signed only with FIRMA.
 */
export type CertificateRefusal = 'no_match' | 'authentication_only';

/**
 * What the signer uses for one operation. Never leaves the main process. With a `placement`
 * request, `placement` is where the user put the visible signature (null: they chose none).
 * `displayName` is the signer's name as the visible signature writes it (Mis datos' spelling).
 */
export type SigningKey = (P12SigningKey | ExternalSigningKey) & {
  placement?: SignaturePlacement | null;
  displayName?: string;
};

/**
 * Where a visible PDF signature goes: a 1-based page and the box's lower-left and upper-right
 * corners in that page's default user space (points, before /Rotate).
 */
export interface SignaturePlacement {
  page: number;
  rect: [number, number, number, number];
}

/** A visible PDF signature to place or show in the approval (AutoFirma's visible PAdES). */
export interface SignaturePlacementRequest {
  /** `fixed`: the site chose the box and the card only shows it; `choose`: the user places it. */
  mode: 'fixed' | 'choose';
  /** The user may also sign without a visible signature (AutoFirma's `visibleSignature=optional`). */
  optional?: boolean;
  /** Where the box starts: the site's box, an empty signature field or the app's default. */
  initial?: SignaturePlacement;
  /** `handwritten`: our signature with the signer's name; `text`: the site's own text. */
  appearance: 'handwritten' | 'text';
}

export interface AfirmaDocument {
  name?: string;
  mimeType: string;
  data: Uint8Array;
}

export interface AfirmaSignatureSummary {
  method: string;
  format: string;
  algorithm: string;
  origin: string;
  /** Human readable description of what is being signed (file name, size...). */
  description: string;
  dataSize?: number;
  /** What is signed, in the order `SignatureBinding.document` refers to (empty: unknown). */
  documents: AfirmaDocument[];
  /** Every signature of the operation will carry a `SignatureBinding`. */
  verifiable: boolean;
  /** Signatures the operation makes, when more than one (batches). */
  signatures?: number;
  /** A visible signature on `documents[0]` (a PDF): the approval shows or places its box. */
  placement?: SignaturePlacementRequest;
}

export interface AfirmaHandlerContext {
  procedureId: string;
  /**
   * Ask the user to approve the signature (and pick a certificate if several). Resolves with the
   * certificate to use, or null if the user declined / has no certificate.
   */
  approveSignature(summary: AfirmaSignatureSummary): Promise<SigningKey | null>;
  /** Report the outcome so it can be shown to the agent and the user. */
  report(event: {
    status: 'signed' | 'rejected' | 'failed';
    format: string;
    origin: string;
    message?: string;
  }): void;
  /** fetch() used for triphase / remote servlets (injectable for tests). */
  fetch?: typeof fetch;
}

export type AfirmaHandler = (call: AfirmaCall, ctx: AfirmaHandlerContext) => Promise<AfirmaReply>;
