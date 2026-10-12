export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/**
 * JSON-lines logger. Privacy rule for every call site: never log voucher codes, API keys (ours
 * or the LiteLLM master key), admin tokens or client IP addresses.
 */
export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(
  options: { level?: LogLevel; write?: (line: string) => void } = {},
): Logger {
  const min = ORDER[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const emit = (level: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields) => {
    if (ORDER[level] < min) return;
    write(JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields }));
  };
  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
