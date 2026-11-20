import { readFile, writeFile } from 'node:fs/promises';
import { ASSISTANT_AGENT_ID, type ChatItem, type UserItem } from '@sa/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_VERSION } from '../app/paths';
import { ATTACHMENTS_HEADER } from '../chat/service';
import { t } from '../core/i18n';
import { createTestApp, type TestApp } from '../testing/harness';
import { cutSession } from './rewind';

type Line = Record<string, unknown>;

/** A pi session file: a header, then entries chained by parentId unless an entry names its own. */
function session(...entries: Line[]): string {
  let parent: string | null = null;
  const lines: Line[] = [{ type: 'session', version: 3, id: 's1', timestamp: 'x', cwd: '/w' }];
  entries.forEach((entry, i) => {
    const id = (entry.id as string | undefined) ?? `e${i}`;
    const parentId = 'parentId' in entry ? (entry.parentId as string | null) : parent;
    lines.push({ timestamp: 'x', ...entry, id, parentId });
    parent = id;
  });
  return lines.map((l) => `${JSON.stringify(l)}\n`).join('');
}

const user = (text: string, extra: Line = {}): Line => ({
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra,
});
const reply = (text: string, extra: Line = {}): Line => ({
  type: 'message',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  ...extra,
});
const setup: Line[] = [
  { type: 'model_change', provider: 'p', modelId: 'm' },
  { type: 'message', message: { role: 'system', content: 'You are…' } },
];
const said = (text: string, attachments?: UserItem['attachments']) =>
  ({ text, ...(attachments ? { attachments } : {}) }) as Pick<UserItem, 'text' | 'attachments'>;

/** The text of each message left in a cut session. */
function texts(content: string): string[] {
  return content
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; message?: { content: unknown } })
    .flatMap((e) => {
      if (e.type === 'session') return ['<header>'];
      const c = e.message?.content;
      if (typeof c === 'string') return [c];
      if (Array.isArray(c)) return [(c[0] as { text: string }).text];
      return [`<${e.type}>`];
    });
}

describe('cutSession', () => {
  it('keeps what came before the message, as the coordinator read it', () => {
    const content = session(
      ...setup,
      user('[Procedures: none yet]\n\nHola'),
      reply('¡Hola!'),
      user('[Report from agent a_1 "DNI"]\nDone.'),
      reply('Tu agente terminó.'),
      user(
        '[Procedures (as the user sees them; procedure_read for fresh ones)]\n- p_1 v2 "DNI" · active\n\n[Interrupted runs (…): run_1]\n\nRenueva mi DNI',
      ),
      reply('Vale.'),
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } },
    );
    const cut = cutSession(content, [said('Renueva mi DNI')]);
    expect(texts(cut!.content)).toEqual([
      '<header>',
      '<model_change>',
      'You are…',
      '[Procedures: none yet]\n\nHola',
      '¡Hola!',
      '[Report from agent a_1 "DNI"]\nDone.',
      'Tu agente terminó.',
    ]);
    expect(cut!.removed).toBe(3);
  });

  it('cuts at the first message down to the setup entries', () => {
    const content = session(...setup, user('[Procedures: none yet]\n\nHola'), reply('¡Hola!'));
    expect(texts(cutSession(content, [said('Hola')])!.content)).toEqual([
      '<header>',
      '<model_change>',
      'You are…',
    ]);
  });

  it('finds a message with documents by its text and the list that follows', () => {
    const attachments = [{ documentId: 'd_1', name: 'dni.png', mimeType: 'image/png' }];
    const content = session(
      user('Hola'),
      reply('¡Hola!'),
      user(`Aquí está\n\n${ATTACHMENTS_HEADER}\n- dni.png (image/png, documentId: d_1)`),
      reply('Gracias.'),
      user(`(no text)\n\n${ATTACHMENTS_HEADER}\n- dni.png (image/png, documentId: d_1)`),
    );
    expect(texts(cutSession(content, [said('Aquí está', attachments)])!.content)).toEqual([
      '<header>',
      'Hola',
      '¡Hola!',
    ]);
    expect(texts(cutSession(content, [said('', attachments)])!.content)).toHaveLength(5);
    // The same words without documents are another message.
    expect(cutSession(content, [said('Aquí está')])).toBeNull();
  });

  it('tells repeated messages apart by the later ones', () => {
    const content = session(user('Sí'), reply('1'), user('No'), reply('2'), user('Sí'), reply('3'));
    // The chat's first "Sí" (a later one follows), then the second.
    expect(texts(cutSession(content, [said('Sí'), said('No'), said('Sí')])!.content)).toEqual([
      '<header>',
    ]);
    expect(texts(cutSession(content, [said('Sí')])!.content)).toEqual([
      '<header>',
      'Sí',
      '1',
      'No',
      '2',
    ]);
  });

  it('follows the branch of the last line and drops abandoned ones', () => {
    const content = session(
      user('A', { id: 'a' }),
      reply('old', { id: 'old' }),
      reply('new', { id: 'new', parentId: 'a' }),
      user('B', { id: 'b' }),
      reply('ok'),
    );
    expect(texts(cutSession(content, [said('B')])!.content)).toEqual(['<header>', 'A', 'new']);
  });

  it('drops a compaction after the cut and keeps the entries it summarized', () => {
    const content = session(
      user('A', { id: 'a' }),
      reply('1'),
      user('B'),
      reply('2'),
      { type: 'compaction', summary: 'A and B', firstKeptEntryId: 'a', tokensBefore: 9 },
      user('C'),
      reply('3'),
    );
    expect(texts(cutSession(content, [said('B')])!.content)).toEqual(['<header>', 'A', '1']);
    expect(texts(cutSession(content, [said('C')])!.content)).toEqual([
      '<header>',
      'A',
      '1',
      'B',
      '2',
      '<compaction>',
    ]);
  });

  it('cuts at the next message the model got when this one never reached it', () => {
    const content = session(user('A'), reply('1'), user('C'), reply('3'));
    expect(texts(cutSession(content, [said('B'), said('C')])!.content)).toEqual([
      '<header>',
      'A',
      '1',
    ]);
    expect(cutSession(content, [said('B')])).toBeNull();
    expect(cutSession('', [said('A')])).toBeNull();
  });

  it('reads plain string contents and skips malformed lines', () => {
    const content = `${session(user('A'))}not json\n${JSON.stringify({ type: 'message', id: 'x', parentId: 'e0', message: { role: 'user', content: 'B' } })}\n`;
    expect(texts(cutSession(content, [said('B')])!.content)).toEqual(['<header>', 'A']);
  });
});

