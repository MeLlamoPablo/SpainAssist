import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AssistantMessage,
  Credential,
  CredentialStore,
  Message,
  ThinkingLevel,
  UserMessage,
} from '@earendil-works/pi-ai';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { classifyAgentError, configureModel, type PiCredential } from '@sa/agent';
import { APPOINTMENT_MORE } from '@sa/shared';
import { z } from 'zod';
import type { EvalModelChoice, EvalProvider, PendingPrompt } from '../contracts';
import type { CredentialSource } from './credentials';
import { writeFileAtomic } from './home';
import type { MeterRun } from './meter';
import { SecretRegistry } from './redact';

/**
 * The answerer: the cheap model that plays the user when a fixture's answer is `freeform`. Given
 * the persona, the instructions of the answer, a description of the form the app is asking (title,
 * message, field labels and options: never secret values) and the conversation so far, it returns
 * form values. It calls pi's `ModelRuntime.completeSimple` in process, like
 * `tools/scan-eval`, through the meter with the agent key `answerer`, so it is capped, metered
 * and cacheable like every other model call and works for both providers. Output is strict JSON,
 * validated with zod, with one repair retry. Every model call is written to a transcript sink
 * (the run's `answerer/` directory). Nothing in a prompt, a transcript or an error ever carries a
 * secret: registered secrets are refused before the call and masked everywhere they could appear.
 */

export const ANSWERER_AGENT_KEY = 'answerer';
export const DEFAULT_ANSWERER_MODEL = 'anthropic/claude-haiku-5.5';
/** The cheap Codex model, for runs on a ChatGPT plan. */
export const DEFAULT_CODEX_ANSWERER_MODEL = 'gpt-6-luna';
export const DEFAULT_ANSWERER_THINKING: EvalModelChoice['answererThinking'] = 'low';
/** Output budget; it includes thinking tokens, so even short answers need room. */
export const DEFAULT_ANSWERER_MAX_TOKENS = 2048;

export type AnswererErrorCode =
  /** The meter refused (budget, caps, kill switch): the run should end as a budget stop. */
  | 'budget'
  | 'replay_miss'
  | 'model_error'
  | 'invalid_output'
  | 'secret_in_prompt'
  | 'unsupported_prompt';

export class AnswererError extends Error {
  readonly code: AnswererErrorCode;
  constructor(code: AnswererErrorCode, message: string) {
    super(message);
    this.name = 'AnswererError';
    this.code = code;
  }
}

type FormValue = string | number | boolean | string[];

/** What the answerer is told about a question: `PendingPrompt` without ids. */
export interface AnswererPrompt {
  /** Only a `form` can be answered. */
  kind: PendingPrompt['kind'];
  title: string;
  message?: string | undefined;
  fields?: PendingPrompt['fields'] | undefined;
}

export interface ConversationTurn {
  from: 'agent' | 'user';
  text: string;
}

export interface AnswererRequest {
  /** The fixture's persona: who the user is and what they know. */
  persona: string;
  /** The `freeform` answer's instructions for this question. */
  instructions?: string;
  prompt: AnswererPrompt;
  /** Earlier turns, oldest first. */
  conversation?: readonly ConversationTurn[];
  language?: 'es' | 'en';
}

export interface AnswererResult {
  type: 'values';
  /** By field key; fields the persona does not know are left out. */
  values: Record<string, FormValue>;
  /** Keys of the fields that got no value (unknown to the persona). */
  skipped: string[];
}

/** One model call of the answerer, as written to the transcript. */
export interface AnswererRecord {
  /** Number of the answer (1-based), shared by its attempts. */
  n: number;
  /** 1, or 2 for the repair retry. */
  attempt: 1 | 2;
  at: string;
  provider: EvalProvider;
  model: string;
  thinking: string;
  request: { system: string; messages: { role: string; text: string }[] };
  response?: {
    text: string;
    stopReason: string;
    usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  };
  /** The validated outcome, when this attempt produced one. */
  parsed?: AnswererResult;
  /** Why the attempt failed (redacted). */
  error?: string;
}

export type TranscriptSink = (record: AnswererRecord) => void | Promise<void>;

