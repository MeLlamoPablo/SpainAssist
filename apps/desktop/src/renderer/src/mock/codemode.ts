import type {
  CodemodeAgentInfo,
  ProcedureListItem,
  RunInfo,
  SaEvent,
  UiEvent,
  UiNode,
} from '@sa/shared';

/**
 * The codemode harness in the web preview: two runs waiting for the user,
 * rendered from local state the way a run's sandbox would (a tree per render, handlers by
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

interface SimRun {
  info: RunInfo;
  /** Builds the tree of an open interface from the simulated durable state. */
  render: Record<string, () => El>;
  handle: Record<string, (handler: string, value: UiEvent['value']) => void>;
}

export function createCodemodeMock(deps: CodemodeMockDeps) {
  const tr = (es: string, en: string) => (deps.lang() === 'en' ? en : es);
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  const runs = new Map<string, SimRun>();
  const agents = new Map<string, CodemodeAgentInfo>();

  const emitRun = (w: SimRun) => {
    w.info = { ...w.info, updatedAt: deps.now() };
    deps.emit({ type: 'codemode.run', run: structuredClone(w.info) });
  };
  const rerender = (w: SimRun, key: string) => {
    const ui = w.info.ui.find((u) => u.key === key);
    const render = w.render[key];
    if (!ui || !render) return;
    ui.tree = render();
    ui.rev += 1;
    emitRun(w);
  };
  const close = (w: SimRun, key: string) => {
    w.info.ui = w.info.ui.filter((u) => u.key !== key);
    if (!w.info.ui.length) w.info.status = 'running';
    emitRun(w);
  };
  const open = (w: SimRun, key: string) => {
    const render = w.render[key];
    if (!render) return;
    w.info.ui.push({ key, status: 'open', tree: render(), rev: 1, openedAt: deps.now() });
    w.info.status = 'waiting_user';
    emitRun(w);
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
  const citaRun: SimRun = {
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
          close(citaRun, 'donde-cuando');
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
            open(citaRun, 'huecos');
          }, 2200);
          return;
        }
        rerender(citaRun, 'donde-cuando');
      },
      huecos: (handler, value) => {
        if (handler.endsWith('#onChange')) {
          if (value === 'more') return;
          cita.slot = String(value);
          rerender(citaRun, 'huecos');
          return;
        }
        close(citaRun, 'huecos');
        setAgent('a_dni', {
          activity: 'working',
          status: tr('Reservando la cita…', 'Booking the appointment…'),
          since: deps.now(),
        });
        window.setTimeout(() => {
          citaRun.info.status = 'succeeded';
          emitRun(citaRun);
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
  citaRun.info.ui.push({
    key: 'donde-cuando',
    status: 'open',
    tree: citaRun.render['donde-cuando']?.(),
    rev: 1,
    openedAt: ago(30),
  });
  runs.set(citaRun.info.id, citaRun);

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
      runs: [...runs.values()]
        .filter((w) => w.info.ui.length || w.info.status === 'running')
        .map((w) => structuredClone(w.info)),
    }),
    uiEvent: (runId: string, key: string, event: UiEvent): boolean => {
      const w = runs.get(runId);
      const handle = w?.handle[key];
      if (!w || !handle || !w.info.ui.some((u) => u.key === key)) return false;
      if (!deps.freeze) window.setTimeout(() => handle(event.handler, event.value), 60);
      else handle(event.handler, event.value);
      return true;
    },
    pins: (_runId: string, _key: string, addresses: string[]) =>
      addresses.map((a) => deps.places[a] ?? null),
    stopAgent: (agentId: string) => setAgent(agentId, { activity: 'idle' }),
    uiFailed: (runId: string, key: string): boolean => {
      const w = runs.get(runId);
      if (!w?.info.ui.some((u) => u.key === key)) return false;
      w.info.ui = w.info.ui.filter((u) => u.key !== key);
      emitRun(w);
      return true;
    },
  };
}
