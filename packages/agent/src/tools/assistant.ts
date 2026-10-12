import type { ProcedureBrief, ProcedureListItem } from '@sa/shared';
import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import { callBridge, clip, compact, defineSaTool, textResult } from './common';
import { renderProcedure } from './procedure';

/**
 * The assistant's (orchestrator's) tools: it never researches or browses itself. It starts one
 * agent per procedure, passes it what the user says, and reads the cards those agents keep.
 * Results are deliberately short: the assistant's context lives forever (compacted), so nothing
 * bulky should ever land in it.
 */

const ProcedureId = Type.String({
  minLength: 1,
  maxLength: 64,
  description: 'Procedure id from procedure_list or procedure_start, e.g. "p_0123456789abcdef"',
});

export const ProcedureListParams = Type.Object({
  includeArchived: Type.Optional(Type.Boolean({ description: 'Default false' })),
});

export const ProcedureReadParams = Type.Object({ procedureId: ProcedureId });

export const ProcedureStartParams = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: 160,
    description: 'Short title in plain words, e.g. "Renovar el DNI"',
  }),
  brief: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "Everything the procedure's agent needs to start: what the user wants and why, and what you already know that matters (situation, city, dates, preferences, document ids). Not the user's saved data: the agent reads it itself.",
  }),
});

export const ProcedureMessageParams = Type.Object({
  procedureId: ProcedureId,
  message: Type.String({
    minLength: 1,
    maxLength: 4000,
    description: 'New information, a decision or a request from the user, in a few sentences',
  }),
});

export const ProcedureCancelParams = Type.Object({
  procedureId: ProcedureId,
  reason: Type.Optional(Type.String({ maxLength: 300 })),
});

const ACTIVITY: Record<ProcedureBrief['activity'], string> = {
  idle: 'idle',
  working: 'working',
  needs_user: 'waiting for the user',
};

export function renderBrief(p: ProcedureBrief): string {
  const parts = [`${p.id} "${p.title}"`, p.status, ACTIVITY[p.activity]];
  if (p.archived) parts.push('archived');
  if (p.nextAction) parts.push(`next: ${clip(p.nextAction.text, 120)} (${p.nextAction.owner})`);
  const appointment = p.nextAction?.appointment;
  if (appointment) parts.push(`appointment: ${appointment.startsAt} at ${appointment.address}`);
  return `- ${parts.join(' · ')}`;
}

export function renderCard(p: ProcedureListItem): string {
  const lines = [renderProcedure(p).replace(/^Plan card updated\. /, '')];
  if (p.summary) lines.push(`Summary: ${clip(p.summary, 400)}`);
  lines.push(
    `Agent: ${ACTIVITY[p.runtime.activity]}${p.runtime.error ? ` (error: ${p.runtime.error})` : ''}`,
  );
  for (const item of p.runtime.prompts ?? []) {
    const prompt = item.prompt;
    lines.push(`Pending question ${item.id} (${prompt.kind}): ${prompt.title}`);
    if (prompt.kind === 'phone_call')
      lines.push(`Call ${prompt.organization} at ${prompt.phoneNumber}: ${prompt.purpose}`);
    else if (prompt.message) lines.push(prompt.message);
    if (prompt.kind === 'form') {
      for (const field of prompt.fields) {
        const { defaultValue, ...definition } = field;
        lines.push(
          JSON.stringify({
            ...definition,
            ...(field.type !== 'secret' && defaultValue !== undefined ? { defaultValue } : {}),
          }),
        );
      }
    } else
      lines.push(
        'Only the user can approve or complete this in the native UI. procedure_resume can cancel it when the user changes plans.',
      );
  }
  return `Procedure ${p.id}\n${lines.join('\n')}`;
}

