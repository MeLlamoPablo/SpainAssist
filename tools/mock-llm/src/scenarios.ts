import { parseScenario, type Scenario, type ScenarioInput } from './scenario';

const DNI_REQUEST =
  '(renov\\w*|caduca\\w*|nuevo)\\b[\\s\\S]*\\bdni\\b|\\bdni\\b[\\s\\S]*(renov|caduc)';

/** Requests of the coordinator (the chat's agent) and of its background agents, by their tools. */
const COORDINATOR = '^agent_start$';
const AGENT = '^codemode$';

/**
 * The demo's workflow (docs/codemode.md): the "Renovar el DNI" card with its plan, one interface
 * for the province and the DNI's expiry, then the card updated with the answer. JavaScript with
 * JSX, as an agent writes it.
 */
export const DEMO_WORKFLOW = `import { Form, Text, Province, TextField, Actions, Button } from '@spainassist/ui';

function Datos({ api }) {
  const [province, setProvince] = api.ui.useDurableState('province', '');
  const [expiry, setExpiry] = api.ui.useDurableState('expiry', '');
  return (
    <Form title="Dos datos para la cita del DNI">
      <Text tone="muted">Así busco la oficina que te toca y te digo si ya puedes renovarlo.</Text>
      <Province value={province} onChange={setProvince} />
      <TextField label="¿Cuándo caduca tu DNI?" type="date" value={expiry} onChange={setExpiry} required={false} />
      <Actions>
        <Button type="secondary" onClick={() => api.ui.close({ skipped: true })}>Ahora no</Button>
        <Button type="primary" disabled={!province} onClick={() => api.ui.close({ province, expiry })}>Seguir</Button>
      </Actions>
    </Form>
  );
}

export async function main(api) {
  await api.setStatus('Preparando el plan para renovar el DNI…');
  const dni = await api.procedures.getOrCreate({
    id: 'renovar-dni',
    title: 'Renovar el DNI',
    status: 'researching',
    summary: 'Pides cita previa, vas a una oficina de expedición del DNI con tu DNI actual y una foto, y pagas la tasa. Suelen dártelo en el momento.',
    administration: { level: 'state', name: 'Policía Nacional' },
    steps: [
      { id: 'cita', title: 'Pedir cita previa', status: 'current', owner: 'user' },
      { id: 'documentos', title: 'Preparar DNI actual y foto', status: 'pending', owner: 'user' },
      { id: 'oficina', title: 'Ir a la oficina y pagar la tasa', status: 'pending', owner: 'user' },
    ],
    requirements: [
      { id: 'dni-actual', label: 'Tu DNI actual', status: 'have' },
      { id: 'foto', label: 'Una foto reciente en color (fondo blanco)', status: 'missing' },
    ],
    facts: [
      { label: 'Coste', value: '12 € (tasa de 2025; pendiente de confirmar)' },
      { label: 'Dónde', value: 'Oficina de expedición del DNI (Policía Nacional)' },
    ],
    sources: [
      { title: 'Portal del DNI electrónico', url: 'https://www.dnielectronico.es/PortalDNIe/' },
      { title: 'Cita previa DNI y pasaporte', url: 'https://www.citapreviadnie.es/' },
    ],
    nextAction: { text: 'Decirme tu provincia y cuándo caduca tu DNI', owner: 'user' },
  });
  const answer = await api.ui.present('datos', () => <Datos api={api} />);
  if (answer.skipped) return { skipped: true };
  await api.state.memo('guardar-provincia', () =>
    api.vault.save([{ key: 'addressProvince', value: answer.province }]),
  );
  await dni.update({
    status: 'planned',
    nextAction: { text: 'Pedir cita previa en citapreviadnie.es', owner: 'user' },
  });
  return { province: answer.province, expiry: answer.expiry || null };
}
`;

/**
 * "demo": plausibly handles "renovar el DNI" with the codemode harness, so the desktop UI can be
 * demoed without a real model. The coordinator (requests declaring agent_start) starts an agent
 * and relays its reports. The agent (requests declaring codemode) runs one workflow
 * (`DEMO_WORKFLOW`): the card with its plan, a question above the cards, the card updated with
 * the answer; then it reports. Facts are worded as "to be confirmed" on purpose: this is a mock.
 */
