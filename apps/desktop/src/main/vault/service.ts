import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type {
  AddCertificateInput,
  AddClaveInput,
  AddDocumentInput,
  CredentialPolicy,
  CredentialSummary,
  DocumentMeta,
  Language,
  PersonalDataInput,
  PersonalSaveIssue,
  VaultOverview,
} from '@sa/shared';
import { friendlyVaultError, UserError } from '../core/errors';
import type { EventBus } from '../core/events';
import { ensurePrivateDir, writeFileAtomic, writeNewFile } from '../core/fs';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';
import type { Biometric, VaultPort } from '../ports';
import { logPersonalSaveFailure, setPersonalPartial } from './partial';

const PREVIEW_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const OPEN_FILE_TTL_MS = 10 * 60_000;

export interface VaultServiceDeps {
  vault: VaultPort;
  events: EventBus;
  logger: Logger;
  biometric: Biometric;
  /** Private scratch directory under the OS temporary directory. */
  tmpDir: string;
  /** User Downloads directory. Exports remain until the user removes them. */
  downloadsDir: string;
  /** shell.openPath: resolves with an error message, or '' on success. */
  openPath(path: string): Promise<string>;
  lang: () => Language;
  /**
   * DNIe with the phone (`dnie-phone` feature flag). Off: a saved `dnie` credential stays in the
   * vault, hidden from Mis datos, and none can be added.
   */
  dniePhone: boolean;
  /** Drops active browser contexts that may retain a deleted client certificate. */
  onCredentialDeleted?(id: string): Promise<void>;
}

export function safeFileName(name: string): string {
  const ext = extname(name)
    .replace(/[^\w.]/g, '')
    .slice(0, 10);
  const base = name
    .slice(0, name.length - extname(name).length)
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^[._\s]+/, '')
    .trim()
    .slice(0, 80);
  return `${base || 'documento'}${ext}`;
}

/** "Mis datos" for the renderer (`vault.*`): every mutation emits `vault.changed`. */
export class VaultService {
  constructor(private readonly deps: VaultServiceDeps) {}

  get vault(): VaultPort {
    return this.deps.vault;
  }

