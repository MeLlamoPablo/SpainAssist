import type { Procedure } from '@sa/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BridgeClient } from '../src/bridge/client';
import type { ToolResult } from '../src/tools/common';
import { type AnyToolDefinition, createCoordinatorTools } from '../src/tools/index';
import { COORDINATOR_TOOL_NAMES } from '../src/tools/names';
import { createFakeBridge, type FakeBridge } from './helpers/fake-bridge';
import { textOf } from './helpers/tools';

function card(patch: Partial<Procedure> = {}): Procedure {
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
    version: 2,
    ...patch,
  };
}

describe('codemode coordinator tools', () => {
  let bridge: FakeBridge;
  let tools: AnyToolDefinition[];
  const run = (name: string, params: Record<string, unknown>) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`No tool ${name}`);
    return tool.execute('call-1', params, undefined, undefined, {} as never) as Promise<ToolResult>;
  };

  beforeEach(async () => {
    bridge = await createFakeBridge();
    tools = createCoordinatorTools({
      bridge: new BridgeClient({ url: bridge.url, token: bridge.token }),
    });
  });
  afterEach(async () => {
    await bridge.close();
  });

  it('registers only delegation and card reads', () => {
    expect(tools.map((t) => t.name)).toEqual([...COORDINATOR_TOOL_NAMES]);
    expect(tools.find((t) => t.name === 'agent_start')?.executionMode).toBe('sequential');
  });

  it('starts, messages, lists and stops agents through the bridge', async () => {
    bridge.setHandler('agents.start', () => ({ agentId: 'a_1' }));
    expect(textOf(await run('agent_start', { status: 'DNI', brief: 'Renovar el DNI.' }))).toBe(
      'Started agent a_1. Nothing is done yet; its report will reach you when it finishes.',
    );
    expect(bridge.callsTo('agents.start')[0]?.params).toEqual({
      status: 'DNI',
      brief: 'Renovar el DNI.',
    });

    bridge.setHandler('agents.message', () => ({ delivered: 'queued', cancelledPrompts: 0 }));
    expect(
      textOf(
        await run('agent_message', {
          agentId: 'a_1',
          message: 'En Sevilla.',
          status: 'Buscando citas en Sevilla…',
        }),
      ),
    ).toBe('Queued: the agent reads it after its current step.');
    expect(bridge.callsTo('agents.message')[0]?.params).toEqual({
      agentId: 'a_1',
      message: 'En Sevilla.',
      status: 'Buscando citas en Sevilla…',
    });

    bridge.setHandler('agents.list', () => ({
      agents: [
        {
          id: 'a_1',
          status: 'DNI',
          activity: 'working',
          now: 'Buscando citas',
          procedures: ['p_1'],
        },
      ],
    }));
    expect(textOf(await run('agent_list', {}))).toBe(
      '- a_1 "DNI" · working (Buscando citas) · procedures: p_1',
    );

    bridge.setHandler('agents.stop', () => ({ stopped: true }));
    expect(textOf(await run('agent_stop', { agentId: 'a_1' }))).toBe('Stopped.');
  });

  it('reads the cards agents keep', async () => {
    bridge.setHandler('procs.list', () => ({ procedures: [card()] }));
    expect(textOf(await run('procedure_list', {}))).toBe(
      '- p_1 "Renovar el DNI" · planned · next: Elegir oficina (user)',
    );
    expect(bridge.callsTo('procs.list')[0]?.params).toEqual({ includeArchived: false });

    bridge.setHandler('procs.get', () => card());
    const read = textOf(await run('procedure_read', { procedureId: 'p_1' }));
    expect(read).toContain('Procedure p_1');
    expect(read).toContain('Pedir cita [current, agent]');
    expect(bridge.callsTo('procs.get')[0]?.params).toEqual({ id: 'p_1' });
  });
});
