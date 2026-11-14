import type {
  BrowserQueryArgs,
  BrowserQueryOp,
  ClientCertificateUse,
  LiveInput,
  ScreencastFrame,
  TypeOptions,
} from '@sa/browser';
import type { BrowserObservation } from '@sa/shared';
import { BridgeError } from '../core/errors';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { BrowserPort } from '../ports';

/** Said to the agent after `reopenHeaded`: what the move kept and what it lost. */
export const REOPENED_HEADED_NOTE =
  "Reopened in a visible browser window (the user doesn't have to look at it). Cookies and site storage were kept and the last page was loaded again, so anything typed on a page and not submitted is gone, and a form that was submitted may need to be filled again: check the page before continuing.";

/**
 * The agent's browsers: a headless one for every procedure, and a headed one (a real window,
 * minimized) created only when an agent moves a procedure there with `reopenHeaded`, for sites
 * that refuse the headless browser. Each procedure's calls go to the browser that holds it.
 * Without a headed factory (the primary browser is already headed) every procedure stays put.
 */
export class RoutedBrowser implements BrowserPort {
  private headed?: BrowserPort;
  /** Procedures moved to the headed browser. They stay there (the site refused headless). */
  private readonly onHeaded = new Set<string>();
  /** Procedures that opened a page in the headless browser: only they may move. */
  private readonly triedHeadless = new Set<string>();
  /** The client certificate each procedure presents, to present it again after a move. */
  private readonly certificates = new Map<string, ClientCertificateUse>();

  constructor(
    private readonly primary: BrowserPort,
    private readonly createHeaded: (() => BrowserPort) | undefined,
    private readonly log: Logger,
  ) {}

  /** Whether this procedure's browser is the headed one (a real window). */
  isHeaded(procedureId: string): boolean {
    return !this.createHeaded || this.onHeaded.has(procedureId);
  }

  /**
   * Moves the procedure to the headed browser: its cookies and storage go along, its last page
   * is opened again. Only after it opened a page headless (never the first attempt).
   */
  async reopenHeaded(procedureId: string): Promise<BrowserObservation> {
    if (this.isHeaded(procedureId)) {
      const observation = await this.for(procedureId).snapshot(procedureId);
      return {
        ...observation,
        notes: [...observation.notes, 'The browser of this procedure is already visible.'],
      };
    }
    if (!this.triedHeadless.has(procedureId))
      throw new BridgeError(
        'bad_request',
        'Open the site in the normal browser first: the visible browser is only for sites that refuse it (blocked, endless checks).',
      );
    const url = this.primary.currentUrl(procedureId);
    if (!url)
      throw new BridgeError(
        'bad_request',
        'The browser of this procedure has no page open: open the site first.',
      );
    const state = await this.primary.exportState(procedureId);
    await this.primary.close(procedureId);
    const headed = this.headedBrowser();
    this.onHeaded.add(procedureId);
    if (state) await headed.importState(procedureId, state);
    // biome-ignore lint/correctness/useHookAtTopLevel: presents the certificate in the new browser.
    await headed.useClientCertificate(procedureId, this.certificates.get(procedureId) ?? null);
    this.log.info('procedure moved to the headed browser', { procedureId });
    const observation = await headed.open(procedureId, url);
    return { ...observation, notes: [...observation.notes, REOPENED_HEADED_NOTE] };
  }

  private headedBrowser(): BrowserPort {
    if (!this.createHeaded) throw new Error('No headed browser');
    this.headed ??= this.createHeaded();
    return this.headed;
  }

  private for(procedureId: string): BrowserPort {
    return this.onHeaded.has(procedureId) && this.headed ? this.headed : this.primary;
  }

