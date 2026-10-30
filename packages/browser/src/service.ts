/**
 * BrowserService implementation: one lazily-launched Chromium, one isolated context per
 * procedure. See README.md for the design and the risks.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AFIRMA_BINDING,
  AFIRMA_NOTICE,
  type AfirmaCall,
  type AfirmaHandlerContext,
  type AfirmaReply,
  type BrowserObservation,
  type BrowserTab,
} from '@sa/shared';
import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Cookie,
  chromium,
  type Dialog,
  type Download,
  type FileChooser,
  type Frame,
  type LaunchOptions,
  type Locator,
  type Page,
  type Request,
  type Response,
} from 'playwright-core';
import {
  CaptureRun,
  type CaptureStep,
  claimScratch,
  currentCaptureTool,
  releaseScratch,
  SECRET_FIELD_STYLE,
  tracesDirOf,
} from './capture';
import { certificateHosts } from './certificates';
import {
  BrowserError,
  cleanPlaywrightMessage,
  maskSecrets,
  secretVariants,
  staleRefError,
  toActionError,
} from './errors';
import { NetworkTracker } from './network';
import {
  afirmaPageNote,
  CLIENT_CERT_NET_ERROR,
  certificateFailedNote,
  certificateRequestedNote,
  detectPageNotes,
} from './notes';
import { type RefMeta, renderSnapshot } from './snapshot';
import type {
  BrowserService,
  BrowserServiceOptions,
  ClientCertificateUse,
  CrlSetComponent,
  Logger,
  RefInfo,
  ScreencastFrame,
  TypeOptions,
} from './types';
import {
  collectPasswordValues,
  effectiveFrameUrl,
  fileNameFromContentDisposition,
  fileNameFromUrl,
  guessMimeType,
  hostOf,
  isHttpUrl,
  noop,
  originOf,
  sanitizeFileName,
  settleAll,
  sha256,
  sleep,
  withTimeout,
} from './util';

type StorageState = Exclude<BrowserContextOptions['storageState'], string | undefined>;

const REF_RE = /^(?:f\d+)?e\d+$/;
const DEFAULT_BUDGET = 24_000;
const QUIET_MS = 350;
/** The longest a click waits for a window it asked to open (`watchPopups`). */
const POPUP_WAIT_MS = 5_000;
/** Closing the pages of a context before the context itself, and the wait for either. */
const PAGE_CLOSE_MS = 3_000;
const CONTEXT_CLOSE_MS = 15_000;
/**
 * How long after launch a seeded CRLSet takes to reach the network stack: Chromium hands it over
 * in its after-startup tasks, about 2 s after launch on a Mac (README.md, "Revoked certificates").
 */
const CRLSET_SETTLE_MS = 5_000;
/**
 * The component updater's server while a CRLSet is seeded: it must run to load the seeded
 * CRLSet, but never download anything. Port 9 is on Chromium's list of unsafe ports, so nothing
 * is ever sent there.
 */
const NO_COMPONENT_UPDATES = '--component-updater=url-source=http://127.0.0.1:9/';
/** Temporary profiles of CRLSet launches, in the OS temp directory. */
export const PROFILE_PREFIX = 'sa-agent-profile-';
/**
 * A browser that closes by itself this soon after launch, before any of its pages loaded a site,
 * never got going. After EARLY_EXITS_LIMIT of those in a row the service stops relaunching:
 * agents retry a closed browser, so one that dies at startup would relaunch on every tool call.
 */
const EARLY_EXIT_MS = 10_000;
const EARLY_EXITS_LIMIT = 2;
const BROWSER_CLOSED = 'The browser window was closed or crashed. Try again: it will be reopened.';
const BROWSER_UNAVAILABLE =
  'The browser keeps closing by itself right after it starts, so it was not opened again. Do not retry browser actions: tell the user the browser could not start on this computer, and that restarting the app may help.';

const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

interface Screencast {
  onFrame: (frame: ScreencastFrame) => void | Promise<void>;
  size?: { width: number; height: number };
  quality?: number;
  page?: Page;
  disposable?: { dispose(): Promise<void> };
  stopped: boolean;
  chain: Promise<void>;
}

interface Session {
  id: string;
  context?: BrowserContext;
  everHadContext: boolean;
  pages: Page[];
  active?: Page;
  /** This context's username on the TLS sidecar: random, never the procedure id. */
  proxyUser: string;
  pendingState?: StorageState;
  cachedCookies?: Cookie[];
  lastUrl?: string;
  secrets: Set<string>;
  secretVariants: string[];
  lastRefs: Map<string, RefMeta>;
  downloads: BrowserObservation['downloads'];
  signatures: BrowserObservation['signatures'];
  dialogs: string[];
  /** Script errors of the pages since the last observation. */
  pageErrors: string[];
  /** Page errors already logged (main.log gets each one once per session). */
  loggedPageErrors: Set<string>;
  /** Origins whose AutoFirma note the agent already got. */
  afirmaOrigins: Set<string>;
  notes: string[];
  /** Downloads / inline PDF captures / certificate checks in progress. */
  pending: Set<Promise<unknown>>;
  /** AutoFirma calls in progress (usually waiting for the user's approval). */
  afirmaInFlight: Set<Promise<unknown>>;
  pdfHashes: Set<string>;
  pdfPages: WeakMap<Page, string>;
  crashedPages: WeakSet<Page>;
  lastMedia?: { at: number; id: string; key: string };
  queue: Promise<void>;
  screencast?: Screencast;
  /** Capture mode: the recording of the current context. */
  capture?: CaptureRun;
  closed: boolean;
  visible: boolean;
  windowQueue: Promise<void>;
}

interface RunOptions {
  /** Create the session if there is none. */
  create?: boolean;
  /** Capture mode: record this action as a step (with `ref`'s element). */
  step?: Pick<CaptureStep, 'action' | 'args'> & { ref?: string };
}

export class PlaywrightBrowserService implements BrowserService {
  private readonly log: Logger;
  private readonly sessions = new Map<string, Session>();
  private readonly trackers = new WeakMap<Page, NetworkTracker>();
  private browser?: Browser;
  private launching?: Promise<Browser>;
  /** The browser of the last launch until it closes: since when, and whether a page loaded. */
  private launched?: { browser: Browser; at: number; loaded: boolean };
  /** Browsers in a row that closed by themselves before loading a page (EARLY_EXIT_MS). */
  private earlyExits = 0;
  /** Deletes the temporary profile of a CRLSet launch (launchWithCrlSet). */
  private readonly removeProfiles = new WeakMap<Browser, () => Promise<void>>();
  private userAgent?: string;
  private readonly budget: number;
  private readonly actionTimeout: number;
  private readonly navigationTimeout: number;
  private readonly settleTimeout: number;
  private readonly signatureWait: number;
  private readonly mediaInterval: number;
  /** Capture mode: this service's private scratch directory (capture.ts). */
  private readonly captureScratch?: Promise<string>;
  /** Capture runs being saved. */
  private readonly captureWork = new Set<Promise<unknown>>();

  constructor(private readonly opts: BrowserServiceOptions) {
    this.log = opts.logger ?? silentLogger;
    this.budget = opts.snapshotBudget ?? DEFAULT_BUDGET;
    this.actionTimeout = opts.actionTimeoutMs ?? 8_000;
    this.navigationTimeout = opts.navigationTimeoutMs ?? 30_000;
    this.settleTimeout = opts.settleTimeoutMs ?? 10_000;
    this.signatureWait = opts.signatureWaitMs ?? 60_000;
    this.mediaInterval = opts.mediaIntervalMs ?? 1_500;
    if (opts.capture) {
      this.captureScratch = claimScratch(opts.capture.scratchDir);
      this.captureScratch.catch((err) =>
        this.log.warn('browser capture unavailable', { error: errorMessage(err) }),
      );
    }
  }

  // =============================================================================================
  // Public API
  // =============================================================================================

  async open(
    procedureId: string,
    url: string,
    opts: { newTab?: boolean } = {},
  ): Promise<BrowserObservation> {
    const target = validateUrl(url);
    return this.run(
      procedureId,
      async (s) => {
        const context = await this.ensureContext(s);
        let page = opts.newTab ? undefined : this.livePage(s);
        if (page && s.crashedPages.has(page)) {
          await page.close().catch(noop);
          page = undefined;
        }
        if (!page) page = await context.newPage();
        this.activate(s, page);
        await this.navigate(s, page, target);
        return this.observe(s);
      },
      { create: true, step: { action: 'open', args: { url, newTab: !!opts.newTab } } },
    );
  }

