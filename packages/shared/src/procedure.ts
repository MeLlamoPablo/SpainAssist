import { z } from 'zod';
import { PromptItem } from './chat';

/**
 * A procedure ("trámite") is the central object of the app. The assistant starts one per
 * procedure the user needs; that procedure's own agent keeps it up to date through the
 * `procedure_update` tool, and the UI renders it natively as a card.
 */

/** Lifecycle status, set by the agent. */
export const ProcedureStatus = z.enum([
  'researching', // understanding what the user needs, gathering requirements
  'planned', // plan ready, waiting for the user to go ahead / provide things
  'in_progress', // the agent (or the user) is executing steps
  'waiting_admin', // submitted, waiting on the administration (resolution, appointment date...)
  'done',
  'blocked', // cannot continue without something external (site down, missing requirement...)
  'cancelled',
]);
export type ProcedureStatus = z.infer<typeof ProcedureStatus>;

/** Who is responsible for a step / the next action. */
export const Actor = z.enum(['agent', 'user', 'administration']);
export type Actor = z.infer<typeof Actor>;

export const StepStatus = z.enum(['pending', 'current', 'done', 'skipped', 'failed']);
export type StepStatus = z.infer<typeof StepStatus>;

export const ProcedureStep = z.object({
  /** Stable id chosen by the agent (e.g. "cita-previa"). */
  id: z.string().min(1).max(64),
  /** Short imperative title in plain language: "Pedir cita previa". */
  title: z.string().min(1).max(160),
  status: StepStatus,
  /** One or two plain-language sentences. */
  detail: z.string().max(1000).optional(),
  owner: Actor.optional(),
});
export type ProcedureStep = z.infer<typeof ProcedureStep>;

export const RequirementStatus = z.enum(['missing', 'have', 'unknown', 'not_needed']);
export type RequirementStatus = z.infer<typeof RequirementStatus>;

/** Something the user needs (a document, a photo, a fee payment, a credential...). */
export const Requirement = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  detail: z.string().max(1000).optional(),
  status: RequirementStatus.default('unknown'),
});
export type Requirement = z.infer<typeof Requirement>;

/** Key facts shown at a glance, e.g. { label: "Coste", value: "12 €" }. */
export const Fact = z.object({
  label: z.string().min(1).max(60),
  value: z.string().min(1).max(300),
});
export type Fact = z.infer<typeof Fact>;

export const Source = z.object({
  title: z.string().min(1).max(200),
  url: z.string().url(),
});
export type Source = z.infer<typeof Source>;

export const AdministrationLevel = z.enum(['state', 'regional', 'local', 'eu', 'other']);
export type AdministrationLevel = z.infer<typeof AdministrationLevel>;

export const Administration = z.object({
  level: AdministrationLevel,
  /** e.g. "Policía Nacional", "Agencia Tributaria", "Ayuntamiento de Madrid". */
  name: z.string().min(1).max(160),
});
export type Administration = z.infer<typeof Administration>;

/**
 * Who the agent hands the procedure to when its run ends. Never the agent: while it works the
 * card shows that, and nothing restarts an idle agent on its own.
 */
export const NextActionOwner = z.enum(['user', 'administration']);
export type NextActionOwner = z.infer<typeof NextActionOwner>;

/** "2026-10-13T11:00": wall-clock time where the appointment is, without a UTC offset. */
const LOCAL_DATE_TIME = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d$/;

/** An appointment the user must attend in person (a confirmed cita). */
export const Appointment = z.object({
  /** Place name and street address, enough to find it on a map. */
  address: z.string().min(1).max(300),
  /** Local start time, "YYYY-MM-DDTHH:mm". */
  startsAt: z
    .string()
    .regex(LOCAL_DATE_TIME)
    // Rejects days a month doesn't have (2026-02-30 would roll over to March).
    .refine((s) => {
      const date = new Date(`${s}:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
    }, 'Invalid date'),
});
export type Appointment = z.infer<typeof Appointment>;

export const NextAction = z.object({
  text: z.string().min(1).max(300),
  owner: NextActionOwner,
  appointment: Appointment.optional(),
});
export type NextAction = z.infer<typeof NextAction>;

export const Procedure = z.object({
  id: z.string(),
  title: z.string().min(1).max(160),
  /** One or two sentences, plain language. */
  summary: z.string().max(1000).optional(),
  status: ProcedureStatus,
  administration: Administration.optional(),
  steps: z.array(ProcedureStep),
  requirements: z.array(Requirement),
  facts: z.array(Fact),
  sources: z.array(Source),
  nextAction: NextAction.optional(),
  /** ISO 8601. */
  createdAt: z.string(),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type Procedure = z.infer<typeof Procedure>;

/**
 * Partial update sent by the agent (`procedure_update` tool). Arrays, when present,
 * REPLACE the previous array entirely (simple semantics for the model).
 */
export const ProcedureUpdate = z.object({
  title: Procedure.shape.title.optional(),
  summary: Procedure.shape.summary,
  status: ProcedureStatus.optional(),
  administration: Administration.optional(),
  steps: z.array(ProcedureStep).max(30).optional(),
  requirements: z.array(Requirement).max(30).optional(),
  facts: z.array(Fact).max(12).optional(),
  sources: z.array(Source).max(20).optional(),
  nextAction: NextAction.nullable().optional(),
});
export type ProcedureUpdate = z.infer<typeof ProcedureUpdate>;

/** Runtime state managed by the app (not persisted by the agent). */
export const ProcedureActivity = z.enum([
  'idle', // nothing happening
  'working', // the agent is running
  'needs_user', // a prompt (form / confirmation / manual action) is waiting for the user
]);
export type ProcedureActivity = z.infer<typeof ProcedureActivity>;

export const ProcedureRuntime = z.object({
  activity: ProcedureActivity,
  /** New agent output the user has not seen yet. */
  unread: z.boolean(),
  /** Last error from the agent process / provider, if any. */
  error: z.string().optional(),
  /** When the agent started this stretch of work (ISO), while `activity` is 'working'. */
  workingSince: z.string().optional(),
  /** What the procedure's agent is doing right now (a tool call), while working. */
  now: z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) }).optional(),
  /** Questions the procedure's agent is waiting on, oldest first (shown on its card). */
  prompts: z.array(PromptItem).optional(),
});
export type ProcedureRuntime = z.infer<typeof ProcedureRuntime>;

export const ProcedureListItem = Procedure.extend({ runtime: ProcedureRuntime });
export type ProcedureListItem = z.infer<typeof ProcedureListItem>;

export function emptyProcedure(
  id: string,
  title: string,
  now = new Date().toISOString(),
): Procedure {
  return {
    id,
    title,
    status: 'researching',
    steps: [],
    requirements: [],
    facts: [],
    sources: [],
    createdAt: now,
    updatedAt: now,
    archived: false,
  };
}
