import { buildResponse, initialValues } from '@sa/desktop/form-logic';
import type { FormField, PromptResponse } from '@sa/shared';
import {
  AnswerState,
  type AnswerStateSnapshot,
  describePrompt,
  resolveFormAction,
  validateFormValues,
} from '../answers';
import type {
  Answer,
  EvalApp,
  Fixture,
  Observation,
  ObservationSink,
  PendingPrompt,
} from '../contracts';
import { type Answerer, AnswererError, type ConversationTurn } from '../llm';

/**
 * The simulated user. It answers every prompt the app shows, one at a time and in the order the
 * prompts appeared, following the fixture's answer groups (`AnswerState`): structured answers are
 * programmatic (forms are built with the renderer's own `formLogic`, credentials go through the
 * UI's path `addClave` + `respond`), `freeform` answers and the `answerer` policy go to the
 * answerer model, which is only created the first time it is needed. What no scripted answer
 * covers follows `Fixture.unexpectedPrompt`.
 *
 * Problems end up in two callbacks: `onUnexpected` (the fixture's `fail` policy met a prompt it
 * has no answer for, or a prompt the simulator cannot answer at all) and `onFatal` (a fixture
 * bug, a failed `respond`, an answerer error such as an exhausted budget). After either the
 * simulator answers nothing more.
 */

/** The log as the simulator uses it: it hears every observation and pushes its own. */
interface ObservationFeed extends ObservationSink {
  on(listener: (observation: Observation) => void): () => void;
}

export type SimulatorErrorCode =
  /** A scripted answer does not fit the prompt it matched: a bug of the fixture. */
  | 'invalid_answer'
  /** The app refused an answer for a prompt that is still pending. */
  | 'respond_failed';

export class SimulatorError extends Error {
  constructor(
    readonly code: SimulatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SimulatorError';
  }
}

export interface UserSimulatorOptions {
  fixture: Pick<Fixture, 'persona' | 'language' | 'answerGroups' | 'unexpectedPrompt'>;
  app: Pick<EvalApp, 'pendingPrompts' | 'respond' | 'addClave'>;
  log: ObservationFeed;
  /** The answer cursor of a checkpoint. */
  state?: AnswerStateSnapshot;
  /** What was said before this simulator started (a resumed run's log): the answerer's context. */
  history?: readonly Observation[];
  /** Creates the answerer on first use (a run that never needs one never pays for it). */
  answerer?: () => Promise<Answerer>;
  /** Registers a secret (a password about to be saved) before it is used anywhere. */
  secrets: (value: string) => void;
  /** Masks registered secrets in the text the answerer is shown. */
  scrub?: (text: string) => string;
  /** The prompt cannot be answered: the run should end as `unexpected-prompt`. */
  onUnexpected(prompt: PendingPrompt, reason: string): void;
  /** The simulator cannot continue: the run should end (an error, or a budget stop). */
  onFatal(error: Error): void;
  /** A human-like pause before each answer (default 0). */
  delayMs?: number;
  /** Tests: how a pause is waited. Must reject or resolve early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface UserSimulator {
  /** Listens for prompts and answers the ones already pending (a resumed run's restored forms). */
  start(): void;
  /** Stops answering now; an answer in flight is abandoned. */
  stop(): Promise<void>;
  /** The answer cursor, for `CheckpointManifest.answerState`. */
  state(): AnswerStateSnapshot;
  /** Ids of the scripted answers that were needed and never used. */
  unusedRequired(): string[];
  /** Resolves once no prompt is queued or being answered. */
  settled(): Promise<void>;
}

const MAX_TURNS = 12;
const MAX_TURN_CHARS = 1200;

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

/**
 * The renderer's form model from what the harness knows of a prompt's fields: everything the UI's
 * own logic reads, so `buildResponse` fills `savedToVault` (the app then stores those answers
 * under their `vaultKey`, as it does for a person) and leaves out the fields a select hides.
 */