  snapshot(procedureId: string): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'snapshot', args: {} }, async (s) => {
      await this.pageFor(s);
      return this.observe(s, { initialWait: 0 });
    });
  }

  click(procedureId: string, ref: string): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'click', args: { ref }, ref }, async (s) => {
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      const stopIntercept = this.interceptFileChooser(s, page);
      const popups = await this.watchPopups(s, page);
      try {
        try {
          await loc.click();
        } catch (err) {
          throw toActionError(err, `click ${ref}`, s.secretVariants);
        }
        await popups.arrived();
        return await this.observe(s);
      } finally {
        stopIntercept();
        await popups.stop();
      }
    });
  }

  type(
    procedureId: string,
    ref: string,
    text: string,
    opts: TypeOptions = {},
  ): Promise<BrowserObservation> {
    const step = {
      action: 'type',
      args: { ref, text, submit: !!opts.submit, secret: !!opts.secret },
      ref,
    };
    return this.act(procedureId, step, async (s) => {
      if (opts.secret) this.addSecret(s, text);
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      if (opts.expect) await this.checkExpectation(s, page, loc, ref, opts.expect);
      const what = `type into ${ref}`;
      const field = await fieldState(loc);
      if (field.locked) {
        s.notes.push(
          `${ref} is ${field.locked}, so nothing was typed. Use its picker/calendar or the button next to it, or fill in what the page asks first.`,
        );
        return this.observe(s);
      }
      try {
        // Marked before typing too (screenshots and, in capture mode, trace screenshots).
        if (opts.secret)
          await loc.evaluate((el) => el.setAttribute('data-sa-secret', '')).catch(noop);
        await this.fill(loc, text);
        if (opts.secret) {
          // Lets screenshots mask the field (best effort; the page may re-render it).
          await loc.evaluate((el) => el.setAttribute('data-sa-secret', '')).catch(noop);
        }
        const note = keptValueNote(ref, text, await settledValue(loc, !field.suggests), {
          secret: !!opts.secret || field.password,
          marked: field.marked,
        });
        if (note) s.notes.push(note);
        if (opts.submit) await loc.press('Enter');
      } catch (err) {
        throw toActionError(err, what, s.secretVariants);
      }
      this.log.debug('type', { procedureId, ref, chars: text.length, secret: !!opts.secret });
      return this.observe(s);
    });
  }

  select(procedureId: string, ref: string, values: string[]): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'select', args: { ref, values }, ref }, async (s) => {
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      const options = await loc
        .evaluate((el) =>
          el instanceof HTMLSelectElement
            ? Array.from(el.options).map((o) => ({ value: o.value, label: o.label || o.text }))
            : null,
        )
        .catch(() => null);
      try {
        if (options) {
          const chosen = values.map((v) => {
            const match = matchOption(options, v);
            if (!match) {
              const list = options
                .slice(0, 40)
                .map((o) => `"${o.label}"`)
                .join(', ');
              throw new BrowserError(
                'bad_input',
                `No option "${v}" in ${ref}. Options: ${list}${options.length > 40 ? ', …' : ''}.`,
              );
            }
            return match.value;
          });
          await loc.selectOption(chosen.map((value) => ({ value })));
        } else {
          // Custom combobox/listbox: open it, then click the options by their accessible name.
          await loc.click();
          const handle = await loc.elementHandle();
          const frame = (await handle?.ownerFrame()) ?? page.mainFrame();
          await handle?.dispose();
          for (const v of values) {
            await frame.getByRole('option', { name: v }).first().click({ timeout: 4_000 });
          }
        }
      } catch (err) {
        throw toActionError(err, `select in ${ref}`, s.secretVariants);
      }
      return this.observe(s);
    });
  }

  check(procedureId: string, ref: string, checked: boolean): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'check', args: { ref, checked }, ref }, async (s) => {
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      try {
        await loc.setChecked(checked);
      } catch (err) {
        throw toActionError(err, `${checked ? 'check' : 'uncheck'} ${ref}`, s.secretVariants);
      }
      return this.observe(s);
    });
  }

  press(procedureId: string, key: string): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'press', args: { key } }, async (s) => {
      const page = await this.pageFor(s);
      try {
        await page.keyboard.press(key);
      } catch (err) {
        throw toActionError(err, `press ${key}`, s.secretVariants);
      }
      return this.observe(s);
    });
  }

  wait(
    procedureId: string,
    opts: { text?: string; textGone?: string; seconds?: number },
  ): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'wait', args: { ...opts } }, async (s) => {
      await this.pageFor(s);
      const seconds = Math.max(0, Math.min(opts.seconds ?? 0, 60));
      if (!opts.text && !opts.textGone) {
        await sleep(seconds ? seconds * 1000 : 1000);
      } else {
        const timeout = seconds ? seconds * 1000 : 20_000;
        if (opts.text && !(await this.waitForText(s, opts.text, true, timeout))) {
          s.notes.push(`"${opts.text}" did not appear within ${Math.round(timeout / 1000)} s.`);
        }
        if (opts.textGone && !(await this.waitForText(s, opts.textGone, false, timeout))) {
          s.notes.push(
            `"${opts.textGone}" was still visible after ${Math.round(timeout / 1000)} s.`,
          );
        }
      }
      return this.observe(s, { initialWait: 0 });
    });
  }

  back(procedureId: string): Promise<BrowserObservation> {
    return this.act(procedureId, { action: 'back', args: {} }, async (s) => {
      const page = await this.pageFor(s);
      const before = page.url();
      try {
        await page.goBack({ waitUntil: 'commit' });
      } catch (err) {
        throw new BrowserError(
          'navigation',
          `Could not go back: ${cleanPlaywrightMessage(errorMessage(err))}`,
        );
      }
      if (page.url() === before) s.notes.push('There is no previous page in this tab.');
      return this.observe(s);
    });
  }

  tabs(
    procedureId: string,
    action: 'list' | 'select' | 'close',
    index?: number,
  ): Promise<BrowserTab[]> {
    const step = action === 'list' ? undefined : { action: 'tabs', args: { action, index } };
    return this.act(procedureId, step, async (s) => {
      await this.ensureContext(s);
      const pages = s.pages.filter((p) => !p.isClosed());
      if (action !== 'list') {
        const page = index === undefined ? undefined : pages[index];
        if (!page) {
          throw new BrowserError(
            'bad_input',
            pages.length
              ? `No tab with index ${index}. Open tabs: 0 to ${pages.length - 1}.`
              : 'No tab is open.',
          );
        }
        if (action === 'select') {
          this.activate(s, page);
          await page.bringToFront().catch(noop);
        } else {
          await page.close({ runBeforeUnload: false }).catch(noop);
        }
      }
      return this.tabsInfo(s);
    });
  }

  screenshot(
    procedureId: string,
    opts: { fullPage?: boolean } = {},
  ): Promise<{ mimeType: 'image/jpeg'; data: Buffer }> {
    return this.run(procedureId, async (s) => {
      const page = await this.pageFor(s);
      try {
        const data = await page.screenshot({
          type: 'jpeg',
          quality: 70,
          scale: 'css',
          fullPage: !!opts.fullPage,
          mask: this.secretMasks(page),
          maskColor: '#888888',
          timeout: 15_000,
        });
        return { mimeType: 'image/jpeg' as const, data };
      } catch (err) {
        throw toActionError(err, 'take a screenshot', s.secretVariants);
      }
    });
  }

  upload(
    procedureId: string,
    ref: string,
    files: { name: string; mimeType: string; buffer: Buffer }[],
  ): Promise<BrowserObservation> {
    const step = {
      action: 'upload',
      args: {
        ref,
        files: files.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.buffer.length })),
      },
      ref,
    };
    return this.act(procedureId, step, async (s) => {
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      const payload = files.map((f) => ({
        name: sanitizeFileName(f.name, 'fichero'),
        mimeType: f.mimeType,
        buffer: f.buffer,
      }));
      try {
        try {
          // Works on <input type=file> and on <label>s of one (Playwright follows labels).
          await loc.setInputFiles(payload, { timeout: 3_000 });
        } catch (err) {
          if (
            !/not an? (?:HTML)?input|input\[type=file\]|Node is not an HTMLInputElement|is not a file input/i.test(
              errorMessage(err),
            )
          ) {
            throw err;
          }
          // A button that opens the native file picker.
          const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
          await loc.click();
          const fc: FileChooser = await chooser.catch(() => {
            throw new BrowserError(
              'action',
              `${ref} did not open a file picker. Use the ref of the file field or of its "Examinar"/"Adjuntar" button.`,
            );
          });
          await fc.setFiles(payload);
        }
      } catch (err) {
        throw toActionError(err, `upload to ${ref}`, s.secretVariants);
      }
      return this.observe(s);
    });
  }

  async describeRef(procedureId: string, ref: string): Promise<RefInfo | null> {
    if (!this.sessions.has(procedureId) || !REF_RE.test(ref.trim())) return null;
    return this.run(procedureId, async (s) => {
      const page = this.livePage(s);
      if (!page || !s.context) return null;
      const loc = page.locator(`aria-ref=${ref.trim()}`);
      const count = await loc.count().catch(() => 0);
      if (count < 1) return null;
      return this.refInfo(s, page, loc.first(), ref.trim());
    });
  }

  async useClientCertificate(procedureId: string, use: ClientCertificateUse | null): Promise<void> {
    const sidecar = this.opts.certificates;
    if (!sidecar)
      throw new BrowserError(
        'certificate',
        'Certificate logins are not available on this computer (the TLS helper is missing).',
      );
    const hosts = use ? certificateHosts(use.origins) : [];
    await this.run(
      procedureId,
      async (s) => {
        try {
          await sidecar.configure(s.proxyUser, hosts, use?.identity ?? null);
        } catch (err) {
          throw new BrowserError(
            'certificate',
            `The certificate could not be used: ${errorMessage(err)}`,
          );
        }
      },
      { create: true },
    );
  }

  currentUrl(procedureId: string): string | undefined {
    const s = this.sessions.get(procedureId);
    if (!s?.context || !this.browser?.isConnected()) return undefined;
    return this.livePage(s)?.url();
  }

  isOpen(procedureId: string): boolean {
    const s = this.sessions.get(procedureId);
    return !!s?.context && !!this.browser?.isConnected() && !!this.livePage(s);
  }

  async show(procedureId: string): Promise<void> {
    const s = this.sessions.get(procedureId);
    if (!s) return;
    const page = this.livePage(s);
    s.visible = true;
    await this.queueWindowChange(s, async () => {
      if (!s.visible || !page || page.isClosed()) return;
      if (this.opts.startHidden && !this.opts.headless) await this.setWindowState(page, 'normal');
      await page.bringToFront();
    });
  }

  async hide(procedureId: string): Promise<void> {
    const s = this.sessions.get(procedureId);
    if (!s) return;
    s.visible = false;
    if (this.opts.headless || !this.opts.startHidden) return;
    await this.queueWindowChange(s, async () => {
      if (s.visible) return;
      for (const page of s.pages) {
        if (!page.isClosed()) await this.setWindowState(page, 'minimized');
      }
    });
  }

  private queueWindowChange(s: Session, change: () => Promise<void>): Promise<void> {
    const result = s.windowQueue.then(change);
    s.windowQueue = result.catch(noop);
    return result;
  }

  private async setWindowState(page: Page, windowState: 'normal' | 'minimized'): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } });
      // Native window transitions are asynchronous (notably on macOS).
      for (let attempt = 0; attempt < 30; attempt++) {
        const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
        if (bounds.windowState === windowState) return;
        await sleep(50);
      }
      throw new BrowserError('action', `Could not change the browser window to ${windowState}.`);
    } finally {
      await cdp.detach().catch(noop);
    }
  }

  async exportState(procedureId: string): Promise<string | null> {
    if (!this.sessions.has(procedureId)) return null;
    return this.run(procedureId, async (s) => {
      if (s.context && this.browser?.isConnected()) {
        return JSON.stringify(await s.context.storageState());
      }
      if (s.pendingState) return JSON.stringify(s.pendingState);
      if (s.cachedCookies) return JSON.stringify({ cookies: s.cachedCookies, origins: [] });
      return null;
    });
  }

  async importState(procedureId: string, state: string): Promise<void> {
    const parsed = parseStorageState(state);
    await this.run(
      procedureId,
      async (s) => {
        if (s.context && this.browser?.isConnected()) await s.context.setStorageState(parsed);
        else s.pendingState = parsed;
      },
      { create: true },
    );
  }

  async close(procedureId: string): Promise<void> {
    const s = this.sessions.get(procedureId);
    if (!s) return;
    this.sessions.delete(procedureId);
    await this.disposeSession(s);
  }

  async closeAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => this.disposeSession(s)));
    const browser = this.browser ?? (await this.launching?.catch(() => undefined));
    this.browser = undefined;
    // Closed on purpose: no early exit, and a later call may launch again.
    this.launched = undefined;
    this.earlyExits = 0;
    await browser?.close().catch(noop);
    // Again, now that the process is gone: a headed Chromium still writes to its profile after
    // `disconnected` (seen on macOS), so that first deletion can fail or be undone.
    if (browser) await this.removeProfiles.get(browser)?.();
    if (this.captureScratch) {
      await settleAll(this.captureWork, 60_000);
      // Raw trace resources shared by every context of the browser.
      await this.captureScratch.then(releaseScratch).catch(noop);
    }
  }

  startScreencast(
    procedureId: string,
    onFrame: (frame: ScreencastFrame) => void | Promise<void>,
    opts: { width?: number; height?: number; quality?: number } = {},
  ): Promise<() => Promise<void>> {
    return this.run(procedureId, async (s) => {
      await this.pageFor(s);
      if (s.screencast) await this.stopScreencast(s, s.screencast);
      const sc: Screencast = {
        onFrame,
        size: opts.width && opts.height ? { width: opts.width, height: opts.height } : undefined,
        quality: opts.quality,
        stopped: false,
        chain: Promise.resolve(),
      };
      s.screencast = sc;
      this.followScreencast(s);
      await sc.chain;
      return () => this.stopScreencast(s, sc);
    });
  }

  // =============================================================================================
  // Sessions, browser and contexts
  // =============================================================================================

  /** `run` for an action that capture mode records as a step. */
  private act<T>(
    procedureId: string,
    step: NonNullable<RunOptions['step']> | undefined,
    fn: (s: Session) => Promise<T>,
  ): Promise<T> {
    return this.run(procedureId, fn, { step });
  }

  private async run<T>(
    procedureId: string,
    fn: (s: Session) => Promise<T>,
    opts: RunOptions = {},
  ): Promise<T> {
    // Read before awaiting anything: the caller's async context.
    const tool = opts.step ? currentCaptureTool() : undefined;
    let s = this.sessions.get(procedureId);
    if (!s) {
      if (!opts.create) {
        throw new BrowserError(
          'no_page',
          'No browser is open for this procedure. Use browser_open with a URL first.',
        );
      }
      s = newSession(procedureId);
      this.sessions.set(procedureId, s);
    }
    const session = s;
    const previous = session.queue;
    let release: () => void = noop;
    session.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let step: CaptureStep | undefined;
    try {
      await previous;
      if (session.closed)
        throw new BrowserError('closed', 'The browser for this procedure was closed.');
      if (opts.step && this.opts.capture) {
        const { ref, ...rest } = opts.step;
        const meta = ref ? session.lastRefs.get(ref.trim()) : undefined;
        step = { ...rest, ...(ref ? { target: { ref, ...meta } } : {}), ...(tool ? { tool } : {}) };
      }
      return await fn(session);
    } catch (err) {
      const error = publicError(session, err);
      if (step) step.error = error.message;
      throw error;
    } finally {
      if (step) await this.recordStep(session, step);
      release();
    }
  }

  /** Capture mode: the HTML of every page after an action, and its line of actions.jsonl. */
  private async recordStep(s: Session, step: CaptureStep): Promise<void> {
    const run = s.capture;
    if (!run || s.closed) return;
    try {
      await run.recordStep(step, s.pages, this.livePage(s));
    } catch (err) {
      this.log.warn('could not record a capture step', { error: errorMessage(err) });
    }
  }

  /**
   * Capture mode: saves the session's run (scrubbed) to its capture folder. With `context`,
   * stops its trace and closes it first (Playwright writes the HAR on close).
   */
  private async endCapture(s: Session, context?: BrowserContext): Promise<void> {
    const run = s.capture;
    const capture = this.opts.capture;
    s.capture = undefined;
    if (context && run) await context.tracing.stop({ path: run.tracePath }).catch(noop);
    if (context) await closeContext(context);
    const scratch = this.captureScratch;
    if (!run || !capture || !scratch) return;
    const keepTyped = capture.scrub === false;
    const secrets = keepTyped ? [] : [...s.secrets];
    const browserVersion = this.browser?.version();
    const work = (async () => {
      const out = await run.finish({
        dir: capture.dir(s.id),
        secrets,
        redact: this.opts.certificates ? [this.opts.certificates.credentials.password] : [],
        keepTyped,
        tracesDir: tracesDirOf(await scratch),
        browserVersion,
      });
      if (out) this.log.info('browser capture saved', { procedureId: s.id, dir: out });
    })().catch((err) =>
      this.log.warn('could not save a browser capture', { error: errorMessage(err) }),
    );
    this.captureWork.add(work);
    await work.finally(() => this.captureWork.delete(work));
  }

  async finishCapture(procedureId: string): Promise<void> {
    if (!this.opts.capture || !this.sessions.get(procedureId)?.capture) return;
    await this.run(procedureId, async (s) => {
      const context = s.context;
      if (!s.capture || !context) return;
      // The next action starts a new context (and run) with the same cookies and storage.
      if (this.browser?.isConnected())
        s.pendingState = await context.storageState().catch(() => undefined);
      s.context = undefined;
      s.pages = [];
      s.active = undefined;
      await this.endCapture(s, context);
    });
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    if (this.earlyExits >= EARLY_EXITS_LIMIT)
      throw new BrowserError('unavailable', BROWSER_UNAVAILABLE);
    const started = Date.now();
    const headless = !!this.opts.headless;
    const options: LaunchOptions = {
      headless,
      args: [
        ...(this.opts.startHidden ? ['--start-minimized'] : []),
        // Trust the sidecar's key: only hosts with a client certificate present it.
        ...(this.opts.certificates?.launchArgs ?? []),
        ...(this.opts.launchArgs ?? []),
      ],
      executablePath: this.opts.executablePath,
      // New headless (full Chromium) instead of chromium-headless-shell: the shell is blocked by
      // some government WAFs (docs/research/browser.md §5.1).
      channel:
        this.opts.channel ?? (headless && !this.opts.executablePath ? 'chromium' : undefined),
      // Capture mode: raw trace files go to the private scratch directory, not the OS temp dir.
      tracesDir: await this.captureScratch?.then(tracesDirOf, () => undefined),
      ...(this.opts.handleSignals === false
        ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false }
        : {}),
    };
    const crlSet = await this.opts.crlSet?.().catch((err) => {
      this.log.warn('no CRLSet for the browser', { error: errorMessage(err) });
      return undefined;
    });
    const browser = crlSet
      ? await this.launchWithCrlSet(options, crlSet)
      : await chromium.launch(options);
    const launched = { browser, at: Date.now(), loaded: false };
    this.launched = launched;
    browser.on('disconnected', () => this.onBrowserDisconnected(browser));
    // Already closed by itself (before the listener): an early exit all the same.
    if (!browser.isConnected()) this.onBrowserDisconnected(browser);
    if (this.opts.certificates) {
      try {
        await answerProxyLogins(browser, this.opts.certificates.credentials);
      } catch (err) {
        // Closed here on purpose, unless it already closed by itself.
        if (this.launched === launched) this.launched = undefined;
        await browser.close().catch(noop);
        throw err;
      }
    }
    this.userAgent = headless ? await headfulUserAgent(browser) : undefined;
    if (!browser.isConnected()) throw new BrowserError('closed', BROWSER_CLOSED);
    this.browser = browser;
    this.log.info('browser launched', {
      headless,
      version: browser.version(),
      launchMs: launched.at - started,
    });
    return browser;
  }

  /**
   * Launches Chromium on a new profile seeded with the CRLSet. Playwright's `launch` always starts
   * from an empty profile of its own, so this is a persistent launch on a temporary profile
   * (deleted when the browser goes away) whose browser gives sessions their contexts as usual.
   * Chromium loads a seeded CRLSet only while its component updater runs (NO_COMPONENT_UPDATES),
   * and enforces it a moment later, so this waits CRLSET_SETTLE_MS before the first page.
   *
   * The persistent launch opens a blank window (Playwright passes `about:blank` instead of
   * `--no-startup-window`), and that window stays open for the browser's whole life, minimized
   * after the wait with `startHidden`: Chromium enforces the CRLSet in after-startup tasks that
   * never run if it closes first, and on Windows and Linux a browser started this way quits when
   * its last window closes (on macOS it keeps running). Closed, it took the browser down as soon
   * as no session had a window, so before the first one. It belongs to the persistent context,
   * which no session uses: sessions get their own contexts, so tabs, snapshots and captures
   * never see it.
   */
  private async launchWithCrlSet(
    options: LaunchOptions,
    crlSet: CrlSetComponent,
  ): Promise<Browser> {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), PROFILE_PREFIX));
    const removeProfile = () =>
      fs.rm(profile, { recursive: true, force: true, maxRetries: 5 }).catch(noop);
    let context: BrowserContext | undefined;
    try {
      await fs.cp(crlSet.dir, path.join(profile, 'CertificateRevocation', crlSet.version), {
        recursive: true,
      });
      context = await chromium.launchPersistentContext(profile, {
        ...options,
        ignoreDefaultArgs: ['--disable-component-update'],
        args: [...(options.args ?? []), NO_COMPONENT_UPDATES],
      });
      const browser = context.browser();
      if (!browser) throw new Error('The persistent launch returned no browser');
      browser.on('disconnected', () => void removeProfile());
      this.removeProfiles.set(browser, removeProfile);
      await sleep(CRLSET_SETTLE_MS);
      // Minimized only now, like the windows of sessions: macOS ignores --start-minimized for it.
      if (this.opts.startHidden && !options.headless) {
        for (const page of context.pages()) {
          await this.setWindowState(page, 'minimized').catch((err) =>
            this.log.warn('could not minimize browser window', { error: errorMessage(err) }),
          );
        }
      }
      this.log.info('browser enforces a CRLSet', { version: crlSet.version });
      return browser;
    } catch (err) {
      await context?.close().catch(noop);
      await removeProfile();
      throw err;
    }
  }

  private onBrowserDisconnected(browser: Browser): void {
    if (this.browser === browser) this.browser = undefined;
    for (const s of this.sessions.values()) {
      if (s.context && s.context.browser() !== browser && s.context.browser() !== null) continue;
      s.context = undefined;
      s.pages = [];
      s.active = undefined;
      // Saves what the run has (no HAR or trace: they died with the browser).
      if (s.capture) void this.endCapture(s);
    }
    const launched = this.launched?.browser === browser ? this.launched : undefined;
    if (!launched) {
      // Closed by the service (closeAll, a failed launch).
      this.log.warn('browser disconnected');
      return;
    }
    this.launched = undefined;
    const afterLaunchMs = Date.now() - launched.at;
    const early = afterLaunchMs < EARLY_EXIT_MS && !launched.loaded;
    this.earlyExits = early ? this.earlyExits + 1 : 0;
    this.log.warn('browser disconnected', {
      afterLaunchMs,
      pageLoaded: launched.loaded,
      earlyExits: this.earlyExits,
    });
    if (this.earlyExits >= EARLY_EXITS_LIMIT)
      this.log.error('browser keeps closing right after launch: not relaunching it', {
        earlyExits: this.earlyExits,
      });
  }

  private async ensureContext(s: Session): Promise<BrowserContext> {
    if (s.context && this.browser?.isConnected()) return s.context;
    const recovering = s.everHadContext;
    const state =
      s.pendingState ??
      (recovering && s.cachedCookies ? { cookies: s.cachedCookies, origins: [] } : undefined);
    s.pendingState = undefined;
    const context = await this.newContext(s, state);
    this.adoptContext(s, context);
    if (recovering) {
      const url = s.lastUrl;
      if (isHttpUrl(url)) {
        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(noop);
      }
      s.notes.push(
        'The browser had stopped and was restarted (cookies kept). The last page was reopened: check it before continuing.',
      );
    }
    return context;
  }

  /** Creates a context for the session without attaching it yet. */
  private async newContext(s: Session, storageState?: StorageState): Promise<BrowserContext> {
    const browser = await this.ensureBrowser();
    const options: BrowserContextOptions = {
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      acceptDownloads: true,
      viewport:
        this.opts.viewport !== undefined
          ? this.opts.viewport
          : this.opts.headless
            ? { width: 1280, height: 800 }
            : null,
      userAgent: this.userAgent,
      ignoreHTTPSErrors: this.opts.ignoreHTTPSErrors || undefined,
      storageState,
      // Every context goes through the TLS sidecar on its own port: plain tunnels, except for the
      // hosts where useClientCertificate turned a certificate on (certificates.ts). No proxy
      // credentials here: the browser-level handler answers them (answerProxyLogins).
      proxy: this.opts.certificates
        ? { server: await this.opts.certificates.openSession(s.proxyUser) }
        : undefined,
    };
    // Capture mode: a new run per context (an earlier one is saved first).
    let capture: CaptureRun | undefined;
    if (this.captureScratch) {
      if (s.capture) await this.endCapture(s);
      capture = await this.captureScratch.then(CaptureRun.create, (err) => {
        this.log.warn('browser capture unavailable', { error: errorMessage(err) });
        return undefined;
      });
      if (capture) options.recordHar = { path: capture.harPath, content: 'embed', mode: 'full' };
    }
    const context = await browser.newContext(options);
    if (capture) {
      try {
        await context.tracing.start({
          name: capture.id,
          screenshots: true,
          snapshots: true,
          title: s.id,
        });
        await context.addInitScript(SECRET_FIELD_STYLE);
      } catch (err) {
        await context.close().catch(noop);
        throw err;
      }
      s.capture = capture;
    }
    context.setDefaultTimeout(this.actionTimeout);
    context.setDefaultNavigationTimeout(this.navigationTimeout);
    context.on('page', (page) => this.attachPage(s, context, page));
    context.on('close', () => {
      if (s.context !== context) return;
      s.context = undefined;
      s.pages = [];
      s.active = undefined;
    });
    for (const content of this.opts.initScripts ?? []) {
      try {
        await context.addInitScript({ content });
      } catch (err) {
        await context.close().catch(noop);
        throw err;
      }
    }
    await this.installAfirma(s, context);
    return context;
  }

  private adoptContext(s: Session, context: BrowserContext): void {
    s.context = context;
    s.everHadContext = true;
    s.pages = [];
    s.active = undefined;
    for (const page of context.pages()) this.attachPage(s, context, page);
  }

  private async disposeSession(s: Session): Promise<void> {
    s.closed = true;
    await settleAll(s.pending, 5_000);
    if (s.screencast) await this.stopScreencast(s, s.screencast);
    const context = s.context;
    s.context = undefined;
    s.pages = [];
    s.active = undefined;
    // Capture mode: stops the trace and closes the context, then saves the run (scrubbed).
    await this.endCapture(s, context);
    s.secrets.clear();
    s.secretVariants = [];
    this.opts.certificates?.endSession(s.proxyUser);
    s.pendingState = undefined;
    s.cachedCookies = undefined;
  }

  // =============================================================================================
  // Pages
  // =============================================================================================

  private attachPage(s: Session, context: BrowserContext, page: Page): void {
    if (s.context !== context || s.pages.includes(page)) return;
    s.pages.push(page);
    if (this.opts.startHidden && !this.opts.headless && !s.visible) {
      const hiding = this.queueWindowChange(s, async () => {
        if (!s.visible && !page.isClosed()) await this.setWindowState(page, 'minimized');
      }).catch((err) => {
        this.log.warn('could not minimize browser window', { error: errorMessage(err) });
      });
      s.pending.add(hiding);
      void hiding.finally(() => s.pending.delete(hiding));
    }
    this.trackers.set(page, new NetworkTracker(page));
    page.on('close', () => {
      s.pages = s.pages.filter((p) => p !== page);
      if (s.active === page) {
        s.active = s.pages[s.pages.length - 1];
        this.followScreencast(s);
      }
    });
    page.on('dialog', (dialog) => void this.onDialog(s, dialog));
    page.on('pageerror', (error) => this.onPageError(s, page, error));
    page.on('download', (download) => this.onDownload(s, download));
    page.on('response', (response) => this.onResponse(s, page, response));
    page.on('requestfailed', (request) => this.onRequestFailed(s, request));
    page.on('crash', () => {
      s.crashedPages.add(page);
      s.notes.push('The tab crashed. The next action will reload it.');
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && s.active === page && isHttpUrl(frame.url())) {
        s.lastUrl = frame.url();
      }
    });
    page.on('domcontentloaded', () => {
      // The browser got going: closing later is not an early exit (EARLY_EXIT_MS).
      const launched = this.launched;
      if (launched?.browser === context.browser() && isHttpUrl(page.url())) launched.loaded = true;
    });
    // Popups and new tabs become the active page.
    this.activate(s, page);
  }

  private activate(s: Session, page: Page): void {
    if (s.active === page) return;
    s.active = page;
    this.followScreencast(s);
  }

  private livePage(s: Session): Page | undefined {
    if (s.active && !s.active.isClosed()) return s.active;
    const page = [...s.pages].reverse().find((p) => !p.isClosed());
    s.active = page;
    return page;
  }

  /** The active page, recovering a crashed browser or tab first. */
  private async pageFor(s: Session): Promise<Page> {
    const context = await this.ensureContext(s);
    let page = this.livePage(s);
    if (page && s.crashedPages.has(page)) {
      const url = page.url();
      await page.close().catch(noop);
      page = await context.newPage();
      this.activate(s, page);
      if (isHttpUrl(url)) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(noop);
      s.notes.push('The tab had crashed and was reloaded.');
    }
    if (!page)
      throw new BrowserError('no_page', 'No tab is open. Use browser_open with a URL first.');
    return page;
  }

  private async navigate(s: Session, page: Page, url: string): Promise<void> {
    let response: Response | null;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (err) {
      let msg = errorMessage(err);
      // Through the sidecar Chromium only sees a failed tunnel; the sidecar knows why.
      if (/ERR_TUNNEL_CONNECTION_FAILED/.test(msg)) {
        const target = new URL(url);
        const cause = this.opts.certificates?.networkError(
          s.proxyUser,
          `${target.hostname}:${target.port || (target.protocol === 'http:' ? '80' : '443')}`,
        );
        if (cause) msg = msg.replace('ERR_TUNNEL_CONNECTION_FAILED', cause);
      }
      if (/Download is starting/i.test(msg)) return; // handled by the download listener
      if (CLIENT_CERT_NET_ERROR.test(msg)) {
        s.notes.push(certificateRequestedNote(hostOf(url)));
        return;
      }
      if (/net::ERR_ABORTED|frame was detached|navigation .*interrupted/i.test(msg)) return;
      if (/Timeout \d+ms exceeded/i.test(msg)) {
        s.notes.push(
          `${hostOf(url)} is slow: the page had not finished loading after ${Math.round(this.navigationTimeout / 1000)} s.`,
        );
        return;
      }
      const net = /net::(ERR_[A-Z_]+)/.exec(msg)?.[1];
      throw new BrowserError(
        'navigation',
        `Could not open ${url}: ${net ? `${net} (${netErrorHint(net)})` : cleanPlaywrightMessage(msg)}`,
      );
    }
    // A plain http:// site the sidecar couldn't reach: its answer says why.
    const unreachable = response?.headers()['x-sa-network-error'];
    if (unreachable && /^ERR_[A-Z_]+$/.test(unreachable))
      throw new BrowserError(
        'navigation',
        `Could not open ${url}: ${unreachable} (${netErrorHint(unreachable)})`,
      );
  }

  private async resolveRef(page: Page, ref: string): Promise<Locator> {
    const r = ref.trim();
    if (!REF_RE.test(r)) {
      throw new BrowserError(
        'invalid_ref',
        `"${ref}" is not a ref. Use a ref from the latest snapshot, like e12 or f2e5.`,
      );
    }
    const loc = page.locator(`aria-ref=${r}`);
    let count = 0;
    try {
      count = await loc.count();
    } catch {
      throw staleRefError(r);
    }
    if (count < 1) throw staleRefError(r);
    return loc.first();
  }

  private async refInfo(
    s: Session,
    page: Page,
    loc: Locator,
    ref: string,
  ): Promise<RefInfo | null> {
    const handle = await loc.elementHandle({ timeout: 2_000 }).catch(() => null);
    if (!handle) return null;
    try {
      const frame = await handle.ownerFrame();
      // Selector matching and getAttribute run in Playwright's isolated world, so page scripts
      // cannot fake the answer by patching DOM prototypes.
      const isInput =
        (await loc
          .locator('xpath=self::input')
          .count()
          .catch(() => 0)) > 0;
      let inputType: string | undefined;
      if (isInput) {
        const raw = await loc.getAttribute('type', { timeout: 1_000 }).catch(() => null);
        inputType = (raw ?? '').trim().toLowerCase() || 'text';
      }
      const meta = s.lastRefs.get(ref);
      return {
        role: meta?.role ?? '',
        name: meta?.name ?? '',
        inputType,
        frameUrl: frame?.url() ?? page.url(),
      };
    } finally {
      await handle.dispose().catch(noop);
    }
  }

  private async checkExpectation(
    s: Session,
    page: Page,
    loc: Locator,
    ref: string,
    expect: NonNullable<TypeOptions['expect']>,
  ): Promise<void> {
    const info = await this.refInfo(s, page, loc, ref);
    if (!info) throw staleRefError(ref);
    if (expect.inputType && info.inputType !== expect.inputType.toLowerCase()) {
      throw new BrowserError(
        'expectation_failed',
        `${ref} is not a ${expect.inputType} field (it is ${info.inputType ? `a ${info.inputType} input` : `a ${info.role || 'non-input'} element`}).`,
      );
    }
    if (expect.frameOrigin && originOf(info.frameUrl) !== originOf(expect.frameOrigin)) {
      throw new BrowserError(
        'expectation_failed',
        `${ref} is not on ${originOf(expect.frameOrigin)} (it is on ${originOf(info.frameUrl)}).`,
      );
    }
  }

  /** fill() for normal inputs; key-by-key typing for inputs with key handlers or masks. */
  private async fill(loc: Locator, text: string): Promise<void> {
    const picky = await loc
      .evaluate((el) => {
        const has = (n: string) => el.hasAttribute(n);
        return (
          has('onkeyup') ||
          has('onkeydown') ||
          has('onkeypress') ||
          has('data-mask') ||
          has('data-inputmask') ||
          el.classList.contains('hasDatepicker')
        );
      })
      .catch(() => false);
    if (!picky) {
      await loc.fill(text);
      const value = await loc.inputValue({ timeout: 1_000 }).catch(() => undefined);
      if (value === undefined || value === text) {
        // fill() fires input events only; a real key press lets sites that validate on
        // keydown/keyup notice the new value (End does not change it).
        if (value !== undefined) await loc.press('End').catch(noop);
        return;
      }
    }
    await loc.fill('');
    await loc.pressSequentially(text, { delay: text.length > 80 ? 0 : 20 });
  }

  private async waitForText(
    s: Session,
    text: string,
    visible: boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const page = this.livePage(s);
      if (page) {
        let found = false;
        for (const frame of page.frames().slice(0, 20)) {
          const n = await withTimeout(
            frame.getByText(text).filter({ visible: true }).count(),
            1_500,
            0,
          );
          if (n > 0) {
            found = true;
            break;
          }
        }
        if (found === visible) return true;
      }
      if (Date.now() >= deadline) return false;
      await sleep(250);
    }
  }

  /**
   * Counts the windows the page asks to open (CDP `Page.windowOpen`: window.open, target=_blank
   * links, forms) so `arrived` can wait for them to become tabs. Playwright only announces a popup
   * once it has started, which on a busy machine can be after the opener looks settled.
   */
  private async watchPopups(
    s: Session,
    page: Page,
  ): Promise<{ arrived(): Promise<void>; stop(): Promise<void> }> {
    let requested = 0;
    const popups: Page[] = [];
    const onPopup = (popup: Page): void => void popups.push(popup);
    page.on('popup', onPopup);
    const cdp = await page
      .context()
      .newCDPSession(page)
      .catch(() => undefined);
    cdp?.on('Page.windowOpen', () => requested++);
    await cdp?.send('Page.enable').catch(noop);
    return {
      arrived: async () => {
        // Capped: a blocked popup is asked for but never opens.
        const deadline = Date.now() + Math.min(this.settleTimeout, POPUP_WAIT_MS);
        const ready = () => popups.length >= requested && popups.every((p) => s.pages.includes(p));
        while (!ready() && Date.now() < deadline) await sleep(25);
      },
      stop: async () => {
        page.off('popup', onPopup);
        await cdp?.detach().catch(noop);
      },
    };
  }

  private interceptFileChooser(s: Session, page: Page): () => void {
    // Without a listener a native file dialog would open (and block) in headed mode.
    const onChooser = (): void => {
      s.notes.push(
        'The page opened a file picker. Use browser_upload with the ref of the file field or its button.',
      );
    };
    page.on('filechooser', onChooser);
    return () => page.off('filechooser', onChooser);
  }

  private secretMasks(page: Page): Locator[] {
    return page
      .frames()
      .filter((f) => !f.isDetached())
      .slice(0, 10)
      .flatMap((f) => [f.locator('input[type="password" i]'), f.locator('[data-sa-secret]')]);
  }

  private addSecret(s: Session, secret: string): void {
    if (!secret || s.secrets.has(secret)) return;
    s.secrets.add(secret);
    s.secretVariants = [...new Set([...s.secretVariants, ...secretVariants(secret)])].sort(
      (a, b) => b.length - a.length,
    );
  }

  private async tabsInfo(s: Session): Promise<BrowserTab[]> {
    const pages = s.pages.filter((p) => !p.isClosed());
    const titles = await Promise.all(pages.map((p) => withTimeout(p.title(), 1_000, '')));
    return pages.map((p, index) => ({
      index,
      url: maskSecrets(p.url(), s.secretVariants),
      title: maskSecrets(titles[index] ?? '', s.secretVariants),
      active: p === s.active,
    }));
  }

  // =============================================================================================
  // Observations
  // =============================================================================================

  private async observe(
    s: Session,
    opts: { initialWait?: number } = {},
  ): Promise<BrowserObservation> {
    const first = this.livePage(s);
    if (!first)
      throw new BrowserError('no_page', 'No tab is open. Use browser_open with a URL first.');
    await this.settle(s, first, opts.initialWait ?? 100);
    await this.waitForBackgroundWork(s);

    let page = this.livePage(s) ?? first;
    let before: Awaited<ReturnType<typeof collectPasswordValues>>;
    let after: typeof before;
    let json: unknown;
    let snapshotError: string | undefined;
    for (let attempt = 0; ; attempt++) {
      before = await collectPasswordValues(page);
      json = [];
      snapshotError = undefined;
      try {
        json = await this.captureSnapshot(page);
      } catch (err) {
        snapshotError = cleanPlaywrightMessage(errorMessage(err));
      }
      after = before.count ? await collectPasswordValues(page) : before;
      // A popup the action opened can be reported late (on a busy machine, after the settle
      // above): if the active tab changed while the page was being read, observe that tab
      // instead, so the snapshot, its refs and `tabs` all describe the same page.
      const live = this.livePage(s);
      if (!live || live === page || attempt >= 2) break;
      page = live;
      await this.settle(s, page, 0);
    }
    const rendered = renderSnapshot(json, {
      budget: this.budget,
      secrets: s.secretVariants,
      passwordValues: [...before.values, ...after.values],
    });
    s.lastRefs = rendered.refs;
    const url = page.url();
    if (isHttpUrl(url)) s.lastUrl = url;

    const [title, tabs, imageId] = await Promise.all([
      withTimeout(page.title(), 2_000, ''),
      this.tabsInfo(s),
      this.captureMedia(s, page, sha256(`${url}\n${rendered.text}`)),
    ]);

    const notes = s.notes.splice(0);
    notes.push(
      ...detectPageNotes({
        url,
        title,
        text: rendered.fullText,
        frameUrls: page.frames().map((f) => f.url()),
      }),
    );
    const pdfName = s.pdfPages.get(page);
    if (snapshotError) {
      notes.push(`Could not read the page (${snapshotError}). Take a new snapshot.`);
    } else if (!rendered.text.trim()) {
      notes.push(
        pdfName
          ? `This tab shows a PDF ("${pdfName}"); its text is not in the snapshot. It was saved as a document.`
          : 'The page looks empty (it may still be loading).',
      );
    }
    if (s.context) {
      void s.context
        .cookies()
        .then((cookies) => {
          s.cachedCookies = cookies;
        })
        .catch(noop);
    }

    const mask = (v: string): string => maskSecrets(v, s.secretVariants);
    return {
      url: mask(url),
      title: mask(title),
      snapshot: rendered.text,
      truncated: rendered.truncated,
      tabs,
      downloads: s.downloads.splice(0).map((d) => ({ ...d, name: mask(d.name) })),
      signatures: s.signatures
        .splice(0)
        .map((e) => (e.message === undefined ? e : { ...e, message: mask(e.message) })),
      dialogs: s.dialogs.splice(0).map(mask),
      pageErrors: s.pageErrors.splice(0).map(mask),
      notes: [...new Set(notes.map(mask))],
      imageId,
    };
  }

  /** Waits for the load state and a quiet network (with caps), following popups. */
  private async settle(s: Session, first: Page, initialWait: number): Promise<void> {
    const deadline = Date.now() + this.settleTimeout;
    // Never 0: a Playwright timeout of 0 means "wait forever".
    const remaining = () => Math.max(1, deadline - Date.now());
    if (initialWait) await sleep(initialWait);
    for (let round = 0; round < 8 && Date.now() < deadline; round++) {
      const page = this.livePage(s) ?? first;
      if (page.isClosed()) return;
      const tracker = this.trackers.get(page);
      const navigations = tracker?.navigations ?? 0;
      await page.waitForLoadState('domcontentloaded', { timeout: remaining() }).catch(noop);
      if (tracker) {
        while (Date.now() < deadline && !page.isClosed()) {
          const now = Date.now();
          if (tracker.busy(now) === 0 && now - tracker.lastActivity >= QUIET_MS) break;
          await sleep(50);
        }
      }
      await page.waitForLoadState('load', { timeout: Math.min(1_500, remaining()) }).catch(noop);
      if ((tracker?.navigations ?? 0) === navigations && this.livePage(s) === page) return;
    }
  }

  private async waitForBackgroundWork(s: Session): Promise<void> {
    if (s.pending.size && !(await settleAll(s.pending, 20_000))) {
      s.notes.push('A download is still in progress; it will be reported in a later observation.');
    }
    if (s.afirmaInFlight.size) {
      const done = await settleAll(s.afirmaInFlight, this.signatureWait);
      if (!done) {
        s.notes.push(
          'A signature request is waiting for the user to approve it in the app. Wait (browser_wait) before continuing.',
        );
        return;
      }
      // The site usually submits a form after the signature: let it settle again.
      const page = this.livePage(s);
      if (page) await this.settle(s, page, 100);
      if (s.pending.size) await settleAll(s.pending, 20_000);
    }
  }

  private async captureSnapshot(page: Page): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await page.ariaSnapshotJSON({ mode: 'ai', timeout: 10_000 });
      } catch (err) {
        lastError = err;
        if (page.isClosed()) break;
        await sleep(300);
        await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(noop);
      }
    }
    throw lastError;
  }

  /** Low-res JPEG for the UI (not for the model), throttled. */
  private async captureMedia(s: Session, page: Page, key: string): Promise<string | undefined> {
    const save = this.opts.saveMedia;
    if (!save) return undefined;
    const last = s.lastMedia;
    const now = Date.now();
    if (last && last.key === key) return last.id;
    if (last && now - last.at < this.mediaInterval) return undefined;
    try {
      const jpeg = await page.screenshot({
        type: 'jpeg',
        quality: 45,
        scale: 'css',
        mask: this.secretMasks(page),
        maskColor: '#888888',
        timeout: 5_000,
      });
      const id = await save(s.id, jpeg);
      s.lastMedia = { at: now, id, key };
      return id;
    } catch (err) {
      this.log.debug('ui screenshot failed', { procedureId: s.id, error: errorMessage(err) });
      return undefined;
    }
  }

  // =============================================================================================
  // Page events: dialogs, downloads, inline PDFs, certificate errors
  // =============================================================================================

  private async onDialog(s: Session, dialog: Dialog): Promise<void> {
    const type = dialog.type();
    const message = dialog.message().replace(/\s+/g, ' ').trim().slice(0, 300);
    try {
      if (type === 'prompt') {
        await dialog.dismiss();
        s.dialogs.push(`prompt "${message}" → dismissed`);
      } else if (type === 'beforeunload') {
        await dialog.accept();
        s.dialogs.push('"Leave this page?" → accepted');
      } else {
        await dialog.accept();
        s.dialogs.push(`${type} "${message}" → accepted`);
      }
    } catch (err) {
      this.log.debug('dialog handling failed', { error: errorMessage(err) });
    }
  }

  /** Uncaught exceptions and unhandled rejections of the page's scripts (any frame). */
  private onPageError(s: Session, page: Page, error: Error): void {
    const text = describePageError(error);
    if (s.pageErrors.length < MAX_PAGE_ERRORS && !s.pageErrors.includes(text)) {
      s.pageErrors.push(text);
    }
    if (s.loggedPageErrors.size < 100 && !s.loggedPageErrors.has(text)) {
      s.loggedPageErrors.add(text);
      let host = '';
      try {
        host = hostOf(page.url());
      } catch {
        host = '';
      }
      this.log.warn('page script error', {
        procedureId: s.id,
        host,
        error: maskSecrets(text, s.secretVariants),
      });
    }
  }

  private onDownload(s: Session, download: Download): void {
    this.track(
      s,
      (async () => {
        const name = sanitizeFileName(download.suggestedFilename(), 'descarga');
        await fs.mkdir(this.opts.downloadsDir, { recursive: true });
        const staged = path.join(this.opts.downloadsDir, `${randomUUID()}-${name}`);
        try {
          await download.saveAs(staged);
        } catch {
          const failure = await download.failure().catch(() => null);
          s.notes.push(`The download of "${name}" failed${failure ? ` (${failure})` : ''}.`);
          await fs.rm(staged, { force: true }).catch(noop);
          return;
        } finally {
          await download.delete().catch(noop);
        }
        await this.deliver(s, staged, name);
      })(),
    );
  }

  private onResponse(s: Session, page: Page, response: Response): void {
    let headers: Record<string, string>;
    try {
      headers = response.headers();
    } catch {
      return;
    }
    const contentType = headers['content-type'] ?? '';
    if (/application\/(?:x-)?pdf/i.test(contentType)) {
      this.captureInlinePdf(s, page, response, headers);
    } else if (headers['x-sa-certificate-requested'] === 'none') {
      // The site asked for a client certificate and the sidecar presented none (Chromium never
      // sees the request: it would open its own certificate picker).
      try {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame())
          s.notes.push(certificateRequestedNote(hostOf(response.url())));
      } catch {
        // The frame is gone.
      }
    } else if (headers['x-sa-certificate-error'] && response.status() === 502) {
      // The sidecar's page when a certificate login failed upstream (packages/sidecar).
      const code = headers['x-sa-certificate-error'];
      this.track(
        s,
        (async () => {
          if (!response.request().isNavigationRequest()) return;
          const text = await response.text().catch(() => '');
          const detail = /SpainAssist certificate error \([^)]*\): ([^<]*)/.exec(text)?.[1];
          s.notes.push(certificateFailedNote(hostOf(response.url()), code, decodeEntities(detail)));
        })(),
      );
    }
  }

  /**
   * PDFs that Chromium shows in its viewer fire no download event. The main-frame response body
   * is the viewer's HTML wrapper; the real bytes arrive in a sub-request (type "other") that
   * reuses the original response (even for POST results). Keep whichever body is a real PDF.
   */
  private captureInlinePdf(
    s: Session,
    page: Page,
    response: Response,
    headers: Record<string, string>,
  ): void {
    const disposition = headers['content-disposition'];
    if (disposition && /^\s*attachment/i.test(disposition)) return; // a download event follows
    const type = response.request().resourceType();
    if (type !== 'document' && type !== 'other') return;
    this.track(
      s,
      (async () => {
        const body = await response.body().catch(() => null);
        if (body?.subarray(0, 5).toString('latin1') !== '%PDF-') return;
        const hash = sha256(body);
        if (s.pdfHashes.has(hash)) return;
        if (s.pdfHashes.size > 200) s.pdfHashes.clear();
        s.pdfHashes.add(hash);
        let name =
          fileNameFromContentDisposition(disposition) ??
          fileNameFromUrl(pdfSourceUrl(response, page), 'documento.pdf');
        name = sanitizeFileName(name, 'documento.pdf');
        if (!/\.pdf$/i.test(name)) name += '.pdf';
        await fs.mkdir(this.opts.downloadsDir, { recursive: true });
        const staged = path.join(this.opts.downloadsDir, `${randomUUID()}-${name}`);
        await fs.writeFile(staged, body);
        const doc = await this.deliver(s, staged, name, 'application/pdf');
        if (doc) {
          s.pdfPages.set(page, doc.name);
          s.notes.push(`The PDF shown in the browser was downloaded ("${doc.name}").`);
        }
      })(),
    );
  }

  private onRequestFailed(s: Session, request: Request): void {
    const text = request.failure()?.errorText ?? '';
    if (!CLIENT_CERT_NET_ERROR.test(text)) return;
    let navigation = false;
    try {
      navigation = request.isNavigationRequest();
    } catch {
      return;
    }
    if (navigation) s.notes.push(certificateRequestedNote(hostOf(request.url())));
  }

  /** Hands a staged file to the app, records it for the next observation, deletes what's left. */
  private async deliver(
    s: Session,
    stagedPath: string,
    name: string,
    mimeType?: string,
  ): Promise<{ downloadId: string; name: string; mimeType: string } | undefined> {
    try {
      let type = mimeType;
      if (!type) {
        const handle = await fs.open(stagedPath, 'r');
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 0).finally(() => handle.close());
        type = guessMimeType(name, head);
      }
      const doc = await this.opts.onDownload(s.id, {
        path: stagedPath,
        suggestedName: name,
        mimeType: type,
      });
      const entry = {
        downloadId: String(doc.downloadId),
        name: String(doc.name),
        mimeType: String(doc.mimeType),
      };
      s.downloads.push(entry);
      return entry;
    } catch (err) {
      this.log.error('could not keep a downloaded file', {
        procedureId: s.id,
        error: errorMessage(err),
      });
      s.notes.push(`"${name}" was downloaded but could not be kept.`);
      return undefined;
    } finally {
      await fs.rm(stagedPath, { force: true }).catch(noop);
    }
  }

  private track(s: Session, work: Promise<unknown>): void {
    const guarded = work.catch((err) => {
      this.log.debug('background task failed', { error: errorMessage(err) });
    });
    s.pending.add(guarded);
    void guarded.finally(() => s.pending.delete(guarded));
  }

  // =============================================================================================
  // AutoFirma replacement
  // =============================================================================================

  private async installAfirma(s: Session, context: BrowserContext): Promise<void> {
    const afirma = this.opts.afirma;
    if (!afirma) return;
    await context.exposeBinding(AFIRMA_BINDING, (source: { frame: Frame }, call: unknown) =>
      this.onAfirmaCall(s, source.frame, call),
    );
    if (afirma.shimSource) await context.addInitScript({ content: afirma.shimSource });
  }

  private onAfirmaCall(s: Session, frame: Frame, raw: unknown): Promise<AfirmaReply> {
    const afirma = this.opts.afirma;
    const notice = parseAfirmaArgs(raw);
    if (notice?.method === AFIRMA_NOTICE) {
      this.onAfirmaNotice(s, effectiveFrameUrl(frame), notice.args);
      return Promise.resolve({ ok: true, callbackArgs: [] });
    }
    const work = (async (): Promise<AfirmaReply> => {
      // origin/url come from the calling frame as seen by the browser, never from the page.
      const url = effectiveFrameUrl(frame);
      const origin = originOf(url);
      const parsed = parseAfirmaArgs(raw);
      if (!afirma || !parsed) {
        return {
          ok: false,
          errorType: 'java.lang.IllegalArgumentException',
          errorMessage: 'Invalid AutoFirma call',
        };
      }
      const call: AfirmaCall = { method: parsed.method, args: parsed.args, origin, url };
      let reported = false;
      const report: AfirmaHandlerContext['report'] = (event) => {
        reported = true;
        s.signatures.push({
          status: event.status,
          format: String(event.format ?? ''),
          origin: String(event.origin ?? origin),
          ...(event.message !== undefined ? { message: String(event.message).slice(0, 500) } : {}),
        });
      };
      const host = hostOf(url);
      try {
        const ctx: AfirmaHandlerContext = { ...afirma.context(s.id), procedureId: s.id, report };
        const reply = await afirma.handler(call, ctx);
        if (reply.ok) {
          this.log.info('AutoFirma call', { procedureId: s.id, method: call.method, host });
        } else {
          const code = (reply as { errorCode?: unknown }).errorCode;
          this.log.info('AutoFirma call failed', {
            procedureId: s.id,
            method: call.method,
            host,
            errorType: reply.errorType,
            ...(typeof code === 'string' ? { code } : {}),
            error: maskSecrets(reply.errorMessage.slice(0, 300), s.secretVariants),
          });
          // Signatures report themselves; anything else the page asked AutoFirma for gets a note.
          if (!reported) {
            s.notes.push(
              `The page's AutoFirma call ${call.method} failed: ${reply.errorMessage.slice(0, 200) || reply.errorType}.`,
            );
          }
        }
        return reply;
      } catch (err) {
        this.log.error('AutoFirma handler failed', {
          procedureId: s.id,
          method: call.method,
          error: errorMessage(err),
        });
        report({ status: 'failed', format: '', origin, message: 'Internal error while signing' });
        return { ok: false, errorType: 'java.lang.Exception', errorMessage: 'Internal error' };
      }
    })();
    s.afirmaInFlight.add(work);
    void work.finally(() => s.afirmaInFlight.delete(work)).catch(noop);
    return work;
  }

  /** The shim's diagnostics (`AFIRMA_NOTICE`): never signs, never waits. */
  private onAfirmaNotice(s: Session, url: string, args: unknown[]): void {
    const kind = args[0];
    const detail = typeof args[1] === 'string' ? args[1].slice(0, 64) : '';
    const origin = originOf(url);
    const host = hostOf(url);
    if (kind === 'loaded') {
      this.log.info('AutoFirma page', { procedureId: s.id, host, version: detail });
      if (s.afirmaOrigins.has(origin) || s.afirmaOrigins.size >= 50) return;
      s.afirmaOrigins.add(origin);
      s.notes.push(afirmaPageNote(host));
    } else if (kind === 'ignored' && /^[A-Za-z_$][\w$]*$/.test(detail)) {
      this.log.warn('AutoFirma method not implemented', {
        procedureId: s.id,
        host,
        method: detail,
      });
      s.notes.push(
        `The page called AutoScript.${detail}, which the app's AutoFirma replacement does not implement; the call was ignored. If the page then gets stuck, tell the user this site's AutoFirma flow is not supported yet.`,
      );
    }
  }

  // =============================================================================================
  // Screencast
  // =============================================================================================

  private followScreencast(s: Session): void {
    const sc = s.screencast;
    if (!sc || sc.stopped) return;
    sc.chain = sc.chain.then(async () => {
      if (sc.stopped) return;
      const page = s.active && !s.active.isClosed() ? s.active : undefined;
      if (page === sc.page) return;
      const previous = sc.disposable;
      sc.disposable = undefined;
      sc.page = page;
      await previous?.dispose().catch(noop);
      if (!page || sc.stopped) return;
      try {
        sc.disposable = await page.screencast.start({
          onFrame: (frame) => sc.onFrame(frame),
          size: sc.size,
          quality: sc.quality,
        });
      } catch (err) {
        this.log.debug('screencast start failed', { error: errorMessage(err) });
      }
    });
  }

  private async stopScreencast(s: Session, sc: Screencast): Promise<void> {
    sc.stopped = true;
    if (s.screencast === sc) s.screencast = undefined;
    await sc.chain.catch(noop);
    const d = sc.disposable;
    sc.disposable = undefined;
    await d?.dispose().catch(noop);
  }
}

