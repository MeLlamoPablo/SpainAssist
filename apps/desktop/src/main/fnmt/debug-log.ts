/**
 * TEMPORARY: a full record of every FNMT certificate request and download, so a run that goes
 * wrong while the flow is new can be repaired by hand: the page's calls with all their
 * arguments, the generated private key (PKCS#8 PEM), its public key and hash, the PKCS#10, the
 * certificate data FNMT sent, the parsed certificates and path, the vault's answers and every
 * error with its stack.
 *
 * Unlike main.log, nothing here is redacted: **the files hold private keys in clear**. They live
 * in `<userData>/fnmt-debug/` (0700 folder, 0600 files, one JSON line per event, one file per
 * day), outside the vault and outside "Borrar todo", so a key survives a bug that loses the
 * vault's copy. Delete the folder by hand once it is no longer needed. Remove this module (and
 * `FnmtBroker`'s `debug` calls) once the flow has been proven with real certificates.
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDir } from '../core/fs';
import type { Logger } from '../core/logger';
import { errorMessage } from '../core/util';

export interface FnmtDebugLog {
  write(event: string, data: Record<string, unknown>): Promise<void>;
}

export function pem(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der)
    .toString('base64')
    .replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END ${label}-----\n`;
}

/** Appends to `<dir>/fnmt-<YYYY-MM-DD>.jsonl`. A failed write is logged, never thrown. */
export function createFnmtDebugLog(
  dir: string,
  logger: Logger,
  now: () => Date = () => new Date(),
): FnmtDebugLog {
  let queue: Promise<void> = Promise.resolve();
  let warned = false;
  return {
    write(event, data) {
      const at = now();
      const line = `${JSON.stringify({ at: at.toISOString(), event, ...data }, jsonValue)}\n`;
      const file = join(dir, `fnmt-${at.toISOString().slice(0, 10)}.jsonl`);
      queue = queue
        .then(async () => {
          await ensurePrivateDir(dir);
          await appendFile(file, line, { mode: 0o600 });
        })
        .catch((err) => {
          if (!warned) logger.warn('FNMT debug log write failed', { error: errorMessage(err) });
          warned = true;
        });
      return queue;
    },
  };
}

/** Buffers as base64, errors with their stack. */
function jsonValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'Buffer') {
    const data = (value as { data?: unknown }).data;
    if (Array.isArray(data)) return Buffer.from(data).toString('base64');
  }
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}
