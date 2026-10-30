import { open, readdir, readFile } from 'node:fs/promises';
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
  /** The app's logs: `main.log` and `main.1.log`, its predecessor (`core/logger`). */
  logsDir: string;
  /** The user's Downloads directory. */
  downloadsDir: string;
  /** Writes pending transcript and procedure changes to disk. */
  flush(): Promise<void>;
  clock: Clock;
  lang(): Language;
}

/** A log keeps its last 5 MiB in the zip: the size at which `main.log` rotates. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** A log file, as `manifest.json` lists it. */
interface LogEntry {
  /** Its path in the zip. */
  file: string;
  /** Its size on disk. */
  bytes?: number;
  /** Set when it was larger than MAX_LOG_BYTES: the bytes of its end in the zip. */
  keptLastBytes?: number;
  /** Why it is not in the zip (an error code). */
  error?: string;
}

/**
 * Saves every stored transcript and the app's logs in a new zip in Downloads, for analysis;
 * returns its file name. Layout: the folders of userData, without media/ and work/:
 *   manifest.json  (the app, its version, and the logs: which, their size, which were cut)
 *   assistant/transcript.json, assistant/session.jsonl
 *   procedures/<id>/procedure.json, transcript.json, session.jsonl
 *   scanner/<scan id>/...  (development builds only)
 *   logs/main.log, logs/main.1.log  (each cut to its last 5 MiB)
 */
export async function exportTranscripts(deps: TranscriptExportDeps): Promise<string> {
  await deps.flush();
  const now = deps.clock();
  const logs = await readLogs(deps.logsDir);
  const manifest = {
    app: deps.appInfo.name,
    version: deps.appInfo.version,
    platform: deps.appInfo.platform,
    exportedAt: now.toISOString(),
    logs: logs.map((log) => log.entry),
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
        for (const log of logs) if (log.data) await zip.add(log.entry.file, log.data);
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

/**
 * Every `*.log` of `dir`, each cut to its last MAX_LOG_BYTES from a line start. Never throws, so
 * logs never stop an export: a missing folder gives none, and an unreadable file or folder is
 * listed with its error code and left out.
 */
async function readLogs(dir: string): Promise<{ entry: LogEntry; data?: Buffer }[]> {
  let names: string[];
  try {
    names = (await entries(dir, 'file')).filter((name) => name.endsWith('.log'));
  } catch (err) {
    return [{ entry: { file: 'logs/', error: errorCode(err) } }];
  }
  const logs: { entry: LogEntry; data?: Buffer }[] = [];
  for (const name of names) {
    const file = `logs/${name}`;
    try {
      const { bytes, data } = await readTail(join(dir, name), MAX_LOG_BYTES);
      if (bytes <= MAX_LOG_BYTES) {
        logs.push({ entry: { file, bytes }, data });
        continue;
      }
      // Start at a whole line, and say in the file itself that its beginning is left out.
      const kept = data.subarray(data.indexOf('\n') + 1);
      const note = `[Spain Assist export: only the last ${kept.length} of this log's ${bytes} bytes]\n`;
      logs.push({
        entry: { file, bytes, keptLastBytes: kept.length },
        data: Buffer.concat([Buffer.from(note), kept]),
      });
    } catch (err) {
      logs.push({ entry: { file, error: errorCode(err) } });
    }
  }
  return logs;
}

/** The last `max` bytes of a file (all of it when smaller), and its size. */
async function readTail(path: string, max: number): Promise<{ bytes: number; data: Buffer }> {
  const handle = await open(path, 'r');
  try {
    const bytes = (await handle.stat()).size;
    const data = Buffer.alloc(Math.min(bytes, max));
    let read = 0;
    while (read < data.length) {
      const chunk = await handle.read(data, read, data.length - read, bytes - data.length + read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    return { bytes, data: data.subarray(0, read) };
  } finally {
    await handle.close();
  }
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'unreadable';
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
