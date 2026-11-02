/**
 * Contract between the in-page stand-in for FNMT's Configurador (the `FnmtCertRequest` shim,
 * injected into every page of the agent's browser) and the main process, which makes the key and
 * the certificate request and keeps the pending key in the vault (docs/research/fnmt.md §7).
 *
 * Flow: FNMT's page calls FnmtCertRequest.requestCert(ok, ko, keyType, keyLength, csrType,
 * forceCard) or FnmtCertRequest.installCert(ok, ko, cert)
 *   -> the shim sends an FnmtCall through window[FNMT_BINDING](call)
 *   -> main: generates the key once the user approves / turns the certificate into a vault
 *      credential
 *   -> FnmtReply; the shim calls the page's ok or ko callback.
 */
import { z } from 'zod';

/** Name of the Playwright binding exposed to pages. */
export const FNMT_BINDING = '__saFnmt';

/**
 * `FnmtCall.method` of the shim's own diagnostics: `args` is `[kind, detail]`, where kind is
 * `'loaded'` (the page created its FnmtCertRequest object; detail: its VERSION) or `'ignored'`
 * (the page called a method the shim doesn't implement; detail: its name). Never generates or
 * installs anything.
 */
export const FNMT_NOTICE = 'shim.notice';

export type FnmtMethod = 'requestCert' | 'installCert';

export interface FnmtCall {
  method: FnmtMethod | typeof FNMT_NOTICE;
  /**
   * The page's arguments without the callbacks:
   * - requestCert: [keyType, keyLength, csrType, forceCard] (each may be null or undefined);
   * - installCert: [cert] (base64 or base64url, maybe gzipped, of a PKCS#7 bundle or an X.509).
   */
  args: unknown[];
  /** Page origin and URL at call time (filled by the browser from the calling frame). */
  origin: string;
  url: string;
}

export type FnmtReply =
  | {
      ok: true;
      /** requestCert: the PKCS#10 in standard base64. installCert: FNMT_INSTALLED. */
      result?: string;
    }
  | {
      ok: false;
      /** Java-style type the page shows or checks, e.g. "java.lang.Exception". */
      errorType: string;
      errorMessage: string;
    };

/**
 * installCert's result: base64 of `OK`, what the Configurador's answer decrypts to. FNMT's
 * download page (`descarga.js`) decodes it with `atob` and shows its success panel only if it
 * trims to `OK`; with no result `atob` throws (docs/research/fnmt.md §2.1).
 */
export const FNMT_INSTALLED = 'T0s=';

/** Error types the shim and the main process answer with. */
export const FNMT_ERROR = {
  /** The user declined, or closed the prompt. */
  cancelled: 'es.gob.fnmt.cert.certrequest.CancelledOperationException',
  /** `forceCard === true`: a smart card is required, which the app doesn't support. */
  cardNotSupported: 'es.gob.fnmt.cert.certrequest.CardNotSupportedException',
  /** The certificate's key isn't among the app's pending requests. */
  keyNotFound: 'es.gob.fnmt.cert.certrequest.KeyNotFoundException',
  generic: 'java.lang.Exception',
} as const;

/**
 * A key the app generated for an FNMT certificate request, waiting for its certificate (Mis datos
 * shows it as "En proceso"). The private key itself never leaves the vault and the main process.
 */
export const PendingCertificateRequest = z.object({
  id: z.string(),
  /** base64url(SHA-256(DER SubjectPublicKeyInfo)), as the Configurador indexes it. */
  publicKeyHash: z.string(),
  /** e.g. "rsa 2048", "ec prime256v1". */
  keyDescription: z.string(),
  /** Origin of the page that asked for the request. */
  origin: z.string(),
  /** The procedure that made the request, when there was one. */
  procedureId: z.string().optional(),
  createdAt: z.string(),
});
export type PendingCertificateRequest = z.infer<typeof PendingCertificateRequest>;