// ===============================================================================================
// Helpers
// ===============================================================================================

function newSession(id: string): Session {
  return {
    id,
    everHadContext: false,
    pages: [],
    proxyUser: randomUUID(),
    secrets: new Set(),
    secretVariants: [],
    lastRefs: new Map(),
    downloads: [],
    signatures: [],
    dialogs: [],
    pageErrors: [],
    loggedPageErrors: new Set(),
    afirmaOrigins: new Set(),
    notes: [],
    pending: new Set(),
    afirmaInFlight: new Set(),
    pdfHashes: new Set(),
    pdfPages: new WeakMap(),
    crashedPages: new WeakSet(),
    queue: Promise.resolve(),
    closed: false,
    visible: false,
    windowQueue: Promise.resolve(),
  };
}

/** The viewer's stream request has a chrome-extension:// URL; its frame keeps the real one. */
function pdfSourceUrl(response: Response, page: Page): string {
  const url = response.url();
  if (isHttpUrl(url)) return url;
  try {
    const frameUrl = response.frame().url();
    if (isHttpUrl(frameUrl)) return frameUrl;
  } catch {
    // no frame (service worker)
  }
  return page.url();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function publicError(s: Session, err: unknown): BrowserError {
  if (err instanceof BrowserError) {
    return new BrowserError(err.code, maskSecrets(err.message, s.secretVariants));
  }
  const raw = errorMessage(err);
  if (
    /Target (?:page, context or browser )?(?:has been )?closed|Browser has been closed|browser has disconnected/i.test(
      raw,
    )
  ) {
    return new BrowserError('closed', BROWSER_CLOSED);
  }
  return new BrowserError('internal', maskSecrets(cleanPlaywrightMessage(raw), s.secretVariants));
}

function validateUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new BrowserError(
      'bad_input',
      `"${url}" is not a valid URL. Use a full address like https://sede.example.gob.es/.`,
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.protocol !== 'http:' &&
    parsed.href !== 'about:blank'
  ) {
    throw new BrowserError(
      'bad_input',
      `Only http(s) addresses can be opened (got ${parsed.protocol}).`,
    );
  }
  return parsed.href;
}

