/**
 * What a run keeps of its world once it is over (`<runDir>/bench/`):
 *
 * ```text
 * state.json               BenchWorldState: what the scoring API reported last
 * requests.jsonl           the server's request log, one entry per line, all of it
 * downloads/index.json     the BenchDownload records, each with its `index` and the `file` saved
 * downloads/<n>-<name>     the bytes of every file the mock sent (SHA-256 checked)
 * snapshot.json            the world as a snapshot, request log included (for inspection)
 * errors.json              only when a part failed: [{ part, error, code? }]
 * ```
 *
 * The parts are independent: one that fails (the server dropped the bytes of a file, the log is
 * cut, a call times out) is recorded in `errors.json` and does not stop the others. The call only
 * rejects when the folder itself cannot be written. Files are owner-only (0600).
 */
import {
  appendFileSync,
  closeSync,
  fchmodSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { BenchApi, BenchDownload, BenchWorldState, SaveBenchArtifacts } from '../contracts';
import { isBenchError } from './errors';

/** The most entries the server returns per `requests` page. */
const MAX_PAGE = 5_000;

export type SaveBenchArtifactsOptions = NonNullable<Parameters<SaveBenchArtifacts>[3]> & {
  /** Entries per `requests` page (default and maximum 5000). */
  pageSize?: number;
  /** A part failed (it is also in `errors.json`). Must not throw. */
  onError?: (part: string, error: Error) => void;
};

interface PartError {
  part: string;
  error: string;
  code?: string;
}

/** A name that is safe as a file name: no folders, no dots in front, plain characters. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const plain = base
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return plain || 'download';
}

function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export async function saveBenchArtifacts(
  api: BenchApi,
  worldId: string,
  dir: string,
  options: SaveBenchArtifactsOptions = {},
): Promise<void> {
  const pageSize = Math.min(Math.max(1, Math.floor(options.pageSize ?? MAX_PAGE)), MAX_PAGE);
  const mask = (text: string) => (options.scrub ? options.scrub(text) : text);
  const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const errors: PartError[] = [];
  const fail = (part: string, cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const failed = isBenchError(error)
      ? error
      : isBenchError(error.cause)
        ? error.cause
        : undefined;
    errors.push({ part, error: error.message, ...(failed ? { code: failed.code } : {}) });
    try {
      options.onError?.(part, error);
    } catch {
      // onError must not stop the other parts.
    }
  };
  const part = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      fail(name, error);
    }
  };

  // The state is read once: state.json and the downloads' index describe the same moment.
  let stateRead: Promise<BenchWorldState> | undefined;
  const state = () => {
    stateRead ??= api.state(worldId);
    return stateRead;
  };

  await part('state', async () => {
    writeFileAtomic(join(dir, 'state.json'), mask(pretty(await state())));
  });

  await part('requests', async () => {
    const fd = openSync(join(dir, 'requests.jsonl'), 'w', 0o600);
    try {
      fchmodSync(fd, 0o600);
      let since = 0;
      for (let first = true; ; first = false) {
        const page = await api.requests(worldId, since, pageSize);
        if (first && page.truncated) {
          fail(
            'requests',
            new Error('the server no longer holds the oldest entries of its request log'),
          );
        }
        if (!page.requests.length) break;
        if (page.next <= since) {
          throw new Error(`the request log did not advance (next ${page.next} after ${since})`);
        }
        appendFileSync(
          fd,
          page.requests.map((entry) => `${mask(JSON.stringify(entry))}\n`).join(''),
        );
        since = page.next;
        if (page.requests.length < pageSize) break;
      }
    } finally {
      closeSync(fd);
    }
  });

  await part('downloads', async () => {
    let downloads: BenchDownload[];
    try {
      downloads = (await state()).downloads;
    } catch (cause) {
      throw new Error(
        `the list of downloads comes from the world's state, which could not be read: ${cause instanceof Error ? cause.message : cause}`,
        { cause },
      );
    }
    const folder = join(dir, 'downloads');
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const index: (BenchDownload & { index: number; file: string | null })[] = [];
    for (const [n, record] of downloads.entries()) {
      let file: string | null = null;
      try {
        const { bytes, sha256 } = await api.download(worldId, n);
        file = `${n}-${safeFilename(record.filename)}`;
        writeFileAtomic(join(folder, file), bytes);
        if (sha256 !== record.sha256.toLowerCase()) {
          fail(
            `downloads/${n}`,
            new Error(`its SHA-256 (${sha256}) differs from the state's record (${record.sha256})`),
          );
        }
      } catch (error) {
        fail(`downloads/${n}`, error);
      }
      index.push({ ...record, index: n, file });
    }
    writeFileAtomic(join(folder, 'index.json'), mask(pretty(index)));
  });

  await part('snapshot', async () => {
    const snapshot = await api.snapshot(worldId, { keepLog: true });
    writeFileAtomic(join(dir, 'snapshot.json'), mask(JSON.stringify(snapshot)));
  });

  const file = join(dir, 'errors.json');
  if (errors.length) writeFileAtomic(file, pretty(errors));
  else rmSync(file, { force: true });
}