/** A sink writing `<dir>/<nnn>-<attempt>.json` (0600), with the secrets masked. */
export function createDirectorySink(dir: string, secrets: readonly string[] = []): TranscriptSink {
  const registry = new SecretRegistry();
  for (const secret of secrets) registry.add(secret);
  return (record) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${String(record.n).padStart(3, '0')}-${record.attempt}.json`;
    writeFileAtomic(join(dir, name), `${registry.redact(JSON.stringify(record, null, 2))}\n`);
  };
}

export interface AnswererOptions {
  provider: EvalProvider;
  /** The meter run the calls go through (agent key `answerer`). */
  run: Pick<MeterRun, 'agentBaseUrl'>;
  /** Where the hosts' credential comes from (`createCredentialSource`). */
  credentials: CredentialSource;
  /** Default `anthropic/claude-haiku-5.5` (`gpt-6-luna` for Codex). */
  model?: string;
  /**
   * Default `low`. A level the model does not support moves to the nearest one it does: Haiku 5.5
   * has no `minimal`, so it becomes `low`; `off` goes out as effort `none` (`Answerer.thinking`).
   */
  thinking?: EvalModelChoice['answererThinking'];
  /** Default 2048. */
  maxTokens?: number;
  sink?: TranscriptSink;
  /** Values that must never reach the model or a transcript (passwords, PINs). */
  secrets?: readonly string[];
  /** Per model call; default 60 s, and 10 minutes for a local model (`LOCAL_TIMEOUT_MS`). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Answerer {
  readonly model: string;
  /** The reasoning level actually requested, after the model's supported levels were applied. */
  readonly thinking: string;
  answer(request: AnswererRequest): Promise<AnswererResult>;
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

type Field = NonNullable<AnswererPrompt['fields']>[number];

/** Fields the harness fills itself: secrets and vault documents are never the answerer's job. */
function answerable(field: Field): boolean {
  return !field.secret && field.type !== 'secret' && field.type !== 'document';
}

const FIELD_HINTS: Record<string, string> = {
  select: 'one option value',
  'map-options': 'one option value',
  multiselect: 'an array of option values',
  boolean: 'true or false',
  number: 'a number',
  date: 'a date as YYYY-MM-DD',
  appointment: 'one of the slots as YYYY-MM-DDTHH:MM, or "more" if none suits you',
};

function systemPrompt(request: AnswererRequest): string {
  const language = request.language === 'en' ? 'English' : 'Spanish';
  return [
    'You play the user in an automated test of Spain Assist, an assistant that completes Spanish administrative procedures for people. Stay in character: you are the person below, never an assistant.',
    '',
    'Who you are and what you know:',
    request.persona.trim(),
    ...(request.instructions?.trim()
      ? ['', 'Instructions for this answer:', request.instructions.trim()]
      : []),
    '',
    'Rules:',
    '- Answer only with what you know from the facts above. If they do not say, do not invent it: leave a form field out (null) or say you do not know.',
    '- Never make up passwords, PINs, codes, ID numbers, document numbers or any credential that the facts do not give.',
    `- Write in ${language}, informally, in short sentences.`,
    '- Reply with ONE JSON object and nothing else: no markdown fences, no commentary.',
  ].join('\n');
}

function userPrompt(request: AnswererRequest, fields: Field[]): string {
  const { prompt } = request;
  const conversation = (request.conversation ?? []).map((turn) => ({
    from: turn.from,
    text: turn.text,
  }));
  const shown = fields.map((field) => ({
    key: field.key,
    type: field.type,
    label: field.label,
    answer: FIELD_HINTS[field.type] ?? 'text',
    ...(field.options?.length
      ? { options: field.options.map((o) => ({ value: o.value, label: o.label })) }
      : {}),
    ...(field.slots?.length ? { slots: field.slots } : {}),
  }));
  return [
    'A form is shown to you:',
    JSON.stringify(
      {
        title: prompt.title,
        ...(prompt.message ? { message: prompt.message } : {}),
        fields: shown,
        ...(conversation.length > 0 ? { conversation } : {}),
      },
      null,
      2,
    ),
    '',
    'Reply with a JSON object whose keys are the field keys and whose values follow each field\'s "answer" hint. Use null for a field you cannot answer from the facts.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function fieldSchema(field: Field): z.ZodType<FormValue | null | undefined> {
  const options = field.options ?? [];
  const byValue = new Map(options.map((o) => [o.value, o.value]));
  const byLabel = new Map(options.map((o) => [o.label.trim().toLowerCase(), o.value]));
  const option = (value: string): string | undefined =>
    byValue.get(value) ?? byLabel.get(value.trim().toLowerCase());
  const optionSchema = z.string().transform((value, ctx) => {
    const found = option(value);
    if (found === undefined) {
      ctx.addIssue({ code: 'custom', message: 'must be one of the option values' });
      return z.NEVER;
    }
    return found;
  });
  let schema: z.ZodType<FormValue>;
  switch (field.type) {
    case 'select':
    case 'map-options':
      schema = options.length > 0 ? optionSchema : z.string();
      break;
    case 'multiselect':
      schema = z.array(options.length > 0 ? optionSchema : z.string());
      break;
    case 'boolean':
      schema = z.boolean();
      break;
    case 'number':
      schema = z.number();
      break;
    case 'date':
      schema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');
      break;
    case 'appointment':
      schema = z.enum([APPOINTMENT_MORE, ...(field.slots ?? [])]);
      break;
    default:
      schema = z.string();
  }
  return schema.nullable().optional();
}

/** The JSON object in a model reply: tolerates a markdown fence or text around it. */
function extractJson(text: string): unknown {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error('the reply has no JSON object');
  return JSON.parse(stripped.slice(start, end + 1));
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function validate(fields: Field[], text: string): AnswererResult {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (error) {
    throw new Error(
      error instanceof SyntaxError ? 'the reply is not valid JSON' : (error as Error).message,
    );
  }
  const shape: Record<string, z.ZodType<FormValue | null | undefined>> = {};
  for (const field of fields) shape[field.key] = fieldSchema(field);
  const parsed = z.strictObject(shape).safeParse(json);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  const values: Record<string, FormValue> = {};
  const skipped: string[] = [];
  for (const field of fields) {
    const value = parsed.data[field.key];
    if (value === null || value === undefined) skipped.push(field.key);
    else values[field.key] = value;
  }
  return { type: 'values', values, skipped };
}

// ---------------------------------------------------------------------------------------------
// The answerer
// ---------------------------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * A model on the developer's own machine reads a long conversation slowly (over a minute per
 * request for a small quantized model on a laptop): a gateway's timeout would end the run.
 */
const LOCAL_TIMEOUT_MS = 10 * 60_000;

const PI_PROVIDER: Record<EvalProvider, string> = {
  voucher: 'litellm',
  mock: 'litellm',
  local: 'litellm',
  codex: 'openai-codex',
};

function toPiCredential(credential: PiCredential | null): Credential | undefined {
  return credential ? (credential as unknown as Credential) : undefined;
}

/** pi's credential store over the run's credential source (OAuth refresh goes through its lock). */
function credentialStore(source: CredentialSource): CredentialStore {
  return {
    read: async (id) => toPiCredential(await source.credential(id)),
    list: async () => {
      const credential = await source.credential(source.providerId);
      return credential ? [{ providerId: source.providerId, type: credential.type }] : [];
    },
    modify: async (id, fn) => {
      if (id !== source.providerId) return fn(undefined);
      const current = toPiCredential(await source.credential(id));
      if (current?.type === 'oauth') return toPiCredential(await source.refreshCredential(id));
      return (await fn(current)) ?? current;
    },
    delete: async () => {},
  };
}

function textOf(message: AssistantMessage): string {
  return message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function errorFor(message: string): AnswererError {
  if (/out of budget|quota exceeded|budget has been exceeded/i.test(message)) {
    return new AnswererError('budget', message);
  }
  if (/replay cache miss/i.test(message)) return new AnswererError('replay_miss', message);
  return new AnswererError('model_error', message);
}

export async function createAnswerer(options: AnswererOptions): Promise<Answerer> {
  const piProvider = PI_PROVIDER[options.provider];
  const modelId =
    options.model ??
    (options.provider === 'codex' ? DEFAULT_CODEX_ANSWERER_MODEL : DEFAULT_ANSWERER_MODEL);
  const maxTokens = options.maxTokens ?? DEFAULT_ANSWERER_MAX_TOKENS;
  const secrets = new SecretRegistry();
  for (const secret of options.secrets ?? []) secrets.add(secret);

  const runtime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    credentials: credentialStore(options.credentials),
  });
  const model = configureModel(runtime, {
    provider: piProvider,
    id: modelId,
    baseUrl: options.run.agentBaseUrl(ANSWERER_AGENT_KEY),
    maxTokens,
  });
  // What the model supports decides the level (pi would clamp it too, but an unsupported `off`
  // would be sent as no reasoning parameter at all, which the gateway may treat differently).
  const thinking = clampThinkingLevel(model, options.thinking ?? DEFAULT_ANSWERER_THINKING);
  const timeoutMs =
    options.timeoutMs ?? (options.provider === 'local' ? LOCAL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  let answers = 0;

  const call = (system: string, messages: Message[]): Promise<AssistantMessage> => {
    const signal = AbortSignal.any(
      [AbortSignal.timeout(timeoutMs), options.signal].filter((s): s is AbortSignal => !!s),
    );
    return runtime.completeSimple(
      model,
      { systemPrompt: system, messages },
      {
        maxTokens,
        signal,
        ...(thinking !== 'off' ? { reasoning: thinking as ThinkingLevel } : {}),
      },
    );
  };

  const record = async (entry: AnswererRecord): Promise<void> => {
    await options.sink?.(JSON.parse(secrets.redact(JSON.stringify(entry))) as AnswererRecord);
  };

  const snapshot = (messages: Message[]): { role: string; text: string }[] =>
    messages.map((m) => ({
      role: m.role,
      text:
        m.role === 'user'
          ? typeof m.content === 'string'
            ? m.content
            : m.content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('')
          : m.role === 'assistant'
            ? textOf(m)
            : '',
    }));

  return {
    model: modelId,
    thinking,
    async answer(request) {
      if (request.prompt.kind !== 'form') {
        throw new AnswererError(
          'unsupported_prompt',
          `The answerer answers forms, not ${request.prompt.kind} prompts`,
        );
      }
      const n = ++answers;
      const fields = (request.prompt.fields ?? []).filter(answerable);
      if (fields.length === 0) return { type: 'values', values: {}, skipped: [] };
      const system = systemPrompt(request);
      const user = userPrompt(request, fields);
      if (secrets.has(`${system}\n${user}`)) {
        throw new AnswererError(
          'secret_in_prompt',
          'A secret value is in the answerer prompt: secrets must come from structured answers only',
        );
      }
      const first: UserMessage = { role: 'user', content: user, timestamp: Date.now() };
      const messages: Message[] = [first];

      let lastProblem = '';
      for (const attempt of [1, 2] as const) {
        const base: AnswererRecord = {
          n,
          attempt,
          at: new Date().toISOString(),
          provider: options.provider,
          model: modelId,
          thinking,
          request: { system, messages: snapshot(messages) },
        };
        let message: AssistantMessage;
        try {
          message = await call(system, messages);
        } catch (error) {
          const text = secrets.redact(error instanceof Error ? error.message : String(error));
          await record({ ...base, error: text });
          throw new AnswererError('model_error', text);
        }
        const text = textOf(message);
        const response = {
          text,
          stopReason: message.stopReason,
          usage: {
            input: message.usage.input,
            output: message.usage.output,
            cacheRead: message.usage.cacheRead,
            cacheWrite: message.usage.cacheWrite,
          },
        };
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          const problem = secrets.redact(
            message.errorMessage ?? `the model call ${message.stopReason}`,
          );
          await record({ ...base, response, error: problem });
          const failure = errorFor(problem);
          if (failure.code === 'model_error' && classifyAgentError(problem) === 'quota') {
            throw new AnswererError('budget', problem);
          }
          throw failure;
        }
        try {
          const result = validate(fields, text);
          await record({ ...base, response, parsed: result });
          return result;
        } catch (error) {
          lastProblem = secrets.redact((error as Error).message);
          await record({ ...base, response, error: `invalid output: ${lastProblem}` });
          if (attempt === 2) break;
          messages.push(message, {
            role: 'user',
            content: `Your reply was not valid: ${lastProblem}. Reply again with only the JSON object.`,
            timestamp: Date.now(),
          });
        }
      }
      throw new AnswererError(
        'invalid_output',
        `The answerer did not return valid JSON after a repair retry: ${lastProblem}`,
      );
    },
  };
}
