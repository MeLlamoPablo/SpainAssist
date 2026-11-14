import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SaEvent } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { silentLogger } from '../core/logger';
import { newId } from '../core/util';
import { ConversationService, MAX_CONVERSATION_ITEMS } from './service';

let dir: string;
let events: SaEvent[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-conversation-'));
  events = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function open() {
  const bus = new EventBus();
  bus.on((e) => events.push(structuredClone(e)));
  return new ConversationService({
    dir,
    transcriptFile: join(dir, 'transcript.json'),
    events: bus,
    logger: silentLogger,
    ids: newId,
    clock: () => new Date('2026-10-03T10:00:00Z'),
    debounceMs: 5,
  });
}

describe('ConversationService', () => {
  it('persists the conversation and closes in-flight items on reload', async () => {
    const a = open();
    await a.init();
    a.upsertItem({ id: 'u1', createdAt: '2026-10-03T09:00:00Z', type: 'user', text: 'Hola' });
    a.upsertItem({
      id: 'm1',
      createdAt: '2026-10-03T09:00:01Z',
      type: 'assistant',
      text: 'Ho',
      status: 'streaming',
    });
    a.appendDelta('m1', 'la');
    a.addNotice('info', 'Guardado', 'p_1');
    // No question outlives a restart, not even a form or a phone call: the workflow that asked
    // resumes from its state and asks again.
    a.upsertItem({
      id: 'q1',
      createdAt: '2026-10-03T09:00:02Z',
      type: 'prompt',
      prompt: {
        kind: 'form',
        title: 'Tu nombre',
        fields: [{ key: 'name', label: 'Nombre', type: 'text', required: true }],
        allowDismiss: false,
      },
      status: 'pending',
    });
    a.upsertItem({
      id: 'q2',
      createdAt: '2026-10-03T09:00:03Z',
      type: 'prompt',
      prompt: {
        kind: 'phone_call',
        title: 'Llama a EMASESA',
        organization: 'EMASESA',
        phoneNumber: '+34 955 01 00 10',
        purpose: 'Dar de alta el agua.',
        questions: ['¿Qué documentos piden?'],
      },
      status: 'pending',
    });
    await a.flush();
    const raw = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8'));
    expect(raw).toHaveLength(5);
    expect(events.map((e) => e.type)).toEqual([
      'chat.item',
      'chat.item',
      'chat.delta',
      'chat.item',
      'chat.item',
      'chat.item',
    ]);

    const b = open();
    await b.init();
    expect(b.transcript()).toEqual([
      expect.objectContaining({ id: 'u1' }),
      expect.objectContaining({ id: 'm1', text: 'Hola', status: 'aborted' }),
      expect.objectContaining({ type: 'notice', procedureId: 'p_1' }),
      expect.objectContaining({ id: 'q1', status: 'cancelled' }),
      expect.objectContaining({ id: 'q2', status: 'cancelled' }),
    ]);
  });

  it('keeps only the latest items and reports its state once per change', async () => {
    const c = open();
    await c.init();
    for (let i = 0; i < MAX_CONVERSATION_ITEMS + 5; i++)
      c.upsertItem({ id: `u${i}`, createdAt: '2026-10-03T09:00:00Z', type: 'user', text: `${i}` });
    expect(c.transcript()).toHaveLength(MAX_CONVERSATION_ITEMS);
    expect(c.transcript()[0]?.id).toBe('u5');
    events.length = 0;
    c.setRunning(true);
    c.setRunning(true);
    c.setPendingPrompts(1);
    c.setPendingPrompts(0);
    c.setRunning(false);
    expect(events).toEqual([
      { type: 'chat.state', state: { activity: 'working' } },
      { type: 'chat.state', state: { activity: 'needs_user' } },
      { type: 'chat.state', state: { activity: 'working' } },
      { type: 'chat.state', state: { activity: 'idle' } },
    ]);
    await c.flush();
  });
});