  private changed(): void {
    this.deps.events.emit({ type: 'vault.changed' });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw friendlyVaultError(err, this.deps.lang());
    }
  }

  overview(): VaultOverview {
    const overview = this.deps.vault.overview({
      biometricAvailable: this.deps.biometric.available(),
    });
    if (this.deps.dniePhone) return overview;
    return { ...overview, credentials: overview.credentials.filter((c) => c.kind !== 'dnie') };
  }

  /** A credential Mis datos doesn't show (the DNIe without its feature flag) can't be changed. */
  private requireVisible(id: string): void {
    if (!this.deps.dniePhone && this.deps.vault.getCredential(id)?.kind === 'dnie')
      throw new UserError(t(this.deps.lang(), 'vaultNotFound'), 'not_found');
  }

  setPersonal(items: PersonalDataInput[]): Promise<VaultOverview> {
    return this.guard(async () => {
      try {
        await this.deps.vault.setPersonal(items, 'manual');
      } catch (err) {
        logPersonalSaveFailure(this.deps.logger, err, 'vault personal data save failed');
        throw err;
      }
      this.changed();
      return this.overview();
    });
  }

  /** Document scans: keeps the valid fields when some are rejected, and reports which. */
  setPersonalPartial(
    items: PersonalDataInput[],
  ): Promise<{ overview: VaultOverview; rejected: PersonalSaveIssue[] }> {
    return this.guard(async () => {
      const { saved, rejected } = await setPersonalPartial(
        this.deps.vault,
        items,
        'scan',
        this.deps.logger,
      );
      if (saved.length) this.changed();
      return { overview: this.overview(), rejected };
    });
  }

  deletePersonal(keys: string[]): Promise<VaultOverview> {
    return this.guard(async () => {
      await this.deps.vault.deletePersonal(keys);
      this.changed();
      return this.overview();
    });
  }

  addDocument(input: AddDocumentInput): Promise<DocumentMeta> {
    return this.guard(async () => {
      const meta = await this.deps.vault.addDocument({
        name: input.name,
        mimeType: input.mimeType,
        kind: input.kind,
        source: input.source ?? 'user',
        bytes: Buffer.from(input.bytes),
        ...(input.procedureId ? { procedureId: input.procedureId } : {}),
      });
      this.changed();
      return meta;
    });
  }

  deleteDocument(id: string): Promise<VaultOverview> {
    return this.guard(async () => {
      await this.deps.vault.deleteDocument(id);
      this.changed();
      return this.overview();
    });
  }

  /** Decrypts into a private temp dir, opens it with the OS and deletes it later. */
  openDocument(id: string): Promise<void> {
    return this.guard(async () => {
      const meta = this.deps.vault.getDocument(id);
      if (!meta) throw Object.assign(new Error('not found'), { code: 'not_found' });
      const bytes = await this.deps.vault.readDocument(id);
      const dir = join(this.deps.tmpDir, `open-${randomBytes(8).toString('hex')}`);
      await ensurePrivateDir(dir);
      const file = join(dir, safeFileName(meta.name));
      await writeFileAtomic(file, bytes);
      const timer = setTimeout(() => {
        void rm(dir, { recursive: true, force: true }).catch((err) =>
          this.deps.logger.warn('document cleanup failed', { error: errorMessage(err) }),
        );
      }, OPEN_FILE_TTL_MS);
      timer.unref?.();
      try {
        const error = await this.deps.openPath(file);
        if (error) throw new Error(error);
      } catch (err) {
        clearTimeout(timer);
        await rm(dir, { recursive: true, force: true }).catch((cleanupError) =>
          this.deps.logger.warn('document cleanup failed', { error: errorMessage(cleanupError) }),
        );
        throw err;
      }
    });
  }

  /** Writes a persistent decrypted copy; exclusive creation prevents overwrite and symlink writes. */
  downloadDocument(id: string): Promise<string> {
    return this.guard(async () => {
      const meta = this.deps.vault.getDocument(id);
      if (!meta) throw Object.assign(new Error('not found'), { code: 'not_found' });
      const bytes = await this.deps.vault.readDocument(id);
      return writeNewFile(this.deps.downloadsDir, safeFileName(meta.name), (file) =>
        file.writeFile(bytes),
      );
    });
  }

  async previewDocument(id: string): Promise<string | null> {
    const meta = this.deps.vault.getDocument(id);
    if (!meta || !PREVIEW_TYPES.has(meta.mimeType) || meta.size > MAX_PREVIEW_BYTES) return null;
    try {
      const bytes = await this.deps.vault.readDocument(id);
      return `data:${meta.mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
    } catch (err) {
      this.deps.logger.warn('preview failed', { error: errorMessage(err) });
      return null;
    }
  }

  addClave(input: AddClaveInput): Promise<CredentialSummary> {
    return this.guard(async () => {
      this.deps.logger.addSecret(input.password);
      const summary = await this.deps.vault.addClave({
        username: input.username.trim(),
        password: input.password,
        ...(input.label ? { label: input.label } : {}),
      });
      this.changed();
      return summary;
    });
  }

  addClaveMovil(): Promise<CredentialSummary> {
    return this.guard(async () => {
      const summary = await this.deps.vault.addClaveMovil();
      this.changed();
      return summary;
    });
  }

  addDnie(): Promise<CredentialSummary> {
    return this.guard(async () => {
      if (!this.deps.dniePhone)
        throw new UserError(t(this.deps.lang(), 'dniePhoneOff'), 'unavailable');
      const summary = await this.deps.vault.addDnie();
      this.changed();
      return summary;
    });
  }

  addCertificate(input: AddCertificateInput): Promise<CredentialSummary> {
    return this.guard(async () => {
      this.deps.logger.addSecret(input.passphrase);
      const summary = await this.deps.vault.addCertificate({
        fileName: input.fileName,
        p12: Buffer.from(input.bytes),
        passphrase: input.passphrase,
        ...(input.label ? { label: input.label } : {}),
      });
      this.changed();
      return summary;
    });
  }

  setCredentialPolicy(id: string, policy: CredentialPolicy): Promise<CredentialSummary> {
    return this.guard(async () => {
      this.requireVisible(id);
      const summary = await this.deps.vault.setCredentialPolicy(id, policy);
      this.changed();
      return summary;
    });
  }

  deleteCredential(id: string): Promise<VaultOverview> {
    return this.guard(async () => {
      this.requireVisible(id);
      await this.deps.vault.deleteCredential(id);
      await this.deps.onCredentialDeleted?.(id);
      this.changed();
      return this.overview();
    });
  }

  /** Removes leftovers of opened documents (startup / quit). */
  async cleanupTmp(): Promise<void> {
    await rm(this.deps.tmpDir, { recursive: true, force: true }).catch((err) =>
      this.deps.logger.warn('temporary document cleanup failed', { error: errorMessage(err) }),
    );
    await ensurePrivateDir(this.deps.tmpDir).catch(() => {});
  }
}
