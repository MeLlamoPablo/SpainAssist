import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScannerEvent } from '../../scanner';
import type { ProviderManager } from '../providers/manager';
import { DocumentScanner } from './service';

const fields = {
  givenName: 'Carmen',
  surname1: 'García',
  surname2: 'López',
  documentNumber: '99999999R',
  documentSupportNumber: 'CAA000000',
  documentType: 'DNI',
  birthDate: '1990-01-15',
  sex: 'F',
  nationality: 'ESP',
  documentExpiry: '2036-06-02',
  documentIssueDate: '2026-06-02',
  birthPlace: 'Madrid',
  fatherName: 'Juan',
  motherName: 'Ana',
  addressStreet: 'Calle Ejemplo 12',
  addressMunicipality: 'Madrid',
  addressProvince: 'Madrid',
  dniIssuingTeam: '12345A6B7',
  dniAccessNumber: '123456',
};
const image = (n: number) =>
  `data:image/jpeg;base64,${Buffer.from(`mock-frame-${n}`).toString('base64')}`;
function response(calls: { name: string; arguments: unknown }[]) {
  return new Response(
    `data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: { tool_calls: calls.map((call, i) => ({ index: i, id: `tool-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs pending timers until the promise settles, so scanner delays don't take real time. */
async function settleWithFakeTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) await vi.advanceTimersByTimeAsync(100);
  return promise;
}

