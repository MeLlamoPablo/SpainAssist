/**
 * Reading the network log files another process writes (an agent host's `net/host-<agent>.jsonl`): the
 * whole file, or its records as they are appended. Lines that are not records are skipped.
 */
import fsp from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { NetRecord } from '../contracts';

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

const netRecordSchema = z.looseObject({
  seq: z.number(),
  t: z.string(),
  worldId: z.string(),
  channel: z.enum([
    'browser',
    'fetch_url',
    'run_script',
    'boe_search',
    'web_research',
    'exa',
    'llm',
    'other',
  ]),
  toolCallId: z.string().optional(),
  method: z.string(),
  url: z.string(),
  host: z.string(),
  route: z.enum(['mapped', 'unmapped', 'llm', 'denied']),
  resourceType: z.string().optional(),
  reqHeaders: z.record(z.string(), z.string()),
  reqBody: z.string().optional(),
  reqBodyEncoding: z.literal('base64').optional(),
  reqBodyBytes: z.number().optional(),
  status: z.number().optional(),
  resBytes: z.number().optional(),
  durationMs: z.number(),
  error: z.string().optional(),
  bench: z
    .object({
      kind: z.string().optional(),
      page: z.string().optional(),
      seq: z.number().optional(),
    })
    .optional(),
});

/** Parses JSONL text. Lines that are not records (blank, cut by a crash) are skipped. */
export function parseNetLog(text: string): NetRecord[] {
  const records: NetRecord[] = [];
  for (const line of text.split('\n')) {
    const record = parseNetLine(line);
    if (record) records.push(record);
  }
  return records;
}

function parseNetLine(line: string): NetRecord | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = netRecordSchema.safeParse(JSON.parse(line));
    return parsed.success ? (parsed.data as NetRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** Every record of a log file ([] when the file does not exist yet). */
export async function readNetLog(file: string): Promise<NetRecord[]> {
  try {
    return parseNetLog(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface NetLogFollower {
  /** Resolves after everything written to the file so far was delivered. */
  drain(): Promise<void>;
  /** Delivers what is left, then stops polling. */
  stop(): Promise<void>;
}

/**
 * Delivers the records of a log file as another process appends them (polling; a line is only
 * delivered once it is complete). Starts at the beginning of the file.
 */
export function followNetLog(
  file: string,
  onRecord: (record: NetRecord) => void,
  opts: { intervalMs?: number } = {},
): NetLogFollower {
  let offset = 0;
  let pending = '';
  let decoder = new StringDecoder('utf8');
  let chain: Promise<void> = Promise.resolve();

  const pass = async (): Promise<void> => {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    try {
      const { size } = await handle.stat();
      if (size < offset) {
        offset = 0;
        pending = '';
        decoder = new StringDecoder('utf8');
      }
      const chunk = Buffer.alloc(256 * 1024);
      while (offset < size) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending += decoder.write(chunk.subarray(0, bytesRead));
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          const record = parseNetLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (record) onRecord(record);
          newline = pending.indexOf('\n');
        }
      }
    } finally {
      await handle.close();
    }
  };
  const drain = (): Promise<void> => {
    const run = chain.catch(() => {}).then(pass);
    chain = run;
    return run;
  };
  const timer = setInterval(() => {
    drain().catch(() => {});
  }, opts.intervalMs ?? 100);
  timer.unref();
  return {
    drain,
    async stop() {
      clearInterval(timer);
      await drain();
    },
  };
}
