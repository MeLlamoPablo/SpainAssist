import type {
  AfirmaHandler,
  AfirmaHandlerContext,
  BrowserObservation,
  BrowserTab,
} from '@sa/shared';
import type { Sidecar, SidecarIdentity } from '@sa/sidecar';
import type { CaptureOptions } from './capture';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export interface DownloadedFile {
  path: string;
  suggestedName: string;
  mimeType: string;
}

export interface BrowserServiceOptions {
  /** Default false: a visible window the user can watch and take over. */
  headless?: boolean;
  /** Keep headed windows minimized except while the user is helping. */
  startHidden?: boolean;
  /** Use a system browser instead of Playwright's Chromium. */
  channel?: 'chrome' | 'msedge';
  /**
   * The Chromium to launch, such as the one an app ships with. Without it (and `channel`),
   * Playwright's own build from its cache; this package never downloads one.
   */
  executablePath?: string;
  /** Staging directory for downloads (files left there are deleted after onDownload resolves). */
  downloadsDir: string;
  /** Persist a UI screenshot (JPEG) and return its media id. */
  saveMedia?(procedureId: string, jpeg: Buffer): Promise<string>;
  /**
   * Keep a downloaded file (move or copy it out of the staging directory before resolving) and
   * describe it for the agent. The app decides what happens to it next.
   */
  onDownload(
    procedureId: string,
    file: DownloadedFile,
  ): Promise<{ downloadId: string; name: string; mimeType: string }>;
  /** AutoFirma replacement. When omitted, pages get no shim. */
  afirma?: {
    /** In-page script (string) from @sa/signer, injected with addInitScript. */
    shimSource: string;
    handler: AfirmaHandler;
    /** Per-call context factory (user approval, certificate retrieval). */
    context(procedureId: string): Omit<AfirmaHandlerContext, 'procedureId' | 'report'>;
  };
  /** Max snapshot size in characters (default 24000). */
  snapshotBudget?: number;
  logger?: Logger;

  // --- Optional ------------------------------------------------------------------------------
  /**
   * Viewport of every page. Default: 1280x800 when headless; `null` (the window decides, native
   * pixel ratio) when headed.
   */
  viewport?: { width: number; height: number } | null;
  /** Extra Chromium command-line switches. */
  launchArgs?: string[];
  /**
   * The CRLSet to enforce, asked for at each launch: Chromium's list of revoked certificates and
   * blocked CA keys, which Playwright's Chromium never downloads by itself (README.md, "Revoked
   * certificates"). Without one, the browser trusts every certificate its root store does.
   */
  crlSet?: () => Promise<CrlSetComponent | undefined>;
  /**
   * Scripts (source text) injected into every frame of every context before the page's own
   * scripts run (`addInitScript`). For embedders that must change what a page can see or do, such
   * as the eval suite, which removes WebRTC.
   */
  initScripts?: readonly string[];
  /**
   * Playwright's own handlers for SIGINT, SIGTERM and SIGHUP, which close the browser and then
   * exit the process (code 130 for SIGINT) without asking anyone else (default true). A host that
   * handles those signals itself and must outlive them, like a command line that saves its run
   * before it exits, sets false: it then stops the browser through `close`.
   */
  handleSignals?: boolean;
  /**
   * DEVELOPMENT/TESTS ONLY (e.g. the mock sede with a self-signed certificate): accept invalid
   * server certificates in every context. Never enable in production.
   */
  ignoreHTTPSErrors?: boolean;
  /**
   * The TLS sidecar for certificate logins. Without it, contexts connect directly and
   * `useClientCertificate` fails.
   */
  certificates?: CertificateProxy;
  /** Timeout of element actions (click, type...) in ms. Default 8000. */
  actionTimeoutMs?: number;
  /** Timeout of navigations (open, back) in ms. Default 30000. */
  navigationTimeoutMs?: number;
  /** Max time to wait for the page to settle after an action, in ms. Default 10000. */
  settleTimeoutMs?: number;
  /** Max time an action waits for a signature the user is approving, in ms. Default 60000. */
  signatureWaitMs?: number;
  /** Minimum interval between UI screenshots of a procedure, in ms. Default 1500. */
  mediaIntervalMs?: number;
  /**
   * DEVELOPMENT ONLY: record every context (HAR, trace, HTML after each action, actions.jsonl)
   * for offline mock sites, with typed secrets scrubbed (capture.ts). Never in production.
   */
  capture?: CaptureOptions;
}