function netErrorHint(code: string): string {
  if (/NAME_NOT_RESOLVED|NAME_RESOLUTION/.test(code)) return 'the address does not exist; check it';
  if (/CONNECTION_REFUSED|CONNECTION_RESET|CONNECTION_CLOSED|EMPTY_RESPONSE/.test(code))
    return 'the site did not answer; it may be down';
  if (/TIMED_OUT/.test(code)) return 'the site took too long to answer';
  if (/INTERNET_DISCONNECTED|NETWORK_CHANGED/.test(code)) return 'no internet connection';
  if (/CERT_/.test(code)) return 'the site has an invalid security certificate; do not continue';
  return 'network error';
}

interface FieldState {
  /** Native state that blocks typing: "read-only" or "disabled". */
  locked?: string;
  /** ARIA-only state the page may enforce with scripts. */
  marked?: string;
  password: boolean;
  /** Shows suggestions while focused (blurring would hide them). */
  suggests: boolean;
}

async function fieldState(loc: Locator): Promise<FieldState> {
  return loc
    .evaluate((el): FieldState => {
      const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
      const aria = (n: string) => el.getAttribute(n) === 'true';
      return {
        locked: el.matches(':disabled')
          ? 'disabled'
          : text && el.readOnly
            ? 'read-only'
            : undefined,
        marked: aria('aria-readonly')
          ? 'read-only'
          : aria('aria-disabled')
            ? 'disabled'
            : undefined,
        password: el instanceof HTMLInputElement && el.type === 'password',
        suggests:
          el.getAttribute('role') === 'combobox' ||
          el.hasAttribute('aria-autocomplete') ||
          el.hasAttribute('list'),
      };
    })
    .catch(() => ({ password: false, suggests: false }));
}

