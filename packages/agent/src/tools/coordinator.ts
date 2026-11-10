import type { Procedure } from '@sa/shared';
import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import { callBridge, clip, compact, defineSaTool, textResult } from './common';
import { renderProcedure } from './procedure';

/**
 * The codemode coordinator's tools (docs/codemode.md, "The coordinator"): it only delegates. It
 * never researches, asks the user or creates procedures; its background agents do, and they create
 * the cards once they know which procedures the user has. It starts them, passes on what the user
 * says and reads the cards they keep. Results stay short: its context lives forever (compacted).
 */

const AgentId = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Agent id from agent_start, agent_list or a report, e.g. "a_0123456789abcdef"',
});

const ProcedureId = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Procedure id from procedure_list, e.g. "p_0123456789abcdef"',
});

const STATUS_RULE = 'an ongoing action in the user\'s language, a few everyday words ending in "…"';

const AgentStartParams = Type.Object({
  status: Type.String({
    minLength: 1,
    maxLength: 120,
    description: `What the agent starts doing, as ${STATUS_RULE}: "Buscando cómo pedir el voto por correo…". The user sees it while it works.`,
  }),
  brief: Type.String({
    minLength: 1,
    maxLength: 8000,
    description:
      "The user's goal in their own words and everything they told you that matters (situation, city, dates, preferences, document ids). Never limits they did not set. Not their saved data: the agent reads it itself.",
  }),
  procedures: Type.Optional(
    Type.Array(ProcedureId, {
      maxItems: 20,
      description: 'Existing procedures the agent should continue',
    }),
  ),
});

const AgentMessageParams = Type.Object({
  agentId: AgentId,
  message: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: "The user's news, answer, decision or request, in a few sentences",
  }),
  urgent: Type.Optional(
    Type.Boolean({
      description:
        'True only when the user corrects or changes something the agent may act on now. Default false.',
    }),
  ),
  status: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 120,
      description: `Only when the message changes what the agent does next: its new status, as ${STATUS_RULE} ("Cambiando la cita al jueves…").`,
    }),
  ),
});

function renderCard(p: Procedure): string {
  const lines = [renderProcedure(p).replace(/^Procedure updated\. /, '')];
  if (p.summary) lines.push(`Summary: ${clip(p.summary, 400)}`);
  return `Procedure ${p.id}\n${lines.join('\n')}`;
}

function renderBrief(p: Procedure): string {
  const parts = [`${p.id} "${p.title}"`, p.status];
  if (p.archived) parts.push('archived');
  if (p.nextAction) parts.push(`next: ${clip(p.nextAction.text, 120)} (${p.nextAction.owner})`);
  const appointment = p.nextAction?.appointment;
  if (appointment) parts.push(`appointment: ${appointment.startsAt} at ${appointment.address}`);
  return `- ${parts.join(' · ')}`;
}

export function coordinatorTools(bridge: BridgeTransport) {
  return [
    defineSaTool({
      name: 'agent_start',
      label: 'Start an agent',
      description:
        'Start a background agent for a new request: something the user wants done or only wants to know. It researches, asks the user what it needs in the app, creates the procedures once it knows which ones apply, and does every online step. Returns right away; its short report reaches you when it finishes. One agent can serve several related procedures.',
      parameters: AgentStartParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'agents.start', compact({ ...params }), signal, (result) =>
          textResult(
            `Started agent ${result.agentId}. Nothing is done yet; its report will reach you when it finishes.`,
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'agent_message',
      label: 'Tell an agent',
      description:
        "Pass the user's news, an answer, a decision or a correction to the agent working on it. By default it reads it once its current run ends; urgent only for corrections it must not act against.",
      parameters: AgentMessageParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'agents.message', compact({ ...params }), signal, (result) =>
          textResult(
            result.delivered === 'started'
              ? 'Delivered: the agent started working on it.'
              : 'Queued: the agent reads it after its current step.',
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'agent_stop',
      label: 'Stop an agent',
      description:
        'Stop an agent. Its procedures are kept, and a message continues it later. Only when the user asks to stop or pause.',
      parameters: Type.Object({ agentId: AgentId }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'agents.stop', params, signal, (result) =>
          textResult(result.stopped ? 'Stopped.' : 'It was not working.', result),
        );
      },
    }),

    defineSaTool({
      name: 'agent_list',
      label: 'List agents',
      description:
        'The agents (id, status, whether they are working or waiting for the user, their procedures). Use it to find the agent to message.',
      parameters: Type.Object({}),
      async execute(_id, _params, signal) {
        return callBridge(bridge, 'agents.list', {}, signal, (result) =>
          textResult(
            result.agents.length > 0
              ? result.agents
                  .map(
                    (a) =>
                      `- ${a.id} "${a.status}" · ${a.activity}${a.now ? ` (${a.now})` : ''}${a.procedures.length ? ` · procedures: ${a.procedures.join(', ')}` : ''}`,
                  )
                  .join('\n')
              : 'No agents yet.',
            { count: result.agents.length },
          ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_list',
      label: 'List procedures',
      description:
        "The user's procedures (id, title, status, next action, appointment), as the user sees them.",
      parameters: Type.Object({
        includeArchived: Type.Optional(Type.Boolean({ description: 'Default false' })),
      }),
      async execute(_id, params, signal) {
        return callBridge(
          bridge,
          'procs.list',
          { includeArchived: params.includeArchived ?? false },
          signal,
          (result) =>
            textResult(
              result.procedures.length > 0
                ? result.procedures.map(renderBrief).join('\n')
                : 'No procedures yet.',
              { count: result.procedures.length },
            ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_read',
      label: 'Read a procedure',
      description:
        'One procedure as the user sees it: status, steps, requirements, key facts, next action. Answer questions about a procedure from it; message its agent only for what it does not say.',
      parameters: Type.Object({ procedureId: ProcedureId }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procs.get', { id: params.procedureId }, signal, (p) =>
          textResult(renderCard(p), { status: p.status, title: p.title }),
        );
      },
    }),
  ];
}