  async open(
    procedureId: string,
    url: string,
    opts?: { newTab?: boolean },
  ): Promise<BrowserObservation> {
    const browser = this.for(procedureId);
    const observation = await browser.open(procedureId, url, opts);
    if (browser === this.primary) this.triedHeadless.add(procedureId);
    return observation;
  }
  snapshot(procedureId: string): Promise<BrowserObservation> {
    return this.for(procedureId).snapshot(procedureId);
  }
  click(procedureId: string, ref: string): Promise<BrowserObservation> {
    return this.for(procedureId).click(procedureId, ref);
  }
  type(
    procedureId: string,
    ref: string,
    text: string,
    opts?: TypeOptions,
  ): Promise<BrowserObservation> {
    return this.for(procedureId).type(procedureId, ref, text, opts);
  }
  select(procedureId: string, ref: string, values: string[]): Promise<BrowserObservation> {
    return this.for(procedureId).select(procedureId, ref, values);
  }
  check(procedureId: string, ref: string, checked: boolean): Promise<BrowserObservation> {
    return this.for(procedureId).check(procedureId, ref, checked);
  }
  press(procedureId: string, key: string): Promise<BrowserObservation> {
    return this.for(procedureId).press(procedureId, key);
  }
  wait(
    procedureId: string,
    opts: { text?: string; textGone?: string; seconds?: number },
  ): Promise<BrowserObservation> {
    return this.for(procedureId).wait(procedureId, opts);
  }
  back(procedureId: string): Promise<BrowserObservation> {
    return this.for(procedureId).back(procedureId);
  }
  tabs(procedureId: string, action: 'list' | 'select' | 'close', index?: number) {
    return this.for(procedureId).tabs(procedureId, action, index);
  }
  screenshot(procedureId: string, opts?: { fullPage?: boolean }) {
    return this.for(procedureId).screenshot(procedureId, opts);
  }
  upload(
    procedureId: string,
    ref: string,
    files: { name: string; mimeType: string; buffer: Buffer }[],
  ): Promise<BrowserObservation> {
    return this.for(procedureId).upload(procedureId, ref, files);
  }
  query(
    procedureId: string,
    target: string,
    op: BrowserQueryOp,
    args?: BrowserQueryArgs,
  ): Promise<unknown> {
    return this.for(procedureId).query(procedureId, target, op, args);
  }
  reload(procedureId: string): Promise<BrowserObservation> {
    return this.for(procedureId).reload(procedureId);
  }
  info(procedureId: string): Promise<{ url: string; title: string }> {
    return this.for(procedureId).info(procedureId);
  }
  describeRef(procedureId: string, ref: string) {
    return this.for(procedureId).describeRef(procedureId, ref);
  }
  async useClientCertificate(procedureId: string, use: ClientCertificateUse | null): Promise<void> {
    await this.for(procedureId).useClientCertificate(procedureId, use);
    if (use) this.certificates.set(procedureId, use);
    else this.certificates.delete(procedureId);
  }
  currentUrl(procedureId: string): string | undefined {
    return this.for(procedureId).currentUrl(procedureId);
  }
  isOpen(procedureId: string): boolean {
    return this.for(procedureId).isOpen(procedureId);
  }
  show(procedureId: string): Promise<void> {
    return this.for(procedureId).show(procedureId);
  }
  hide(procedureId: string): Promise<void> {
    return this.for(procedureId).hide(procedureId);
  }
  exportState(procedureId: string): Promise<string | null> {
    return this.for(procedureId).exportState(procedureId);
  }
  importState(procedureId: string, state: string): Promise<void> {
    return this.for(procedureId).importState(procedureId, state);
  }
  finishCapture(procedureId: string): Promise<void> {
    return this.for(procedureId).finishCapture(procedureId);
  }
  async close(procedureId: string): Promise<void> {
    this.certificates.delete(procedureId);
    await this.for(procedureId).close(procedureId);
  }
  async closeAll(): Promise<void> {
    const headed = this.headed;
    this.headed = undefined;
    this.onHeaded.clear();
    this.triedHeadless.clear();
    this.certificates.clear();
    await Promise.all(
      [this.primary, headed].map((browser) =>
        browser
          ?.closeAll()
          .catch((err) => this.log.warn('closeAll failed', { error: errorMessage(err) })),
      ),
    );
  }
  startScreencast(
    procedureId: string,
    onFrame: (frame: ScreencastFrame) => void | Promise<void>,
    opts?: { width?: number; height?: number; quality?: number },
  ): Promise<() => Promise<void>> {
    return this.for(procedureId).startScreencast(procedureId, onFrame, opts);
  }
  input(procedureId: string, event: LiveInput): Promise<void> {
    return this.for(procedureId).input(procedureId, event);
  }
}
