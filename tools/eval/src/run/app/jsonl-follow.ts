/**
 * Following a JSONL file another process appends to (pi's session file): every complete line is
 * delivered once, parsed. Same polling scheme as `followNetLog` (`src/net/netlog-reader.ts`), for
 * lines that are not network records.
 */
import { statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

export interface JsonlFollower {
  /** Resolves after everything written to the file so far was delivered. */
  drain(): Promise<void>;
  /** Delivers what is left, then stops polling. */
  stop(): Promise<void>;
}

interface FollowJsonlOptions {
  /** Default 50 ms. */
  intervalMs?: number;
  /** Skip what the file holds now: deliver only what is appended from here on. */
  fromEnd?: boolean;
  /** Called with a line that is not JSON. Default: ignored (a line cut by a crash). */
  onInvalid?(line: string): void;
}

export function followJsonl(
  file: string,
  onValue: (value: unknown) => void,
  options: FollowJsonlOptions = {},
): JsonlFollower {
  let offset = 0;
  if (options.fromEnd) {
    try {
      offset = statSync(file).size;
    } catch {
      offset = 0;
    }
  }
  let pending = '';
  let decoder = new StringDecoder('utf8');
  let chain: Promise<void> = Promise.resolve();

  const deliver = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      options.onInvalid?.(line);
      return;
    }
    onValue(value);
  };

  const pass = async (): Promise<void> => {
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size < offset) {
        // The file was rewritten: start again (the consumer skips what it has seen).
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
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          deliver(line);
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
  }, options.intervalMs ?? 50);
  timer.unref();
  return {
    drain,
    async stop() {
      clearInterval(timer);
      await drain();
    },
  };
}
