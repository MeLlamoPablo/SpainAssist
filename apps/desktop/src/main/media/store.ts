import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir, writeFileAtomic } from '../core/fs';
import { isSafeId } from '../core/util';

const MEDIA_ID = /^([a-z]{1,8}_[a-f0-9]{16})\.([a-f0-9]{16})\.(jpg|png)$/;

/**
 * Screenshots shown in the UI (never sent to the model by the app). Stored per procedure in
 * procedures/<id>/media/. Ids look like "<procedureId>.<random>.jpg" so `media.get(id)` can
 * resolve them without an index; they are validated strictly (no path traversal).
 */
export class MediaStore {
  constructor(private readonly mediaDirOf: (procedureId: string) => string) {}

  async save(
    procedureId: string,
    bytes: Uint8Array,
    mimeType: 'image/jpeg' | 'image/png' = 'image/jpeg',
  ): Promise<string> {
    if (!isSafeId(procedureId)) throw new Error('Invalid procedure id');
    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const id = `${procedureId}.${randomBytes(8).toString('hex')}.${ext}`;
    const dir = this.mediaDirOf(procedureId);
    await ensurePrivateDir(dir);
    await writeFileAtomic(join(dir, id), bytes);
    return id;
  }

  private locate(mediaId: string): { path: string; mimeType: string; procedureId: string } | null {
    const m = MEDIA_ID.exec(mediaId);
    if (!m) return null;
    const [, procedureId, , ext] = m;
    return {
      procedureId: procedureId!,
      path: join(this.mediaDirOf(procedureId!), mediaId),
      mimeType: ext === 'png' ? 'image/png' : 'image/jpeg',
    };
  }

  /** True if the id is valid, belongs to `procedureId` and exists. */
  exists(procedureId: string, mediaId: string): boolean {
    const loc = this.locate(mediaId);
    return !!loc && loc.procedureId === procedureId && existsSync(loc.path);
  }

  async dataUrl(mediaId: string): Promise<string | null> {
    const loc = this.locate(mediaId);
    if (!loc) return null;
    try {
      const bytes = await readFile(loc.path);
      return `data:${loc.mimeType};base64,${bytes.toString('base64')}`;
    } catch {
      return null;
    }
  }
}
