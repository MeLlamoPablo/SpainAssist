/**
 * @sa/browser — the agent's web browser (playwright-core + Chromium), one isolated browser
 * context per procedure. Plain Node library (no Electron imports); the desktop main process
 * owns the single BrowserService instance and calls it from the host bridge.
 *
 * Responsibilities:
 *  - accessibility snapshots with element refs for the model (incl. iframes), size-budgeted
 *  - actions by ref (click/type/select/check/press/upload), waits, tabs/popups, dialogs
 *  - typing secrets without revealing them (and masking them in later snapshots)
 *  - downloads (and PDFs shown inline) -> handed to the app (temporary downloads) and reported in the next
 *    observation
 *  - TLS client-certificate logins through the TLS sidecar (`@sa/sidecar`): a .p12 key or the
 *    DNIe in the phone, presented only to the origins the app turns on
 *  - AutoFirma replacement: inject the shim (from @sa/signer) in every frame and expose the
 *    AFIRMA_BINDING that forwards calls to the AfirmaHandler
 *  - low-res screenshots for the UI (stored through `saveMedia`) and a live screencast
 *  - development only: capture mode (HAR, trace, HTML, actions.jsonl; secrets scrubbed)
 *
 * See README.md for the design notes and the known risks.
 */
import { PlaywrightBrowserService } from './service';
import type { BrowserService, BrowserServiceOptions } from './types';

export { type CaptureOptions, type CaptureToolCall, withCaptureTool } from './capture';
export {
  CERTIFICATE_ORIGINS,
  type CertificateSite,
  certificateHosts,
  certificateSite,
  normalizeOrigin,
} from './certificates';
export { BrowserError, type BrowserErrorCode } from './errors';
export { type ChromiumRegistry, ensureChromium } from './install';
export { type RenderOptions, type RenderResult, renderSnapshot } from './snapshot';
export type {
  BrowserService,
  BrowserServiceOptions,
  CertificateProxy,
  ClientCertificateUse,
  DownloadedFile,
  Logger,
  RefInfo,
  ScreencastFrame,
  TypeOptions,
} from './types';

export function createBrowserService(opts: BrowserServiceOptions): BrowserService {
  return new PlaywrightBrowserService(opts);
}