const demo: ScenarioInput = {
  name: 'demo',
  rules: [
    // --- the coordinator (the chat): only requests that declare agent_start -------------------
    {
      id: 'coordinator-done',
      when: { hasTool: COORDINATOR, lastUser: '\\[Report from agent[\\s\\S]*Esto es lo que' },
      reply: {
        text: 'Listo: tienes el plan en la tarjeta de **Renovar el DNI**. Lo siguiente es **pedir cita previa**.',
      },
    },
    {
      id: 'coordinator-waiting',
      when: { hasTool: COORDINATOR, lastUser: '\\[Report from agent' },
      reply: { text: 'Te he dejado dos preguntas arriba, en Mis trámites.' },
    },
    {
      id: 'coordinator-started',
      when: { hasTool: COORDINATOR, lastTool: 'agent_start' },
      reply: { text: 'Lo estoy mirando. Si necesito algo, te lo pregunto en Mis trámites.' },
    },
    {
      id: 'coordinator-start-dni',
      when: { hasTool: COORDINATOR, turn: 0, lastUser: DNI_REQUEST },
      reply: {
        text: 'Vale, me pongo con la renovación del DNI.',
        toolCalls: [
          {
            name: 'agent_start',
            arguments: {
              status: 'Mirando cómo renovar el DNI…',
              brief:
                'El usuario quiere renovar el DNI. Investiga qué necesita y prepárale el plan.',
            },
          },
        ],
      },
    },
    {
      id: 'coordinator-fallback',
      when: { hasTool: COORDINATOR },
      reply: { text: 'Soy el modelo de demostración. Prueba a escribir «Quiero renovar el DNI».' },
    },
    // --- the agent: only requests that declare codemode ---------------------------------------
    {
      id: 'dni-summary',
      when: {
        hasTool: AGENT,
        lastUser: '\\[Workflow "renovar-dni"[^\\]]*succeeded[\\s\\S]*province',
      },
      reply: {
        text: [
          'Listo. Esto es lo que tiene que hacer:',
          '',
          '- **Pedir cita previa** en citapreviadnie.es.',
          '- **Llevar** su DNI actual y una foto reciente en color.',
          '- **Pagar la tasa** en la oficina (unos 12 €; pendiente de confirmar en la web oficial).',
        ].join('\n'),
      },
    },
    {
      id: 'dni-dismissed',
      when: { hasTool: AGENT, lastUser: '\\[Workflow "renovar-dni"' },
      reply: { text: 'No me ha dado su provincia; el plan queda a la espera.' },
    },
    {
      id: 'dni-waiting',
      when: { hasTool: AGENT, lastTool: 'codemode', lastToolResult: 'waiting for the user' },
      reply: {
        text: 'Tarjeta creada con el plan. Le he preguntado su provincia y cuándo caduca su DNI.',
      },
    },
    {
      id: 'dni-workflow',
      when: { hasTool: AGENT, turn: 0, lastUser: DNI_REQUEST },
      reply: {
        text: 'Preparo el plan y le pregunto lo que falta.',
        toolCalls: [
          {
            name: 'codemode',
            arguments: {
              workflow: 'renovar-dni',
              title: 'Renovar el DNI',
              source: DEMO_WORKFLOW,
            },
          },
        ],
      },
    },
  ],
  fallback: {
    text: 'Soy el modelo de demostración. Prueba a escribir «Quiero renovar el DNI».',
  },
};

/** "echo": answers every request with the last user message. Handy for smoke tests. */
const echo: ScenarioInput = {
  name: 'echo',
  rules: [{ id: 'echo', when: {}, reply: { text: 'Echo: {{lastUser}}' } }],
};

export const BUILTIN_SCENARIOS: Record<string, ScenarioInput> = { demo, echo };

export function builtinScenario(name: string): Scenario | undefined {
  const input = BUILTIN_SCENARIOS[name];
  return input ? parseScenario(input) : undefined;
}
