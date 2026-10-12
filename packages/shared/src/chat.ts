import { z } from 'zod';
import { CompanionPurpose } from './companion';
import { CredentialKind, PersonalSaveIssue } from './vault';

/**
 * Chat transcript model (main process -> renderer). The main process translates raw pi RPC
 * events into these items. There is ONE conversation with the assistant (the orchestrator); each
 * procedure also keeps its own activity log (what its worker agent did), made of the same items.
 * The renderer never sees pi events.
 */

// ---------------------------------------------------------------------------------------------
// Prompts: structured, native UI requests to the user (forms, confirmations, manual actions)
// ---------------------------------------------------------------------------------------------

export const FormFieldType = z.enum([
  'text',
  'textarea',
  'number',
  'date', // value: YYYY-MM-DD
  'email',
  'phone',
  'select',
  'map-options', // a single place value selected from a map and list
  'multiselect',
  'boolean',
  'document', // value: a vault document id (user picks an existing document or uploads a new one)
  'secret', // masked input (e.g. an SMS code); never saved to the vault
  'province', // a Spanish province from the built-in list (provinces.ts); value: its name
]);
export type FormFieldType = z.infer<typeof FormFieldType>;

export const FormField = z.object({
  /** Machine key used in the response values. */
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(160),
  type: FormFieldType,
  required: z.boolean().default(true),
  options: z
    .array(
      z.object({
        value: z.string().max(200),
        label: z.string().max(200),
        /** Required for map options: the street address with its town, looked up when shown. */
        address: z.string().min(1).max(500).optional(),
      }),
    )
    .max(50)
    .optional(),
  placeholder: z.string().max(200).optional(),
  help: z.string().max(500).optional(),
  /** Show this field only when the named select field has one of these option values. */
  visibleWhen: z
    .object({
      field: z.string().min(1).max(64),
      values: z.array(z.string().max(200)).min(1).max(50),
    })
    .optional(),
  /** Prefilled value (e.g. from the vault). */
  defaultValue: z.string().max(2000).optional(),
  /**
   * If set, the app always stores the answer (except secrets and documents) under this
   * personal-data key (see vault.ts PERSONAL_FIELDS, or "custom.<slug>").
   */
  vaultKey: z.string().max(80).optional(),
});
export type FormField = z.infer<typeof FormField>;

const FormFields = z
  .array(FormField)
  .min(1)
  .max(20)
  .superRefine((fields, ctx) => {
    const byKey = new Map(fields.map((field) => [field.key, field]));
    for (const [index, field] of fields.entries()) {
      const issue = (message: string) =>
        ctx.addIssue({ code: 'custom', path: [index, 'visibleWhen'], message });
      if (fields.filter((other) => other.key === field.key).length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: 'Field keys must be unique.',
        });
      }
      if (field.type === 'map-options') {
        const options = field.options ?? [];
        if (
          !options.length ||
          new Set(options.map((o) => o.value)).size !== options.length ||
          options.some((o) => !o.value.trim() || !o.label.trim() || !o.address?.trim())
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'options'],
            message: 'Map options need unique nonempty values, a name and a street address.',
          });
        }
      }
      if (!field.visibleWhen) continue;
      const source = byKey.get(field.visibleWhen.field);
      if (source?.type !== 'select') {
        issue('visibleWhen must reference a select field in this form.');
        continue;
      }
      if (
        field.visibleWhen.values.some((value) => !source.options?.some((o) => o.value === value))
      ) {
        issue('visibleWhen values must be option values of the referenced select.');
      }
      const seen = new Set([field.key]);
      let current: FormField | undefined = source;
      while (current) {
        if (seen.has(current.key)) {
          issue('Field visibility must not contain cycles.');
          break;
        }
        seen.add(current.key);
        current = current.visibleWhen ? byKey.get(current.visibleWhen.field) : undefined;
      }
    }
  });

/** Hidden controllers cannot activate their dependent fields. Invalid/cyclic rules stay hidden. */
export function visibleFormFields(
  fields: FormField[],
  values: Record<string, string | string[] | boolean>,
): FormField[] {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  const visible = (field: FormField, seen = new Set<string>()): boolean => {
    if (seen.has(field.key)) return false;
    if (!field.visibleWhen) return true;
    seen.add(field.key);
    const source = byKey.get(field.visibleWhen.field);
    const value = values[field.visibleWhen.field];
    return Boolean(
      source &&
        source.type === 'select' &&
        visible(source, seen) &&
        typeof value === 'string' &&
        source.options?.some((option) => option.value === value) &&
        field.visibleWhen.values.includes(value),
    );
  };
  return fields.filter((field) => visible(field));
}

