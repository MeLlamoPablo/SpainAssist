/** Bounded, abortable backoff; retries continue until the user closes the scanner. */
export function retryDelay(attempt: number, signal: AbortSignal): Promise<void> {
  return scanDelay(Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), 10_000), signal);
}

/** Abortable wait for scanner transitions as well as retry backoff. */
export function scanDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
