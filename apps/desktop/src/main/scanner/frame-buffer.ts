import type { FrameDecision } from './decider';
import { retryDelay, scanDelay } from './retry';

const BUFFER_SIZE = 3;
const MAX_FRAME_AGE_MS = 10_000;
const CHECK_INTERVAL_MS = 200;
const GUIDANCE_PAUSE_MS = 4_000;

/**
 * How long to hold frames back after a recapture: new guidance or a successful read asks the
 * user to move the document, so give them time to do it before the agent sees a frame.
 */
export function capturePauseMs(reason: string | undefined, success: boolean | undefined) {
  return success === true || reason !== undefined ? GUIDANCE_PAUSE_MS : 0;
}

function waitForCheck(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, CHECK_INTERVAL_MS);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One continuous gate worker, independent of extraction, with a small in-memory buffer. */
export class CameraFrameBuffer {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly worker: Promise<void>;
  private generation = 0;
  private frames: { image: string; capturedAt: number }[] = [];
  private failure?: unknown;
  private pending?: { resolve(images: string[]): void; reject(error: unknown): void };

  constructor(
    private readonly ports: {
      signal: AbortSignal;
      capture(signal: AbortSignal): Promise<string>;
      gate: { check(image: string, signal: AbortSignal): Promise<FrameDecision | undefined> };
      reason(): string;
      failed?(error: unknown, attempt: number): void;
      checked(image: string, decision: FrameDecision, reason: string): Promise<void>;
    },
  ) {
    this.signal = AbortSignal.any([ports.signal, this.controller.signal]);
    this.worker = this.run().catch((error: unknown) => {
      this.failure = error;
      if (!this.signal.aborted) this.ports.failed?.(error, 0);
      this.frames = [];
      this.pending?.reject(error);
      this.pending = undefined;
    });
  }

  private prune() {
    const oldest = performance.now() - MAX_FRAME_AGE_MS;
    this.frames = this.frames.filter((frame) => frame.capturedAt >= oldest);
  }

  private drain() {
    this.prune();
    return this.frames.splice(0).map((frame) => frame.image);
  }

  private async run() {
    let failures = 0;
    while (true) {
      this.signal.throwIfAborted();
      const generation = this.generation;
      const reason = this.ports.reason();
      const image = await this.ports.capture(this.signal);
      this.signal.throwIfAborted();
      const capturedAt = performance.now();
      let decision: FrameDecision | undefined;
      try {
        decision = await this.ports.gate.check(image, this.signal);
        failures = 0;
      } catch (error) {
        this.signal.throwIfAborted();
        this.ports.failed?.(error, ++failures);
        await retryDelay(failures, this.signal);
        continue;
      }
      this.signal.throwIfAborted();
      if (decision) await this.ports.checked(image, decision, reason);
      this.signal.throwIfAborted();
      // A side-change request invalidates frames already captured or being checked.
      if (generation === this.generation && (!decision || decision.accepted)) {
        this.prune();
        if (!this.frames.some((frame) => frame.image === image))
          this.frames.push({ image, capturedAt });
        if (this.frames.length > BUFFER_SIZE) this.frames.shift();
        this.prune();
        if (this.pending && this.frames.length) {
          const pending = this.pending;
          this.pending = undefined;
          pending.resolve(this.drain());
        }
      }
      await waitForCheck(this.signal);
    }
  }

  take(fresh = false, pauseMs = GUIDANCE_PAUSE_MS): Promise<string[]> {
    this.signal.throwIfAborted();
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new Error('Capture already pending'));
    if (fresh) {
      this.generation++;
      this.frames = [];
      if (pauseMs === 0) return this.take();
      // Give the user time to move the document. Keep sampling/screening, but discard
      // everything captured during the pause, including checks still in flight.
      return scanDelay(pauseMs, this.signal).then(() => {
        this.signal.throwIfAborted();
        this.generation++;
        this.frames = [];
        return this.take();
      });
    }
    const images = this.drain();
    if (images.length) return Promise.resolve(images);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }

  async stop() {
    this.controller.abort();
    this.frames = [];
    this.pending?.reject(new Error('cancelled'));
    this.pending = undefined;
    await this.worker;
  }
}