describe('chat.rewind', () => {
  let app: TestApp;
  afterEach(async () => {
    await app?.close();
  });

  async function withProvider(isDev = true) {
    app = await createTestApp({ isDev });
    const res = await app.invoke('providers.setCustom', {
      baseUrl: 'http://127.0.0.1:8789/v1',
      api: 'openai-completions',
      model: 'mock-model',
    });
    expect(res.ok).toBe(true);
  }

  const sessionFile = () => `${app.paths.assistantDir}/session-v${CHAT_VERSION}.jsonl`;
  const userItems = () =>
    app.services.conversation.transcript().filter((i): i is UserItem => i.type === 'user');

  it('stops the coordinator and cuts the chat and its session before the message', async () => {
    await withProvider();
    const first = await app.say('Hola');
    app.services.conversation.upsertItem({
      id: 'a_1',
      createdAt: new Date().toISOString(),
      type: 'assistant',
      text: '¡Hola!',
      status: 'complete',
    });
    await app.say('Renueva mi DNI');
    const [hello, renew] = first.client.prompts.map((p) => p.text);
    // pi's file, as the coordinator's process wrote it.
    await writeFile(
      sessionFile(),
      session(...setup, user(hello!), reply('¡Hola!'), user(renew!), reply('Vale, ')),
    );
    // A turn in progress.
    first.client.emit({ type: 'run_start' });

    const target = userItems()[1]!;
    expect(await app.invoke('chat.rewind', target.id)).toEqual({ text: 'Renueva mi DNI' });

    expect(first.client.aborts).toBe(1);
    expect(first.client.stopped).toBe(true);
    expect(texts(await readFile(sessionFile(), 'utf8'))).toEqual([
      '<header>',
      '<model_change>',
      'You are…',
      hello,
      '¡Hola!',
    ]);
    const kept = app.services.conversation.transcript().map((i) => i.id);
    expect(kept).toEqual([userItems()[0]!.id, 'a_1']);
    expect(await app.invoke('chat.state')).toEqual({ activity: 'idle' });
    const reset = app.events.findLast((e) => e.type === 'chat.reset');
    expect(reset).toEqual({ type: 'chat.reset', items: app.services.conversation.transcript() });
    await app.services.conversation.flush();
    const saved = JSON.parse(
      await readFile(`${app.paths.assistantDir}/transcript.json`, 'utf8'),
    ) as ChatItem[];
    expect(saved.map((i) => i.id)).toEqual(kept);

    // The next message starts a new process, and the procedures are sent again: they were in
    // what was cut.
    const next = await app.say('Renueva mi pasaporte');
    expect(next.client).not.toBe(first.client);
    expect(next.client.prompts[0]?.text).toBe('[Procedures: none yet]\n\nRenueva mi pasaporte');
  });

  it('gives back the documents of the message', async () => {
    await withProvider();
    const doc = await app.invoke('vault.addDocument', {
      name: 'dni.png',
      mimeType: 'image/png',
      bytes: new Uint8Array([137, 80, 78, 71]),
    });
    await app.invoke('chat.send', {
      text: 'Mi DNI',
      attachments: [{ documentId: doc.id, name: 'x', mimeType: 'x' }],
    });
    await app.services.chat.settled();
    expect(await app.invoke('chat.rewind', userItems()[0]!.id)).toEqual({
      text: 'Mi DNI',
      attachments: [{ documentId: doc.id, name: 'dni.png', mimeType: 'image/png' }],
    });
    expect(app.services.conversation.transcript()).toEqual([]);
    // No session file yet: nothing to cut, nothing created.
    await expect(readFile(sessionFile(), 'utf8')).rejects.toThrow();
  });

  it('only rewinds to the user messages of the chat', async () => {
    await withProvider();
    await app.say('Hola');
    const notice = app.services.conversation.addNotice('info', 'Aviso');
    await expect(app.invoke('chat.rewind', notice.id)).rejects.toThrow(
      t('es', 'rewindNotUserMessage'),
    );
    await expect(app.invoke('chat.rewind', 'u_missing')).rejects.toThrow(
      t('es', 'rewindNotUserMessage'),
    );
    expect(app.agentFor(ASSISTANT_AGENT_ID)!.client.stopped).toBe(false);
  });

  it('is refused by packaged builds', async () => {
    await withProvider(false);
    await app.say('Hola');
    await expect(app.invoke('chat.rewind', userItems()[0]!.id)).rejects.toThrow(t('es', 'devOnly'));
    expect(userItems()).toHaveLength(1);
    expect(app.agentFor(ASSISTANT_AGENT_ID)!.client.stopped).toBe(false);
  });
});
