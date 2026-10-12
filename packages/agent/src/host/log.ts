/**
 * Host logging goes to stderr only: stdout carries the RPC protocol. Lines look like
 * `[sa-host] <level> <message>`; PiRpcClient turns them into `log` events.
 */
export type HostLogLevel = 'debug' | 'info' | 'warn' | 'error';

export const HOST_LOG_PREFIX = '[sa-host]';

export function hostLog(level: HostLogLevel, message: string): void {
  process.stderr.write(`${HOST_LOG_PREFIX} ${level} ${message.replace(/\n/g, ' ')}\n`);
}
