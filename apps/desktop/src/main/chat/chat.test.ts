import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FormPrompt, SaEvent } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../conversation/service';
import { PromptCancelledError } from '../core/errors';
import { EventBus } from '../core/events';
import { t } from '../core/i18n';
import { silentLogger } from '../core/logger';
import { newId } from '../core/util';
import { ProcedureService } from '../procedures/service';
import { ProcedureStore } from '../procedures/store';
import { sanitizeArgs, TranscriptMapper } from './mapper';
import { PromptManager, REDACTED, sanitizeResponse } from './prompts';

let dir: string;
let events: SaEvent[];
let procedures: ProcedureService;
let conversation: ConversationService;
let procedureId: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-chat-'));
  const bus = new EventBus();
  events = [];
  bus.on((e) => events.push(structuredClone(e)));
  procedures = new ProcedureService({
    store: new ProcedureStore(dir, silentLogger, 10),
    events: bus,
    logger: silentLogger,
    ids: newId,
    clock: () => new Date(),
    lang: () => 'es',
  });
  conversation = new ConversationService({
    dir: join(dir, 'assistant'),
    transcriptFile: join(dir, 'assistant', 'transcript.json'),
    events: bus,
    logger: silentLogger,
    ids: newId,
    clock: () => new Date(),
    debounceMs: 10,
  });
  await conversation.init();
  procedureId = (await procedures.create('Trámite')).id;
  events.length = 0;
});
afterEach(async () => {
  await procedures.flush();
  await conversation.flush();
  await rm(dir, { recursive: true, force: true });
});

function mapper(mediaExists?: (id: string) => boolean) {
  return new TranscriptMapper(procedureId, {
    sink: procedures.sinkFor(procedureId),
    clock: () => new Date(),
    lang: () => 'es',
    logger: silentLogger,
    ...(mediaExists ? { mediaExists } : {}),
  });
}

