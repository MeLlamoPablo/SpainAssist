import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameCheckError, type FrameDecision } from './decider';
import { ScanScreening } from './screening';

const accepted: FrameDecision = {
  accepted: true,
  documentPresent: 0.99,
  documentLegible: 0.99,
  model: 'mock',
  usage: { input_tokens: 1, output_tokens: 0 },
  startedAt: 0,
  completedAt: 1,
};
function harness() {
  vi.useFakeTimers();
  const gate = { check: vi.fn(async (_image: string, _signal: AbortSignal) => accepted) };
  const failed = vi.fn();
  const bypass = vi.fn();
  const controller = new AbortController();
  const screening = new ScanScreening(gate, failed, bypass);
  return { screening, gate, failed, bypass, controller };
}
afterEach(() => vi.useRealTimers());

describe('three-second screening fallback', () => {
  it('retries failures for three seconds then bypasses all subsequent frames in this scan', async () => {
    const { screening, gate, failed, bypass, controller } = harness();
    gate.check.mockRejectedValue(new Error('provider failure'));
    const pending = screening.check('frame', controller.signal);
    const delivered = vi.fn();
    void pending.then(delivered);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(delivered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeUndefined();
    expect(bypass).toHaveBeenCalledOnce();
    expect(await screening.check('next frame', controller.signal)).toBeUndefined();
    expect(gate.check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['budget', 'missing_key', 'unauthorized'] as const)(
    'bypasses at once when retrying cannot help (%s)',
    async (category) => {
      const { screening, gate, failed, bypass, controller } = harness();
      gate.check.mockRejectedValue(new FrameCheckError(category, 422));
      expect(await screening.check('frame', controller.signal)).toBeUndefined();
      expect(failed).toHaveBeenCalledOnce();
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ category }), 1);
      expect(bypass).toHaveBeenCalledOnce();
      expect(await screening.check('next frame', controller.signal)).toBeUndefined();
      expect(gate.check).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('caps an unresponsive check at three seconds and ignores late results', async () => {
    const { screening, gate, failed, bypass, controller } = harness();
    let resolve!: (result: FrameDecision) => void;
    gate.check.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = screening.check('frame', controller.signal);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBeUndefined();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ category: 'timeout' }), 1);
    expect(bypass).toHaveBeenCalledOnce();
    expect(gate.check.mock.calls[0]![1].aborted).toBe(true);
    resolve(accepted);
    await vi.advanceTimersByTimeAsync(0);
    expect(await screening.check('next', controller.signal)).toBeUndefined();
  });

  it('recovers within the budget and retains screening, including valid rejections', async () => {
    const { screening, gate, bypass, controller } = harness();
    gate.check.mockRejectedValueOnce(new Error('provider failure'));
    gate.check.mockResolvedValueOnce({ ...accepted, accepted: false, documentLegible: 0.1 });
    const pending = screening.check('frame', controller.signal);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ accepted: false });
    expect(await screening.check('next', controller.signal)).toEqual(accepted);
    expect(bypass).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])(
    'cancels during a pending request or retry wait (retry=%s)',
    async (retry) => {
      const { screening, gate, bypass, controller } = harness();
      if (retry) gate.check.mockRejectedValue(new Error('failure'));
      else gate.check.mockImplementation(() => new Promise(() => {}));
      const pending = screening.check('frame', controller.signal);
      const rejection = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await rejection;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(bypass).not.toHaveBeenCalled();
      expect(gate.check).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
