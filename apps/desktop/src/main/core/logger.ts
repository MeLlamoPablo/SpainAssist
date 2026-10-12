import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * Small structured logger for the main process. Rules:
 *  - never log secrets or personal data: data objects are redacted by key name, long strings are
 *    truncated, and every registered secret value (API keys, tokens, typed secrets...) is masked
 *    wherever it appears in the final line;
 *  - obvious secret shapes (Bearer tokens, sk-... keys, JWTs) are masked as a last line of defense.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  /** Logger that prefixes messages with a scope, sharing sinks and secrets. */
  child(scope: string): Logger;
  /** Register a value that must never appear in logs. */
  addSecret(value: string | undefined | null): void;
}

export type LogSink = (line: string, level: LogLevel) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never logged (user content, secrets). */
const REDACTED_KEYS =
  /^(password|passphrase|pass|secret|secrets|token|apikey|api_key|key|access|refresh|authorization|cookie|cookies|p12|pfx|value|values|text|query|q|body|message|title|delta|snapshot|args|response|credential|bytes|data|database64|code|username|pin)$/i;

const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
];

const MAX_STRING = 300;

export function truncate(value: string, max = MAX_STRING): string {
  return value.length > max ? `${value.slice(0, max)}…(${value.length - max} more)` : value;
}

/** Recursively redacts sensitive keys and truncates strings/arrays for logging. */
export function redactForLog(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    const code = (value as Error & { code?: unknown }).code;
    return { name: value.name, message: truncate(value.message), ...(code ? { code } : {}) };
  }
  if (value instanceof Uint8Array) return `[${value.byteLength} bytes]`;
  if (depth >= 4) return '[…]';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => redactForLog(v, depth + 1));
    if (value.length > 20) items.push(`…(${value.length - 20} more)`);
    return items;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.test(k) ? '[redacted]' : redactForLog(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

class SecretMask {
  private readonly secrets = new Set<string>();
  add(value: string | undefined | null): void {
    if (typeof value !== 'string') return;
    const v = value.trim();
    if (v.length >= 4) this.secrets.add(v);
  }
  apply(line: string): string {
    let out = line;
    for (const s of this.secrets) {
      if (out.includes(s)) out = out.split(s).join('[secret]');
    }
    for (const re of SECRET_PATTERNS) out = out.replace(re, '[secret]');
    return out;
  }
}

export interface CreateLoggerOptions {
  /** Directory for `main.log` (rotated at ~5 MB). Omit for no file output. */
  dir?: string;
  level?: LogLevel;
  console?: boolean;
  /** Extra sinks (tests). */
  sinks?: LogSink[];
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function openLogFile(dir: string): WriteStream | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, 'main.log');
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, join(dir, 'main.1.log'));
    } catch {
      // no previous log
    }
    const stream = createWriteStream(file, { flags: 'a', mode: 0o600 });
    stream.on('error', () => {});
    return stream;
  } catch {
    return undefined;
  }
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger & { close(): void } {
  const mask = new SecretMask();
  const min = LEVELS[opts.level ?? 'info'];
  const sinks: LogSink[] = [...(opts.sinks ?? [])];
  const file = opts.dir ? openLogFile(opts.dir) : undefined;
  if (file) sinks.push((line) => file.write(`${line}\n`));
  if (opts.console) {
    sinks.push((line, level) => {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    });
  }

  function write(level: LogLevel, scope: string | undefined, msg: string, data?: unknown): void {
    if (LEVELS[level] < min) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scope ? `[${scope}] ` : ''}${truncate(msg, 500)}`;
    if (data !== undefined) {
      try {
        line += ` ${JSON.stringify(redactForLog(data))}`;
      } catch {
        line += ' [unserializable]';
      }
    }
    line = mask.apply(line);
    for (const sink of sinks) {
      try {
        sink(line, level);
      } catch {
        // never let logging break the app
      }
    }
  }

  function make(scope?: string): Logger {
    return {
      debug: (m, d) => write('debug', scope, m, d),
      info: (m, d) => write('info', scope, m, d),
      warn: (m, d) => write('warn', scope, m, d),
      error: (m, d) => write('error', scope, m, d),
      child: (s) => make(scope ? `${scope}:${s}` : s),
      addSecret: (v) => mask.add(v),
    };
  }

  return Object.assign(make(), {
    close: () => {
      file?.end();
    },
  });
}

/** Logger that drops everything (tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
  addSecret: () => {},
};