/**
 * The field's value once the page had a moment to react. With `blur`, also after the field
 * loses focus (date pickers and masks often clear or reformat it then); focus is given back so
 * a later key press still goes to the field.
 */
async function settledValue(loc: Locator, blur: boolean): Promise<string | undefined> {
  const page = loc.page();
  await page.waitForTimeout(100);
  if (blur) {
    await loc.evaluate((el) => (el as HTMLElement).blur()).catch(noop);
    await page.waitForTimeout(100);
  }
  const value = await loc.inputValue({ timeout: 1_000 }).catch(() => undefined);
  if (blur) await loc.focus({ timeout: 1_000 }).catch(noop);
  return value;
}

/** A note when the page did not keep the typed text. Secret values are never echoed. */
function keptValueNote(
  ref: string,
  typed: string,
  value: string | undefined,
  opts: { secret: boolean; marked?: string },
): string | undefined {
  if (value === undefined) return;
  const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (opts.secret ? value !== '' : loose(value) === loose(typed)) return;
  const marked = opts.marked ? ` It is marked ${opts.marked}.` : '';
  const now = opts.secret ? 'is empty' : `now contains "${value}" (typed "${typed}")`;
  return `${ref} ${now}: the page rejected or reformatted the value.${marked} It may be read-only or need its picker/calendar.`;
}