export const FormPrompt = z.object({
  kind: z.literal('form'),
  title: z.string().min(1).max(160),
  message: z.string().max(2000).optional(),
  fields: FormFields,
  submitLabel: z.string().max(40).optional(),
  /**
   * Legacy: forms used to offer "not now". Questions no longer block the conversation, so the
   * app never offers skipping; kept so old transcripts still parse.
   */
  allowDismiss: z.boolean().default(false),
});
export type FormPrompt = z.infer<typeof FormPrompt>;

export const ConfirmKind = z.enum([
  'action', // generic: "Voy a enviar la solicitud"
  'submission', // submitting an official form / registration
  'payment', // paying a fee
  'credential', // using a credential set to "ask before use" (raised by the app, not the agent)
  'signature', // signing a document with the digital certificate (raised by the app)
]);
export type ConfirmKind = z.infer<typeof ConfirmKind>;

export const ConfirmPrompt = z.object({
  kind: z.literal('confirm'),
  confirmKind: ConfirmKind,
  title: z.string().min(1).max(160),
  /** Plain-language explanation of exactly what will happen. */
  message: z.string().min(1).max(2000),
  details: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(500) }))
    .max(20)
    .optional(),
  confirmLabel: z.string().max(40).optional(),
  rejectLabel: z.string().max(40).optional(),
  /** Destructive / irreversible: render the confirm button as dangerous. */
  danger: z.boolean().optional(),
  /** Decided by the app: require Touch ID / OS authentication when available. */
  biometric: z.boolean().optional(),
});
export type ConfirmPrompt = z.infer<typeof ConfirmPrompt>;

export const UserActionKind = z.enum([
  'captcha', // solve a captcha in the browser window
  'qr_scan', // scan a QR (e.g. Cl@ve Móvil) shown in the browser window
  'phone_approval', // approve a request on the phone (Cl@ve Móvil push)
  'manual_step', // anything else the user must do in the browser
  'offline', // something outside the computer (go to an office, sign a paper...)
]);
export type UserActionKind = z.infer<typeof UserActionKind>;

export const UserActionPrompt = z.object({
  kind: z.literal('user_action'),
  actionKind: UserActionKind,
  title: z.string().min(1).max(160),
  message: z.string().min(1).max(2000),
  /** Bring the agent's browser window to the front. */
  showBrowser: z.boolean().default(true),
  /** Optional screenshot (media id) to show inline, e.g. a QR code. */
  imageId: z.string().optional(),
  doneLabel: z.string().max(40).optional(),
});
export type UserActionPrompt = z.infer<typeof UserActionPrompt>;

/** The credentials the agent can ask the user to add in the chat. */
export const PromptableCredential = CredentialKind.extract(['clave_permanente', 'dnie']);
export type PromptableCredential = z.infer<typeof PromptableCredential>;

/**
 * Ask the user to add a login method that isn't saved: a Cl@ve Permanente (the app's own form
 * takes the username and password straight to the vault) or the DNIe with the phone (pairing
 * happens later, in the login's own card). The agent only gets the new credential's id.
 */
export const CredentialPrompt = z.object({
  kind: z.literal('credential'),
  credential: PromptableCredential,
  title: z.string().min(1).max(160),
  /** Why the procedure needs it, in plain words. */
  message: z.string().min(1).max(2000),
});
export type CredentialPrompt = z.infer<typeof CredentialPrompt>;

/** Digits of a phone number written with spaces, dots, dashes or brackets ("900 822 010"). */
const PHONE_SEPARATORS = /[\s.\-()]/g;
const PHONE_DIGITS = /^(\+|00)?\d{3,15}$/;

/**
 * A number the user can dial: a Spanish number ("900 822 010", "+34 954 …", short numbers such
 * as "010") or an international one ("+44 …", "0044 …"). Kept as written, for display.
 */
export const PhoneNumber = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .refine((value) => PHONE_DIGITS.test(value.replace(PHONE_SEPARATORS, '')), {
    message: 'Expected a phone number: digits, optionally with + and spaces.',
  });

/** `tel:` link of a PhoneNumber. 9-digit Spanish numbers get +34. */
export function telHref(phoneNumber: string): string {
  const digits = phoneNumber.replace(PHONE_SEPARATORS, '').replace(/^00/, '+');
  return `tel:${!digits.startsWith('+') && digits.length === 9 ? `+34${digits}` : digits}`;
}

/** Longest call the app records and transcribes. */
export const PHONE_CALL_MAX_SECONDS = 20 * 60;
/**
 * How the renderer records calls: plain WAV (every transcription model reads it; Chromium's
 * MediaRecorder only writes WebM, which OpenRouter does not take). 16 kHz mono is what speech
 * models use anyway: 32 kB per second, 38.4 MB for 20 minutes.
 */
