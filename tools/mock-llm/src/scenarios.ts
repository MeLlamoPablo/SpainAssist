import { parseScenario, type Scenario, type ScenarioInput } from './scenario';

/**
 * "demo": plausibly handles "renovar el DNI" with SpainAssist's tools, so the desktop UI can be
 * demoed without a real model. The assistant (requests declaring procedure_start) starts a
 * "Renovar el DNI" procedure and later relays its report. The procedure's agent: Exa agent_run (or scripted offline feedback_search) → procedure_update (status researching)
 * → ask_user → procedure_update (status planned) → final report. Facts are worded as "to be
 * confirmed" on purpose: this is a mock.
 */
const demo: ScenarioInput = {
  name: 'demo',
  rules: [
    // --- the assistant (orchestrator): only requests that declare procedure_start ----------------
    {
      id: 'assistant-report',
      when: { hasTool: '^procedure_start$', lastUser: '^\\[Report from procedure' },
      reply: {
        text: 'Listo: tienes el plan en la tarjeta de **Renovar el DNI**. Lo siguiente es **pedir cita previa**.',
      },
    },
    {
      id: 'assistant-start-dni',
      when: {
        hasTool: '^procedure_start$',
        turn: 0,
        lastUser:
          '(renov\\w*|caduca\\w*|nuevo)\\b[\\s\\S]*\\bdni\\b|\\bdni\\b[\\s\\S]*(renov|caduc)',
      },
      reply: {
        text: 'Vale, me pongo con la renovación del DNI.',
        toolCalls: [
          {
            name: 'procedure_start',
            arguments: {
              title: 'Renovar el DNI',
              brief:
                'El usuario quiere renovar el DNI. Investiga qué necesita y prepárale el plan.',
            },
          },
        ],
      },
    },
    {
      id: 'assistant-started',
      when: { hasTool: '^procedure_start$', lastTool: 'procedure_start' },
      reply: { text: 'Lo estoy mirando. Si necesito algo, te lo pregunto aquí.' },
    },
    {
      id: 'assistant-fallback',
      when: { hasTool: '^procedure_start$' },
      reply: { text: 'Soy el modelo de demostración. Prueba a escribir «Quiero renovar el DNI».' },
    },
    // --- the procedure's agent ---------------------------------------------------------------------
    {
      id: 'dni-start',
      when: {
        turn: 0,
        lastUser:
          '(renov\\w*|caduca\\w*|nuevo)\\b[\\s\\S]*\\bdni\\b|\\bdni\\b[\\s\\S]*(renov|caduc)',
      },
      reply: {
        text: 'Vale, te ayudo a renovar el DNI. Primero miro los requisitos del trámite.',
        toolCalls: [{ name: 'feedback_search', arguments: { query: 'renovar DNI cita previa' } }],
      },
    },
    {
      id: 'dni-plan',
      when: { lastTool: 'feedback_search' },
      reply: {
        text: 'Ya tengo lo básico. Lo apunto en tu plan.',
        toolCalls: [
          {
            name: 'procedure_update',
            arguments: {
              title: 'Renovar el DNI',
              summary:
                'Pides cita previa, vas a una oficina de expedición del DNI con tu DNI actual y una foto, y pagas la tasa. Suelen dártelo en el momento.',
              status: 'researching',
              administration: { level: 'state', name: 'Policía Nacional' },
              steps: [
                { id: 'cita', title: 'Pedir cita previa', status: 'current', owner: 'user' },
                {
                  id: 'documentos',
                  title: 'Preparar DNI actual y foto',
                  status: 'pending',
                  owner: 'user',
                },
                {
                  id: 'oficina',
                  title: 'Ir a la oficina y pagar la tasa',
                  status: 'pending',
                  owner: 'user',
                },
              ],
              requirements: [
                { id: 'dni-actual', label: 'Tu DNI actual', status: 'unknown' },
                {
                  id: 'foto',
                  label: 'Una foto reciente en color (fondo blanco)',
                  status: 'unknown',
                },
                {
                  id: 'empadronamiento',
                  label: 'Certificado de empadronamiento',
                  detail: 'Solo si cambias de domicilio.',
                  status: 'unknown',
                },
              ],
              facts: [
                { label: 'Coste', value: '12 € (tasa de 2025; pendiente de confirmar)' },
                { label: 'Dónde', value: 'Oficina de expedición del DNI (Policía Nacional)' },
              ],
              sources: [
                {
                  title: 'Portal del DNI electrónico',
                  url: 'https://www.dnielectronico.es/PortalDNIe/',
                },
                { title: 'Cita previa DNI y pasaporte', url: 'https://www.citapreviadnie.es/' },
              ],
              nextAction: { text: 'Decirme tu provincia y cuándo caduca tu DNI', owner: 'user' },
            },
          },
        ],
      },
    },
    {
      id: 'dni-ask',
      when: { lastTool: 'procedure_update', lastToolResult: 'status:\\s*researching' },
      reply: {
        toolCalls: [
          {
            name: 'ask_user',
            arguments: {
              title: 'Dos datos para la cita',
              message: 'Así busco la oficina que te toca y te digo si ya puedes renovarlo.',
              fields: [
                {
                  key: 'addressProvince',
                  label: '¿En qué provincia vives?',
                  type: 'text',
                  vaultKey: 'addressProvince',
                },
                {
                  key: 'documentExpiry',
                  label: '¿Cuándo caduca tu DNI?',
                  type: 'date',
                  vaultKey: 'documentExpiry',
                },
              ],
              submitLabel: 'Seguir',
            },
          },
        ],
      },
    },
    {
      id: 'dni-dismissed',
      when: { lastTool: 'ask_user', lastToolResult: 'dismissed|did not answer|declined' },
      reply: { text: 'Sin problema. Cuando quieras, dime tu provincia y seguimos.' },
    },
    {
      id: 'dni-planned',
      when: { lastTool: 'ask_user' },
      reply: {
        text: 'Gracias. Actualizo el plan.',
        toolCalls: [
          {
            name: 'procedure_update',
            arguments: {
              status: 'planned',
              nextAction: { text: 'Pedir cita previa en citapreviadnie.es', owner: 'user' },
            },
          },
        ],
      },
    },
    {
      id: 'dni-summary',
      when: { lastTool: 'procedure_update', lastToolResult: 'status:\\s*planned' },
      reply: {
        text: [
          'Listo. Esto es lo que tienes que hacer:',
          '',
          '- **Pide cita previa** en citapreviadnie.es.',
          '- **Lleva** tu DNI actual y una foto reciente en color.',
          '- **Paga la tasa** en la oficina (unos 12 €; lo confirmo en la web oficial).',
          '',
          '¿Quieres que te ayude a pedir la cita?',
        ].join('\n'),
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
