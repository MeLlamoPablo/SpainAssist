import type { ScanGuidance } from '../../../scanner';

const FEEDBACK_MINIMUM_MS = 3_000;

/** Hold feedback in the UI without delaying camera capture or model requests. */
export function createScanGuidancePresenter(show: (guidance: ScanGuidance) => void) {
  const pending: ScanGuidance[] = [];
  let holdUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  let stopped = false;
  let lastFeedback: ScanGuidance | undefined;
  let retaining = false;
  let displayed: ScanGuidance | undefined;

  const flush = () => {
    if (stopped || timer !== undefined) return;
    while (pending.length || finish) {
      const remaining = holdUntil - performance.now();
      if (remaining > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, remaining);
        return;
      }
      const next = pending.shift();
      if (!next) {
        const done = finish!;
        finish = undefined;
        done();
        return;
      }
      if (next.state === 'feedback') holdUntil = performance.now() + FEEDBACK_MINIMUM_MS;
      displayed = next;
      show(next);
    }
  };

  return {
    guidance(value: ScanGuidance) {
      if (stopped || finish) return;
      if (value.state === 'feedback') {
        lastFeedback = value;
        retaining = false;
      } else if (retaining) return;
      // Keep each feedback message, but coalesce superseded camera/reading states.
      if (pending.at(-1)?.state !== 'feedback') pending.pop();
      pending.push(value);
      flush();
    },
    retain() {
      if (stopped || finish || !lastFeedback) return;
      retaining = true;
      // Drop queued blue/progress updates and restore the last actionable instruction.
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.state !== 'feedback') pending.splice(i, 1);
      }
      if (displayed?.state !== 'feedback' && !pending.some((item) => item.state === 'feedback')) {
        displayed = lastFeedback;
        show(lastFeedback);
      }
    },
    complete(done: () => void) {
      if (stopped) return;
      // Completion replaces transient progress, after every feedback message has been readable.
      if (pending.at(-1)?.state !== 'feedback') pending.pop();
      finish = done;
      flush();
    },
    cancel() {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      pending.length = 0;
      finish = undefined;
    },
  };
}
