import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameDecision } from './decider';
import { CameraFrameBuffer, capturePauseMs } from './frame-buffer';

const accepted: FrameDecision = {
  accepted: true,
  documentPresent: 0.99,
  documentLegible: 0.99,
  model: 'mock-gate',
  usage: { input_tokens: 1, output_tokens: 0 },
  startedAt: 0,
  completedAt: 1,
};
const buffers: CameraFrameBuffer[] = [];
function harness() {
  vi.useFakeTimers();
  let frame = 0;
  const controller = new AbortController();
  const ports = {
    signal: controller.signal,
    capture: vi.fn(async (_signal: AbortSignal) => `image-${++frame}`),
    gate: { check: vi.fn(async (_image: string, _signal: AbortSignal) => accepted) },
    reason: () => 'Mock capture',
    checked: vi.fn(async () => {}),
    failed: vi.fn(),
  };
  const buffer = new CameraFrameBuffer(ports);
  buffers.push(buffer);
  return { buffer, ports, controller };
}

afterEach(async () => {
  for (const buffer of buffers.splice(0)) await buffer.stop();
  vi.useRealTimers();
});

describe('camera frames checked in parallel with extraction', () => {
  it('continues checking without a capture tool call and delivers the newest three accepted frames immediately', async () => {
    const { buffer, ports } = harness();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ports.gate.check).toHaveBeenCalledTimes(6);
    expect(await buffer.take()).toEqual(['image-4', 'image-5', 'image-6']);
    const next = buffer.take();
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toEqual(['image-7']);
  });

  it('keeps rejected frames out of the buffer and sends no duplicate JPEGs in a batch', async () => {
    const { buffer, ports } = harness();
    ports.gate.check.mockResolvedValueOnce({ ...accepted, accepted: false, documentLegible: 0.1 });
    ports.capture.mockResolvedValue('same-jpeg');
    await vi.advanceTimersByTimeAsync(800);
    expect(ports.checked).toHaveBeenCalledTimes(5);
    expect(await buffer.take()).toEqual(['same-jpeg']);
  });

  it('clears the previous side and discards an in-flight decision when a fresh side is requested', async () => {
    const { buffer, ports } = harness();
    await vi.advanceTimersByTimeAsync(0);
    let resolveDecision!: (decision: FrameDecision) => void;
    ports.gate.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const newSide = buffer.take(true);
    const delivered = vi.fn();
    void newSide.then(delivered);
    resolveDecision(accepted);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(201);
    expect(await newSide).toEqual(['image-22']);
  });

  it('clears buffered and in-flight frames after a recapture without a pause', async () => {
    const { buffer, ports } = harness();
    await vi.advanceTimersByTimeAsync(0);
    let resolveDecision!: (decision: FrameDecision) => void;
    ports.gate.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(200);
    const next = buffer.take(true, 0);
    const delivered = vi.fn();
    void next.then(delivered);
    resolveDecision(accepted);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toEqual(['image-3']);
  });

  it('cancels the four-second side-change pause without delivering frames', async () => {
    const { buffer, controller } = harness();
    const next = buffer.take(true);
    const rejection = expect(next).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await rejection;
    await buffer.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires accepted frames after ten seconds and never starts a second simultaneous gate call', async () => {
    const { buffer, ports } = harness();
    await vi.advanceTimersByTimeAsync(0);
    let resolveDecision!: (decision: FrameDecision) => void;
    ports.gate.check.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(10_201);
    expect(ports.gate.check).toHaveBeenCalledTimes(2);
    const next = buffer.take();
    const delivered = vi.fn();
    void next.then(delivered);
    resolveDecision(accepted); // The checked image is also too old to retain.
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await next).toEqual(['image-3']);
  });

  it('aborts pending checks and waiting captures, clears frames, and stops scheduling requests', async () => {
    const { buffer, ports, controller } = harness();
    const next = buffer.take();
    const rejection = expect(next).rejects.toThrow();
    controller.abort();
    await rejection;
    await buffer.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.gate.check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => buffer.take()).toThrow();
  });

  it('cancels a gate request already in flight without scheduling a replacement', async () => {
    const { buffer, ports, controller } = harness();
    ports.gate.check.mockImplementationOnce(
      (_image, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        }),
    );
    const next = buffer.take();
    const rejection = expect(next).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(ports.gate.check).toHaveBeenCalledOnce();
    controller.abort();
    await rejection;
    await buffer.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ports.gate.check).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('logs each failed check, preserves accepted frames and resumes screening with fresh captures', async () => {
    const { buffer, ports } = harness();
    await vi.advanceTimersByTimeAsync(0);
    ports.gate.check.mockRejectedValueOnce(new Error('mock failure'));
    ports.gate.check.mockRejectedValueOnce(new Error('mock failure'));
    await vi.advanceTimersByTimeAsync(200);
    expect(await buffer.take()).toEqual(['image-1']);
    const next = buffer.take();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ports.failed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await next).toEqual(['image-4']);
    expect(ports.gate.check).toHaveBeenCalledTimes(4);
  });

  it('cancels promptly during screening retry backoff', async () => {
    const { buffer, ports, controller } = harness();
    ports.gate.check.mockRejectedValueOnce(new Error('mock failure'));
    const next = buffer.take();
    const rejection = expect(next).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejection;
    await buffer.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(ports.gate.check).toHaveBeenCalledOnce();
  });

  it('pauses after new guidance or a successful read, not while waiting for a turn-over', () => {
    expect(capturePauseMs('Dale la vuelta al documento.', true)).toBe(4_000);
    expect(capturePauseMs(undefined, true)).toBe(4_000);
    expect(capturePauseMs('Acerca el documento.', false)).toBe(4_000);
    expect(capturePauseMs(undefined, false)).toBe(0);
    expect(capturePauseMs(undefined, undefined)).toBe(0);
  });
});