describe('TranscriptMapper', () => {
  it('streams assistant text as one item plus deltas, then completes it', () => {
    const m = mapper();
    m.handle({ type: 'run_start' });
    expect(procedures.get(procedureId)?.runtime.activity).toBe('working');
    m.handle({ type: 'assistant_start', messageId: 'msg1' });
    m.handle({ type: 'assistant_delta', messageId: 'msg1', delta: '  ' });
    m.handle({ type: 'assistant_delta', messageId: 'msg1', delta: 'Hola' });
    m.handle({ type: 'assistant_delta', messageId: 'msg1', delta: ', Lucía' });
    m.handle({ type: 'assistant_end', messageId: 'msg1', text: '  Hola, Lucía.' });
    m.handle({ type: 'run_end' });

    const logEvents = events.filter((e) => e.type === 'procedure.log');
    expect(logEvents).toHaveLength(3);
    const [first, delta, last] = logEvents;
    expect(first).toMatchObject({
      procedureId,
      item: { type: 'assistant', text: '  Hola', status: 'streaming' },
    });
    expect(delta).toMatchObject({ item: { text: '  Hola, Lucía' } });
    expect(last).toMatchObject({ item: { text: '  Hola, Lucía.', status: 'complete' } });
    const transcript = procedures.transcript(procedureId);
    expect(transcript).toHaveLength(1);
    expect(procedures.get(procedureId)?.runtime).toEqual({ activity: 'idle', unread: true });
    expect(m.lastRun).toEqual({
      aborted: false,
      text: 'Hola, Lucía.',
      startedAt: expect.any(String),
    });
  });

  it('streams into the conversation with chat.item + chat.delta for the assistant', () => {
    const m = new TranscriptMapper('assistant', {
      sink: conversation,
      clock: () => new Date(),
      lang: () => 'es',
      logger: silentLogger,
    });
    m.handle({ type: 'run_start' });
    expect(conversation.state()).toEqual({ activity: 'working' });
    m.handle({ type: 'assistant_start', messageId: 'a' });
    m.handle({ type: 'assistant_delta', messageId: 'a', delta: 'Hola' });
    m.handle({ type: 'assistant_delta', messageId: 'a', delta: '.' });
    m.handle({ type: 'assistant_end', messageId: 'a', text: 'Hola.' });
    m.handle({ type: 'run_end' });
    expect(events.map((e) => e.type)).toEqual([
      'chat.state',
      'chat.item',
      'chat.delta',
      'chat.item',
      'chat.state',
    ]);
    expect(conversation.transcript()).toEqual([
      expect.objectContaining({ type: 'assistant', text: 'Hola.', status: 'complete' }),
    ]);
  });

  it('creates no item for tool-only assistant messages', () => {
    const m = mapper();
    m.handle({ type: 'assistant_start', messageId: 'msg1' });
    m.handle({ type: 'assistant_end', messageId: 'msg1', text: '' });
    expect(procedures.transcript(procedureId)).toHaveLength(0);
  });

  it('maps tool calls to activity rows with sanitized args and validated screenshots', () => {
    const m = mapper((id) => id === 'shot-1');
    m.handle({
      type: 'tool_start',
      toolCallId: 'c1',
      tool: 'browser_type',
      args: { ref: 'e5', text: 'x'.repeat(400), password: 'leak', nested: { token: 't', ok: 1 } },
    });
    let item = procedures.transcript(procedureId)[0];
    expect(item).toMatchObject({ type: 'activity', status: 'running', tool: 'browser_type' });
    if (item?.type !== 'activity') throw new Error('expected activity');
    expect(item.args.password).toBeUndefined();
    expect(item.args.nested).toEqual({ ok: 1 });
    expect((item.args.text as string).length).toBeLessThanOrEqual(301);

    m.handle({ type: 'tool_update', toolCallId: 'c1', tool: 'browser_type', summary: 'En curso.' });
    expect(procedures.transcript(procedureId)).toHaveLength(1);
    expect(procedures.transcript(procedureId)[0]).toMatchObject({
      status: 'running',
      summary: 'En curso.',
    });

    m.handle({
      type: 'tool_end',
      toolCallId: 'c1',
      tool: 'browser_type',
      isError: false,
      summary: 'Escrito.',
      details: { imageId: 'shot-1' },
    });
    item = procedures.transcript(procedureId)[0];
    expect(item).toMatchObject({ status: 'done', summary: 'Escrito.', imageId: 'shot-1' });

    m.handle({ type: 'tool_start', toolCallId: 'c2', tool: 'browser_open', args: {} });
    m.handle({
      type: 'tool_end',
      toolCallId: 'c2',
      tool: 'browser_open',
      isError: true,
      details: { imageId: '../../etc/passwd' },
    });
    const second = procedures.transcript(procedureId)[1];
    expect(second).toMatchObject({ status: 'error' });
    expect(second && 'imageId' in second ? second.imageId : undefined).toBeUndefined();
  });

  it('turns provider errors into a friendly notice and runtime error', () => {
    const m = mapper();
    m.handle({ type: 'run_start' });
    m.handle({ type: 'assistant_start', messageId: 'a' });
    m.handle({
      type: 'assistant_end',
      messageId: 'a',
      text: '',
      error: '402: {"message":"Key limit exceeded"}',
    });
    m.handle({ type: 'run_end' });
    const notice = procedures.transcript(procedureId).find((i) => i.type === 'notice');
    expect(notice).toMatchObject({ level: 'error', text: t('es', 'agentErrorCredit') });
    expect(procedures.get(procedureId)?.runtime.error).toBe(t('es', 'agentErrorCredit'));
    m.handle({ type: 'run_start' });
    expect(procedures.get(procedureId)?.runtime.error).toBeUndefined();
  });

  it('marks in-flight items as aborted on abort', () => {
    const m = mapper();
    m.handle({ type: 'run_start' });
    m.handle({ type: 'assistant_start', messageId: 'a' });
    m.handle({ type: 'assistant_delta', messageId: 'a', delta: 'Voy a' });
    m.handle({ type: 'tool_start', toolCallId: 'c', tool: 'web_search', args: { query: 'dni' } });
    m.handle({ type: 'run_end', aborted: true });
    const [assistant, activity] = procedures.transcript(procedureId);
    expect(assistant).toMatchObject({ status: 'aborted' });
    expect(activity).toMatchObject({ status: 'error', summary: 'Cancelado' });
    expect(procedures.transcript(procedureId).some((i) => i.type === 'notice')).toBe(false);
  });

  it('sanitizes args recursively', () => {
    expect(sanitizeArgs({ a: [{ apiKey: 'x', b: 2 }], otp: '1234' })).toEqual({ a: [{ b: 2 }] });
    expect(sanitizeArgs('nope')).toEqual({});
  });
});

