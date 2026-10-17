import type { ScanGuidance, ScannerStatus } from '../../../scanner';
import { useAppStore } from '../store/app';
import { isMockApi } from './api';
import type { ScanOutcome } from './scan';
import { createScanGuidancePresenter } from './scan-guidance';

export async function scannerStatus(): Promise<ScannerStatus> {
  if (!useAppStore.getState().provider?.configured)
    return { available: false, reason: 'no_provider' };
  if (isMockApi()) return { available: true, provider: useAppStore.getState().provider?.label };
  return window.saScanner?.status() ?? { available: false, reason: 'no_provider' };
}

// 1408² is below Decider's 2048 tiles of 32×32 pixels, even for square/portrait uploads.
export function documentFrame(source: CanvasImageSource, width: number, height: number): string {
  if (!width || !height) throw new Error('Image unavailable');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1408 / Math.max(width, height));
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Image unavailable');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/** Capture requests stay in main; only sampled JPEGs cross IPC, never credentials. */
export function scanDocumentSession(options: {
  capture(signal: AbortSignal): Promise<string[]>;
  guidance(value: ScanGuidance): void;
  complete(outcome: ScanOutcome): void;
  error(): void;
  language: string;
  source?: 'camera' | 'photo';
}): () => void {
  const sessionId = crypto.randomUUID();
  const controller = new AbortController();
  const { signal } = controller;
  let unsubscribe = () => {};
  const presentation = createScanGuidancePresenter(options.guidance);
  const cancel = () => {
    if (signal.aborted) return;
    presentation.cancel();
    controller.abort();
    unsubscribe();
    void window.saScanner?.cancel(sessionId).catch(() => {});
  };
  const fail = () => {
    if (signal.aborted) return;
    cancel();
    options.error();
  };
  const complete = (fields: import('../../../scanner').DocumentFields, permanent = false) => {
    if (signal.aborted) return;
    presentation.complete(() => {
      cancel();
      options.complete({ fields, permanent });
    });
  };
  if (isMockApi()) {
    // Deterministic preview: the same capture/guidance lifecycle, entirely offline.
    void (async () => {
      presentation.guidance({ state: 'positioning' });
      await options.capture(signal);
      if (signal.aborted) return;
      presentation.guidance({ state: 'reading' });
      await waitForFrame(signal, 1200);
      presentation.guidance({
        state: 'feedback',
        success: true,
        reason:
          options.language === 'en'
            ? 'Turn your DNI over so I can read your address.'
            : 'Dale la vuelta al DNI para que pueda leer tu dirección.',
      });
      await waitForFrame(signal, 1200);
      await options.capture(signal);
      if (signal.aborted) return;
      presentation.guidance({ state: 'reading' });
      await waitForFrame(signal, 1200);
      complete({
        givenName: 'Carmen',
        surname1: 'García',
        surname2: 'López',
        documentType: 'DNI',
        documentNumber: '99999999R',
        birthDate: '1990-01-15',
        birthPlace: 'Madrid',
        addressStreet: 'Calle de Ejemplo, 12',
        addressMunicipality: 'Madrid',
        addressProvince: 'Madrid',
      });
    })().catch(fail);
  } else if (window.saScanner) {
    const scanner = window.saScanner;
    let captureRequest: string | undefined;
    unsubscribe = scanner.on((event) => {
      if (event.sessionId !== sessionId || signal.aborted) return;
      if (event.type === 'retain_guidance') {
        presentation.retain();
        return;
      }
      if (event.type === 'guidance') presentation.guidance(event.guidance);
      else if (event.type === 'complete') complete(event.fields, event.permanent);
      else if (event.type === 'error') fail();
      else if (event.type === 'capture') {
        captureRequest = event.requestId;
        void (async () => {
          while (!signal.aborted && captureRequest === event.requestId) {
            try {
              const images = await options.capture(signal);
              if (!signal.aborted && captureRequest === event.requestId)
                await scanner.frames(sessionId, event.requestId, images);
              return;
            } catch {
              if (signal.aborted || captureRequest !== event.requestId) return;
              if (options.source !== 'camera') throw new Error('capture_failed');
              // Fixed diagnostic only: never forward raw browser/IPC errors or image data.
              void scanner
                .cameraEvent({ stage: 'failed', errorName: 'OperationError' })
                .catch(() => {});
              await waitForFrame(signal, 1_000);
            }
          }
        })().catch(() => {
          if (!signal.aborted) fail();
        });
      }
    });
    void scanner.start(sessionId, options.source ?? 'photo').catch(fail);
  } else queueMicrotask(fail);
  return cancel;
}

function waitForFrame(signal: AbortSignal, milliseconds = 200): Promise<void> {
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

/** Sample every 200 ms, retaining only the latest frame while a check/inference is in flight. */
export function createDocumentFrameSampler(read: () => string, milliseconds = 200) {
  let latest: string | undefined;
  let stopped = false;
  let pending: { resolve(image: string[]): void; reject(error: Error): void } | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    latest = undefined;
    pending?.reject(new Error('cancelled'));
    pending = undefined;
  };
  const timer = setInterval(() => {
    try {
      latest = read();
      if (pending) {
        const waiting = pending;
        pending = undefined;
        const image = latest;
        latest = undefined;
        waiting.resolve([image]);
      }
    } catch {
      stop();
    }
  }, milliseconds);
  return {
    stop,
    capture(signal: AbortSignal): Promise<string[]> {
      signal.throwIfAborted();
      if (stopped) return Promise.reject(new Error('cancelled'));
      if (pending) return Promise.reject(new Error('Capture already pending'));
      if (latest) {
        const image = latest;
        latest = undefined;
        return Promise.resolve([image]);
      }
      return new Promise((resolve, reject) => {
        const abort = () => stop();
        signal.addEventListener('abort', abort, { once: true });
        pending = {
          resolve: (images) => {
            signal.removeEventListener('abort', abort);
            resolve(images);
          },
          reject: (error) => {
            signal.removeEventListener('abort', abort);
            reject(error);
          },
        };
      });
    },
  };
}