/** Chromium's CRLSet component, unpacked: `dir` holds `crl-set` and `manifest.json`. */
export interface CrlSetComponent {
  version: string;
  dir: string;
}

/** What the browser needs from the TLS sidecar (`@sa/sidecar`'s `Sidecar`). */
export type CertificateProxy = Pick<
  Sidecar,
  'launchArgs' | 'credentials' | 'openSession' | 'configure' | 'endSession' | 'networkError'
>;

/** A client certificate for some origins of one procedure (see certificates.ts). */
export interface ClientCertificateUse {
  /** Exact https origins, e.g. "https://pasarela-ident.clave.gob.es" (a path is ignored). */
  origins: string[];
  identity: SidecarIdentity;
}

export interface RefInfo {
  role: string;
  name: string;
  /** For inputs: "text", "password", "email"... (undefined for other elements). */
  inputType?: string;
  /** URL of the frame containing the element (used for credential domain checks). */
  frameUrl: string;
}

export interface TypeOptions {
  /** Press Enter after typing. */
  submit?: boolean;
  /** Mask `text` in every later observation of this procedure (and in screenshots). */
  secret?: boolean;
  /**
   * Re-checked right before typing (closes the gap between describeRef and type): the element
   * must still be an input of this type and live in a frame of this origin.
   */
  expect?: { inputType?: string; frameOrigin?: string };
}

export interface ScreencastFrame {
  data: Buffer;
  timestamp: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface BrowserService {
  open(procedureId: string, url: string, opts?: { newTab?: boolean }): Promise<BrowserObservation>;
  snapshot(procedureId: string): Promise<BrowserObservation>;
  click(procedureId: string, ref: string): Promise<BrowserObservation>;
  /** `secret: true` masks `text` in every later snapshot of this procedure. */
  type(
    procedureId: string,
    ref: string,
    text: string,
    opts?: TypeOptions,
  ): Promise<BrowserObservation>;
  select(procedureId: string, ref: string, values: string[]): Promise<BrowserObservation>;
  check(procedureId: string, ref: string, checked: boolean): Promise<BrowserObservation>;
  press(procedureId: string, key: string): Promise<BrowserObservation>;
  wait(
    procedureId: string,
    opts: { text?: string; textGone?: string; seconds?: number },
  ): Promise<BrowserObservation>;
  back(procedureId: string): Promise<BrowserObservation>;
  tabs(
    procedureId: string,
    action: 'list' | 'select' | 'close',
    index?: number,
  ): Promise<BrowserTab[]>;
  screenshot(
    procedureId: string,
    opts?: { fullPage?: boolean },
  ): Promise<{ mimeType: 'image/jpeg'; data: Buffer }>;
  upload(
    procedureId: string,
    ref: string,
    files: { name: string; mimeType: string; buffer: Buffer }[],
  ): Promise<BrowserObservation>;
  /** Information about a ref from the latest snapshot (null if unknown/stale). */
  describeRef(procedureId: string, ref: string): Promise<RefInfo | null>;
  /**
   * Presents a client certificate to these origins from now on (null turns it off). Open
   * connections to them are closed, so a login started before must be started again.
   */
  useClientCertificate(procedureId: string, use: ClientCertificateUse | null): Promise<void>;
  currentUrl(procedureId: string): string | undefined;
  isOpen(procedureId: string): boolean;
  /** Bring the procedure's window to the front (headed mode). */
  show(procedureId: string): Promise<void>;
  /** Minimize every window belonging to this procedure. */
  hide(procedureId: string): Promise<void>;
  /** Serialized storage state (cookies, localStorage) for encrypted persistence by the app. */
  exportState(procedureId: string): Promise<string | null>;
  importState(procedureId: string, state: string): Promise<void>;
  /**
   * Capture mode only (a no-op otherwise): saves the procedure's capture run now. Its context is
   * closed (that writes the HAR); the next action reopens the last page with the same cookies.
   */
  finishCapture(procedureId: string): Promise<void>;
  close(procedureId: string): Promise<void>;
  closeAll(): Promise<void>;
  /**
   * Live view: JPEG frames of the procedure's active tab (follows tab switches and popups).
   * Resolves with a function that stops the screencast.
   */
  startScreencast(
    procedureId: string,
    onFrame: (frame: ScreencastFrame) => void | Promise<void>,
    opts?: { width?: number; height?: number; quality?: number },
  ): Promise<() => Promise<void>>;
}
