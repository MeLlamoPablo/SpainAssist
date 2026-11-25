import type { AssistantItem } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STALL_MS, useChatStore } from './chat';

function assistantMessage(text: string, status: AssistantItem['status']): AssistantItem {
  return { id: 'm_1', createdAt: '2026-11-25T20:37:50.592Z', type: 'assistant', text, status };
}

const isStalled = () => useChatStore.getState().stalled.has('m_1');

describe('stalled streaming messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({ conversation: { status: 'loaded', items: [] }, stalled: new Set() });
  });
  afterEach(() => vi.useRealTimers());

  it('stalls a message whose text stopped arriving while its stream stays open', () => {
    useChatStore.getState().applyItem(assistantMessage('En ello,', 'streaming'));
    useChatStore.getState().applyDelta('m_1', ' te lo saco.');
    vi.advanceTimersByTime(STALL_MS - 1);
    expect(isStalled(), 'the text arrived just now').toBe(false);

    vi.advanceTimersByTime(1);
    expect(isStalled(), 'no text for STALL_MS').toBe(true);
  });

  it('un-stalls a message when more text arrives', () => {
    useChatStore.getState().applyItem(assistantMessage('En ello,', 'streaming'));
    vi.advanceTimersByTime(STALL_MS);

    useChatStore.getState().applyDelta('m_1', ' te lo saco.');
    expect(isStalled()).toBe(false);
  });

  it('never stalls a finished message', () => {
    useChatStore.getState().applyItem(assistantMessage('En ello,', 'streaming'));
    useChatStore.getState().applyItem(assistantMessage('En ello, te lo saco.', 'complete'));
    vi.advanceTimersByTime(STALL_MS);
    expect(isStalled()).toBe(false);
  });
});
