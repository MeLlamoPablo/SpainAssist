import type { PromptResponse, UiNode, WorkflowInfo } from '@sa/shared';
import { describe, expect, it } from 'vitest';
import type { PendingPrompt } from '../../../src/contracts';
import {
  actionable,
  BUTTON_FIELD,
  InterfacePrompts,
  type InterfacePromptsOptions,
  interfaceForm,
  readTree,
} from '../../../src/run/app/interfaces';

const h = (id: string) => ({ $handler: id });
const el = (type: string, props: Record<string, unknown>, ...children: UiNode[]): UiNode => ({
  type: type as never,
  props,
  children,
});

/** A DNI renewal question as a model might write it. */
const dniTree = (state: { dni: string; when?: string }): UiNode =>
  el(
    'Root',
    {},
    el(
      'Form',
      { title: 'Datos para la cita' },
      el('Text', {}, 'Necesito tu DNI para buscar cita.'),
      el('Facts', { items: [{ label: 'Coste', value: '12 €' }] }),
      el('TextField', { label: 'Número de DNI', value: state.dni, onChange: h('r/0/2#onChange') }),
      el('Choice', {
        label: 'Horario',
        options: [
          { value: 'am', label: 'Mañanas' },
          { value: 'pm', label: 'Tardes' },
        ],
        ...(state.when ? { value: state.when } : {}),
        onChange: h('r/0/3#onChange'),
      }),
      el(
        'Actions',
        {},
        el('Button', { type: 'secondary', onClick: h('r/0/4/0#onClick') }, 'Cancelar'),
        el('Button', { type: 'primary', onClick: h('r/0/4/1#onClick') }, 'Buscar cita'),
      ),
    ),
  );

describe('readTree and interfaceForm', () => {
  it('turns inputs into fields, texts into the message, and several buttons into a choice', () => {
    const read = readTree(dniTree({ dni: '' }));
    expect(actionable(read)).toBe(true);
    const form = interfaceForm(read, 'Renovar el DNI');
    expect(form.title).toBe('Datos para la cita');
    expect(form.message).toBe('Necesito tu DNI para buscar cita.\nCoste: 12 €');
    expect(form.fields).toEqual([
      { key: 'numero_de_dni', type: 'text', label: 'Número de DNI', required: false },
      {
        key: 'horario',
        type: 'select',
        label: 'Horario',
        required: true,
        options: [
          { value: 'am', label: 'Mañanas' },
          { value: 'pm', label: 'Tardes' },
        ],
      },
      {
        key: BUTTON_FIELD,
        type: 'select',
        label: 'Botón que pulsas',
        required: true,
        options: [
          { value: 'Cancelar', label: 'Cancelar' },
          { value: 'Buscar cita', label: 'Buscar cita' },
        ],
        defaultValue: 'Buscar cita',
      },
    ]);
  });

  it('asks which button when there is nothing else, and presses a lone one after the inputs', () => {
    const buttons = el(
      'Root',
      {},
      el('Text', {}, '¿Pago en efectivo o con cargo en cuenta?'),
      el('Button', { onClick: h('a') }, 'Efectivo'),
      el('Button', { onClick: h('b') }, 'Cargo en cuenta'),
    );
    const form = interfaceForm(readTree(buttons), 'Tasa');
    expect(form.title).toBe('Tasa');
    expect(form.fields.map((f) => [f.key, f.options?.map((o) => o.label)])).toEqual([
      [BUTTON_FIELD, ['Efectivo', 'Cargo en cuenta']],
    ]);
    const lone = el(
      'Root',
      {},
      el('Appointment', { slots: ['2026-11-10T09:00'], allowMore: true, onChange: h('c') }),
      el('Button', { onClick: h('d') }, 'Reservar'),
    );
    const one = interfaceForm(readTree(lone), 'Cita');
    expect(one.fields).toEqual([
      {
        key: 'appointment',
        type: 'appointment',
        label: 'Cita',
        required: true,
        slots: ['2026-11-10T09:00'],
      },
    ]);
    expect([...one.buttons.keys()]).toEqual(['Reservar']);
  });

  it('is nothing to act on while a button loads, or with no handlers', () => {
    expect(
      actionable(
        readTree(el('Root', {}, el('Button', { loading: true, onClick: h('x') }, 'Enviando'))),
      ),
    ).toBe(false);
    expect(actionable(readTree(el('Root', {}, el('Progress', { label: 'Buscando citas' }))))).toBe(
      false,
    );
  });
});

