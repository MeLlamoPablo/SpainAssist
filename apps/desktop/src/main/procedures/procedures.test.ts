import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatItem, SaEvent } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from '../core/events';
import { silentLogger } from '../core/logger';
import { newId } from '../core/util';
import { ProcedureService } from './service';
import { ProcedureStore } from './store';

let dir: string;
let events: EventBus;
let seen: SaEvent[];

function makeService(root = dir, clock = () => new Date()) {
  const store = new ProcedureStore(root, silentLogger, 20);
  return {
    store,
    service: new ProcedureService({
      store,
      events,
      logger: silentLogger,
      ids: newId,
      clock,
      lang: () => 'es',
    }),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-proc-'));
  events = new EventBus();
  seen = [];
  events.on((e) => seen.push(structuredClone(e)));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ProcedureService', () => {
  it('creates private procedure directories and emits upserts', async () => {
    const { service, store } = makeService();
    const p = await service.create('Renovar el DNI');
    const paths = store.paths(p.id);
    expect(existsSync(paths.procedureFile)).toBe(true);
    expect(existsSync(paths.workDir)).toBe(true);
    expect(existsSync(paths.mediaDir)).toBe(true);
    if (process.platform !== 'win32') expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
    expect(seen.at(-1)).toMatchObject({
      type: 'procedure.upserted',
      procedure: {
        id: p.id,
        title: 'Renovar el DNI',
        status: 'researching',
        runtime: { activity: 'idle' },
      },
    });
  });

  it('applies agent updates: arrays replace, nextAction null clears', async () => {
    const { service } = makeService();
    const p = await service.create('x');
    service.applyUpdate(p.id, {
      title: 'Renovación del DNI',
      steps: [{ id: 'a', title: 'Pedir cita', status: 'current' }],
      sources: [
        { title: 'Policía', url: 'https://www.policia.es/dni' },
        { title: 'Blog', url: 'https://citas-dni-facil.com/' },
      ],
      nextAction: { text: 'Pide cita', owner: 'user' },
    });
    const updated = service.applyUpdate(p.id, {
      steps: [{ id: 'b', title: 'Ir a la comisaría', status: 'pending' }],
      nextAction: null,
    });
    expect(updated.title).toBe('Renovación del DNI');
    expect(updated.steps.map((s) => s.id)).toEqual(['b']);
    expect(updated.nextAction).toBeUndefined();
    expect(updated.sources.map((s) => s.title)).toEqual(['Policía', 'Blog']);
  });

  it('computes runtime activity and unread', async () => {
    const { service } = makeService();
    const p = await service.create('x');
    service.setRunning(p.id, true);
    expect(service.get(p.id)?.runtime.activity).toBe('working');
    const question = {
      id: 'q_1',
      createdAt: new Date(0).toISOString(),
      type: 'prompt' as const,
      procedureId: p.id,
      prompt: {
        kind: 'confirm' as const,
        confirmKind: 'action' as const,
        title: 't',
        message: 'm',
      },
      status: 'pending' as const,
    };
    service.setPrompts(p.id, [question]);
    expect(service.get(p.id)?.runtime).toMatchObject({
      activity: 'needs_user',
      prompts: [{ id: 'q_1' }],
    });
    service.setPrompts(p.id, []);
    service.setRunning(p.id, false);
    service.setUnread(p.id);
    service.setError(p.id, 'boom');
    expect(service.get(p.id)?.runtime).toEqual({ activity: 'idle', unread: true, error: 'boom' });
    service.markRead(p.id);
    expect(service.get(p.id)?.runtime.unread).toBe(false);
  });

  it('records when the agent started working, not counting time waiting on the user', async () => {
    let time = Date.parse('2026-01-01T10:00:00Z');
    const { service } = makeService(dir, () => new Date(time));
    const p = await service.create('x');
    service.setRunning(p.id, true);
    expect(service.get(p.id)?.runtime.workingSince).toBe('2026-01-01T10:00:00.000Z');
    time += 60_000;
    service.setRunning(p.id, true);
    expect(service.get(p.id)?.runtime.workingSince).toBe('2026-01-01T10:00:00.000Z');
    const question = {
      id: 'q_1',
      createdAt: new Date(0).toISOString(),
      type: 'prompt' as const,
      procedureId: p.id,
      prompt: {
        kind: 'confirm' as const,
        confirmKind: 'action' as const,
        title: 't',
        message: 'm',
      },
      status: 'pending' as const,
    };
    service.setPrompts(p.id, [question]);
    expect(service.get(p.id)?.runtime.workingSince).toBeUndefined();
    time += 60_000;
    service.setPrompts(p.id, []);
    expect(service.get(p.id)?.runtime.workingSince).toBe('2026-01-01T10:02:00.000Z');
    service.setRunning(p.id, false);
    expect(service.get(p.id)?.runtime.workingSince).toBeUndefined();
  });

  it('persists transcripts (debounced) and closes stale in-flight items on reload', async () => {
    const { service, store } = makeService();
    const p = await service.create('x');
    const items: ChatItem[] = [
      { id: 'u1', createdAt: '2026-01-01T00:00:00Z', type: 'user', text: 'Hola' },
      {
        id: 'm1',
        createdAt: '2026-01-01T00:00:01Z',
        type: 'assistant',
        text: 'Hol',
        status: 'streaming',
      },
      {
        id: 'q1',
        createdAt: '2026-01-01T00:00:02Z',
        type: 'prompt',
        status: 'pending',
        prompt: { kind: 'confirm', confirmKind: 'action', title: 't', message: 'm' },
      },
    ];
    for (const item of items) service.upsertItem(p.id, item);
    service.appendDelta(p.id, 'm1', 'a');
    expect(seen.filter((e) => e.type === 'procedure.log').at(-1)).toMatchObject({
      type: 'procedure.log',
      procedureId: p.id,
      item: { id: 'm1', text: 'Hola' },
    });
    await store.flush();
    const raw = JSON.parse(await readFile(store.paths(p.id).transcriptFile, 'utf8'));
    expect(raw[1].text).toBe('Hola');

    const { service: reloaded } = makeService();
    await reloaded.init();
    const transcript = reloaded.transcript(p.id);
    expect(transcript.map((i) => i.id)).toEqual(['u1', 'm1', 'q1']);
    expect(transcript[1]).toMatchObject({ status: 'aborted', text: 'Hola' });
    expect(transcript[2]).toMatchObject({ status: 'cancelled' });
  });

  it('skips invalid procedure files and deletes procedures completely', async () => {
    const { service, store } = makeService();
    const p = await service.create('x');
    await writeFile(join(dir, 'notes.txt'), 'ignored');
    await writeFile(join(dir, 'bad'), 'x');
    await service.delete(p.id);
    expect(existsSync(store.paths(p.id).dir)).toBe(false);
    expect(seen.at(-1)).toEqual({ type: 'procedure.deleted', procedureId: p.id });
    expect(() => service.require(p.id)).toThrow('Ese trámite ya no existe.');
    const { service: reloaded } = makeService();
    await reloaded.init();
    expect(reloaded.list()).toEqual([]);
  });

  it('lists the most recently updated first', async () => {
    const { service } = makeService();
    const a = await service.create('a');
    await new Promise((r) => setTimeout(r, 5));
    const b = await service.create('b');
    expect(service.list().map((p) => p.id)).toEqual([b.id, a.id]);
    await new Promise((r) => setTimeout(r, 5));
    service.touch(a.id);
    expect(service.list().map((p) => p.id)).toEqual([a.id, b.id]);
  });
});
