import type { PromptImage } from '@sa/agent';
import {
  ASSISTANT_AGENT_ID,
  type Attachment,
  type ChatItem,
  type ConversationState,
  type Language,
  type PromptResponse,
  type SendMessageInput,
} from '@sa/shared';
import type { AgentManager } from '../agents/manager';
import type { ConversationService } from '../conversation/service';
import { friendlyAgentError, NoProviderError, UserError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage } from '../core/util';
import type { VaultPort } from '../ports';
import type { PromptManager } from './prompts';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 4;

export interface ChatServiceDeps {
  conversation: ConversationService;
  agents: AgentManager;
  prompts: PromptManager;
  vault: () => VaultPort;
  logger: Logger;
  clock: Clock;
  lang: () => Language;
}

/**
 * `chat.*`: the user's messages go to the assistant (started on demand); errors become notices.
 * Answers to prompts go to whichever agent asked.
 */
export class ChatService {
  private readonly deliveries = new Set<Promise<void>>();

  constructor(private readonly deps: ChatServiceDeps) {}

  transcript(): ChatItem[] {
    return structuredClone(this.deps.conversation.transcript());
  }

  state(): ConversationState {
    return this.deps.conversation.state();
  }

  /**
   * Appends the user's message and hands it to the assistant in the background (starting it
   * takes a moment; progress and errors arrive as chat events). The assistant's own pending
   * questions are dropped: the user answered with a message instead. Questions from procedure
   * agents stay.
   */
  async send(input: SendMessageInput): Promise<void> {
    const { conversation } = this.deps;
    const text = input.text.trim();
    const attachments = this.resolveAttachments(input.attachments ?? []);
    if (!text && attachments.length === 0)
      throw new UserError(t(this.deps.lang(), 'emptyMessage'), 'bad_request');
    this.deps.prompts.cancelAll(ASSISTANT_AGENT_ID);
    conversation.upsertItem({
      id: conversation.newItemId('u'),
      createdAt: this.deps.clock().toISOString(),
      type: 'user',
      text,
      ...(attachments.length ? { attachments } : {}),
    });
    conversation.setError(undefined);
    // Show "working" right away: starting the assistant takes a moment.
    conversation.setRunning(true);
    const delivery = this.deliver(text, attachments).finally(() =>
      this.deliveries.delete(delivery),
    );
    this.deliveries.add(delivery);
  }

  /** Waits for background deliveries (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries]);
  }

  private resolveAttachments(input: Attachment[]): Attachment[] {
    const vault = this.deps.vault();
    const out: Attachment[] = [];
    for (const a of input) {
      const doc = vault.getDocument(a.documentId);
      if (doc) out.push({ documentId: doc.id, name: doc.name, mimeType: doc.mimeType });
    }
    return out;
  }

  private async deliver(text: string, attachments: Attachment[]): Promise<void> {
    const { conversation } = this.deps;
    try {
      const { promptText, images } = await this.buildPrompt(text, attachments);
      await this.deps.agents.send(
        ASSISTANT_AGENT_ID,
        promptText,
        images.length ? images : undefined,
      );
    } catch (err) {
      const lang = this.deps.lang();
      const message =
        err instanceof NoProviderError
          ? t(lang, 'agentErrorNoProvider')
          : friendlyAgentError(errorMessage(err), lang);
      this.deps.logger.warn('message delivery failed', { error: errorMessage(err) });
      conversation.setRunning(false);
      conversation.addNotice('error', message);
      conversation.setError(message);
    }
  }

  private async buildPrompt(
    text: string,
    attachments: Attachment[],
  ): Promise<{ promptText: string; images: PromptImage[] }> {
    if (attachments.length === 0) return { promptText: text, images: [] };
    const vault = this.deps.vault();
    const images: PromptImage[] = [];
    const lines: string[] = [];
    for (const a of attachments) {
      const doc = vault.getDocument(a.documentId);
      if (!doc) continue;
      lines.push(`- ${doc.name} (${doc.mimeType}, documentId: ${doc.id})`);
      if (
        IMAGE_TYPES.has(doc.mimeType) &&
        doc.size <= MAX_IMAGE_BYTES &&
        images.length < MAX_IMAGES
      ) {
        const bytes = await vault.readDocument(doc.id);
        images.push({ mimeType: doc.mimeType, dataBase64: Buffer.from(bytes).toString('base64') });
      }
    }
    const header = '[Documents attached by the user (stored in their data)]';
    return {
      promptText: `${text || '(no text)'}\n\n${header}\n${lines.join('\n')}`,
      images,
    };
  }

  /** Stops the assistant's reply. Procedure agents keep working. */
  async abort(): Promise<void> {
    await this.deps.agents.abort(ASSISTANT_AGENT_ID);
  }

  respond(promptItemId: string, response: PromptResponse): void | Promise<void> {
    return this.deps.prompts.respond(promptItemId, response);
  }
}