/** One workflow with one interface that re-renders on events, as the kernel does. */
function fakeWorkflow(render: (state: Record<string, unknown>) => UiNode | null) {
  const state: Record<string, unknown> = { dni: '' };
  let rev = 1;
  let open = true;
  const events: { handler: string; value?: unknown; rev: number }[] = [];
  const listeners: ((w: WorkflowInfo) => void)[] = [];
  const info = (): WorkflowInfo => {
    const tree = open ? render(state) : null;
    return {
      id: 'renovar-dni',
      title: 'Renovar el DNI',
      status: tree ? 'waiting_user' : 'succeeded',
      agentId: 'a_0123456789abcdef',
      ui: tree ? [{ key: 'datos', status: 'open', tree, rev, openedAt: '' }] : [],
      attached: true,
      createdAt: '',
      updatedAt: '',
    };
  };
  const changed = () => {
    for (const listener of listeners) listener(info());
  };
  return {
    state,
    events,
    port: {
      workflows: () => [info()],
      async uiEvent(
        _w: string,
        _k: string,
        event: { handler: string; rev: number; value?: unknown },
      ) {
        events.push(event);
        setTimeout(() => {
          if (event.handler === 'r/0/2#onChange') state.dni = event.value;
          else if (event.handler === 'r/0/3#onChange') state.when = event.value;
          else if (event.handler === 'r/0/4/1#onClick') {
            if (state.dni === '12345678Z') open = false;
            else state.error = true;
          }
          rev++;
          changed();
        }, 5);
        return true;
      },
    },
    on: (listener: (w: WorkflowInfo) => void) => listeners.push(listener),
    info,
    rerender: () => {
      rev++;
      changed();
    },
  };
}

