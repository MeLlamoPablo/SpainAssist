import type { ProcedureListItem } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/bridge/client';
import type { ToolResult } from '../src/tools/common';
import { type AnyToolDefinition, createAssistantTools } from '../src/tools/index';
import { ASSISTANT_TOOL_NAMES } from '../src/tools/names';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { textOf } from './helpers/tools';

function card(patch: Partial<ProcedureListItem> = {}): ProcedureListItem {
  return {
    id: 'p_1',
    title: 'Renovar el DNI',
    status: 'planned',
    steps: [{ id: 'cita', title: 'Pedir cita', status: 'current', owner: 'agent' }],
    requirements: [],
    facts: [{ label: 'Coste', value: '12 €' }],
    sources: [],
    nextAction: { text: 'Elegir oficina', owner: 'user' },
    createdAt: '2026-10-03T10:00:00.000Z',
    updatedAt: '2026-10-03T10:00:00.000Z',
    archived: false,
    runtime: { activity: 'needs_user', unread: false },
    ...patch,
  };
}

describe('assistant tools', () => {
  let bridge: FakeBridge;
  let tools: AnyToolDefinition[];
  const run = (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.execute('call-1', params, undefined, undefined, {} as never) as Promise<ToolResult>;
  };

  beforeEach(async () => {
    bridge = await createFakeBridge();
    tools = createAssistantTools({
      bridge: new BridgeClient({ url: bridge.url, token: bridge.token }),
    });
  });
  afterEach(async () => {
    await bridge.close();
  });

  it('registers only the delegation, form and data tools', () => {
    expect(tools.map((t) => t.name)).toEqual([...ASSISTANT_TOOL_NAMES]);
    expect(tools.find((t) => t.name === 'procedure_start')?.executionMode).toBe('sequential');
  });

  it('lists procedures in one short line each', async () => {
    bridge.setHandler('procedures.list', () => ({
      procedures: [
        {
          id: 'p_1',
          title: 'Renovar el DNI',
          status: 'planned',
          activity: 'needs_user',
          nextAction: { text: 'Elegir oficina', owner: 'user' },
          archived: false,
          updatedAt: '2026-10-03T10:00:00.000Z',
        },
      ],
    }));
    const text = textOf(await run('procedure_list', {}));
    expect(text).toBe(
      '- p_1 "Renovar el DNI" · planned · waiting for the user · next: Elegir oficina (user)',
    );
    expect(bridge.callsTo('procedures.list')[0]?.params).toEqual({ includeArchived: false });

    bridge.setHandler('procedures.list', () => ({ procedures: [] }));
    expect(textOf(await run('procedure_list', {}))).toBe('No procedures yet.');
  });

  it('reads a card, starts, messages and cancels procedures through the bridge', async () => {
    bridge.setHandler('procedures.read', () => card());
    const read = textOf(await run('procedure_read', { procedureId: 'p_1' }));
    expect(read).toContain('Procedure p_1');
    expect(read).toContain('Pedir cita [current, agent]');
    expect(read).toContain('Agent: waiting for the user');
    expect(read).not.toContain('Plan card updated');

    bridge.setHandler('procedures.start', (params) => ({
      procedureId: 'p_2',
      title: params.title,
    }));
    const started = textOf(
      await run('procedure_start', { title: 'Empadronarme', brief: 'Madrid' }),
    );
    expect(started).toContain('Started p_2 "Empadronarme"');

    bridge.setHandler('procedures.message', () => ({ delivered: 'queued' }));
    expect(
      textOf(await run('procedure_message', { procedureId: 'p_2', message: 'Tardes' })),
    ).toContain('Queued for after the current run finishes');

    bridge.setHandler('procedures.cancel', () => ({ cancelled: true }));
    expect(textOf(await run('procedure_cancel', { procedureId: 'p_2' }))).toBe('Cancelled.');
    expect(bridge.callsTo('procedures.cancel')[0]?.params).toEqual({ procedureId: 'p_2' });
  });

  it('shows pending question ids and options without secret defaults', async () => {
    bridge.setHandler('procedures.read', () =>
      card({
        runtime: {
          activity: 'needs_user',
          unread: false,
          prompts: [
            {
              id: 'q_1',
              createdAt: '2026-10-03T10:00:00.000Z',
              type: 'prompt',
              status: 'pending',
              prompt: {
                kind: 'form',
                title: 'Acceso',
                allowDismiss: false,
                fields: [
                  {
                    key: 'method',
                    label: 'Método',
                    type: 'select',
                    required: true,
                    options: [{ value: 'sms', label: 'SMS' }],
                  },
                  {
                    key: 'code',
                    label: 'Código',
                    type: 'secret',
                    required: true,
                    defaultValue: 'do-not-expose',
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const text = textOf(await run('procedure_read', { procedureId: 'p_1' }));
    expect(text).toContain('Pending question q_1 (form): Acceso');
    expect(text).toContain('"value":"sms"');
    expect(text).not.toContain('do-not-expose');
  });

  it('shows who the user must phone for a pending call', async () => {
    bridge.setHandler('procedures.read', () =>
      card({
        runtime: {
          activity: 'needs_user',
          unread: false,
          prompts: [
            {
              id: 'q_2',
              createdAt: '2026-10-03T10:00:00.000Z',
              type: 'prompt',
              status: 'pending',
              prompt: {
                kind: 'phone_call',
                title: 'Llama a EMASESA',
                organization: 'EMASESA',
                phoneNumber: '900 822 010',
                purpose: 'Cambiar el número de personas.',
                questions: ['¿Qué papeles hacen falta?'],
              },
            },
          ],
        },
      }),
    );
    const text = textOf(await run('procedure_read', { procedureId: 'p_1' }));
    expect(text).toContain('Pending question q_2 (phone_call): Llama a EMASESA');
    expect(text).toContain('Call EMASESA at 900 822 010: Cambiar el número de personas.');
  });

  it('answers, dismisses and resumes with sequential tools', async () => {
    bridge.setHandler('procedures.respond', (params) => ({
      answered: !!params.values,
      dismissed: !params.values,
    }));
    bridge.setHandler('procedures.resume', () => ({ delivered: 'queued' }));
    await run('procedure_respond', {
      procedureId: 'p_1',
      promptId: 'q_1',
      values: { method: 'sms' },
    });
    expect(bridge.callsTo('procedures.respond')[0]?.params.values).toEqual({ method: 'sms' });
    expect(
      textOf(await run('procedure_respond', { procedureId: 'p_1', promptId: 'q_1' })),
    ).toContain('dismissed');
    expect(
      textOf(await run('procedure_resume', { procedureId: 'p_1', message: 'Relee Mis datos' })),
    ).toContain('Completion will be reported separately');
    for (const name of ['procedure_respond', 'procedure_resume']) {
      expect(tools.find((tool) => tool.name === name)?.executionMode).toBe('sequential');
    }
  });

  it('interrupts work through the coordinator stop tool', async () => {
    bridge.setHandler('procedures.stop', () => ({ stopped: true }));
    const result = await run('procedure_stop', { procedureId: 'p_1' });
    expect(textOf(result)).toContain('The procedure is kept and can resume later.');
    expect(bridge.callsTo('procedures.stop')[0]?.params).toEqual({ procedureId: 'p_1' });
    expect(bridge.callsTo('procedures.cancel')).toHaveLength(0);
    expect(tools.find((t) => t.name === 'procedure_stop')?.executionMode).toBe('sequential');
  });

  it('turns bridge failures into helpful errors', async () => {
    const result = await run('procedure_message', { procedureId: 'p_x', message: 'Hola' });
    expect(result.isError).toBe(true);
  });

  it.each(['procedure_message', 'procedure_resume'])(
    '%s distinguishes a queued instruction from a started run',
    async (name) => {
      const method = name === 'procedure_message' ? 'procedures.message' : 'procedures.resume';
      bridge.setHandler(method, () => ({ delivered: 'queued' }));
      const queued = textOf(await run(name, { procedureId: 'p_1', message: 'Cambia de método' }));
      expect(queued.toLowerCase()).toContain('queued');
      expect(queued).not.toContain('Delivered');
      expect(queued).toMatch(/not (read or |been )?acted on/);
      bridge.setHandler(method, () => ({ delivered: 'started' }));
      const started = textOf(await run(name, { procedureId: 'p_1', message: 'Cambia de método' }));
      expect(started).toMatch(/new run (started|accepted)/);
      expect(started).toMatch(/not yet confirmed|no action has been confirmed/);
    },
  );
});
