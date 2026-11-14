/**
 * What the coordinator (the app's chat agent) does for "sácame la vida laboral": it hands the job
 * to an agent and relays the agent's reports, the last one with the link to the saved document. It
 * never asks the user anything: the agent does, in its interfaces (docs/codemode.md).
 *
 * Its turns are told apart by what the conversation already holds (tool calls and messages), not
 * by a counter, so the same rules serve a conversation that a restored app carries on.
 */
import { COORDINATOR, REPORT_PREFIX, type Rule } from './kit';

/** The brief the coordinator gives the agent: the user's words, nothing more. */
export const VIDA_LABORAL_BRIEF =
  'El usuario quiere su informe de vida laboral de la Seguridad Social.';

/** A message of the user asking for the report (not a report of an agent). */
const REQUEST = { lastUser: 'vida laboral', not: { lastUser: REPORT_PREFIX } };

export function coordinatorRules(): Rule[] {
  return [
    {
      // The report names the documents the run saved: the link to the first is the answer.
      id: 'coordinator-relays-document',
      when: {
        ...COORDINATOR,
        lastUser: `${REPORT_PREFIX}[\\s\\S]*Saved documents: (?<doc>[0-9a-f-]{36}) "(?<docname>[^"]*)"`,
      },
      reply: {
        text: 'Listo: tienes tu vida laboral en [tus documentos](sa:vault/documents).\n[{{docname}}](sa:document/{{doc}})',
      },
    },
    {
      id: 'coordinator-relays',
      when: { ...COORDINATOR, lastUser: REPORT_PREFIX },
      reply: { text: 'Hay novedades de tu vida laboral. Mira la tarjeta del trámite.' },
    },
    {
      id: 'coordinator-starts',
      when: { ...COORDINATOR, ...REQUEST, toolCalled: { name: 'agent_start', atMost: 0 } },
      reply: {
        toolCalls: [
          {
            id: 'start',
            name: 'agent_start',
            arguments: { status: 'Sacando tu vida laboral…', brief: VIDA_LABORAL_BRIEF },
          },
        ],
      },
    },
    {
      id: 'coordinator-says',
      when: { ...COORDINATOR, lastTool: 'agent_start' },
      reply: { text: 'Me pongo con tu vida laboral. Te aviso en cuanto la tenga.' },
    },
  ];
}
