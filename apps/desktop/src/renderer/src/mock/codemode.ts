import type {
  CodemodeAgentInfo,
  ProcedureListItem,
  SaEvent,
  UiEvent,
  UiNode,
  WorkflowInfo,
} from '@sa/shared';

/**
 * The codemode harness in the web preview (`?codemode=1`): two workflows waiting for the user,
 * rendered from local state the way a workflow's sandbox would (a tree per render, handlers by
 * id), and the agents of the progress meter. No sandbox and no model: the trees are built here.
 */

type El = Exclude<UiNode, string>;
const el = (type: El['type'], props: Record<string, unknown>, ...children: UiNode[]): El => ({
  type,
  props,
  children,
});
const h = (id: string) => ({ $handler: id });

export interface CodemodeMockDeps {
  lang(): 'es' | 'en';
  emit(event: SaEvent): void;
  getProcedure(id: string): ProcedureListItem | undefined;
  putProcedure(p: ProcedureListItem): void;
  /** Places of the demo's map (they have pins). */
  places: Record<string, { latitude: number; longitude: number }>;
  dniProcedureId: string;
  freeze: boolean;
  now(): string;
}

interface SimWorkflow {
  info: WorkflowInfo;
  /** Builds the tree of an open interface from the simulated durable state. */
  render: Record<string, () => El>;
  handle: Record<string, (handler: string, value: UiEvent['value']) => void>;
}