export function assistantTools(bridge: BridgeTransport) {
  return [
    defineSaTool({
      name: 'procedure_list',
      label: 'List procedures',
      description:
        "List the user's procedures (id, title, status, whether its agent is working or waiting for the user, next action). Call it before starting a procedure that may already exist.",
      parameters: ProcedureListParams,
      async execute(_id, params, signal) {
        return callBridge(
          bridge,
          'procedures.list',
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
        "Read one procedure's card as the user sees it: status, steps, requirements, key facts, next action and pending questions (ids, fields and options). Use it to answer questions about a procedure; ask its agent (procedure_message) only for what the card does not say.",
      parameters: ProcedureReadParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.read', params, signal, (procedure) =>
          textResult(renderCard(procedure), { status: procedure.status, title: procedure.title }),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_start',
      label: 'Start a procedure',
      description:
        "Create a procedure and start its own agent, which researches it and does every online step itself (it asks the user directly through forms in this chat when it needs something). Returns right away; the agent's short report reaches you when it finishes. One procedure per administrative goal: several related goals are several procedures.",
      parameters: ProcedureStartParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.start', params, signal, (result) =>
          textResult(
            `Started ${result.procedureId} "${result.title}". Its agent accepted the brief; no completed action is confirmed yet. Its report will reach you when it finishes.`,
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_message',
      label: 'Tell a procedure',
      description:
        "Pass an update that can wait to a procedure's agent. While busy it is queued until the current run finishes and does not release a pending question. Use procedure_resume for corrections or changes of plan that must affect the next decision. Acceptance is not proof the agent read or acted on it.",
      parameters: ProcedureMessageParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.message', params, signal, (result) =>
          textResult(
            result.delivered === 'started'
              ? 'Accepted: a new run started. The agent has not yet confirmed acting on this instruction.'
              : 'Queued for after the current run finishes. The agent has not read or acted on this instruction yet; any pending question still needs a response.',
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_respond',
      label: 'Answer a procedure question',
      description:
        'Answer a pending data form using information the user gave you or saved personal data. Read procedure_read first for the prompt id, field keys and options. Provide all required visible fields. Omit values to dismiss an obsolete request. Never supply secrets or approve confirmations or manual actions.',
      parameters: Type.Object({
        procedureId: ProcedureId,
        promptId: Type.String({ minLength: 1, maxLength: 128 }),
        values: Type.Optional(
          Type.Record(
            Type.String(),
            Type.Union([Type.String(), Type.Array(Type.String()), Type.Boolean()]),
          ),
        ),
      }),
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.respond', compact({ ...params }), signal, (result) =>
          textResult(
            result.dismissed
              ? 'Data request dismissed; the agent can continue.'
              : 'Answered; the agent can continue.',
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_resume',
      label: 'Resume a procedure',
      description:
        "Abort the current run and cancel its pending requests, then start the procedure agent with the user's new instructions. Use for user corrections, changed plans or newly available credentials. Read procedure_read first. Cancels obsolete forms, confirmations and manual actions without approving or completing them. Only the coordinator can do this; ordinary procedure_message queues an update for later.",
      parameters: ProcedureMessageParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.resume', params, signal, (result) =>
          textResult(
            result.delivered === 'started'
              ? 'The previous run and pending requests were cancelled. A new run accepted the instructions; no action has been confirmed yet. Completion will be reported separately.'
              : 'The previous run and pending requests were cancelled. The instructions are queued and have not been acted on yet. Completion will be reported separately.',
            result,
          ),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_stop',
      label: 'Stop a procedure agent',
      description:
        "Interrupt a procedure's agent and cancel its pending questions without cancelling the procedure. Use only when the user explicitly asks to stop or pause its work. It can resume later with procedure_message.",
      parameters: ProcedureReadParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.stop', params, signal, (result) =>
          textResult('Stopped. The procedure is kept and can resume later.', result),
        );
      },
    }),

    defineSaTool({
      name: 'procedure_cancel',
      label: 'Cancel a procedure',
      description:
        "Stop a procedure's agent and mark the procedure cancelled. Only when the user says they no longer want it.",
      parameters: ProcedureCancelParams,
      async execute(_id, params, signal) {
        return callBridge(bridge, 'procedures.cancel', compact({ ...params }), signal, (result) =>
          textResult(result.cancelled ? 'Cancelled.' : 'It was already stopped.', result),
        );
      },
    }),
  ];
}
