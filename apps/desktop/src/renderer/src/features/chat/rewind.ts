import { api, errorMessage } from '../../lib/api';
import { useAppStore } from '../../store/app';
import { toast } from '../../store/toast';

/**
 * Development builds only: cuts the chat back to before one of the user's messages (main stops
 * the assistant and pushes the shorter transcript as `chat.reset`) and puts that message, with
 * its documents, back in the composer to edit and send again.
 */
export async function rewindChat(userItemId: string): Promise<void> {
  try {
    const message = await api.invoke('chat.rewind', userItemId);
    useAppStore.getState().focusComposer(message.text, message.attachments ?? []);
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

/** What the chat's user messages get: the rewind only in development builds. */
export const rewindHandler: ((userItemId: string) => void) | undefined = import.meta.env.DEV
  ? (userItemId) => void rewindChat(userItemId)
  : undefined;