const waitFor = async <T>(fn: () => T | undefined, ms = 2000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const form = (values: Record<string, string | boolean | string[]>): PromptResponse => ({
  kind: 'form',
  values,
  dismissed: false,
  savedToVault: [],
});

function setup(
  render: (state: Record<string, unknown>) => UiNode | null,
  options: Partial<InterfacePromptsOptions> = {},
) {
  const workflow = fakeWorkflow(render);
  const shown: PendingPrompt[] = [];
  const notes: string[] = [];
  const renders: { rev: number; actionable: boolean }[] = [];
  const prompts = new InterfacePrompts({
    port: workflow.port,
    onShown: (prompt) => shown.push(prompt),
    onNote: (text) => notes.push(text),
    onRender: ({ rev, actionable }) => renders.push({ rev, actionable }),
    settleMs: 20,
    repeatSettleMs: 60,
    maxSettleMs: 80,
    renderWaitMs: 500,
    ...options,
  });
  workflow.on((info) => prompts.update(info));
  prompts.update(workflow.info());
  return { workflow, prompts, shown, notes, renders };
}

describe('InterfacePrompts', () => {
  it('shows a settled interface as a form prompt that names no procedure, as the app does', async () => {
    const { prompts, shown } = setup((s) => dniTree({ dni: String(s.dni) }));
    expect(prompts.pending()).toEqual([]);
    const prompt = await waitFor(() => shown[0]);
    expect(prompt).toMatchObject({
      itemId: 'wf_renovar-dni:datos:1',
      agent: 'procedure',
      kind: 'form',
      title: 'Datos para la cita',
    });
    expect(prompt).not.toHaveProperty('procedureId');
    expect(prompts.pending()).toEqual([prompt]);
    expect(prompts.owns(prompt.itemId)).toBe(true);
    expect(prompts.owns('q_0123456789abcdef')).toBe(false);
  });

  it('shows a first render at once: components are synchronous, so it is the whole question', async () => {
    const { shown, renders } = setup((s) => dniTree({ dni: String(s.dni) }), {
      settleMs: 10_000,
      maxSettleMs: 10_000,
    });
    await waitFor(() => shown[0], 200);
    expect(renders).toEqual([{ rev: 1, actionable: true }]);
  });

  it('reports each render once, and a loading tree as not actionable', async () => {
    let loading = true;
    const { workflow, shown, renders } = setup((s) =>
      loading
        ? el('Root', {}, el('Actions', {}, el('Button', { loading: true }, 'Buscando…')))
        : dniTree({ dni: String(s.dni) }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(shown).toEqual([]);
    loading = false;
    workflow.rerender();
    await waitFor(() => shown[0]);
    expect(renders).toEqual([
      { rev: 1, actionable: false },
      { rev: 2, actionable: true },
    ]);
  });

  it('is busy while an interface waits to settle, so the run does not go quiet before it is shown', async () => {
    const { prompts, shown } = setup((s) => dniTree({ dni: String(s.dni) }));
    expect(shown).toEqual([]);
    expect(prompts.busy()).toBe(true);
    await waitFor(() => shown[0]);
    expect(prompts.busy()).toBe(false);
    expect(prompts.pending()).toHaveLength(1);
  });

  it('plays an answer as the renderer would: each change after the last re-render, then the click', async () => {
    const { workflow, prompts, shown } = setup((s) =>
      dniTree({ dni: String(s.dni), ...(s.when ? { when: String(s.when) } : {}) }),
    );
    const prompt = await waitFor(() => shown[0]);
    await prompts.respond(
      prompt.itemId,
      form({ numero_de_dni: '12345678Z', horario: 'pm', [BUTTON_FIELD]: 'Buscar cita' }),
    );
    expect(workflow.events.map((e) => [e.handler, e.value, e.rev])).toEqual([
      ['r/0/2#onChange', '12345678Z', 1],
      ['r/0/3#onChange', 'pm', 2],
      ['r/0/4/1#onClick', undefined, 3],
    ]);
    // The click closed it: nothing is pending, and nothing new is shown.
    await new Promise((r) => setTimeout(r, 100));
    expect(prompts.pending()).toEqual([]);
    expect(shown).toHaveLength(1);
  });

  it('makes the tree a click leads to a new prompt, and keeps the prompt across identical re-renders', async () => {
    const { workflow, prompts, shown } = setup((s) =>
      el(
        'Root',
        {},
        ...(s.error ? [el('Callout', { tone: 'error' }, 'Ese DNI no es válido.')] : []),
        el('TextField', { label: 'DNI', value: String(s.dni), onChange: h('r/0/2#onChange') }),
        el('Button', { onClick: h('r/0/4/1#onClick') }, 'Buscar cita'),
      ),
    );
    const first = await waitFor(() => shown[0]);
    workflow.rerender();
    await new Promise((r) => setTimeout(r, 60));
    expect(shown).toHaveLength(1);
    expect(prompts.pending()).toEqual([first]);
    await prompts.respond(first.itemId, form({ dni: '00000000T' }));
    const second = await waitFor(() => shown[1]);
    expect(second.itemId).toBe('wf_renovar-dni:datos:2');
    expect(second.message).toBe('Ese DNI no es válido.');
    expect(prompts.pending()).toEqual([second]);
    await expect(prompts.respond(first.itemId, form({ dni: 'x' }))).rejects.toThrow(
      'No pending interface',
    );
  });

  it('presses a button the form enables once its inputs are filled in', async () => {
    const { workflow, prompts, shown } = setup((s) =>
      el(
        'Root',
        {},
        el('Choice', {
          label: '¿Cómo entras?',
          options: [
            { value: 'sms', label: 'SMS' },
            { value: 'permanente', label: 'Cl@ve Permanente' },
          ],
          ...(s.when ? { value: String(s.when) } : {}),
          onChange: h('r/0/3#onChange'),
        }),
        el('Button', { disabled: !s.when, onClick: h('r/0/4/1#onClick') }, 'Continuar'),
      ),
    );
    const prompt = await waitFor(() => shown[0]);
    expect(prompt.fields?.map((f) => f.key)).toEqual(['como_entras']);
    await prompts.respond(prompt.itemId, form({ como_entras: 'permanente' }));
    expect(workflow.events.map((e) => e.handler)).toEqual(['r/0/3#onChange', 'r/0/4/1#onClick']);
  });

  it('asks again when the button stays disabled after the answer', async () => {
    const { workflow, prompts, shown, notes } = setup((s) =>
      el(
        'Root',
        {},
        el('TextField', { label: 'DNI', value: String(s.dni), onChange: h('r/0/2#onChange') }),
        el('Button', { disabled: true, onClick: h('r/0/4/1#onClick') }, 'Continuar'),
      ),
    );
    const first = await waitFor(() => shown[0]);
    await prompts.respond(first.itemId, form({ dni: '1' }));
    expect(workflow.events.map((e) => e.handler)).toEqual(['r/0/2#onChange']);
    expect(notes).toEqual([`interface ${first.itemId}: the button "Continuar" is still disabled`]);
    const second = await waitFor(() => shown[1]);
    expect(prompts.pending()).toEqual([second]);
  });

  it('shows a tree that never holds still after a while', async () => {
    const { workflow, shown } = setup((s) => dniTree({ dni: String(s.dni) }));
    const ticking = setInterval(() => workflow.rerender(), 10);
    try {
      await waitFor(() => shown[0], 500);
    } finally {
      clearInterval(ticking);
    }
  });

  it('drops the prompt when the interface closes before it is answered', async () => {
    let open = true;
    const { workflow, prompts, shown } = setup((s) =>
      open ? dniTree({ dni: String(s.dni) }) : null,
    );
    await waitFor(() => shown[0]);
    open = false;
    workflow.rerender();
    expect(prompts.pending()).toEqual([]);
  });
});
