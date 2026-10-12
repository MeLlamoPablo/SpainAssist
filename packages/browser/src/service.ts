/**
 * BrowserService implementation: one lazily-launched Chromium, one isolated context per
 * procedure. See README.md for the design and the risks.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AFIRMA_BINDING,
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
import { certificateHosts } from './certificates';
import {
  BrowserError,
  cleanPlaywrightMessage,
  maskSecrets,
  secretVariants,
  staleRefError,
  toActionError,
} from './errors';
import { ensureChromium } from './install';
import { NetworkTracker } from './network';
import {
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
  closed: boolean;
  visible: boolean;
  windowQueue: Promise<void>;
}

export class PlaywrightBrowserService implements BrowserService {
  private readonly log: Logger;
  private readonly sessions = new Map<string, Session>();
  private readonly trackers = new WeakMap<Page, NetworkTracker>();
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private userAgent?: string;
  private readonly budget: number;
  private readonly actionTimeout: number;
  private readonly navigationTimeout: number;
  private readonly settleTimeout: number;
  private readonly signatureWait: number;
  private readonly mediaInterval: number;

  constructor(private readonly opts: BrowserServiceOptions) {
    this.log = opts.logger ?? silentLogger;
    this.budget = opts.snapshotBudget ?? DEFAULT_BUDGET;
    this.actionTimeout = opts.actionTimeoutMs ?? 8_000;
    this.navigationTimeout = opts.navigationTimeoutMs ?? 30_000;
    this.settleTimeout = opts.settleTimeoutMs ?? 10_000;
    this.signatureWait = opts.signatureWaitMs ?? 60_000;
    this.mediaInterval = opts.mediaIntervalMs ?? 1_500;
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
      { create: true },
    );
  }

  snapshot(procedureId: string): Promise<BrowserObservation> {
    return this.run(procedureId, async (s) => {
      await this.pageFor(s);
      return this.observe(s, { initialWait: 0 });
    });
  }

  click(procedureId: string, ref: string): Promise<BrowserObservation> {
    return this.run(procedureId, async (s) => {
      const page = await this.pageFor(s);
      const loc = await this.resolveRef(page, ref);
      const stopIntercept = this.interceptFileChooser(s, page);
      try {
        try {
          await loc.click();
        } catch (err) {
          throw toActionError(err, `click ${ref}`, s.secretVariants);
        }
        return await this.observe(s);
      } finally {
        stopIntercept();
      }
    });
  }

  type(
    procedureId: string,
    ref: string,
    text: string,
    opts: TypeOptions = {},
  ): Promise<BrowserObservation> {
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    return this.run(procedureId, async (s) => {
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
    await browser?.close().catch(noop);
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

  private async run<T>(
    procedureId: string,
    fn: (s: Session) => Promise<T>,
    opts: { create?: boolean } = {},
  ): Promise<T> {
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
    try {
      await previous;
      if (session.closed)
        throw new BrowserError('closed', 'The browser for this procedure was closed.');
      return await fn(session);
    } catch (err) {
      throw publicError(session, err);
    } finally {
      release();
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.launching ??= this.launch().finally(() => {
      this.launching = undefined;
    });
    return this.launching;
  }

  private async launch(): Promise<Browser> {
    const headless = !!this.opts.headless;
    if (this.opts.installBrowser && !this.opts.executablePath && !this.opts.channel)
      await ensureChromium({ logger: this.log });
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
    };
    const browser = await chromium.launch(options);
    if (this.opts.certificates) {
      try {
        await answerProxyLogins(browser, this.opts.certificates.credentials);
      } catch (err) {
        await browser.close().catch(noop);
        throw err;
      }
    }
    browser.on('disconnected', () => this.onBrowserDisconnected(browser));
    this.userAgent = headless ? await headfulUserAgent(browser) : undefined;
    this.browser = browser;
    this.log.info('browser launched', { headless, version: browser.version() });
    return browser;
  }

  private onBrowserDisconnected(browser: Browser): void {
    if (this.browser === browser) this.browser = undefined;
    for (const s of this.sessions.values()) {
      if (s.context && s.context.browser() !== browser && s.context.browser() !== null) continue;
      s.context = undefined;
      s.pages = [];
      s.active = undefined;
    }
    this.log.warn('browser disconnected');
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
    const context = await browser.newContext(options);
    context.setDefaultTimeout(this.actionTimeout);
    context.setDefaultNavigationTimeout(this.navigationTimeout);
    context.on('page', (page) => this.attachPage(s, context, page));
    context.on('close', () => {
      if (s.context !== context) return;
      s.context = undefined;
      s.pages = [];
      s.active = undefined;
    });
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
    await context?.close().catch(noop);
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

    const page = this.livePage(s) ?? first;
    const before = await collectPasswordValues(page);
    let json: unknown = [];
    let snapshotError: string | undefined;
    try {
      json = await this.captureSnapshot(page);
    } catch (err) {
      snapshotError = cleanPlaywrightMessage(errorMessage(err));
    }
    const after = before.count ? await collectPasswordValues(page) : before;
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
      const report: AfirmaHandlerContext['report'] = (event) => {
        s.signatures.push({
          status: event.status,
          format: String(event.format ?? ''),
          origin: String(event.origin ?? origin),
          ...(event.message !== undefined ? { message: String(event.message).slice(0, 500) } : {}),
        });
      };
      try {
        const ctx: AfirmaHandlerContext = { ...afirma.context(s.id), procedureId: s.id, report };
        return await afirma.handler(call, ctx);
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
    return new BrowserError(
      'closed',
      'The browser window was closed or crashed. Try again: it will be reopened.',
    );
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
