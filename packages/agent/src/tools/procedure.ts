import type { Procedure, ProcedureUpdate } from '@sa/shared';
import { Type } from 'typebox';
import type { BridgeTransport } from '../bridge/client';
import {
  callBridge,
  clip,
  compact,
  defineSaTool,
  errorResult,
  StringEnum,
  textResult,
} from './common';

const Actor = StringEnum(['user', 'agent', 'administration'], {
  description:
    'Who does it: agent (you: anything online, e.g. booking cita previa), user (only in-person or physical steps) or administration',
});

const Step = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64, description: 'Stable id, e.g. "cita-previa"' }),
  title: Type.String({
    minLength: 1,
    maxLength: 160,
    description:
      'A milestone of the procedure as the user would write it in their own to-do list, e.g. "Pedir cita previa", "Ir a la comisaría", "Recoger el DNI". Never your own work ("Investigar requisitos", "Pedir los datos")',
  }),
  status: StringEnum(['pending', 'current', 'done', 'skipped', 'failed']),
  detail: Type.Optional(
    Type.String({ maxLength: 1000, description: 'One or two plain sentences' }),
  ),
  owner: Type.Optional(Actor),
});

const Requirement = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  label: Type.String({ minLength: 1, maxLength: 160, description: 'What the user needs' }),
  detail: Type.Optional(Type.String({ maxLength: 1000 })),
  status: Type.Optional(
    StringEnum(['missing', 'have', 'unknown', 'not_needed'], { description: 'Default unknown' }),
  ),
});

const Fact = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 60, description: 'e.g. Coste, Plazo, Dónde' }),
  value: Type.String({ minLength: 1, maxLength: 300 }),
});

const Source = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  url: Type.String({
    minLength: 1,
    maxLength: 2000,
    description: 'https URL of the page you used',
  }),
});

export const ProcedureUpdateParams = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  summary: Type.Optional(
    Type.String({ maxLength: 1000, description: 'One or two plain-language sentences' }),
  ),
  status: Type.Optional(
    StringEnum(
      ['researching', 'planned', 'in_progress', 'waiting_admin', 'done', 'blocked', 'cancelled'],
      { description: 'Lifecycle status of the procedure' },
    ),
  ),
  administration: Type.Optional(
    Type.Object({
      level: StringEnum(['state', 'regional', 'local', 'eu', 'other']),
      name: Type.String({ minLength: 1, maxLength: 160, description: 'e.g. "Policía Nacional"' }),
    }),
  ),
  steps: Type.Optional(
    Type.Array(Step, {
      maxItems: 30,
      description:
        "COMPLETE list of steps: the user's to-do list for this procedure, from start to finish",
    }),
  ),
  requirements: Type.Optional(
    Type.Array(Requirement, { maxItems: 30, description: 'COMPLETE list of requirements' }),
  ),
  facts: Type.Optional(
    Type.Array(Fact, { maxItems: 12, description: 'COMPLETE list of key facts' }),
  ),
  sources: Type.Optional(
    Type.Array(Source, { maxItems: 20, description: 'COMPLETE list of sources you used' }),
  ),
  nextAction: Type.Optional(
    Type.Object(
      {
        text: Type.String({ minLength: 1, maxLength: 300 }),
        owner: StringEnum(['user', 'administration'], {
          description: 'Who must act before you can continue: the user or the administration',
        }),
        appointment: Type.Optional(
          Type.Object(
            {
              address: Type.String({
                minLength: 1,
                maxLength: 300,
                description:
                  'Place and full street address, e.g. "Centro Médico Hiniesta, C/ Madre Dolores Márquez 2, 41005 Sevilla"',
              }),
              startsAt: Type.String({
                pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$',
                description: 'Local time at the place, "YYYY-MM-DDTHH:mm", e.g. "2026-10-13T11:00"',
              }),
            },
            {
              description:
                "Set it once an in-person appointment is confirmed (e.g. you booked the cita): the card shows it with Google Maps and Google Calendar buttons. Don't repeat its date and place in facts",
            },
          ),
        ),
      },
      {
        description:
          'Only when you hand the procedure over: what the user or the administration must do next. Never your own work',
      },
    ),
  ),
  clearNextAction: Type.Optional(
    Type.Boolean({ description: 'true removes the next action (e.g. when done)' }),
  ),
});

function validUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function renderProcedure(procedure: Procedure): string {
  const lines = [`Plan card updated. Status: ${procedure.status}.`, `Title: ${procedure.title}`];
  if (procedure.administration) {
    lines.push(
      `Administration: ${procedure.administration.name} (${procedure.administration.level})`,
    );
  }
  if (procedure.nextAction) {
    lines.push(`Next action: ${procedure.nextAction.text} (${procedure.nextAction.owner})`);
    const appointment = procedure.nextAction.appointment;
    if (appointment) lines.push(`Appointment: ${appointment.startsAt} at ${appointment.address}`);
  }
  if (procedure.steps.length > 0) {
    lines.push(
      `Steps: ${procedure.steps.map((s) => `${s.title} [${s.status}${s.owner ? `, ${s.owner}` : ''}]`).join('; ')}`,
    );
  }
  if (procedure.requirements.length > 0) {
    lines.push(
      `Requirements: ${procedure.requirements.map((r) => `${r.label} [${r.status}]`).join('; ')}`,
    );
  }
  if (procedure.facts.length > 0) {
    lines.push(
      `Facts: ${procedure.facts.map((f) => `${f.label}: ${clip(f.value, 80)}`).join('; ')}`,
    );
  }
  if (procedure.sources.length > 0) {
    lines.push(`Sources: ${procedure.sources.length}`);
  }
  return lines.join('\n');
}

export function procedureTools(bridge: BridgeTransport) {
  return [
    defineSaTool({
      name: 'procedure_update',
      label: 'Update plan',
      description:
        'Update the plan card the user sees for this procedure. Send only the fields that change, but arrays (steps, requirements, facts, sources) REPLACE the previous list entirely: always send the complete list. Call it early and after every meaningful change (new facts, a step done, a blocker). Returns the updated card.',
      parameters: ProcedureUpdateParams,
      async execute(_id, params, signal) {
        const { clearNextAction, nextAction, ...rest } = params;
        const update: ProcedureUpdate = compact({
          ...rest,
          requirements: rest.requirements?.map((r) => ({ ...r, status: r.status ?? 'unknown' })),
          nextAction: clearNextAction ? null : nextAction,
        }) as ProcedureUpdate;
        if (Object.keys(update).length === 0) {
          return errorResult('Nothing to update: pass at least one field.');
        }
        const badSource = rest.sources?.find((s) => !validUrl(s.url));
        if (badSource) {
          return errorResult(`Invalid source URL "${badSource.url}": use a full https URL.`);
        }
        return callBridge(bridge, 'procedure.update', update, signal, (procedure) =>
          textResult(renderProcedure(procedure), {
            status: procedure.status,
            title: procedure.title,
          }),
        );
      },
    }),
  ];
}