export const PHONE_CALL_AUDIO = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 } as const;
/** Size of the WAV header the renderer writes (PCM, no extra chunks). */
export const WAV_HEADER_BYTES = 44;
/** Largest recording the app accepts: PHONE_CALL_MAX_SECONDS of PHONE_CALL_AUDIO. */
export const PHONE_CALL_MAX_WAV_BYTES =
  WAV_HEADER_BYTES +
  PHONE_CALL_MAX_SECONDS * PHONE_CALL_AUDIO.sampleRate * (PHONE_CALL_AUDIO.bitsPerSample / 8);
/** Longest transcript (user-edited) the app accepts and sends to the agent. */
export const PHONE_CALL_TRANSCRIPT_MAX = 40_000;

/**
 * Ask the user to phone someone (when there is no online route). The card shows the number,
 * what to ask, and can record the call (the microphone) and transcribe it; the user reviews the
 * transcript before it goes back to the agent.
 */
export const PhoneCallPrompt = z.object({
  kind: z.literal('phone_call'),
  title: z.string().min(1).max(160),
  /** Who the user calls: organisation and, if known, department ("EMASESA · Atención al cliente"). */
  organization: z.string().min(1).max(160),
  phoneNumber: PhoneNumber,
  /** Why the user calls, in plain words. */
  purpose: z.string().min(1).max(1000),
  /** What to ask or say, in order. */
  questions: z.array(z.string().trim().min(1).max(300)).min(1).max(12),
  /** What to have at hand (e.g. "Número de contrato, en la factura"). Never secrets. */
  haveAtHand: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  /** A first sentence the user can read out, in Spanish. */
  openingScript: z.string().max(600).optional(),
  /** When they answer, e.g. "Lunes a viernes, de 8:00 a 20:00". */
  hours: z.string().max(200).optional(),
});
export type PhoneCallPrompt = z.infer<typeof PhoneCallPrompt>;

export const PhoneCallOutcome = z.enum([
  'done', // the user talked to them
  'unreachable', // nobody answered, closed, wrong number…
  'skipped', // the user chose not to call
]);
export type PhoneCallOutcome = z.infer<typeof PhoneCallOutcome>;

/**
 * Where a DNIe signature is (raised by the app, never by the agent):
 * - `unlock`: the desktop asks for the DNIe's CAN and/or PIN (`unlock`), before anything goes to
 *   the phone, or again when the card refused one (D20);
 * - `phone`: waiting for the phone app (shows the QR code when no phone is connected);
 * - `reviewing`: the request is on the phone; `card`: approved, hold the DNIe to the phone;
 * - `reading` / `signing`: the phone is talking to the card.
 */
export const DnieSignatureStage = z.enum([
  'unlock',
  'phone',
  'reviewing',
  'card',
  'reading',
  'signing',
]);
export type DnieSignatureStage = z.infer<typeof DnieSignatureStage>;

/**
 * What the `unlock` stage asks for. `refused`: the card refused the CAN or the PIN the phone
 * had; `triesLeft`: the PIN tries the card has left after a wrong one. The CAN and the PIN
 * themselves never go into the prompt: the card sends them to main with `companion.unlock`.
 */
export const DnieUnlock = z.object({
  can: z.boolean(),
  pin: z.boolean(),
  refused: z.enum(['can', 'pin']).optional(),
  triesLeft: z.number().int().min(1).max(2).optional(),
});
export type DnieUnlock = z.infer<typeof DnieUnlock>;

/**
 * A signature or login with the DNIe through the paired phone. The card first asks for the CAN
 * and the PIN when the desktop doesn't have them, then follows the phone's progress; the user
 * approves on the phone and can only cancel here. The QR code is not part of the
 * prompt (it carries the pairing secret): the card reads it from `companion.status`.
 */
export const DnieSignaturePrompt = z.object({
  kind: z.literal('dnie_signature'),
  purpose: CompanionPurpose,
  title: z.string().min(1).max(160),
  message: z.string().min(1).max(2000),
  details: z
    .array(z.object({ label: z.string().max(80), value: z.string().max(500) }))
    .max(20)
    .optional(),
  stage: DnieSignatureStage,
  /** Only in the `unlock` stage. */
  unlock: DnieUnlock.optional(),
});
export type DnieSignaturePrompt = z.infer<typeof DnieSignaturePrompt>;

export const Prompt = z.discriminatedUnion('kind', [
  FormPrompt,
  ConfirmPrompt,
  UserActionPrompt,
  CredentialPrompt,
  PhoneCallPrompt,
  DnieSignaturePrompt,
]);
export type Prompt = z.infer<typeof Prompt>;

