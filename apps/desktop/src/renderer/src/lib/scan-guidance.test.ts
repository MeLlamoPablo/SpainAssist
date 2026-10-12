import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScanGuidancePresenter } from './scan-guidance';

afterEach(() => vi.useRealTimers());

describe('scan feedback visibility', () => {
  it.each([true, false])(
    'keeps success=%s feedback for three seconds before showing blue',
    async (success) => {
      vi.useFakeTimers();
      const show = vi.fn();
      const presentation = createScanGuidancePresenter(show);
      const feedback = { state: 'feedback', reason: 'Dale la vuelta.', success } as const;
      presentation.guidance(feedback);
      await vi.advanceTimersByTimeAsync(200);
      presentation.guidance({ state: 'reading' });
      await vi.advanceTimersByTimeAsync(2_799);
      expect(show.mock.calls).toEqual([[feedback]]);
      await vi.advanceTimersByTimeAsync(1);
      expect(show.mock.calls).toEqual([[feedback], [{ state: 'reading' }]]);
      presentation.cancel();
    },
  );

  it('restores the previous instruction and suppresses progress when reason is omitted', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const presentation = createScanGuidancePresenter(show);
    const green = { state: 'feedback', reason: 'Dale la vuelta.', success: true } as const;
    presentation.guidance(green);
    presentation.guidance({ state: 'reading' });
    presentation.retain();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(show).toHaveBeenLastCalledWith(green);
    presentation.guidance({ state: 'reading' });
    expect(show).toHaveBeenLastCalledWith(green);
    const red = { state: 'feedback', reason: 'Acerca el reverso.', success: false } as const;
    presentation.guidance(red);
    presentation.guidance({ state: 'reading' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(show).toHaveBeenLastCalledWith({ state: 'reading' });
    presentation.retain();
    expect(show).toHaveBeenLastCalledWith(red);
    presentation.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows each rapid feedback message for three seconds and keeps the latest progress state', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const presentation = createScanGuidancePresenter(show);
    const green = { state: 'feedback', reason: 'Dale la vuelta.', success: true } as const;
    const red = { state: 'feedback', reason: 'Enseña el reverso.', success: false } as const;
    presentation.guidance(green);
    presentation.guidance({ state: 'reading' });
    presentation.guidance(red);
    presentation.guidance({ state: 'legibility' });
    presentation.guidance({ state: 'reading' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(show.mock.calls).toEqual([[green], [red]]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(show).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(show).toHaveBeenLastCalledWith({ state: 'reading' });
    presentation.cancel();
  });

  it('does not replace feedback with completion before its minimum duration', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const done = vi.fn();
    const presentation = createScanGuidancePresenter(show);
    presentation.guidance({ state: 'feedback', reason: 'Dale la vuelta.', success: true });
    presentation.guidance({ state: 'reading' });
    presentation.complete(done);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    presentation.cancel();
  });

  it('clears pending updates and completion when the scan is cancelled', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const done = vi.fn();
    const presentation = createScanGuidancePresenter(show);
    presentation.guidance({ state: 'feedback', reason: 'Dale la vuelta.', success: true });
    presentation.guidance({ state: 'reading' });
    presentation.complete(done);
    presentation.cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(show).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not add a delay if feedback has already been visible for three seconds', async () => {
    vi.useFakeTimers();
    const show = vi.fn();
    const presentation = createScanGuidancePresenter(show);
    presentation.guidance({ state: 'feedback', reason: 'Dale la vuelta.', success: true });
    await vi.advanceTimersByTimeAsync(3_100);
    presentation.guidance({ state: 'reading' });
    expect(show).toHaveBeenLastCalledWith({ state: 'reading' });
    expect(vi.getTimerCount()).toBe(0);
    presentation.cancel();
  });
});
