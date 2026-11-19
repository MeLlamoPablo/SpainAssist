import type { UserItem } from '@sa/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useAppStore } from '../../store/app';
import { useChatStore } from '../../store/chat';
import { toast } from '../../store/toast';
import { UserMessage } from './ChatItems';
import { rewindChat } from './rewind';

// Leaflet (the map of form prompts) needs a window at import time.
vi.mock('./prompts/LocationMap', () => ({ LocationMap: () => null }));

const invoke = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (original) => ({
  ...(await original<typeof import('../../lib/api')>()),
  api: { invoke, on: () => () => {} },
}));

const item: UserItem = {
  id: 'u_1',
  createdAt: '2026-11-20T10:00:00.000Z',
  type: 'user',
  text: 'Renueva mi DNI',
};

beforeEach(() => {
  invoke.mockReset();
  useAppStore.setState({ draft: null, composerFocusTick: 0 });
});

describe('UserMessage', () => {
  const render = (onRewind?: (id: string) => void) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <UserMessage item={item} onRewind={onRewind} />
      </TooltipProvider>,
    );

  it('offers the rewind only when the chat gives it one', () => {
    const html = render(() => {});
    expect(html).toContain('data-testid="chat-rewind"');
    expect(html).toContain('Rebobinar');
    // Hidden until the message is hovered (or the button focused).
    expect(html).toMatch(/opacity-0[^"]*group-hover:opacity-100/);
    expect(render()).not.toContain('chat-rewind');
  });
});

describe('rewindChat', () => {
  it('puts the message back in the composer, replacing its documents', async () => {
    invoke.mockResolvedValueOnce({ text: 'Renueva mi DNI' });
    await rewindChat('u_1');
    expect(invoke).toHaveBeenCalledWith('chat.rewind', 'u_1');
    expect(useAppStore.getState().draft).toEqual({
      text: 'Renueva mi DNI',
      attachments: [],
      tick: 1,
    });
    expect(useAppStore.getState().composerFocusTick).toBe(1);

    const attachments = [{ documentId: 'd_1', name: 'dni.png', mimeType: 'image/png' }];
    invoke.mockResolvedValueOnce({ text: '', attachments });
    await rewindChat('u_2');
    expect(useAppStore.getState().draft).toEqual({ text: '', attachments, tick: 2 });
  });

  it('shows why main refused', async () => {
    const error = vi.spyOn(toast, 'error').mockImplementation(() => {});
    invoke.mockRejectedValueOnce(new Error('Solo está disponible en las versiones de desarrollo.'));
    await rewindChat('u_1');
    expect(error).toHaveBeenCalledWith('Solo está disponible en las versiones de desarrollo.');
    expect(useAppStore.getState().draft).toBeNull();
  });
});

describe('chat.reset', () => {
  it('replaces the conversation, even one still loading', () => {
    const chat = useChatStore.getState();
    chat.setConversation({ status: 'loading', items: [item] });
    chat.replaceItems([]);
    expect(useChatStore.getState().conversation).toEqual({ status: 'loaded', items: [] });
  });
});
