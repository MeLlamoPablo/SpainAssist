/**
 * The network log: one JSON line per request the evaluated agents make (`NetRecord`). The browser
 * proxy (`EvalNetwork`, in the run's process) and every agent host process (`createWorldFetch` and
 * the egress guard) each write their own file, `net/browser.jsonl` and `net/host-<agent>.jsonl`:
 * those files are the authoritative network log of a run (`seq` numbers the records of one file).
 * `NetLog` also keeps a bounded in-memory tail and tells listeners about every record. Reading the
 * files of another process is `netlog-reader.ts`.
 *
 * Plain Node: this file is bundled into the eval host, which must not import anything heavy.
 * Never print to stdout from here (it is the host's RPC channel).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { NetRecord } from '../contracts';

/** The most request body bytes a record keeps. */
export const MAX_BODY_BYTES = 64 * 1024;

export const REDACTED = '«redacted»';

/** Header values that are credentials of a service, never logged. */
const DEFAULT_REDACTED_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
];

export type HeaderInput =
  | Headers
  | Record<string, string | readonly string[] | number | undefined>
  | readonly string[]
  | readonly (readonly [string, string])[];

/**
 * Header names in lower case with one string per name: repeated headers are joined with ", "
 * (`cookie` with "; "). Accepts `Headers`, Node's header objects, raw `[name, value, ...]` arrays
 * and `[name, value][]`.
 */
export function headersToRecord(input: HeaderInput): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string, value: string) => {
    const key = name.toLowerCase();
    const previous = out[key];
    out[key] =
      previous === undefined ? value : `${previous}${key === 'cookie' ? '; ' : ', '}${value}`;
  };
  if (input instanceof Headers) {
    for (const [name, value] of input) put(name, value);
  } else if (Array.isArray(input)) {
    const list = input as readonly (string | readonly [string, string])[];
    if (list.length && typeof list[0] === 'string') {
      const flat = list as readonly string[];
      for (let i = 0; i + 1 < flat.length; i += 2) put(flat[i] as string, flat[i + 1] as string);
    } else {
      for (const pair of list as readonly (readonly [string, string])[]) put(pair[0], pair[1]);
    }
  } else {
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) put(name, String(v));
      else put(name, String(value));
    }
  }
  return out;
}

/** The request body fields of a record: text as is, binary as base64, at most `max` bytes. */
export function bodyFields(
  body: Uint8Array | undefined,
  totalBytes: number,
  max = MAX_BODY_BYTES,
): Pick<NetRecord, 'reqBody' | 'reqBodyEncoding' | 'reqBodyBytes'> {
  if (!body?.length) return totalBytes > 0 ? { reqBodyBytes: totalBytes } : {};
  let kept = Buffer.from(body.subarray(0, Math.min(body.length, max)));
  if (kept.length < totalBytes) kept = kept.subarray(0, utf8Boundary(kept));
  const text = decodeUtf8(kept);
  if (text !== undefined) return { reqBody: text, reqBodyBytes: totalBytes };
  return { reqBody: kept.toString('base64'), reqBodyEncoding: 'base64', reqBodyBytes: totalBytes };
}