export function createCodemodeMock(deps: CodemodeMockDeps) {
  const tr = (es: string, en: string) => (deps.lang() === 'en' ? en : es);
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const workflows = new Map<string, SimWorkflow>();
  const agents = new Map<string, CodemodeAgentInfo>();

  const emitWorkflow = (w: SimWorkflow) => {
    w.info = { ...w.info, updatedAt: deps.now() };
    deps.emit({ type: 'codemode.workflow', workflow: structuredClone(w.info) });
  };
  const rerender = (w: SimWorkflow, key: string) => {
    const ui = w.info.ui.find((u) => u.key === key);
    const render = w.render[key];
    if (!ui || !render) return;
    ui.tree = render();
    ui.rev += 1;
    emitWorkflow(w);
  };
  const close = (w: SimWorkflow, key: string) => {
    w.info.ui = w.info.ui.filter((u) => u.key !== key);
    if (!w.info.ui.length) w.info.status = 'running';
    emitWorkflow(w);
  };
  const open = (w: SimWorkflow, key: string) => {
    const render = w.render[key];
    if (!render) return;
    w.info.ui.push({ key, status: 'open', tree: render(), rev: 1, openedAt: deps.now() });
    w.info.status = 'waiting_user';
    emitWorkflow(w);
  };
  const setAgent = (id: string, patch: Partial<CodemodeAgentInfo>) => {
    const agent = agents.get(id);
    if (!agent) return;
    const next = { ...agent, ...patch, updatedAt: deps.now() };
    if (next.activity !== 'working') {
      delete next.now;
      delete next.since;
    }
    agents.set(id, next);
    deps.emit({ type: 'codemode.agent', agent: structuredClone(next) });
  };

  // --- the DNI appointment: a map, a choice and a date, then the free slots -------------------
  const cita = {
    office: '',
    time: 'manana',
    from: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    slot: '',
  };
  const placeNames: Record<string, string> = {
    'Calle de ejemplo 20, Sevilla': 'Comisaría Sevilla-Triana',
    'Avenida de ejemplo 1, Sevilla': 'Comisaría Sevilla-Sur',
    'Plaza de ejemplo 3, Sevilla': 'Comisaría Sevilla-Centro',
  };
  const slots = (() => {
    const out: string[] = [];
    for (let d = 3; d < 9; d++) {
      const day = new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      for (const time of ['09:10', '09:40', '10:30', '12:20', '16:45'].slice(0, 2 + (d % 3)))
        out.push(`${day}T${time}`);
    }
    return out;
  })();
  const citaWorkflow: SimWorkflow = {
    info: {
      id: 'cita-dni',
      title: tr('Pedir cita para el DNI', 'Book the DNI appointment'),
      status: 'waiting_user',
      agentId: 'a_dni',
      ui: [],
      attached: true,
      createdAt: ago(300),
      updatedAt: ago(30),
    },
    render: {
      'donde-cuando': () =>
        el(
          'Root',
          {},
          el(
            'Form',
            {
              title: tr(
                '¿Dónde y cuándo quieres la cita?',
                'Where and when do you want the appointment?',
              ),
              description: tr(
                'Busco la primera cita libre que encaje contigo.',
                'I look for the first free slot that suits you.',
              ),
            },
            el('Map', {
              label: tr('Oficina', 'Office'),
              options: Object.entries(placeNames).map(([address, label]) => ({
                value: label,
                label,
                address,
              })),
              value: cita.office,
              onChange: h('r.0:Cita/0#onChange'),
            }),
            el('Choice', {
              label: tr('¿A qué hora te viene mejor?', 'What time suits you best?'),
              options: [
                { value: 'manana', label: tr('Mañanas', 'Mornings') },
                { value: 'tarde', label: tr('Tardes', 'Afternoons') },
              ],
              value: cita.time,
              onChange: h('r.0:Cita/1#onChange'),
            }),
            el('TextField', {
              label: tr('A partir de', 'From'),
              type: 'date',
              value: cita.from,
              help: tr('Busco citas desde este día.', 'I look for slots from this day.'),
              onChange: h('r.0:Cita/2#onChange'),
            }),
            el(
              'Actions',
              {},
              el(
                'Button',
                { type: 'primary', disabled: !cita.office, onClick: h('r.0:Cita/3/1#onClick') },
                tr('Buscar cita', 'Find a slot'),
              ),
            ),
          ),
        ),
      huecos: () =>
        el(
          'Root',
          {},
          el(
            'Form',
            {
              title: tr('Elige tu cita', 'Pick your appointment'),
              description: tr(`Huecos libres en ${cita.office}.`, `Free slots at ${cita.office}.`),
            },
            el('Appointment', {
              slots,
              value: cita.slot,
              allowMore: true,
              onChange: h('r.0:Huecos/0#onChange'),
            }),
            el(
              'Actions',
              {},
              el(
                'Button',
                { type: 'primary', disabled: !cita.slot, onClick: h('r.0:Huecos/1/0#onClick') },
                tr('Reservar esta cita', 'Book this slot'),
              ),
            ),
          ),
        ),
    },
    handle: {
      'donde-cuando': (handler, value) => {
        if (handler.endsWith('Cita/0#onChange')) cita.office = String(value);
        else if (handler.endsWith('Cita/1#onChange')) cita.time = String(value);
        else if (handler.endsWith('Cita/2#onChange')) cita.from = String(value);
        else if (handler.endsWith('#onClick')) {
          close(citaWorkflow, 'donde-cuando');
          setAgent('a_dni', {
            activity: 'working',
            status: tr(
              `Buscando citas libres en ${cita.office}…`,
              `Looking for free slots at ${cita.office}…`,
            ),
            since: deps.now(),
          });
          window.setTimeout(() => {
            setAgent('a_dni', { activity: 'waiting_user' });
            open(citaWorkflow, 'huecos');
          }, 2200);
          return;
        }
        rerender(citaWorkflow, 'donde-cuando');
      },
      huecos: (handler, value) => {
        if (handler.endsWith('#onChange')) {
          if (value === 'more') return;
          cita.slot = String(value);
          rerender(citaWorkflow, 'huecos');
          return;
        }
        close(citaWorkflow, 'huecos');
        setAgent('a_dni', {
          activity: 'working',
          status: tr('Reservando la cita…', 'Booking the appointment…'),
          since: deps.now(),
        });
        window.setTimeout(() => {
          citaWorkflow.info.status = 'succeeded';
          emitWorkflow(citaWorkflow);
          setAgent('a_dni', { activity: 'idle' });
          const p = deps.getProcedure(deps.dniProcedureId);
          if (p) {
            const address =
              Object.entries(placeNames).find(([, name]) => name === cita.office)?.[0] ??
              cita.office;
            deps.putProcedure({
              ...p,
              version: (p.version ?? 0) + 1,
              steps: p.steps.map((s) =>
                s.status === 'current' ? { ...s, status: 'done' as const } : s,
              ),
              nextAction: {
                text: tr(
                  `Ve a ${cita.office} con tu DNI caducado y una foto reciente.`,
                  `Go to ${cita.office} with your expired DNI and a recent photo.`,
                ),
                owner: 'user',
                appointment: { address: `${cita.office}, ${address}`, startsAt: cita.slot },
              },
            });
          }
        }, 1800);
      },
    },
  };
  citaWorkflow.info.ui.push({
    key: 'donde-cuando',
    status: 'open',
    tree: citaWorkflow.render['donde-cuando']?.(),
    rev: 1,
    openedAt: ago(30),
  });
  workflows.set(citaWorkflow.info.id, citaWorkflow);

  agents.set('a_dni', {
    id: 'a_dni',
    kind: 'agent',
    status: tr('Esperando tu respuesta…', 'Waiting for your answer…'),
    activity: 'waiting_user',
    procedures: [deps.dniProcedureId],
    createdAt: ago(900),
    updatedAt: ago(30),
  });
  agents.set('a_padron', {
    id: 'a_padron',
    kind: 'agent',
    status: tr(
      'Leyendo los requisitos en sevilla.org…',
      'Reading the requirements on sevilla.org…',
    ),
    activity: 'working',
    since: ago(42),
    procedures: ['p-padron'],
    createdAt: ago(600),
    updatedAt: ago(42),
  });

  return {
    state: () => ({
      agents: [...agents.values()].map((a) => structuredClone(a)),
      workflows: [...workflows.values()]
        .filter((w) => w.info.ui.length || w.info.status === 'running')
        .map((w) => structuredClone(w.info)),
    }),
    uiEvent: (workflowId: string, key: string, event: UiEvent): boolean => {
      const w = workflows.get(workflowId);
      const handle = w?.handle[key];
      if (!w || !handle || !w.info.ui.some((u) => u.key === key)) return false;
      if (!deps.freeze) window.setTimeout(() => handle(event.handler, event.value), 60);
      else handle(event.handler, event.value);
      return true;
    },
    pins: (_workflowId: string, _key: string, addresses: string[]) =>
      addresses.map((a) => deps.places[a] ?? null),
    stopAgent: (agentId: string) => setAgent(agentId, { activity: 'idle' }),
    uiFailed: (workflowId: string, key: string): boolean => {
      const w = workflows.get(workflowId);
      if (!w?.info.ui.some((u) => u.key === key)) return false;
      w.info.ui = w.info.ui.filter((u) => u.key !== key);
      emitWorkflow(w);
      return true;
    },
    cancelWorkflow: (workflowId: string) => {
      const w = workflows.get(workflowId);
      if (!w) return;
      w.info.ui = [];
      w.info.status = 'cancelled';
      emitWorkflow(w);
    },
  };
}
