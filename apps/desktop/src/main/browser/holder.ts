import { join } from 'node:path';
import type {
  CaptureOptions,
  CertificateProxy,
  ClientCertificateUse,
  CrlSetComponent,
  DownloadedFile,
} from '@sa/browser';
import type {
  AfirmaSignatureSummary,
  CredentialSummary,
  DocumentMeta,
  Language,
  SigningKey,
} from '@sa/shared';
import { openP12 } from '@sa/signer';
import type { PromptManager } from '../chat/prompts';
import type { CompanionService } from '../companion/service';
import type { EventBus } from '../core/events';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage, formatBytes, hostOf } from '../core/util';
import type { MediaStore } from '../media/store';
import type { Biometric, BrowserFactory, BrowserPort, SignerLib, VaultPort } from '../ports';
import type { ProcedureService } from '../procedures/service';
import { DownloadStore, documentFileName } from './downloads';

export interface BrowserHolderDeps {
  factory: BrowserFactory;
  certificates?: CertificateProxy;
  certificateLoginsAvailable?: boolean;
  /** The Chromium to launch; Playwright's cache without it (development, e2e). */
  executablePath?: string;
  /** Chrome's CRLSet for each launch (`crlset/store.ts`); none in tests. */
  crlSet?: () => Promise<CrlSetComponent | undefined>;
  /** Headless override for development/test runs only. */
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
  /** DNIe signatures and logins with the paired phone; absent without the feature flag. */
  companion?: CompanionService;
  /** fetch for triphase signing (Electron's net.fetch uses the OS trust store). */
  fetch?: typeof fetch;
  logger: Logger;
  lang: () => Language;
}

function describeCertificate(c: CredentialSummary, lang: Language): string {
  if (c.kind === 'dnie') {
    const holder = c.certificate?.holderName;
    return holder ? t(lang, 'dnieOptionHolder', { holder }) : t(lang, 'dnieOption');
  }
  const holder = c.certificate?.holderName ?? c.label;
  const issuer = c.certificate?.issuer;
  const until = c.certificate?.validTo?.slice(0, 10);
  const parts = [
    holder,
    issuer,
    until ? `${lang === 'es' ? 'válido hasta' : 'valid until'} ${until}` : undefined,
  ];
  return parts.filter(Boolean).join(' · ').slice(0, 200);
}

/**
 * Owns the single BrowserService (created lazily, windows minimized until help is requested)
 * and its app-side hooks: downloads go to temporary downloads (until the agent saves them to
 * the vault with `saveDownload`), screenshots to the media store, and
 * AutoFirma signature requests to an approval prompt in the procedure's chat.
 */
export class BrowserHolder {
  private service?: BrowserPort;
  readonly downloads: DownloadStore;

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
      if (!identity) throw new Error('DNIe login was cancelled or unavailable.');
      return identity;
    }
    const secret = await this.deps.vault().getCredentialSecret(credential.id);
    if (secret.kind !== 'certificate') throw new Error('Unexpected credential type');
    this.deps.logger.addSecret(secret.passphrase);
    const identity = openP12(secret.p12, secret.passphrase);
    return { id: credential.id, chain: identity.chainDer, key: identity.privateKey };
  }

  /** News of the procedure's DNIe logins for the agent's next observation. */
  loginNotes(procedureId: string): string[] {
    return this.deps.companion?.takeLoginNotes(procedureId) ?? [];
  }

  get(): BrowserPort {
    this.service ??= this.create();
    return this.service;
  }

  current(): BrowserPort | undefined {
    return this.service;
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
    if (this.service?.isOpen(procedureId)) await this.service.close(procedureId);
  }

  /** Capture mode: saves the procedure's browser capture (when it is stopped or cancelled). */
  async finishCapture(procedureId: string): Promise<void> {
    await this.service?.finishCapture(procedureId);
  }

  async closeAll(): Promise<void> {
    const service = this.service;
    this.service = undefined;
    if (service)
      await service
        .closeAll()
        .catch((err) => this.deps.logger.warn('closeAll failed', { error: errorMessage(err) }));
  }

  private create(): BrowserPort {
    const { deps } = this;
    const signer = deps.signer?.shimSource ? deps.signer : undefined;
    return deps.factory({
      certificates: deps.certificates,
      headless: deps.headless ?? false,
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
                  this.approveSignature(procedureId, summary),
                ...(deps.fetch ? { fetch: deps.fetch } : {}),
              }),
            },
          }
        : {}),
      logger: deps.logger,
    });
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
   * AutoFirma replacement approval: pick a certificate or the DNIe (if several), then confirm
   * with the details of what is signed (+ Touch ID when available). Signatures with a `.p12`
   * always ask, whatever the credential's policy. The DNIe is approved on the phone instead
   * (`CompanionService.approve`), after the desktop asks for its CAN and PIN when it doesn't
   * have them. Returns null when declined / cancelled / no certificate.
   */
  async approveSignature(
    procedureId: string,
    summary: AfirmaSignatureSummary,
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
        // The DNIe may have been renewed since its certificate was last read.
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
        const pick = await deps.prompts.ask(procedureId, {
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
        });
        if (pick.kind !== 'form' || pick.dismissed) return null;
        chosen = certificates.find((c) => c.id === pick.values?.certificate);
      }
      if (!chosen) return null;
      if (chosen.kind === 'dnie') {
        if (!deps.companion) return null;
        // The consent happens on the phone; the desktop asks for the CAN and the PIN.
        return await deps.companion.approve(procedureId, summary, chosen);
      }
      if (!(await this.confirm(procedureId, summary, chosen))) return null;
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
      };
    } catch (err) {
      deps.logger.info('signature not approved', { procedureId, error: errorMessage(err) });
      return null;
    }
  }

  /** The signature confirmation with what is signed, for whom and with what (+ Touch ID). */
  private async confirm(
    procedureId: string,
    summary: AfirmaSignatureSummary,
    chosen: CredentialSummary,
  ): Promise<boolean> {
    const { deps } = this;
    const lang = deps.lang();
    const host = hostOf(summary.origin);
    const details: { label: string; value: string }[] = [
      { label: t(lang, 'detailWhat'), value: summary.description.slice(0, 500) },
      { label: t(lang, 'detailFor'), value: host },
      {
        label: t(lang, 'detailFormat'),
        value: `${summary.format} · ${summary.algorithm}`.slice(0, 500),
      },
    ];
    if (summary.dataSize !== undefined)
      details.push({ label: t(lang, 'detailSize'), value: formatBytes(summary.dataSize) });
    if (summary.dataSha256)
      details.push({ label: t(lang, 'detailHash'), value: summary.dataSha256 });
    details.push({
      label: t(lang, 'detailCertificate'),
      value: describeCertificate(chosen, lang),
    });
    const confirm = await deps.prompts.ask(procedureId, {
      kind: 'confirm',
      confirmKind: 'signature',
      title: t(lang, 'signatureTitle'),
      message: t(lang, 'signatureMessage', { host }),
      details,
      confirmLabel: t(lang, 'signLabel'),
      rejectLabel: t(lang, 'dontSignLabel'),
      biometric: deps.biometric.available(),
    });
    if (confirm.kind !== 'confirm' || !confirm.approved) return false;
    return deps.biometric.prompt(t(lang, 'touchIdSignature'));
  }
}