describe('PromptManager', () => {
  const form: FormPrompt = {
    kind: 'form',
    title: 'Datos',
    fields: [
      { key: 'name', label: 'Nombre', type: 'text', required: true, vaultKey: 'givenName' },
      { key: 'sms', label: 'Código SMS', type: 'secret', required: true, vaultKey: 'custom.sms' },
      { key: 'ok', label: 'Acepto', type: 'boolean', required: true },
    ],
    allowDismiss: false,
  };

  /** A procedure's questions live in its activity log and runtime, not in the conversation. */
  const logPrompts = () => procedures.transcript(procedureId).filter((i) => i.type === 'prompt');

  function manager() {
    return new PromptManager({
      procedures,
      conversation,
      logger: silentLogger,
      clock: () => new Date(),
      lang: () => 'es',
    });
  }

  it('resolves with the answer, keeps declared fields only and redacts secrets in the transcript', async () => {
    const prompts = manager();
    const answer = prompts.ask(procedureId, form);
    expect(procedures.get(procedureId)?.runtime.activity).toBe('needs_user');
    const item = logPrompts()[0]!;
    expect(item).toMatchObject({ type: 'prompt', procedureId });
    expect(procedures.get(procedureId)?.runtime.prompts?.map((p) => p.id)).toEqual([item.id]);
    expect(conversation.transcript()).toHaveLength(0);
    prompts.respond(item.id, {
      kind: 'form',
      values: { name: 'Lucía', sms: '483920', ok: true, extra: 'x' },
      dismissed: false,
      savedToVault: ['name', 'sms', 'ok'],
    });
    const response = await answer;
    expect(response).toEqual({
      kind: 'form',
      values: { name: 'Lucía', sms: '483920', ok: true },
      dismissed: false,
      savedToVault: ['name'],
    });
    const stored = logPrompts()[0];
    expect(stored).toMatchObject({
      status: 'answered',
      response: { values: { sms: REDACTED, name: 'Lucía' } },
    });
    expect(JSON.stringify(events)).not.toContain('483920');
    expect(procedures.get(procedureId)?.runtime.activity).toBe('idle');
    expect(procedures.get(procedureId)?.runtime.prompts).toBeUndefined();
  });

  it('rejects mismatched or stale answers', async () => {
    const prompts = manager();
    const answer = prompts.ask(procedureId, {
      kind: 'confirm',
      confirmKind: 'action',
      title: 't',
      message: 'm',
    });
    const item = logPrompts()[0]!;
    expect(() => prompts.respond(item.id, { kind: 'user_action', done: true })).toThrow();
    expect(() => prompts.respond('q_unknown', { kind: 'confirm', approved: true })).toThrow(
      t('es', 'promptNotPending'),
    );
    prompts.respond(item.id, { kind: 'confirm', approved: false });
    await expect(answer).resolves.toEqual({ kind: 'confirm', approved: false });
    expect(() => prompts.respond(item.id, { kind: 'confirm', approved: true })).toThrow();
  });

  it('cancels on abort signal and on cancelAll', async () => {
    const prompts = manager();
    const controller = new AbortController();
    const a = prompts.ask(procedureId, form, { signal: controller.signal });
    const b = prompts.ask(procedureId, form);
    expect(prompts.pendingCount(procedureId)).toBe(2);
    controller.abort();
    await expect(a).rejects.toBeInstanceOf(PromptCancelledError);
    prompts.cancelAll(procedureId);
    await expect(b).rejects.toBeInstanceOf(PromptCancelledError);
    expect(logPrompts().map((i) => (i.type === 'prompt' ? i.status : ''))).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(procedures.get(procedureId)?.runtime.activity).toBe('idle');
  });

  it('keeps map pins in memory with the pending prompt only', async () => {
    const prompts = manager();
    const point = { latitude: 37.38, longitude: -5.98 };
    const answer = prompts.ask(procedureId, form, { mapPins: new Map([['centre', [point]]]) });
    const item = logPrompts()[0]!;
    expect(prompts.mapPins(item.id)?.get('centre')).toEqual([point]);
    // Mapbox results may not be stored: the saved transcript never holds them.
    expect(JSON.stringify(procedures.transcript(procedureId))).not.toContain('37.38');
    prompts.respond(item.id, {
      kind: 'form',
      values: { name: 'Lucía', sms: '483920', ok: true },
      dismissed: false,
      savedToVault: [],
    });
    await answer;
    expect(prompts.mapPins(item.id)).toBeUndefined();
  });

  it('treats dismissed forms (old clients) as dismissed', async () => {
    const prompts = manager();
    const answer = prompts.ask(procedureId, form);
    const item = logPrompts()[0]!;
    prompts.respond(item.id, {
      kind: 'form',
      values: { name: 'x' },
      dismissed: true,
      savedToVault: ['name'],
    });
    await expect(answer).resolves.toEqual({ kind: 'form', dismissed: true, savedToVault: [] });
  });

  it("puts the assistant's own questions in the conversation without a procedure", async () => {
    const prompts = manager();
    const answer = prompts.ask('assistant', form);
    const item = conversation.transcript()[0]!;
    expect(item).toMatchObject({ type: 'prompt', status: 'pending' });
    expect(item.type === 'prompt' && item.procedureId).toBeFalsy();
    expect(conversation.state()).toEqual({ activity: 'needs_user' });
    expect(procedures.get(procedureId)?.runtime.activity).toBe('idle');
    prompts.cancelAll('assistant');
    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
    expect(conversation.state()).toEqual({ activity: 'idle' });
  });
});

