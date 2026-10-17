/**
 * What the orchestrator (the app's single chat agent) does for "sácame la vida laboral": look at
 * what the user has, ask how they identify themselves when nothing is known, hand the job to a
 * procedure agent and relay its report with the link to the saved document.
 *
 * Its turns are told apart by what the conversation already holds (tool calls and their results),
 * not by a counter, so the same rules serve a conversation that a restored app carries on.
 */
import { ORCHESTRATOR, type Rule } from './kit';

export interface OrchestratorOptions {
  /**
   * Ask the user how they identify themselves when the vault holds no Cl@ve Permanente, and start
   * the procedure with the answer. Without it the procedure starts at once (the vault has it).
   */
  askMethod: boolean;
}

/** The report of a procedure's agent, as the app hands it to the orchestrator. */
export const REPORT_PREFIX = '^\\[Report from procedure';

/** The ways a person can identify themselves to the Seguridad Social: what the question offers. */
const METHODS = [
  { value: 'clave_permanente', label: 'Cl@ve Permanente' },
  { value: 'clave_movil', label: 'Cl@ve Móvil' },
  { value: 'sms', label: 'Vía SMS' },
  { value: 'certificado', label: 'Certificado digital o DNIe' },
];

const NOT_STARTED = { name: 'procedure_start', atMost: 0 };

/** A message of the user asking for the report (not a report of an agent). */
const REQUEST = { lastUser: 'vida laboral', not: { lastUser: REPORT_PREFIX } };

const brief = (method: string) =>
  `El usuario quiere su informe de vida laboral de la Seguridad Social. ${method}`;

export function orchestratorRules(options: OrchestratorOptions): Rule[] {
  const rules: Rule[] = [
    {
      // The report names the documents the run saved: the link to the first is the answer.
      id: 'assistant-relays-document',
      when: {
        ...ORCHESTRATOR,
        lastUser: `${REPORT_PREFIX}[\\s\\S]*Saved documents: (?<doc>[0-9a-f-]{36}) "(?<docname>[^"]*)"`,
      },
      reply: {
        text: 'Listo: tienes tu vida laboral en [tus documentos](sa:vault/documents).\n[{{docname}}](sa:document/{{doc}})',
      },
    },
    {
      id: 'assistant-relays',
      when: { ...ORCHESTRATOR, lastUser: REPORT_PREFIX },
      reply: { text: 'Hay novedades de tu vida laboral. Mira la tarjeta del trámite.' },
    },
    {
      id: 'assistant-looks',
      when: { ...ORCHESTRATOR, ...REQUEST, toolCalled: { name: 'procedure_list', atMost: 0 } },
      reply: {
        toolCalls: [
          { id: 'list', name: 'procedure_list', arguments: {} },
          { id: 'vault', name: 'vault_read', arguments: {} },
        ],
      },
    },
  ];
  if (options.askMethod) {
    rules.push(
      {
        id: 'assistant-asks-method',
        when: {
          ...ORCHESTRATOR,
          ...REQUEST,
          toolCalled: [
            { name: 'vault_read', result: 'Credentials: none saved' },
            { name: 'ask_user', atMost: 0 },
          ],
        },
        reply: {
          toolCalls: [
            {
              id: 'method',
              name: 'ask_user',
              arguments: {
                title: '¿Cómo te identificas?',
                message: 'Para sacar tu vida laboral la Seguridad Social te pide identificarte.',
                fields: [
                  {
                    key: 'metodo',
                    label: 'Método de identificación',
                    type: 'select',
                    required: true,
                    options: METHODS,
                  },
                ],
                submitLabel: 'Seguir',
              },
            },
          ],
        },
      },
      {
        id: 'assistant-starts-with-method',
        when: {
          ...ORCHESTRATOR,
          ...REQUEST,
          toolCalled: [{ name: 'ask_user', result: 'metodo\\): clave_permanente' }, NOT_STARTED],
        },
        reply: {
          toolCalls: [
            {
              id: 'start',
              name: 'procedure_start',
              arguments: {
                title: 'Vida laboral',
                brief: brief('Se identifica con Cl@ve Permanente y aún no la tiene guardada.'),
              },
            },
          ],
        },
      },
    );
  } else {
    rules.push({
      id: 'assistant-starts',
      when: {
        ...ORCHESTRATOR,
        ...REQUEST,
        toolCalled: [{ name: 'vault_read' }, NOT_STARTED],
      },
      reply: {
        toolCalls: [
          {
            id: 'start',
            name: 'procedure_start',
            arguments: {
              title: 'Vida laboral',
              brief: brief('Tiene guardada su Cl@ve Permanente.'),
            },
          },
        ],
      },
    });
  }
  rules.push({
    id: 'assistant-says',
    when: { ...ORCHESTRATOR, lastTool: 'procedure_start' },
    reply: { text: 'Me pongo con tu vida laboral. Te aviso en cuanto la tenga.' },
  });
  return rules;
}
