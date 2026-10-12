import type { ChatItem, ConversationState } from '@sa/shared';
import { create } from 'zustand';

export interface Transcript {
  status: 'loading' | 'loaded' | 'error';
  items: ChatItem[];
}

const EMPTY: Transcript = { status: 'loading', items: [] };

interface ChatState {
  /** The one conversation with the assistant. */
  conversation: Transcript;
  state: ConversationState;

  setConversation: (transcript: Transcript) => void;
  setState: (state: ConversationState) => void;
  applyItem: (item: ChatItem) => void;
  applyDelta: (itemId: string, delta: string) => void;
}

/** Upsert by id, keeping the original position of existing items. */
export function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const index = items.findIndex((i) => i.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

/** Append streamed text to an assistant item. Unknown items are ignored (the next load has it). */
export function appendDelta(items: ChatItem[], itemId: string, delta: string): ChatItem[] {
  const index = items.findIndex((i) => i.id === itemId);
  if (index === -1) return items;
  const item = items[index]!;
  if (item.type !== 'assistant') return items;
  const next = items.slice();
  next[index] = { ...item, text: item.text + delta };
  return next;
}

/**
 * Merge a freshly loaded transcript with items pushed while it was loading: the loaded list is
 * the base; pushed items replace their loaded twin or are appended.
 */
export function mergeLoaded(loaded: ChatItem[], pushed: ChatItem[]): ChatItem[] {
  let items = loaded;
  for (const item of pushed) items = upsertItem(items, item);
  return items;
}

/** Loaded transcripts keep items pushed while they were loading. */
function settle(prev: Transcript | undefined, next: Transcript): Transcript {
  if (next.status !== 'loaded') return { status: next.status, items: prev?.items ?? next.items };
  const pushed = prev?.status === 'loading' ? prev.items : [];
  return { status: 'loaded', items: mergeLoaded(next.items, pushed) };
}

export const useChatStore = create<ChatState>()((set) => ({
  conversation: EMPTY,
  state: { activity: 'idle' },

  setConversation: (transcript) =>
    set((s) => ({ conversation: settle(s.conversation, transcript) })),
  setState: (state) => set({ state }),
  applyItem: (item) =>
    set((s) => ({
      conversation: { ...s.conversation, items: upsertItem(s.conversation.items, item) },
    })),
  applyDelta: (itemId, delta) =>
    set((s) => {
      const items = appendDelta(s.conversation.items, itemId, delta);
      return items === s.conversation.items ? s : { conversation: { ...s.conversation, items } };
    }),
}));