function toFormFields(fields: NonNullable<PendingPrompt['fields']>): FormField[] {
  return fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type as FormField['type'],
    required: field.required ?? true,
    ...(field.options ? { options: field.options.map((o) => ({ ...o })) } : {}),
    ...(field.vaultKey ? { vaultKey: field.vaultKey } : {}),
    ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
    ...(field.visibleWhen
      ? { visibleWhen: { field: field.visibleWhen.field, values: [...field.visibleWhen.values] } }
      : {}),
  }));
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createUserSimulator(options: UserSimulatorOptions): UserSimulator {
  const { fixture, app, log } = options;
  const state = new AnswerState(fixture.answerGroups, options.state);
  const scrub = options.scrub ?? ((text: string) => text);
  const sleep = options.sleep ?? defaultSleep;
  const delayMs = options.delayMs ?? 0;
  const stopController = new AbortController();

  const queue: PendingPrompt[] = [];
  const seen = new Set<string>();
  const waiters: (() => void)[] = [];
  const turns: ConversationTurn[] = [];
  let off: (() => void) | undefined;
  let working = false;
  let stopped = false;
  let answerer: Promise<Answerer> | undefined;

  const busy = () => !stopped && (working || queue.length > 0);

  function wake(): void {
    if (busy()) return;
    for (const resolve of waiters.splice(0)) resolve();
  }

  function halt(): void {
    stopped = true;
    stopController.abort();
    off?.();
    off = undefined;
    queue.length = 0;
    wake();
  }

  function note(text: string): void {
    if (!stopped) log.push({ type: 'note', text });
  }

  function remember(turn: ConversationTurn): void {
    turns.push({ from: turn.from, text: shorten(scrub(turn.text), MAX_TURN_CHARS) });
    if (turns.length > MAX_TURNS * 2) turns.splice(0, turns.length - MAX_TURNS * 2);
  }

  /** What the conversation adds to the answerer's context. */
  function recall(observation: Observation): void {
    if (observation.type === 'assistant_message') {
      remember({ from: 'agent', text: observation.text });
    } else if (observation.type === 'user_message') {
      remember({ from: 'user', text: observation.text });
    }
  }

  function hear(observation: Observation): void {
    if (observation.type === 'prompt_shown') enqueue(observation.prompt);
    else recall(observation);
  }

  function enqueue(prompt: PendingPrompt): void {
    if (stopped || seen.has(prompt.itemId)) return;
    seen.add(prompt.itemId);
    queue.push(prompt);
    void pump();
  }

  async function pump(): Promise<void> {
    if (working) return;
    working = true;
    try {
      // Never answer from inside the observation that announced the prompt: the app may still be
      // registering it.
      await nextTurn();
      while (!stopped) {
        const prompt = queue.shift();
        if (!prompt) break;
        try {
          await answer(prompt);
        } catch (error) {
          if (stopped) break;
          const failure = error instanceof Error ? error : new Error(String(error));
          halt();
          options.onFatal(failure);
        }
      }
    } finally {
      working = false;
      wake();
    }
  }

  // -------------------------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------------------------

  async function answer(prompt: PendingPrompt): Promise<void> {
    const decision = state.decide(prompt, fixture.unexpectedPrompt);
    switch (decision.type) {
      case 'fail':
        refuse(prompt, decision.reason);
        return;
      case 'default':
        await send(prompt, decision.response, { by: 'default' });
        return;
      case 'improvise':
        await freeform(prompt, decision.instructions, undefined);
        return;
      case 'answer':
        await scripted(prompt, decision.answer);
        return;
    }
  }

  /** The run cannot go on with this prompt: report it and answer nothing more. */
  function refuse(prompt: PendingPrompt, reason: string): void {
    halt();
    options.onUnexpected(prompt, reason);
  }

  async function scripted(prompt: PendingPrompt, answer: Answer): Promise<void> {
    const { action } = answer;
    switch (action.type) {
      case 'select':
      case 'values': {
        const resolved = resolveFormAction(action, prompt);
        if (resolved.issues.length > 0 || Object.keys(resolved.values).length === 0) {
          const problems = [
            ...resolved.issues,
            ...(resolved.ignored.length > 0
              ? [`not fields of the form: ${resolved.ignored.join(', ')}`]
              : []),
          ];
          throw new SimulatorError(
            'invalid_answer',
            `answer "${answer.id}" does not fit ${describePrompt(prompt)}: ${
              problems.join('; ') || 'it sets no field'
            }`,
          );
        }
        if (resolved.ignored.length > 0) {
          note(
            `answer ${answer.id}: ignored fields that the form does not have: ${resolved.ignored.join(', ')}`,
          );
        }
        await send(prompt, formResponse(prompt, resolved.values), {
          by: 'structured',
          answerId: answer.id,
        });
        return;
      }
      case 'typed': {
        // The form's secret field (what `browser_fill_from_user` asks for), else its only text field.
        const fields = (prompt.fields ?? []).filter((field) => field.type !== 'document');
        const secret = fields.find((field) => field.secret || field.type === 'secret');
        const texts = fields.filter((field) => field.type === 'text');
        const target = secret ?? (texts.length === 1 ? texts[0] : undefined);
        if (!target) {
          throw new SimulatorError(
            'invalid_answer',
            `answer "${answer.id}" does not fit ${describePrompt(prompt)}: no secret field and not exactly one text field`,
          );
        }
        await send(prompt, formResponse(prompt, { [target.key]: action.value }), {
          by: 'structured',
          answerId: answer.id,
        });
        return;
      }
      case 'credential': {
        options.secrets(action.password);
        const credentialId = await app.addClave({
          username: action.username,
          password: action.password,
        });
        await send(
          prompt,
          { kind: 'credential', credentialId },
          { by: 'structured', answerId: answer.id },
        );
        return;
      }
      case 'confirm':
        await send(
          prompt,
          { kind: 'confirm', approved: action.approved },
          { by: 'structured', answerId: answer.id },
        );
        return;
      case 'user_action':
        await send(
          prompt,
          {
            kind: 'user_action',
            done: action.done,
            ...(action.note !== undefined ? { note: action.note } : {}),
          },
          { by: 'structured', answerId: answer.id },
        );
        return;
      case 'freeform':
        await freeform(prompt, action.instructions, answer.id);
        return;
    }
  }

  // -------------------------------------------------------------------------------------------
  // The answerer
  // -------------------------------------------------------------------------------------------

  async function freeform(
    prompt: PendingPrompt,
    instructions: string,
    answerId: string | undefined,
  ): Promise<void> {
    if (prompt.kind !== 'form') {
      refuse(
        prompt,
        `the answerer only answers forms, not ${prompt.kind} prompts: ${describePrompt(prompt)}`,
      );
      return;
    }
    if (!options.answerer) {
      throw new SimulatorError(
        'invalid_answer',
        `${describePrompt(prompt)} needs the answerer model, but this run has none`,
      );
    }
    answerer ??= options.answerer();
    const model = await answerer;
    if (stopped) return;
    let result: Awaited<ReturnType<Answerer['answer']>>;
    try {
      result = await model.answer({
        persona: fixture.persona,
        instructions,
        prompt: {
          kind: 'form',
          title: scrub(prompt.title),
          ...(prompt.message ? { message: scrub(prompt.message) } : {}),
          fields: prompt.fields,
        },
        conversation: turns.slice(-MAX_TURNS),
        ...(fixture.language ? { language: fixture.language } : {}),
      });
    } catch (error) {
      if (error instanceof AnswererError && error.code === 'invalid_output') {
        note(`the answerer gave no valid answer for ${describePrompt(prompt)}: dismissed`);
        await send(prompt, dismissal(), { by: 'answerer', ...(answerId ? { answerId } : {}) });
        return;
      }
      throw error;
    }
    if (stopped) return;
    const checked = validateFormValues(prompt.fields ?? [], result.values);
    if (checked.issues.length > 0) {
      note(`answerer values dropped for ${describePrompt(prompt)}: ${checked.issues.join('; ')}`);
    }
    const response =
      Object.keys(checked.values).length === 0 ? dismissal() : formResponse(prompt, checked.values);
    await send(prompt, response, { by: 'answerer', ...(answerId ? { answerId } : {}) });
  }

  // -------------------------------------------------------------------------------------------
  // Answering
  // -------------------------------------------------------------------------------------------

  function dismissal(): PromptResponse {
    return { kind: 'form', dismissed: true, savedToVault: [] };
  }

  /** What the UI submits: the field defaults, then the values, the way `buildResponse` shapes them. */
  function formResponse(
    prompt: PendingPrompt,
    values: Record<string, string | string[] | boolean>,
  ): PromptResponse {
    const fields = toFormFields(prompt.fields ?? []);
    return buildResponse(fields, { ...initialValues(fields), ...values });
  }

  async function send(
    prompt: PendingPrompt,
    response: PromptResponse,
    how: { by: 'structured' | 'answerer' | 'default'; answerId?: string },
  ): Promise<void> {
    if (delayMs > 0) await sleep(delayMs, stopController.signal);
    if (stopped) return;
    log.push({
      type: 'prompt_answered',
      itemId: prompt.itemId,
      ...(how.answerId ? { answerId: how.answerId } : {}),
      by: how.by,
    });
    if (response.kind === 'form' && !response.dismissed) {
      remember({
        from: 'agent',
        text: `${prompt.title}${prompt.message ? `\n${prompt.message}` : ''}`,
      });
      remember({ from: 'user', text: describeForm(prompt, response) });
    }
    try {
      await app.respond(prompt.itemId, response);
    } catch (error) {
      if (stopped) return;
      const message = error instanceof Error ? error.message : String(error);
      if (app.pendingPrompts().some((pending) => pending.itemId === prompt.itemId)) {
        throw new SimulatorError(
          'respond_failed',
          `the app refused the answer to ${describePrompt(prompt)}: ${message}`,
        );
      }
      note(`prompt ${prompt.itemId} was no longer pending when it was answered: ${message}`);
    }
  }

  function describeForm(
    prompt: PendingPrompt,
    response: Extract<PromptResponse, { kind: 'form' }>,
  ): string {
    const lines: string[] = [];
    for (const field of prompt.fields ?? []) {
      const value = response.values?.[field.key];
      if (value === undefined || field.secret || field.type === 'secret') continue;
      const label = (raw: string) => field.options?.find((o) => o.value === raw)?.label ?? raw;
      const shown = Array.isArray(value) ? value.map(label).join(', ') : label(String(value));
      lines.push(`${field.label}: ${shown}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'I answered the form.';
  }

  return {
    start() {
      if (off || stopped) return;
      for (const observation of options.history ?? []) recall(observation);
      off = log.on(hear);
      for (const prompt of app.pendingPrompts()) enqueue(prompt);
    },
    async stop() {
      halt();
    },
    state: () => state.snapshot(),
    unusedRequired: () => state.unusedRequired(),
    settled() {
      if (!busy()) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