describe('camera buffering through scanner and inference', () => {
  it('logs screening and extraction failures, recovers without an error event, and keeps sampling during retries', async () => {
    const request = vi.fn(async () =>
      response([
        {
          name: 'finish_scan',
          arguments: { fields, sides: ['front', 'back'], unavailable: [], permanent: false },
        },
      ]),
    );
    request.mockRejectedValueOnce(new Error('raw secret provider error'));
    vi.stubGlobal('fetch', request);
    const gate = {
      check: vi.fn(async () => ({
        accepted: true,
        documentPresent: 0.99,
        documentLegible: 0.99,
        model: 'mock-gate',
        usage: { input_tokens: 1, output_tokens: 0 },
        startedAt: 0,
        completedAt: 1,
      })),
    };
    gate.check.mockRejectedValueOnce(new Error('raw secret screening error'));
    const providers = {
      agentModel: async () => ({
        provider: 'custom',
        id: 'mock-vision',
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
      }),
      refreshCredential: async () => ({ type: 'api_key', key: 'test-only' }),
      creditSpent: () => {},
    };
    const log = { warn: vi.fn() };
    const scanner = new DocumentScanner(
      providers as unknown as ProviderManager,
      () => 'en',
      undefined,
      gate,
      undefined,
      log,
    );
    const sessionId = randomUUID();
    const events: ScannerEvent[] = [];
    let captures = 0;
    const completed = new Promise<ScannerEvent>((resolve, reject) => {
      void scanner
        .start({ sessionId, source: 'camera' }, (event) => {
          events.push(event);
          if (event.type === 'capture')
            scanner.frames({ sessionId, requestId: event.requestId, images: [image(++captures)] });
          if (event.type === 'complete' || event.type === 'error') resolve(event);
        })
        .catch(reject);
    });
    try {
      expect(await completed).toMatchObject({ type: 'complete', fields });
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(captures).toBeGreaterThan(2);
      expect(log.warn).toHaveBeenCalledWith(
        'scanner retry',
        expect.objectContaining({ stage: 'screening' }),
      );
      expect(log.warn).toHaveBeenCalledWith(
        'scanner retry',
        expect.objectContaining({ stage: 'extraction' }),
      );
      expect(JSON.stringify(log.warn.mock.calls)).not.toContain('raw secret');
    } finally {
      await scanner.cancel(sessionId);
    }
  });

  it('restarts an invalid model response automatically using the same camera session', async () => {
    const request = vi.fn(async () =>
      response([
        {
          name: 'finish_scan',
          arguments: { fields, sides: ['front', 'back'], unavailable: [], permanent: false },
        },
      ]),
    );
    request.mockResolvedValueOnce(response([]));
    vi.stubGlobal('fetch', request);
    const gate = {
      check: vi.fn(async () => ({
        accepted: true,
        documentPresent: 0.99,
        documentLegible: 0.99,
        model: 'mock-gate',
        usage: { input_tokens: 1, output_tokens: 0 },
        startedAt: 0,
        completedAt: 1,
      })),
    };
    const providers = {
      agentModel: async () => ({
        provider: 'custom',
        id: 'mock-vision',
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
      }),
      refreshCredential: async () => ({ type: 'api_key', key: 'test-only' }),
      creditSpent: () => {},
    };
    const log = { warn: vi.fn() };
    const scanner = new DocumentScanner(
      providers as unknown as ProviderManager,
      () => 'en',
      undefined,
      gate,
      undefined,
      log,
    );
    const sessionId = randomUUID();
    const completed = new Promise<ScannerEvent>((resolve, reject) => {
      void scanner
        .start({ sessionId, source: 'camera' }, (event) => {
          if (event.type === 'capture')
            scanner.frames({ sessionId, requestId: event.requestId, images: [image(1)] });
          if (event.type === 'complete' || event.type === 'error') resolve(event);
        })
        .catch(reject);
    });
    try {
      expect(await completed).toMatchObject({ type: 'complete', fields });
      expect(request).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(
        'scanner retry',
        expect.objectContaining({ stage: 'restart' }),
      );
    } finally {
      await scanner.cancel(sessionId);
    }
  });

  it.each(['camera', 'photo'] as const)(
    'forwards unscreened frames after three seconds of errors (%s)',
    async (source) => {
      // The 3 s screening budget and the 4 s turn-over pause would exceed the test timeout.
      vi.useFakeTimers();
      const request = vi.fn(async () =>
        response([
          {
            name: 'finish_scan',
            arguments: { fields, sides: ['front', 'back'], unavailable: [], permanent: false },
          },
        ]),
      );
      request.mockResolvedValueOnce(
        response([
          {
            name: 'capture_images',
            arguments: { reason: 'Show the reverse side.', success: true },
          },
        ]),
      );
      vi.stubGlobal('fetch', request);
      const gate = {
        check: vi.fn(async () => {
          throw new Error('raw secret screening error');
        }),
      };
      const providers = {
        agentModel: async () => ({
          provider: 'custom',
          id: 'mock-vision',
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
        }),
        refreshCredential: async () => ({ type: 'api_key', key: 'test-only' }),
        creditSpent: () => {},
      };
      const log = { warn: vi.fn() };
      const scanner = new DocumentScanner(
        providers as unknown as ProviderManager,
        () => 'en',
        undefined,
        gate,
        undefined,
        log,
      );
      const sessionId = randomUUID();
      let captures = 0;
      const completed = new Promise<ScannerEvent>((resolve, reject) => {
        void scanner
          .start({ sessionId, source }, (event) => {
            if (event.type === 'capture')
              scanner.frames({
                sessionId,
                requestId: event.requestId,
                images: [image(++captures)],
              });
            if (event.type === 'complete' || event.type === 'error') resolve(event);
          })
          .catch(reject);
      });
      try {
        expect(await settleWithFakeTimers(completed)).toMatchObject({ type: 'complete', fields });
        expect(request).toHaveBeenCalledTimes(2);
        expect(gate.check).toHaveBeenCalledTimes(2);
        expect(
          log.warn.mock.calls.filter(([message]) => message === 'scanner screening bypassed'),
        ).toHaveLength(1);
        expect(JSON.stringify(log.warn.mock.calls)).not.toContain('raw secret');
      } finally {
        await scanner.cancel(sessionId);
      }
    },
  );

  it('keeps photo uploads on demand during extraction', async () => {
    let inferenceStarted!: () => void;
    let releaseInference!: () => void;
    const started = new Promise<void>((resolve) => {
      inferenceStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseInference = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inferenceStarted();
        await released;
        return response([
          {
            name: 'finish_scan',
            arguments: {
              fields,
              sides: ['front', 'back'],
              unavailable: [],
              permanent: false,
            },
          },
        ]);
      }),
    );
    const gate = {
      check: vi.fn(async () => ({
        accepted: true,
        documentPresent: 0.99,
        documentLegible: 0.99,
        model: 'mock-gate',
        usage: { input_tokens: 1, output_tokens: 0 },
        startedAt: 0,
        completedAt: 1,
      })),
    };
    const providers = {
      agentModel: async () => ({
        provider: 'custom',
        id: 'mock-vision',
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
      }),
      refreshCredential: async () => ({ type: 'api_key', key: 'test-only' }),
      creditSpent: () => {},
    };
    const scanner = new DocumentScanner(
      providers as unknown as ProviderManager,
      () => 'en',
      undefined,
      gate,
    );
    const sessionId = randomUUID();
    let captures = 0;
    const completed = new Promise<ScannerEvent>((resolve, reject) => {
      void scanner
        .start({ sessionId, source: 'photo' }, (event) => {
          if (event.type === 'capture') {
            captures++;
            scanner.frames({ sessionId, requestId: event.requestId, images: [image(captures)] });
          }
          if (event.type === 'complete' || event.type === 'error') resolve(event);
        })
        .catch(reject);
    });
    try {
      await started;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(captures).toBe(1);
      expect(gate.check).toHaveBeenCalledOnce();
      releaseInference();
      expect(await completed).toMatchObject({ type: 'complete', fields });
    } finally {
      releaseInference();
      await scanner.cancel(sessionId);
    }
  });
  it.each([
    { name: 'a failed read without new guidance', args: { success: false }, pause: false },
    {
      name: 'a failed read with new guidance',
      args: { reason: 'Keep it still.', success: false },
      pause: true,
    },
    { name: 'a successful read', args: { reason: 'Turn it over.', success: true }, pause: true },
  ])(
    'clears buffered frames on recapture after $name, pausing only for guidance or success',
    async ({ args, pause }) => {
      let unblockInference!: () => void;
      const enoughFrames = new Promise<void>((resolve) => {
        unblockInference = resolve;
      });
      const requests: Record<string, unknown>[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: RequestInit) => {
          requests.push(JSON.parse(init.body as string));
          if (requests.length === 1) {
            await enoughFrames;
            return response([
              { name: 'record_fields', arguments: { fields: {}, sides: [] } },
              { name: 'capture_images', arguments: args },
            ]);
          }
          return response([
            {
              name: 'finish_scan',
              arguments: { fields, sides: ['front', 'back'], unavailable: [], permanent: false },
            },
          ]);
        }),
      );
      const gate = {
        check: vi.fn(async (jpeg: string, _signal: AbortSignal) => ({
          accepted: jpeg !== image(3),
          documentPresent: 0.99,
          documentLegible: jpeg === image(3) ? 0.1 : 0.99,
          model: 'mock-gate',
          usage: { input_tokens: 1, output_tokens: 0 },
          startedAt: 0,
          completedAt: 1,
        })),
      };
      const providers = {
        agentModel: async () => ({
          provider: 'custom',
          id: 'mock-vision',
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
        }),
        refreshCredential: async () => ({ type: 'api_key', key: 'test-only' }),
        creditSpent: () => {},
      };
      let pendingOldFrame: Extract<ScannerEvent, { type: 'capture' }> | undefined;
      let frame = 0;
      let feedbackAt = 0;
      const capturedAt = new Map<number, number>();
      const events: ScannerEvent[] = [];
      const scanner = new DocumentScanner(
        providers as unknown as ProviderManager,
        () => 'en',
        undefined,
        gate,
        async () => {
          // Completion may race a previously requested JPEG; it must be harmless during shutdown.
          if (!pause && pendingOldFrame)
            scanner.frames({
              sessionId: pendingOldFrame.sessionId,
              requestId: pendingOldFrame.requestId,
              images: [image(6)],
            });
          return undefined;
        },
      );
      const sessionId = randomUUID();
      try {
        const completed = new Promise<ScannerEvent>((resolve, reject) => {
          void scanner
            .start({ sessionId, source: 'camera' }, (event) => {
              events.push(event);
              if (event.type === 'guidance' && event.guidance.state === 'feedback')
                feedbackAt = performance.now();
              if (event.type === 'capture') {
                frame++;
                capturedAt.set(frame, performance.now());
                if (frame === 6) {
                  pendingOldFrame = event;
                  unblockInference();
                  return;
                }
                scanner.frames({ sessionId, requestId: event.requestId, images: [image(frame)] });
              }
              const recapture =
                (event.type === 'guidance' && event.guidance.state === 'feedback') ||
                event.type === 'retain_guidance';
              if (recapture && pendingOldFrame)
                scanner.frames({
                  sessionId,
                  requestId: pendingOldFrame.requestId,
                  images: [image(6)],
                });
              if (event.type === 'complete' || event.type === 'error') resolve(event);
            })
            .catch(reject);
        });
        expect(await completed).toMatchObject({ type: 'complete', fields });
        expect(requests).toHaveLength(2);
        expect(gate.check.mock.calls.length).toBeGreaterThanOrEqual(5);
        const second = JSON.stringify(requests[1]);
        if (pause) {
          const delivered = [...capturedAt].filter(
            ([n]) => n > 1 && second.includes(JSON.stringify(image(n))),
          );
          expect(delivered).toHaveLength(1);
          expect(delivered[0]![1] - feedbackAt).toBeGreaterThanOrEqual(4_000);
          for (const [n, time] of capturedAt) {
            if (time - feedbackAt < 4_000 && n > 1)
              expect(second).not.toContain(JSON.stringify(image(n)));
          }
        } else {
          expect(second).toContain(image(7));
          for (const n of [2, 3, 4, 5, 6]) expect(second).not.toContain(image(n));
        }
        const firstFeedback = events.findIndex(
          (e) =>
            (e.type === 'guidance' && e.guidance.state === 'feedback') ||
            e.type === 'retain_guidance',
        );
        expect(events.slice(0, firstFeedback).filter((e) => e.type === 'capture')).toHaveLength(6);
        expect(
          events.filter((e) => e.type === 'guidance' && e.guidance.state === 'legibility'),
        ).toHaveLength(0);
      } finally {
        unblockInference();
        await scanner.cancel(sessionId);
      }
    },
    10_000,
  );
});
