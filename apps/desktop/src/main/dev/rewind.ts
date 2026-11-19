import { readFile } from 'node:fs/promises';
import { ASSISTANT_AGENT_ID, type Language, type RewoundMessage, type UserItem } from '@sa/shared';
import type { AgentManager } from '../agents/manager';
import { ATTACHMENTS_HEADER, type ChatService, NO_TEXT } from '../chat/service';
import { INTERRUPTED_NOTE, PROCEDURES_PREFACE } from '../codemode/coordinator';
import type { ConversationService } from '../conversation/service';
import { UserError } from '../core/errors';
import { writeFileAtomic } from '../core/fs';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';

/**
 * Development builds only: "Rewind" on one of the user's messages in the coordinator's chat.
 * Stops the coordinator and cuts its chat back to just before that message, in what the user
 * sees (transcript.json) and in what the model reads (its pi session), so that the next message
 * starts from there. Chat state only: procedures, documents, background agents and their
 * workflows stay as they are.
 */
export interface ChatRewindDeps {
  conversation: ConversationService;
  agents: Pick<AgentManager, 'abort' | 'stop' | 'exclusive'>;
  chat: Pick<ChatService, 'dropDeliveries'>;
  coordinator: { forgetProcedures(agentId: string): void };
  /** The coordinator's pi session (`assistantPaths(…).sessionFile(CHAT_VERSION)`). */
  sessionFile: string;
  logger: Logger;
  lang(): Language;
}

export function createChatRewind(deps: ChatRewindDeps) {
  return async (itemId: string): Promise<RewoundMessage> => {
    const { conversation, agents } = deps;
    const items = conversation.transcript();
    const index = items.findIndex((i) => i.id === itemId);
    const target = items[index];
    if (target?.type !== 'user')
      throw new UserError(t(deps.lang(), 'rewindNotUserMessage'), 'not_found');
    const users = items.slice(index).filter((i): i is UserItem => i.type === 'user');

    // A message still reading its attachments must not reach the model after the cut.
    deps.chat.dropDeliveries();
    await agents.abort(ASSISTANT_AGENT_ID);
    await agents.exclusive(ASSISTANT_AGENT_ID, async () => {
      // pi keeps the session in memory and appends to it: the process must be gone before the
      // file changes (the next message starts a new one, which reads the shorter file).
      await agents.stop(ASSISTANT_AGENT_ID);
      const removed = await cutSessionFile(deps.sessionFile, users);
      deps.logger.info('chat rewound', { removedSessionEntries: removed });
      // After the stop: its last events (the reply marked aborted) must not land after the cut.
      await conversation.truncateFrom(itemId);
      // The procedures the coordinator was sent may have been in what was cut.
      deps.coordinator.forgetProcedures(ASSISTANT_AGENT_ID);
    });
    return {
      text: target.text,
      ...(target.attachments?.length ? { attachments: target.attachments } : {}),
    };
  };
}

/** Rewrites the session file without the message of `users[0]` and what follows. */
async function cutSessionFile(file: string, users: UserItem[]): Promise<number> {
  let content: string;
  try {
    content = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  const cut = cutSession(content, users);
  if (!cut) return 0;
  await writeFileAtomic(file, cut.content);
  return cut.removed;
}

interface Entry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown };
}

/**
 * Cuts a pi session (JSONL: a header, then entries linked by `parentId` into a tree whose last
 * line is the current leaf) just before the user's message `users[0]`. `users` are that message
 * and the user's later ones in the chat, oldest first.
 *
 * The new file is the header plus the path from the root to the entry before the message, so
 * that the cut message, what followed it and abandoned branches are all gone (pi takes the last
 * line as the leaf). Compaction stays right: a compaction after the cut goes with it, and the
 * entries it summarized are still on the path.
 *
 * The message is found by its text, as the coordinator read it (after the blocks main puts
 * before it, with its attachments' list): `users` disambiguates repeated texts, counting from
 * the end. A message that never reached the model (its delivery failed) cuts at the next one
 * that did. Returns null when none of them is in the session (nothing to cut).
 */
export function cutSession(
  content: string,
  users: Pick<UserItem, 'text' | 'attachments'>[],
): { content: string; removed: number } | null {
  const lines = content.split('\n').filter((line) => line.trim());
  const entries: Entry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as Entry);
    } catch {
      // pi skips malformed lines too.
    }
  }
  const header = entries.find((e) => e.type === 'session');
  const path = leafPath(entries.filter((e) => e.type !== 'session'));
  const sent = path.flatMap((entry, at) =>
    entry.type === 'message' && entry.message?.role === 'user'
      ? [{ at, text: stripDecoration(messageText(entry.message.content)) }]
      : [],
  );
  for (let i = 0; i < users.length; i++) {
    const user = users[i]!;
    const repeats = users.slice(i + 1).filter((u) => sameMessage(u, user)).length;
    const match = sent.filter((m) => readAs(m.text, user)).at(-(repeats + 1));
    if (!match) continue;
    const kept = [...(header ? [header] : []), ...path.slice(0, match.at)];
    return {
      content: kept.map((e) => `${JSON.stringify(e)}\n`).join(''),
      removed: entries.length - kept.length,
    };
  }
  return null;
}

/** The entries from the root to the leaf (the last entry), in that order. */
function leafPath(entries: Entry[]): Entry[] {
  const byId = new Map(entries.flatMap((e) => (e.id ? [[e.id, e] as const] : [])));
  const path: Entry[] = [];
  const seen = new Set<string>();
  let current = entries.at(-1);
  while (current?.id && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path.reverse();
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part: { type?: string; text?: unknown }) =>
      part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('\n');
}

/** Drops the blocks main puts before the user's words (`decorateUserMessage`). */
function stripDecoration(text: string): string {
  let rest = text;
  while (rest.startsWith(PROCEDURES_PREFACE) || rest.startsWith(INTERRUPTED_NOTE)) {
    const end = rest.indexOf('\n\n');
    if (end < 0) break;
    rest = rest.slice(end + 2);
  }
  return rest;
}

/** Whether the model read `text` for this chat message (`ChatService.buildPrompt`). */
function readAs(text: string, user: Pick<UserItem, 'text' | 'attachments'>): boolean {
  if (!user.attachments?.length) return text === user.text;
  return text.startsWith(`${user.text || NO_TEXT}\n\n${ATTACHMENTS_HEADER}\n`);
}

function sameMessage(
  a: Pick<UserItem, 'text' | 'attachments'>,
  b: Pick<UserItem, 'text' | 'attachments'>,
): boolean {
  return a.text === b.text && Boolean(a.attachments?.length) === Boolean(b.attachments?.length);
}
