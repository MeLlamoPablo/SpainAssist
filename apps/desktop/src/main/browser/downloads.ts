import { randomBytes } from 'node:crypto';
import { chmod, copyFile, readFile, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { DownloadedFile } from '@sa/browser';
import { safeFileName } from '@sa/shared';
import { ensurePrivateDir } from '../core/fs';

export interface TemporaryDownload {
  id: string;
  procedureId: string;
  /** The website's file name. */
  name: string;
  mimeType: string;
}

/**
 * The file name for a download the agent saves: its readable name (path separators replaced)
 * plus the original extension, which the agent can't change, made safe on every OS
 * (`safeFileName`): it is also the name of the document's copies on disk.
 */
export function documentFileName(name: string, original: string): string {
  const ext = extname(original);
  let base = name.replace(/[\\/]/g, '-').trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, -ext.length);
  return safeFileName(`${base.trim() || basename(original, ext)}${ext}`);
}

/**
 * Files a procedure's browser downloaded that the agent hasn't saved to the vault yet. They
 * stay in a private folder (0700, files 0600) until the agent saves them, the procedure is
 * deleted or the app starts again.
 */
export class DownloadStore {
  private readonly items = new Map<string, TemporaryDownload & { path: string }>();

  constructor(private readonly dir: string) {}

  /** Removes every temporary download, including those left by a previous run. */
  async reset(): Promise<void> {
    this.items.clear();
    await rm(this.dir, { recursive: true, force: true });
  }

  /** Takes the staged file (moves it, or copies it across devices). */
  async add(procedureId: string, file: DownloadedFile): Promise<TemporaryDownload> {
    await ensurePrivateDir(this.dir);
    const id = `dl_${randomBytes(8).toString('hex')}`;
    const path = join(this.dir, id);
    await rename(file.path, path).catch(() => copyFile(file.path, path));
    await chmod(path, 0o600);
    const item = {
      id,
      procedureId,
      name: file.suggestedName || 'descarga',
      mimeType: file.mimeType || 'application/octet-stream',
      path,
    };
    this.items.set(id, item);
    return describe(item);
  }

  /** A download of this procedure, or undefined. */
  get(procedureId: string, id: string): TemporaryDownload | undefined {
    const item = this.items.get(id);
    return item?.procedureId === procedureId ? describe(item) : undefined;
  }

  async read(id: string): Promise<Buffer> {
    const item = this.items.get(id);
    if (!item) throw new Error('Download not found');
    return readFile(item.path);
  }

  async remove(id: string): Promise<void> {
    const item = this.items.get(id);
    if (!item) return;
    this.items.delete(id);
    await rm(item.path, { force: true });
  }

  /** Drops every temporary download of a procedure. */
  async discard(procedureId: string): Promise<void> {
    for (const item of [...this.items.values()]) {
      if (item.procedureId === procedureId) await this.remove(item.id);
    }
  }
}

function describe(item: TemporaryDownload): TemporaryDownload {
  return { id: item.id, procedureId: item.procedureId, name: item.name, mimeType: item.mimeType };
}