it('drops hidden field answers and vault saves even when the renderer submits them', () => {
  const prompt: FormPrompt = {
    kind: 'form',
    title: 'Acceso',
    allowDismiss: false,
    fields: [
      {
        key: 'access',
        label: 'Acceso',
        type: 'select',
        required: true,
        options: [
          { value: 'sms', label: 'SMS' },
          { value: 'clave', label: 'Cl@ve' },
        ],
      },
      {
        key: 'phone',
        label: 'Móvil',
        type: 'phone',
        required: true,
        vaultKey: 'phone',
        visibleWhen: { field: 'access', values: ['sms'] },
      },
    ],
  };
  for (const access of ['clave', 'unknown', undefined]) {
    expect(
      sanitizeResponse(prompt, {
        kind: 'form',
        dismissed: false,
        values: { ...(access ? { access } : {}), phone: '600000000' },
        savedToVault: ['phone'],
      }),
    ).toMatchObject({ values: access ? { access } : {}, savedToVault: [] });
  }
  expect(
    sanitizeResponse(prompt, {
      kind: 'form',
      dismissed: false,
      values: { access: 'sms', phone: '600000000' },
      savedToVault: ['phone'],
    }),
  ).toMatchObject({ values: { access: 'sms', phone: '600000000' }, savedToVault: ['phone'] });
});