/** Normalizes for loose option matching: lowercase, no accents, collapsed spaces. */
function looseText(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchOption(
  options: { value: string; label: string }[],
  wanted: string,
): { value: string; label: string } | undefined {
  const exact = options.find((o) => o.value === wanted) ?? options.find((o) => o.label === wanted);
  if (exact) return exact;
  const w = looseText(wanted);
  const loose =
    options.find((o) => looseText(o.label) === w) ?? options.find((o) => looseText(o.value) === w);
  if (loose) return loose;
  const partial = options.filter((o) => looseText(o.label).includes(w));
  return partial.length === 1 ? partial[0] : undefined;
}

const MAX_PAGE_ERRORS = 5;

/** `TypeError: x is not a function (/js/login.js:12)`: no query strings, short. */
function describePageError(error: Error): string {
  const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : '';
  const message = String(error?.message ?? error)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  let where = '';
  const frame = /\(?((?:https?|file):\/\/[^\s)]+?):(\d+):\d+\)?/.exec(String(error?.stack ?? ''));
  if (frame?.[1]) {
    try {
      where = ` (${new URL(frame[1]).pathname}:${frame[2]})`;
    } catch {
      where = '';
    }
  }
  return `${name}${message || 'Unknown error'}${where}`;
}

function parseAfirmaArgs(raw: unknown): { method: string; args: unknown[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const { method, args } = raw as { method?: unknown; args?: unknown };
  if (typeof method !== 'string' || !/^[A-Za-z][\w.]{0,63}$/.test(method)) return null;
  if (args !== undefined && !Array.isArray(args)) return null;
  return { method, args: Array.isArray(args) ? args.slice(0, 32) : [] };
}

function isCookie(c: unknown): boolean {
  if (!c || typeof c !== 'object') return false;
  const k = c as Record<string, unknown>;
  return (
    typeof k.name === 'string' &&
    typeof k.value === 'string' &&
    typeof k.domain === 'string' &&
    typeof k.path === 'string' &&
    typeof k.expires === 'number' &&
    typeof k.httpOnly === 'boolean' &&
    typeof k.secure === 'boolean' &&
    (k.sameSite === 'Strict' || k.sameSite === 'Lax' || k.sameSite === 'None')
  );
}

function parseStorageState(state: string): StorageState {
  let raw: unknown;
  try {
    raw = JSON.parse(state);
  } catch {
    throw new BrowserError('bad_input', 'The saved browser state is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object') {
    throw new BrowserError('bad_input', 'The saved browser state is not an object.');
  }
  const { cookies, origins } = raw as { cookies?: unknown; origins?: unknown };
  const validOrigins = (Array.isArray(origins) ? origins : []).filter(
    (o): o is StorageState['origins'][number] =>
      !!o &&
      typeof o === 'object' &&
      typeof (o as { origin?: unknown }).origin === 'string' &&
      Array.isArray((o as { localStorage?: unknown }).localStorage),
  );
  return {
    cookies: (Array.isArray(cookies) ? cookies : []).filter(isCookie) as StorageState['cookies'],
    origins: validOrigins,
  };
}

/**
 * Answers the TLS sidecar's proxy authentication (its per-launch password) for every context,
 * from one browser-level DevTools session. Chromium only reports auth challenges for requests it
 * intercepts, so http(s) requests are paused and each one continues at once; chrome-extension://
 * requests (Chromium's PDF viewer) are left alone and the HTTP cache stays on. Playwright's own
 * proxy credentials would intercept every request of the context instead, which breaks PDFs
 * shown inline. Sites' own auth challenges keep Chromium's default behaviour.
 */
async function answerProxyLogins(
  browser: Browser,
  credentials: { username: string; password: string },
): Promise<void> {
  const cdp = await browser.newBrowserCDPSession();
  const answered = new Set<string>();
  cdp.on('Fetch.requestPaused', (event) => {
    cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(noop);
  });
  cdp.on('Fetch.authRequired', (event) => {
    // A second challenge for the same request means the password was refused: stop there.
    const proxy = event.authChallenge.source === 'Proxy' && !answered.has(event.requestId);
    if (proxy) answered.add(event.requestId);
    if (answered.size > 1000) answered.clear();
    cdp
      .send('Fetch.continueWithAuth', {
        requestId: event.requestId,
        authChallengeResponse: proxy
          ? { response: 'ProvideCredentials', ...credentials }
          : { response: event.authChallenge.source === 'Proxy' ? 'CancelAuth' : 'Default' },
      })
      .catch(noop);
  });
  await cdp.send('Fetch.enable', {
    handleAuthRequests: true,
    patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }],
  });
}

/**
 * Closes a context after its pages. `context.close()` alone never finishes for a context that
 * records a HAR and ever showed a PDF in Chromium's viewer (even after navigating away); closing
 * the pages first takes milliseconds. Neither wait can block the caller: a context that does not
 * close in time is left to the browser (which closes with the service).
 */
async function closeContext(context: BrowserContext): Promise<void> {
  await Promise.all(
    context
      .pages()
      .map((page) => withTimeout(page.close({ runBeforeUnload: false }), PAGE_CLOSE_MS, undefined)),
  );
  await withTimeout(context.close(), CONTEXT_CLOSE_MS, undefined);
}

async function headfulUserAgent(browser: Browser): Promise<string | undefined> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const version = (await cdp.send('Browser.getVersion')) as { userAgent?: string };
    await cdp.detach().catch(noop);
    return version.userAgent?.replace(/HeadlessChrome/g, 'Chrome');
  } catch {
    return undefined;
  }
}

function decodeEntities(text: string | undefined): string {
  return (text ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&#34;|&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}
