import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppInfo, Language } from '@sa/shared';
import { UserError } from '../core/errors';
import { writeNewFile } from '../core/fs';
import { t } from '../core/i18n';
import { type Clock, isSafeId } from '../core/util';
import { ZipTooLargeError, ZipWriter } from './zip';

export interface TranscriptExportDeps {
  appInfo: Pick<AppInfo, 'name' | 'version' | 'platform'>;
  assistantDir: string;
  proceduresDir: string;
  scanTranscriptsDir: string;
  /** The user's Downloads directory. */
  downloadsDir: string;
  /** Writes pending transcript and procedure changes to disk. */
  flush(): Promise<void>;
  clock: Clock;
  lang(): Language;
}

/**
 * Saves every stored transcript in a new zip in Downloads, for analysis; returns its file name.
 * Layout: the folders of userData, without media/ and work/:
 *   assistant/transcript.json, assistant/session.jsonl
 *   procedures/<id>/procedure.json, transcript.json, session.jsonl
 *   scanner/<scan id>/...  (development builds only)
 */
export async function exportTranscripts(deps: TranscriptExportDeps): Promise<string> {
  await deps.flush();
  const now = deps.clock();
  const manifest = {
    app: deps.appInfo.name,
    version: deps.appInfo.version,
    platform: deps.appInfo.platform,
    exportedAt: now.toISOString(),
  };
  try {
    return await writeNewFile(
      deps.downloadsDir,
      `SpainAssist-transcripts-${now.toISOString().slice(0, 10)}.zip`,
      async (file) => {
        const zip = new ZipWriter(file, now);
        await zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
        await addFiles(zip, deps.assistantDir, 'assistant', false);
        for (const id of await entries(deps.proceduresDir, 'dir'))
          if (isSafeId(id))
            await addFiles(zip, join(deps.proceduresDir, id), `procedures/${id}`, false);
        await addFiles(zip, deps.scanTranscriptsDir, 'scanner', true);
        await zip.finish();
      },
    );
  } catch (err) {
    if (err instanceof ZipTooLargeError) throw new UserError(t(deps.lang(), 'exportTooLarge'));
    throw err;
  }
}

async function addFiles(zip: ZipWriter, dir: string, prefix: string, recursive: boolean) {
  // Skip atomic-write leftovers (`core/fs` writeFileAtomic).
  for (const name of await entries(dir, 'file'))
    if (!name.endsWith('.tmp')) await zip.add(`${prefix}/${name}`, await readFile(join(dir, name)));
  if (recursive)
    for (const name of await entries(dir, 'dir'))
      await addFiles(zip, join(dir, name), `${prefix}/${name}`, true);
}

/** Regular files or directories of `dir` (never symlinks), sorted; none when it doesn't exist. */
async function entries(dir: string, kind: 'file' | 'dir'): Promise<string[]> {
  const all = await readdir(dir, { withFileTypes: true }).catch((err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  });
  return all
    .filter((entry) => (kind === 'file' ? entry.isFile() : entry.isDirectory()))
    .map((entry) => entry.name)
    .sort();
}