/** The length of `buf` without a UTF-8 sequence that was cut at its end. */
function utf8Boundary(buf: Buffer): number {
  for (let back = 1; back <= Math.min(3, buf.length); back++) {
    const byte = buf[buf.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.length - back : buf.length;
  }
  return buf.length;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined;
  try {
    return strictUtf8.decode(buf);
  } catch {
    return undefined;
  }
}

export type NetRecordInput = Omit<NetRecord, 'seq' | 't' | 'worldId'> & {
  /** From `nextSeq()`, taken when the request started, so seq follows the order of requests. */
  seq?: number;
  t?: string;
};

export interface NetLogOptions {
  worldId: string;
  /** JSONL file to append to (created with its folder). Without it the log lives in memory only. */
  file?: string;
  /** How many records `tail()` can return. Default 1000. */
  tail?: number;
  /** Header names (any case) whose values are replaced by «redacted». Default: service credentials. */
  redactHeaders?: readonly string[];
  /**
   * Masks typed secrets in every text of a record (url, header values, text body) before it is
   * stored or shown to listeners. Binary (base64) bodies are not scrubbed.
   */
  scrub?(text: string): string;
  /** Called with write failures and with the errors listeners throw. Default: a line on stderr. */
  onError?(error: unknown): void;
  now?(): Date;
}

export type NetLogListener = (record: NetRecord) => void;

export class NetLog {
  readonly worldId: string;
  private counter = 0;
  private readonly recent: NetRecord[] = [];
  private readonly tailSize: number;
  private readonly redact: ReadonlySet<string>;
  private readonly listeners = new Set<NetLogListener>();
  private readonly fd?: number;
  private failure?: unknown;
  private closed = false;

  constructor(private readonly options: NetLogOptions) {
    this.worldId = options.worldId;
    this.tailSize = Math.max(1, options.tail ?? 1000);
    this.redact = new Set(
      (options.redactHeaders ?? DEFAULT_REDACTED_HEADERS).map((h) => h.toLowerCase()),
    );
    if (options.file) {
      fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
      // One synchronous append per record on an O_APPEND descriptor: nothing is lost when the process
      // is killed, and the lines of writers that share a file never mix.
      this.fd = fs.openSync(options.file, 'a', 0o600);
    }
  }

  /** The current time, as records write it. */
  stamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  /** The next sequence number (take it when a request starts to number requests in order). */
  nextSeq(): number {
    return ++this.counter;
  }

  /** Stores a record (redacted, scrubbed), writes its line, tells the listeners, returns it. */
  append(input: NetRecordInput): NetRecord {
    if (this.closed) throw new Error('The network log is closed');
    const seq = input.seq ?? this.nextSeq();
    this.counter = Math.max(this.counter, seq);
    const { seq: _seq, t, ...rest } = input;
    const record: NetRecord = this.clean({
      seq,
      t: t ?? this.stamp(),
      worldId: this.worldId,
      ...rest,
    });
    this.recent.push(record);
    if (this.recent.length > this.tailSize)
      this.recent.splice(0, this.recent.length - this.tailSize);
    this.write(`${JSON.stringify(record)}\n`);
    for (const listener of this.listeners) {
      try {
        listener(record);
      } catch (err) {
        this.report(err);
      }
    }
    return record;
  }

  /** The newest records (all of the retained ones by default), oldest first. */
  tail(limit = this.tailSize): NetRecord[] {
    return this.recent.slice(-limit);
  }

  /** Calls `listener` with every record appended from now on. Returns the function that stops it. */
  on(listener: NetLogListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Closes the file. Appending afterwards throws. Throws the first write failure, if there was one. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== undefined) {
      try {
        fs.closeSync(this.fd);
      } catch (err) {
        this.failure ??= err;
      }
    }
    if (this.failure) throw this.failure;
  }

  private write(line: string): void {
    if (this.fd === undefined) return;
    try {
      const bytes = Buffer.from(line);
      let written = 0;
      while (written < bytes.length) written += fs.writeSync(this.fd, bytes, written);
    } catch (err) {
      this.failure ??= err;
      this.report(err);
    }
  }

  private clean(record: NetRecord): NetRecord {
    const scrub = this.options.scrub;
    const text = (value: string) => (scrub ? scrub(value) : value);
    const reqHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(record.reqHeaders)) {
      const key = name.toLowerCase();
      reqHeaders[key] = this.redact.has(key) ? REDACTED : text(value);
    }
    const cleaned: NetRecord = { ...record, url: text(record.url), reqHeaders };
    if (record.reqBody !== undefined && record.reqBodyEncoding !== 'base64')
      cleaned.reqBody = text(record.reqBody);
    if (record.error !== undefined) cleaned.error = text(record.error);
    return cleaned;
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else process.stderr.write(`[sa-eval] network log: ${String(error)}\n`);
  }
}
