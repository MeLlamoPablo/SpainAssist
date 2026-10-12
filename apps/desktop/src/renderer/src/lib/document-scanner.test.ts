import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScannerEvent } from '../../../scanner';
import { createDocumentFrameSampler, scanDocumentSession } from './document-scanner';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('camera frame sampling', () => {
  it('samples every 200 ms and returns only the latest frame, without a backlog', async () => {
    vi.useFakeTimers();
    let number = 0;
    const read = vi.fn(() => `frame-${++number}`);
    const sampler = createDocumentFrameSampler(read);
    const signal = new AbortController().signal;
    const first = sampler.capture(signal);
    await vi.advanceTimersByTimeAsync(199);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toEqual(['frame-1']);
    // While the decision request is in flight, frames 2–5 replace one another.
    await vi.advanceTimersByTimeAsync(800);
    expect(read).toHaveBeenCalledTimes(5);
    expect(await sampler.capture(signal)).toEqual(['frame-5']);
    const fresh = sampler.capture(signal);
    await vi.advanceTimersByTimeAsync(200);
    expect(await fresh).toEqual(['frame-6']);
    sampler.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(6);
  });
  it('aborts pending capture and stops sampling', async () => {
    vi.useFakeTimers();
    const read = vi.fn(() => 'frame');
    const sampler = createDocumentFrameSampler(read);
    const controller = new AbortController();
    const captured = sampler.capture(controller.signal);
    const rejection = expect(captured).rejects.toThrow('cancelled');
    controller.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('scanner guidance events', () => {
  it('logs and retries camera delivery failures without cancelling the active scan', async () => {
    vi.useFakeTimers();
    let listener: (event: ScannerEvent) => void = () => {};
    const scanner = {
      on: vi.fn((value: typeof listener) => {
        listener = value;
        return () => {};
      }),
      start: vi.fn(async (_id: string) => {}),
      frames: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      cameraEvent: vi.fn(async () => {}),
    };
    scanner.frames.mockRejectedValueOnce(new Error('raw secret'));
    vi.stubGlobal('window', { saScanner: scanner });
    const options = {
      language: 'es',
      source: 'camera' as const,
      capture: vi.fn(async () => ['data:image/jpeg;base64,AAAA']),
      guidance: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
    };
    const cancel = scanDocumentSession(options);
    const sessionId = scanner.start.mock.calls[0]![0];
    listener({ sessionId, type: 'capture', requestId: 'retry-request' });
    await vi.advanceTimersByTimeAsync(0);
    expect(scanner.cameraEvent).toHaveBeenCalledWith({
      stage: 'failed',
      errorName: 'OperationError',
    });
    expect(scanner.cancel).not.toHaveBeenCalled();
    expect(options.error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scanner.frames).toHaveBeenCalledTimes(2);
    cancel();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scanner.frames).toHaveBeenCalledTimes(2);
  });

  it('forwards typed pill states for the active session and ignores late events after cancellation', async () => {
    vi.useFakeTimers();
    let listener: (event: ScannerEvent) => void = () => {};
    const scanner = {
      on: vi.fn((value: typeof listener) => {
        listener = value;
        return unsubscribe;
      }),
      start: vi.fn(async (_id: string) => {}),
      frames: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
    const unsubscribe = vi.fn();
    vi.stubGlobal('window', { saScanner: scanner });
    const options = {
      language: 'es',
      capture: vi.fn(async () => ['data:image/jpeg;base64,AAAA']),
      guidance: vi.fn(),
      complete: vi.fn(),
      error: vi.fn(),
    };
    const cancel = scanDocumentSession(options);
    const sessionId = scanner.start.mock.calls[0]![0];
    listener({ sessionId: 'other-session', type: 'guidance', guidance: { state: 'reading' } });
    expect(options.guidance).not.toHaveBeenCalled();
    const states = [
      { state: 'positioning' },
      { state: 'legibility' },
      { state: 'reading' },
      { state: 'feedback', reason: 'Dale la vuelta.', success: true },
      { state: 'reading' },
      { state: 'feedback', reason: 'Enseña el reverso.', success: false },
      { state: 'reading' },
    ] as const;
    for (const guidance of states) {
      listener({ sessionId, type: 'guidance', guidance });
      if (guidance.state === 'feedback') {
        listener({ sessionId, type: 'capture', requestId: 'during-feedback' });
        await Promise.resolve();
        expect(scanner.frames).toHaveBeenCalledWith(sessionId, 'during-feedback', [
          'data:image/jpeg;base64,AAAA',
        ]);
        // Captures complete without waiting for the UI's three-second minimum.
        expect(options.capture).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3_000);
      }
    }
    expect(options.guidance.mock.calls.map(([guidance]) => guidance)).toEqual(states);
    listener({ sessionId, type: 'capture', requestId: 'request' });
    await Promise.resolve();
    expect(scanner.frames).toHaveBeenCalledWith(sessionId, 'request', [
      'data:image/jpeg;base64,AAAA',
    ]);
    cancel();
    listener({ sessionId, type: 'guidance', guidance: { state: 'reading' } });
    listener({ sessionId, type: 'complete', fields: {}, permanent: false });
    expect(options.guidance).toHaveBeenCalledTimes(states.length);
    expect(options.complete).not.toHaveBeenCalled();
    expect(options.error).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(scanner.cancel).toHaveBeenCalledWith(sessionId);
  });
});