export const FormValue = z.union([z.string(), z.array(z.string()), z.boolean()]);
export type FormValue = z.infer<typeof FormValue>;

export const PromptResponse = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('form'),
    /** Undefined when dismissed. */
    values: z.record(z.string(), FormValue).optional(),
    dismissed: z.boolean().default(false),
    /** Keys the user chose to save to the vault. */
    savedToVault: z.array(z.string()).default([]),
    /** Personal data the app could not save (from a document scan or these answers). */
    vaultErrors: z.array(PersonalSaveIssue).max(50).optional(),
  }),
  z.object({ kind: z.literal('confirm'), approved: z.boolean() }),
  z.object({
    kind: z.literal('user_action'),
    done: z.boolean(),
    note: z.string().max(1000).optional(),
  }),
  z.object({
    kind: z.literal('credential'),
    /** The saved credential. Undefined when the user does not have a Cl@ve Permanente. */
    credentialId: z.string().max(120).optional(),
  }),
  z.object({
    kind: z.literal('phone_call'),
    outcome: PhoneCallOutcome,
    /** The call's transcript as the user reviewed it (absent when not recorded). */
    transcript: z.string().trim().max(PHONE_CALL_TRANSCRIPT_MAX).optional(),
    /** What the user wrote after the call. */
    notes: z.string().trim().max(4000).optional(),
  }),
  z.object({
    kind: z.literal('dnie_signature'),
    /** `cancelled` comes from the user; the app ends the prompt with `signed` or `failed`. */
    outcome: z.enum(['signed', 'failed', 'cancelled']),
  }),
]);
export type PromptResponse = z.infer<typeof PromptResponse>;

// ---------------------------------------------------------------------------------------------
// Chat items
// ---------------------------------------------------------------------------------------------

export const Attachment = z.object({
  /** Vault document id. */
  documentId: z.string(),
  name: z.string(),
  mimeType: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

const base = {
  id: z.string(),
  /** ISO 8601. */
  createdAt: z.string(),
};

export const UserItem = z.object({
  ...base,
  type: z.literal('user'),
  text: z.string(),
  attachments: z.array(Attachment).optional(),
});

export const AssistantItem = z.object({
  ...base,
  type: z.literal('assistant'),
  /** Markdown. */
  text: z.string(),
  status: z.enum(['streaming', 'complete', 'error', 'aborted']),
});

export const ActivityStatus = z.enum(['running', 'done', 'error']);

/**
 * A tool call made by the agent, shown as a compact activity row. The renderer turns
 * `tool` + `args` into a friendly, localized label (see activity labels in the renderer).
 * Secrets never appear here (tools never receive them).
 */
export const ActivityItem = z.object({
  ...base,
  type: z.literal('activity'),
  toolCallId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: ActivityStatus,
  /** Short plain-text summary of the result or the error. */
  summary: z.string().optional(),
  /** Optional screenshot (media id), e.g. after a browser action. */
  imageId: z.string().optional(),
  finishedAt: z.string().optional(),
});

export const PromptItem = z.object({
  ...base,
  type: z.literal('prompt'),
  /** The procedure whose agent asks (absent when the assistant itself asks). */
  procedureId: z.string().optional(),
  prompt: Prompt,
  status: z.enum(['pending', 'answered', 'cancelled']),
  response: PromptResponse.optional(),
});

export const NoticeItem = z.object({
  ...base,
  type: z.literal('notice'),
  /** The procedure this notice is about, if any. */
  procedureId: z.string().optional(),
  level: z.enum(['info', 'success', 'warning', 'error']),
  text: z.string(),
});

export const ChatItem = z.discriminatedUnion('type', [
  UserItem,
  AssistantItem,
  ActivityItem,
  PromptItem,
  NoticeItem,
]);
export type ChatItem = z.infer<typeof ChatItem>;
export type UserItem = z.infer<typeof UserItem>;
export type AssistantItem = z.infer<typeof AssistantItem>;
export type ActivityItem = z.infer<typeof ActivityItem>;
export type PromptItem = z.infer<typeof PromptItem>;
export type NoticeItem = z.infer<typeof NoticeItem>;

// ---------------------------------------------------------------------------------------------
// The conversation with the assistant
// ---------------------------------------------------------------------------------------------

/** Runtime state of the assistant (the orchestrator agent behind the single chat). */
export const ConversationState = z.object({
  activity: z.enum(['idle', 'working', 'needs_user']),
  /** Last error from the assistant's process / provider, if any. */
  error: z.string().optional(),
});
export type ConversationState = z.infer<typeof ConversationState>;

/**
 * Activity rows the app adds to the conversation itself (not tool calls of the assistant):
 * a short report from a procedure's agent reached the assistant.
 */
export const REPORT_TOOL = 'procedure_report';
