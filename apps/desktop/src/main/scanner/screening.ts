import { FrameCheckError, type FrameDecision, type FrameGate } from './decider';
import { retryDelay } from './retry';

const SCREENING_BUDGET_MS = 3_000;

/** A scan-local fallback: valid rejections stay screened; service failures fail open. */
export class ScanScreening {
  private bypassed = false;

  constructor(
    private readonly gate: FrameGate,
    private readonly failed: (error: unknown, attempt: number) => void,
    private readonly bypass: () => void,
  ) {}

  async check(image: string, signal: AbortSignal): Promise<FrameDecision | undefined> {
    signal.throwIfAborted();
    if (this.bypassed) return undefined;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), SCREENING_BUDGET_MS);
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    let attempt = 0;
    try {
      while (!requestSignal.aborted) {
        try {
          // Race explicitly so a stalled provider cannot hold the scanner past the budget.
          const decision = await new Promise<FrameDecision>((resolve, reject) => {
            const abort = () =>
              reject(new FrameCheckError('timeout', undefined, SCREENING_BUDGET_MS));
            requestSignal.addEventListener('abort', abort, { once: true });
            void this.gate
              .check(image, requestSignal)
              .then(resolve, reject)
              .finally(() => {
                requestSignal.removeEventListener('abort', abort);
              });
          });
          signal.throwIfAborted();
          if (!deadline.signal.aborted) return decision;
        } catch (error) {
          signal.throwIfAborted();
          this.failed(error, ++attempt);
          // No key, a refused key or a used-up allowance: skip screening for this scan now
          // instead of retrying for the whole budget on every frame.
          if (deadline.signal.aborted || (error instanceof FrameCheckError && error.permanent)) {
            break;
          }
          try {
            await retryDelay(attempt, requestSignal);
          } catch {
            signal.throwIfAborted();
            break;
          }
        }
      }
      signal.throwIfAborted();
      this.bypassed = true;
      this.bypass();
      return undefined;
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }
}
