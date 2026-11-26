import { join } from 'node:path';
import type {
  BrowserServiceOptions,
  CaptureOptions,
  CertificateProxy,
  ClientCertificateUse,
  CrlSetComponent,
  DownloadedFile,
  LiveInput,
} from '@sa/browser';
import {
  type AfirmaSignatureSummary,
  type BrowserObservation,
  type CredentialSummary,
  type DocumentMeta,
  type FnmtCall,
  type FnmtReply,
  issuerName,
  type Language,
  type SignaturePlacement,
  type SigningKey,
} from '@sa/shared';
import type { RemoteKey } from '@sa/sidecar';
import { openP12 } from '@sa/signer';
import type { PromptManager } from '../chat/prompts';
import type { CompanionService } from '../companion/service';
import { UserError } from '../core/errors';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage, formatBytes, hostOf } from '../core/util';
import type { MediaStore } from '../media/store';
import type { OsCertificates } from '../os-certificates/service';
import type { Biometric, BrowserFactory, SignerLib, VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';
import { CertificateBlocks } from './certificate-blocks';
import { DownloadStore, documentFileName } from './downloads';
import { RoutedBrowser } from './routed';

/** The origin of signatures on the user's own documents (no site asks): the app's own site. */
const OWN_DOCUMENTS_ORIGIN = 'https://spainassist.es';

export interface BrowserHolderDeps {
  factory: BrowserFactory;
  certificates?: CertificateProxy;
  certificateLoginsAvailable?: boolean;
  /** The Chromium to launch; Playwright's cache without it (development, e2e). */
  executablePath?: string;
  /** Chrome's CRLSet for each launch (`crlset/store.ts`); none in tests. */
  crlSet?: () => Promise<CrlSetComponent | undefined>;
  /**
   * Development/test override. Default headless: agents move a procedure to a headed browser
   * (`reopenHeaded`) when a site refuses it; with `false` every procedure is headed from the start.
   */
  headless?: boolean;
  /** Staging directory for browser downloads; temporary downloads live in its `kept` folder. */
  downloadsDir: string;
  /** Only enabled in the explicit development e2e mode. */
  ignoreHTTPSErrors?: boolean;
  /** Development only (SA_BROWSER_CAPTURE): record browsing for offline mock sites. */
  capture?: CaptureOptions;
  media: MediaStore;
  vault: () => VaultPort;
  procedures: ProcedureService;
  prompts: PromptManager;
  biometric: Biometric;
  events: EventBus;
  /** AutoFirma replacement; omitted (or empty shim) = no shim injected. */
  signer?: SignerLib;
  /**
   * FNMT certificate requests (`fnmt/broker.ts`), with the signer's `fnmtShimSource`; omitted =
   * FNMT's pages get no shim.
   */
  certificateRequests?: (call: FnmtCall, procedureId: string) => Promise<FnmtReply>;
  /** DNI signatures and logins with the paired phone; absent without the feature flag. */
  companion?: CompanionService;
  /** External certificates, in the OS store (macOS); absent elsewhere. */
  osCertificates?: OsCertificates;
  /** fetch for triphase signing (Electron's net.fetch uses the OS trust store). */
  fetch?: typeof fetch;
  logger: Logger;
  lang: () => Language;
}

/** Frames of the live view: the headless viewport's size (`@sa/browser`), sharp enough to read. */
const LIVE_FRAME_SIZE = { width: 1280, height: 800 };

function describeCertificate(c: CredentialSummary, lang: Language): string {
  if (c.kind === 'dnie') {
    const holder = c.certificate?.holderName;
    return holder ? t(lang, 'dnieOptionHolder', { holder }) : t(lang, 'dnieOption');
  }
  const holder = c.certificate?.holderName ?? c.label;
  const issuer = c.certificate && issuerName(c.certificate.issuer);
  const until = c.certificate?.validTo?.slice(0, 10);
  const parts = [
    holder,
    issuer,
    until ? `${lang === 'es' ? 'válido hasta' : 'valid until'} ${until}` : undefined,
  ];
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}

/**
 * Owns the agent's browsers (`RoutedBrowser`: headless, plus a headed one with minimized windows
 * for procedures an agent moved there), created lazily; the live view that shows the user a
 * headless page and takes their mouse and keys; and the browsers' app-side hooks: downloads go
 * to temporary downloads (until the agent saves them to the vault with `saveDownload`),
 * screenshots to the media store, AutoFirma signature requests to an approval prompt in the
 * procedure's chat, and FNMT certificate requests to `FnmtBroker`.
 */
export class BrowserHolder {
  private service?: RoutedBrowser;
  /** Live views being streamed to the renderer: their stop function, by procedure. */
  private readonly live = new Map<string, () => Promise<void>>();
  readonly downloads: DownloadStore;
  /** `page.withCertificate`: when the procedures' sites may use the user's certificates. */
  readonly certificateBlocks = new CertificateBlocks((procedureId, tls) =>
    this.stopCertificate(procedureId, tls),
  );

  constructor(private readonly deps: BrowserHolderDeps) {
    this.downloads = new DownloadStore(join(deps.downloadsDir, 'kept'));
  }

  certificateLoginsAvailable(): boolean {
    return this.deps.certificateLoginsAvailable !== false;
  }

  async certificateIdentity(
    procedureId: string,
    credential: CredentialSummary,
    origin: string,
  ): Promise<ClientCertificateUse['identity']> {
    if (credential.kind === 'dnie') {
      const identity = await this.deps.companion?.login(procedureId, credential, origin);
      if (!identity) throw new Error('DNI login was cancelled or unavailable.');
      // The block's end waits for the handshakes the phone is signing.
      const key = identity.key as RemoteKey;
      const busy = <T>(p: () => Promise<T>) => {
        const done = this.certificateBlocks.busy(procedureId);
        return p().finally(done);
      };
      return {
        ...identity,
        key: {
          prepare: (host, signal) => busy(() => key.prepare(host, signal)),
          sign: (digest, hash, host, signal) => busy(() => key.sign(digest, hash, host, signal)),
        },
      };
    }
    if (credential.external) {
      if (!this.deps.osCertificates) throw new Error('External certificates are unavailable.');
      return this.deps.osCertificates.sidecarIdentity(credential.id);
    }
    const secret = await this.deps.vault().getCredentialSecret(credential.id);
    if (secret.kind !== 'certificate') throw new Error('Unexpected credential type');
    this.deps.logger.addSecret(secret.passphrase);
    const identity = openP12(secret.p12, secret.passphrase);
    return { id: credential.id, chain: identity.chainDer, key: identity.privateKey };
  }

  /** News of the procedure's DNI logins for the agent's next observation. */
  loginNotes(procedureId: string): string[] {
    return this.deps.companion?.takeLoginNotes(procedureId) ?? [];
  }

  get(): RoutedBrowser {
    this.service ??= this.create();
    return this.service;
  }

  current(): RoutedBrowser | undefined {
    return this.service;
  }

  /** `RoutedBrowser.reopenHeaded`, ending the procedure's live view first (its page goes away). */
  async reopenHeaded(procedureId: string): Promise<BrowserObservation> {
    await this.endLive(procedureId, true);
    return this.get().reopenHeaded(procedureId);
  }

  /**
   * Shows the user the procedure's page: a headed procedure's real window comes to the front
   * (`window`); a headless one streams its frames as `browser.frame` events (`stream`) until
   * `stopLive`. `null` when the procedure has no page open.
   */
  async startLive(procedureId: string): Promise<'stream' | 'window' | null> {
    const browser = this.service;
    if (!browser?.isOpen(procedureId)) return null;
    if (browser.isHeaded(procedureId)) {
      await browser.show(procedureId);
      return 'window';
    }
    await this.endLive(procedureId, false);
    const stop = await browser.startScreencast(
      procedureId,
      (frame) =>
        this.deps.events.emit({
          type: 'browser.frame',
          procedureId,
          jpeg: frame.data.toString('base64'),
          width: frame.viewportWidth,
          height: frame.viewportHeight,
        }),
      { ...LIVE_FRAME_SIZE, quality: 80 },
    );
    this.live.set(procedureId, stop);
    return 'stream';
  }

  /** The renderer closed the live view. */
  stopLive(procedureId: string): Promise<void> {
    return this.endLive(procedureId, false);
  }

  /** Stops a live view; `notify`: main ended it, so the renderer hears `browser.liveEnded`. */
  private async endLive(procedureId: string, notify: boolean): Promise<void> {
    const stop = this.live.get(procedureId);
    if (!stop) return;
    this.live.delete(procedureId);
    if (notify) this.deps.events.emit({ type: 'browser.liveEnded', procedureId });
    await stop().catch((err) =>
      this.deps.logger.warn('could not stop the live view', { error: errorMessage(err) }),
    );
  }

  /** The user's mouse or keys in a live view (ignored when it isn't streaming). */
  async liveInput(procedureId: string, event: LiveInput): Promise<void> {
    if (!this.live.has(procedureId)) return;
    await this.service?.input(procedureId, event);
  }

  needsBrowserHelp(procedureId: string): boolean {
    return (
      this.deps.procedures
        .get(procedureId)
        ?.runtime.prompts?.some(
          (item) =>
            item.status === 'pending' &&
            item.prompt.kind === 'user_action' &&
            item.prompt.showBrowser &&
            item.prompt.actionKind !== 'offline',
        ) ?? false
    );
  }

  async showForHelp(procedureId: string): Promise<void> {
    const browser = this.service;
    if (this.needsBrowserHelp(procedureId) && browser?.isOpen(procedureId)) {
      await browser.show(procedureId);
      // The request may have been answered or cancelled while the window was restoring.
      if (!this.needsBrowserHelp(procedureId)) await browser.hide(procedureId);
    }
  }

  async hideAfterHelp(procedureId: string): Promise<void> {
    if (!this.needsBrowserHelp(procedureId)) await this.service?.hide(procedureId);
  }

  async close(procedureId: string): Promise<void> {
    await this.endLive(procedureId, true);
    if (this.service?.isOpen(procedureId)) await this.service.close(procedureId);
  }

  /** Capture mode: saves the procedure's browser capture (when it is stopped or cancelled). */
  async finishCapture(procedureId: string): Promise<void> {
    await this.service?.finishCapture(procedureId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.endLive(id, true)));
    const service = this.service;
    this.service = undefined;
    await service?.closeAll();
  }

  private create(): RoutedBrowser {
    const { deps } = this;
    const headless = deps.headless ?? true;
    const options = this.options();
    return new RoutedBrowser(
      deps.factory({ ...options, headless }),
      headless ? () => deps.factory({ ...options, headless: false }) : undefined,
      deps.logger,
    );
  }

  private options(): BrowserServiceOptions {
    const { deps } = this;
    const signer = deps.signer?.shimSource ? deps.signer : undefined;
    return {
      certificates: deps.certificates,
      startHidden: true,
      executablePath: deps.executablePath,
      ...(deps.crlSet ? { crlSet: deps.crlSet } : {}),
      ignoreHTTPSErrors: deps.ignoreHTTPSErrors ?? false,
      ...(deps.capture ? { capture: deps.capture } : {}),
      downloadsDir: deps.downloadsDir,
      saveMedia: async (procedureId, jpeg) => {
        // Never recreate the folder of a procedure deleted in the meantime.
        if (!deps.procedures.has(procedureId)) throw new Error('The procedure no longer exists');
        return deps.media.save(procedureId, jpeg, 'image/jpeg');
      },
      onDownload: (procedureId, file) => this.onDownload(procedureId, file),
      ...(signer
        ? {
            afirma: {
              shimSource: signer.shimSource,
              handler: signer.handler,
              context: (procedureId: string) => ({
                approveSignature: (summary: AfirmaSignatureSummary) =>
                  this.approveInBlock(procedureId, summary),
                ...(deps.fetch ? { fetch: deps.fetch } : {}),
              }),
            },
          }
        : {}),
      ...(deps.signer?.fnmtShimSource && deps.certificateRequests
        ? {
            fnmt: {
              shimSource: deps.signer.fnmtShimSource,
              handler: deps.certificateRequests,
            },
          }
        : {}),
      logger: deps.logger,
    };
  }

  /** Keeps a browser download as a temporary download of the procedure (not in the vault). */
  async onDownload(
    procedureId: string,
    file: DownloadedFile,
  ): Promise<{ downloadId: string; name: string; mimeType: string }> {
    if (!this.deps.procedures.has(procedureId)) throw new Error('The procedure no longer exists');
    const download = await this.downloads.add(procedureId, file);
    return { downloadId: download.id, name: download.name, mimeType: download.mimeType };
  }

  /**
   * Moves a temporary download into the vault under a readable name (the original extension is
   * kept). Returns undefined when the procedure has no such download.
   */
  async saveDownload(
    procedureId: string,
    downloadId: string,
    readableName: string,
  ): Promise<DocumentMeta | undefined> {
    const { deps } = this;
    const download = this.downloads.get(procedureId, downloadId);
    if (!download) return undefined;
    const name = documentFileName(readableName, download.name);
    const meta = await deps.vault().addDocument({
      name,
      mimeType: download.mimeType,
      source: 'download',
      bytes: await this.downloads.read(downloadId),
      procedureId,
    });
    await this.downloads.remove(downloadId);
    deps.events.emit({ type: 'vault.changed' });
    deps.procedures.addNotice(
      procedureId,
      'success',
      t(deps.lang(), 'downloadSaved', { name: meta.name }),
    );
    return meta;
  }

  /**
   * A site's AutoFirma request: refused outside a certificate block (the agent's action fails),
   * and the block's end waits for it, until the phone's key is released.
   */
  private async approveInBlock(
    procedureId: string,
    summary: AfirmaSignatureSummary,
  ): Promise<SigningKey | null> {
    if (!this.certificateBlocks.isOpen(procedureId)) {
      this.deps.logger.info('certificate request outside a block refused', {
        procedureId,
        host: hostOf(summary.origin),
      });
      this.certificateBlocks.refuse(procedureId);
      return null;
    }
    const done = this.certificateBlocks.busy(procedureId);
    try {
      const key = await this.approveSignature(procedureId, summary);
      if (key?.kind !== 'external') {
        done();
        return key;
      }
      return {
        ...key,
        release: (ok, refusal) => {
          done();
          key.release(ok, refusal);
        },
      };
    } catch (err) {
      done();
      throw err;
    }
  }

  /** A certificate block ended: the browser stops presenting its certificate. */
  private async stopCertificate(procedureId: string, tls: boolean): Promise<void> {
    this.deps.companion?.endLoginOf(procedureId);
    if (!tls || !this.service) return;
    // biome-ignore lint/correctness/useHookAtTopLevel: turns the certificate off, not a React hook.
    await this.service.useClientCertificate(procedureId, null).catch((err) =>
      this.deps.logger.warn('could not turn the certificate off', {
        procedureId,
        error: errorMessage(err),
      }),
    );
  }

  /**
   * AutoFirma replacement approval: pick a certificate or the DNI (if several), then confirm
   * with the details of what is signed (+ Touch ID when available). Signatures with a `.p12`
   * always ask, whatever the credential's policy. The DNI is approved on the phone instead
   * (`CompanionService.approve`), after the desktop asks for its CAN and PIN when it doesn't
   * have them. Returns null when declined / cancelled / no certificate. `signal` withdraws the
   * desktop's cards when whoever asked stops waiting.
   */
  async approveSignature(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    signal?: AbortSignal,
  ): Promise<SigningKey | null> {
    const { deps } = this;
    const lang = deps.lang();
    if (!deps.procedures.has(procedureId)) return null;
    const host = hostOf(summary.origin);
    const vault = deps.vault();
    const now = Date.now();
    const certificates = vault.listCredentials().filter(
      (c) =>
        (c.kind === 'certificate' && !(c.certificate && Date.parse(c.certificate.validTo) < now)) ||
        // The DNI may have been renewed since its certificate was last read.
        (c.kind === 'dnie' && !!deps.companion),
    );
    if (certificates.length === 0) {
      const notice = deps.companion ? 'noCertificate' : 'noCertificateOnly';
      deps.procedures.addNotice(procedureId, 'warning', t(lang, notice, { host }));
      return null;
    }
    try {
      let chosen: CredentialSummary | undefined = certificates[0];
      if (certificates.length > 1) {
        const pick = await deps.prompts.ask(
          procedureId,
          {
            kind: 'form',
            title: t(lang, 'pickCertificateTitle'),
            fields: [
              {
                key: 'certificate',
                label: t(lang, 'detailCertificate'),
                type: 'select',
                required: true,
                options: certificates.map((c) => ({
                  value: c.id,
                  label: describeCertificate(c, lang),
                })),
              },
            ],
            submitLabel: t(lang, 'continueLabel'),
            allowDismiss: false,
          },
          { signal },
        );
        if (pick.kind !== 'form' || pick.dismissed) return null;
        chosen = certificates.find((c) => c.id === pick.values?.certificate);
      }
      if (!chosen) return null;
      const displayName = this.signerName(chosen);
      // A visible PDF signature: the card shows the document and its box (and places it).
      let placement: SignaturePlacement | null | undefined;
      const extras = () => ({
        ...(placement !== undefined ? { placement } : {}),
        ...(displayName ? { displayName } : {}),
      });
      if (chosen.kind === 'dnie') {
        if (!deps.companion) return null;
        // The phone approves; the desktop only lets the user place the box first.
        if (summary.placement?.mode === 'choose') {
          const placed = await this.signatureCard(procedureId, summary, chosen, 'phone', signal);
          if (!placed) return null;
          placement = placed.placement;
        }
        // The consent happens on the phone; the desktop asks for the CAN and the PIN.
        const key = await deps.companion.approve(procedureId, summary, chosen);
        return key ? { ...key, ...extras() } : null;
      }
      if (summary.placement) {
        const placed = await this.signatureCard(procedureId, summary, chosen, 'here', signal);
        if (!placed) return null;
        placement = placed.placement;
      } else if (!(await this.confirm(procedureId, summary, chosen, signal))) return null;
      if (chosen.external) {
        // The key stays in the OS store, which may ask the user once more on first use.
        if (!deps.osCertificates) return null;
        const key = deps.osCertificates.signingKey(chosen.id);
        deps.logger.info('signature approved', { procedureId, format: summary.format, host });
        return { ...key, ...extras() };
      }
      const secret = await vault.getCredentialSecret(chosen.id);
      if (secret.kind !== 'certificate') return null;
      deps.logger.addSecret(secret.passphrase);
      await vault.markCredentialUsed(chosen.id);
      deps.events.emit({ type: 'vault.changed' });
      deps.logger.info('signature approved', { procedureId, format: summary.format, host });
      return {
        kind: 'p12',
        credentialId: chosen.id,
        p12: secret.p12,
        passphrase: secret.passphrase,
        ...extras(),
      };
    } catch (err) {
      deps.logger.info('signature not approved', { procedureId, error: errorMessage(err) });
      return null;
    }
  }

  /**
   * The signer's name for a visible signature: Mis datos' spelling (accents, capitals) when it is
   * the certificate holder's name, else the certificate's, title-cased.
   */
  private signerName(chosen: CredentialSummary): string | undefined {
    const { deps } = this;
    const holder = chosen.certificate?.holderName;
    if (!holder || !deps.signer) return undefined;
    const vault = deps.vault();
    const mine = ['givenName', 'surname1', 'surname2']
      .map((key) => vault.getPersonal(key)?.value?.trim())
      .filter(Boolean)
      .join(' ');
    const words = (s: string) =>
      s
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .toUpperCase()
        .split(/[\s,]+/)
        .filter(Boolean)
        .sort()
        .join(' ');
    if (mine && words(mine) === words(holder)) return mine;
    return deps.signer.signatureName(holder);
  }

  /**
   * The card of a visible PDF signature: the document with its box. `here`: it is the signature's
   * confirmation (+ Touch ID); `phone`: it only places the box before the phone approves.
   * Resolves with where the user left the box (undefined: they didn't place it), null when they
   * declined.
   */
  private async signatureCard(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    chosen: CredentialSummary,
    approval: 'here' | 'phone',
    signal?: AbortSignal,
  ): Promise<{ placement: SignaturePlacement | null | undefined } | null> {
    const { deps } = this;
    const request = summary.placement;
    const document = summary.documents[0];
    if (!request || !document) return null;
    const lang = deps.lang();
    const own = summary.origin === OWN_DOCUMENTS_ORIGIN;
    const host = hostOf(summary.origin);
    const details: { label: string; value: string }[] = [
      { label: t(lang, 'detailWhat'), value: summary.description.slice(0, 500) },
      { label: t(lang, 'detailFor'), value: own ? t(lang, 'ownDocuments') : host },
      { label: t(lang, 'detailCertificate'), value: describeCertificate(chosen, lang) },
    ];
    const holderId = chosen.certificate?.holderId;
    const name = this.signerName(chosen) ?? t(lang, 'yourSignature');
    const answer = await deps.prompts.ask(
      procedureId,
      {
        kind: 'pdf_signature',
        title: t(lang, 'signatureTitle'),
        message: own
          ? t(lang, 'ownSignatureMessage')
          : request.mode === 'choose'
            ? t(lang, 'placeSignatureMessage', { host })
            : t(lang, 'fixedSignatureMessage', { host }),
        details,
        documentName: (document.name ?? t(lang, 'pdfDocument')).slice(0, 260),
        mode: request.mode,
        ...(request.optional ? { optional: true } : {}),
        ...(request.initial ? { initial: request.initial } : {}),
        appearance: request.appearance,
        signer: {
          name: name.slice(0, 200),
          ...(holderId && deps.signer ? { holderId: deps.signer.maskIds(holderId) } : {}),
        },
        approval,
        ...(approval === 'here' ? { biometric: deps.biometric.available() } : {}),
        confirmLabel: t(lang, approval === 'here' ? 'signLabel' : 'continueLabel'),
        rejectLabel: t(lang, 'dontSignLabel'),
      },
      { document: document.data, signal },
    );
    if (answer.kind !== 'pdf_signature' || !answer.approved) return null;
    if (approval === 'here' && !(await deps.biometric.prompt(t(lang, 'touchIdSignature')))) {
      return null;
    }
    return { placement: answer.placement };
  }

  /**
   * Signs a PDF of Mis documentos with a visible signature, with no site involved (the agent's
   * `api.documents.sign`): the user picks the certificate, places the signature and approves it,
   * then the signed PDF replaces the document (same id and name; the original is still inside it,
   * before the signature's incremental update).
   */
  async signDocument(
    procedureId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<DocumentMeta> {
    const { deps } = this;
    const lang = deps.lang();
    const signer = deps.signer;
    const vault = deps.vault();
    const meta = vault.getDocument(documentId);
    if (!meta) throw new UserError(t(lang, 'vaultNotFound'), 'not_found');
    if (!signer || meta.mimeType !== 'application/pdf') {
      throw new UserError(t(lang, 'signOnlyPdf'), 'bad_request');
    }
    const pdf = await vault.readDocument(documentId);
    let layout: Awaited<ReturnType<SignerLib['pdfLayout']>>;
    try {
      layout = await signer.pdfLayout(pdf);
    } catch {
      throw new UserError(t(lang, 'signOnlyPdf'), 'bad_request');
    }
    const initial = signer.defaultPlacement(layout);
    const key = await this.approveSignature(
      procedureId,
      {
        method: 'sign',
        format: 'PAdES',
        algorithm: 'SHA256withRSA',
        origin: OWN_DOCUMENTS_ORIGIN,
        description: t(lang, 'signDocumentWhat', { name: meta.name }),
        dataSize: meta.size,
        documents: [{ name: meta.name, mimeType: meta.mimeType, data: pdf }],
        // The phone can't check an update that draws a visible signature.
        verifiable: false,
        placement: { mode: 'choose', initial, appearance: 'handwritten' },
      },
      signal,
    );
    if (!key) throw new UserError(t(lang, 'documentNotSigned'), 'cancelled');
    // The agent stopped waiting while Touch ID or the phone answered: don't sign behind its back.
    if (signal?.aborted) throw new UserError(t(lang, 'documentNotSigned'), 'cancelled');
    const signed = await signer.signPdf({ pdf, key, placement: key.placement ?? initial });
    const updated = await vault.replaceDocument(documentId, signed, { signedAt: new Date() });
    deps.events.emit({ type: 'vault.changed' });
    deps.procedures.addNotice(
      procedureId,
      'success',
      t(lang, 'documentSigned', { name: meta.name }),
    );
    deps.logger.info('document signed', { procedureId });
    return updated;
  }

  /** The signature confirmation with what is signed, for whom and with what (+ Touch ID). */
  private async confirm(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    chosen: CredentialSummary,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const { deps } = this;
    const lang = deps.lang();
    const host = hostOf(summary.origin);
    const details: { label: string; value: string }[] = [
      { label: t(lang, 'detailWhat'), value: summary.description.slice(0, 500) },
      { label: t(lang, 'detailFor'), value: host },
    ];
    if (summary.dataSize !== undefined)
      details.push({ label: t(lang, 'detailSize'), value: formatBytes(summary.dataSize) });
    details.push({
      label: t(lang, 'detailCertificate'),
      value: describeCertificate(chosen, lang),
    });
    const confirm = await deps.prompts.ask(
      procedureId,
      {
        kind: 'confirm',
        confirmKind: 'signature',
        title: t(lang, 'signatureTitle'),
        message: t(lang, 'signatureMessage', { host }),
        details,
        confirmLabel: t(lang, 'signLabel'),
        rejectLabel: t(lang, 'dontSignLabel'),
        biometric: deps.biometric.available(),
      },
      { signal },
    );
    if (confirm.kind !== 'confirm' || !confirm.approved) return false;
    return deps.biometric.prompt(t(lang, 'touchIdSignature'));
  }
}
