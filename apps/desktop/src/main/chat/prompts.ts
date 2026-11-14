import {
  APPOINTMENT_MORE,
  ASSISTANT_AGENT_ID,
  type FormField,
  type FormPrompt,
  type FormValue,
  type Language,
  matchProvince,
  type Prompt,
  type PromptItem,
  type PromptResponse,
  visibleFormFields,
} from '@sa/shared';
import { currentCaller } from '../bridge/caller';
import type { ConversationService } from '../conversation/service';
import { PromptCancelledError, UserError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import type { Clock } from '../core/util';
import type { MapPins } from '../places/resolve-form';
import type { ProcedureService } from '../procedures/service';

/** Shown in the transcript instead of secret values. */
export const REDACTED = '••••';

export interface AskOptions {
  /** Cancels the prompt (e.g. the agent's HTTP request closed because the run was aborted). */
  signal?: AbortSignal;
  /** Map pins found for a form before it was shown (memory only, never saved). */
  mapPins?: MapPins;
  /** Gets the item id as soon as the prompt is shown (for `update` and `settle`). */
  onShown?(itemId: string): void;
}

interface PendingPrompt {
  /** Where it is stored: the procedure the asking agent acts on, or ASSISTANT_AGENT_ID. */
  owner: string;
  /** The agent whose bridge call showed it (it waits on the answer). */
  asker?: string;
  item: PromptItem;
  resolve(response: PromptResponse): void;
  reject(err: Error): void;
  cleanup(): void;
  /** Map pins for a form's map fields: in memory only, dropped with the prompt. */
  mapPins?: MapPins;
}

/**
 * Native prompts (confirmations, manual actions, credentials, phone calls, the app's own forms).
 * An agent's questions are stored on the procedure it acts on (its runtime and activity log) and
 * shown above the cards ("Para ti"), never in the conversation. `ask` resolves when the user
 * answers through `chat.respond`: the answer goes straight back to the agent that asked. Secret
 * form fields are never stored: the transcript keeps "••••" instead.
 */
export class PromptManager {
  private readonly pending = new Map<string, PendingPrompt>();

  constructor(
    private readonly deps: {
      procedures: ProcedureService;
      conversation: ConversationService;
      logger: Logger;
      clock: Clock;
      lang: () => Language;
      /** An agent started or stopped waiting for the user on prompts it showed. */
      onAsking?(agentId: string, asking: boolean): void;
    },
  ) {}

  /** Cancels every pending prompt before shutdown: none outlives its agent's bridge call. */
  suspend(): void {
    for (const id of [...this.pending.keys()]) this.finishCancelled(id);
  }

  ask(owner: string, prompt: Prompt, opts: AskOptions = {}): Promise<PromptResponse> {
    const { procedures, conversation } = this.deps;
    const procedureId = owner === ASSISTANT_AGENT_ID ? undefined : owner;
    if (procedureId) procedures.require(procedureId);
    if (opts.signal?.aborted) return Promise.reject(new PromptCancelledError());
    const item: PromptItem = {
      id: procedureId ? procedures.newItemId('q') : conversation.newItemId('q'),
      createdAt: this.deps.clock().toISOString(),
      type: 'prompt',
      ...(procedureId ? { procedureId } : {}),
      prompt,
      status: 'pending',
    };
    const asker = currentCaller();
    return new Promise<PromptResponse>((resolve, reject) => {
      const onAbort = () => this.finishCancelled(item.id);
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(item.id, {
        owner,
        item,
        resolve,
        reject,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
        ...(opts.mapPins ? { mapPins: opts.mapPins } : {}),
        ...(asker ? { asker } : {}),
      });
      this.syncAsker(asker);
      this.store(owner, item);
      if (procedureId) procedures.setUnread(procedureId);
      this.sync(owner);
      this.deps.logger.info('prompt shown', { owner, itemId: item.id, kind: prompt.kind });
      opts.onShown?.(item.id);
    });
  }

  /** Replaces what a pending prompt shows (same kind), e.g. a DNIe signature's progress. */
  update(itemId: string, prompt: Prompt): void {
    const entry = this.pending.get(itemId);
    if (!entry || entry.item.prompt.kind !== prompt.kind) return;
    entry.item = { ...entry.item, prompt };
    this.store(entry.owner, entry.item);
    this.sync(entry.owner);
  }

  /** Ends a pending prompt with an answer from the app itself (not the user). */
  settle(itemId: string, response: PromptResponse): void {
    const entry = this.pending.get(itemId);
    if (!entry || response.kind !== entry.item.prompt.kind) return;
    this.complete(entry, sanitizeResponse(entry.item.prompt, response, this.deps.lang()));
  }

  respond(itemId: string, response: PromptResponse): void {
    const entry = this.pending.get(itemId);
    if (!entry) throw new UserError(t(this.deps.lang(), 'promptNotPending'), 'not_pending');
    if (
      response.kind !== entry.item.prompt.kind ||
      // Only the app says a DNIe signature is signed or failed; the user can only cancel it.
      (response.kind === 'dnie_signature' && response.outcome !== 'cancelled')
    )
      throw new UserError(t(this.deps.lang(), 'invalidRequest'), 'bad_request');
    this.complete(entry, sanitizeResponse(entry.item.prompt, response, this.deps.lang()));
  }

  private complete(entry: PendingPrompt, clean: PromptResponse): void {
    const itemId = entry.item.id;
    this.pending.delete(itemId);
    entry.cleanup();
    this.syncAsker(entry.asker);
    this.store(entry.owner, {
      ...entry.item,
      status: 'answered',
      response: redactResponse(entry.item.prompt, clean),
    });
    this.sync(entry.owner);
    this.deps.logger.info('prompt answered', { owner: entry.owner, itemId, kind: clean.kind });
    entry.resolve(clean);
  }

  /**
   * Cancels every pending prompt stored under `id` (a deleted procedure) or asked by it (an agent
   * that stopped, was aborted or crashed).
   */
  cancelAll(id: string): void {
    for (const [itemId, entry] of this.pending) {
      if (entry.owner === id || entry.asker === id) this.finishCancelled(itemId);
    }
  }

  /**
   * Cancels these prompts if still pending (a message made them obsolete); the agent that asked
   * gets `reason`. Returns how many were still pending.
   */
  cancel(itemIds: readonly string[], reason?: string): number {
    let n = 0;
    for (const id of itemIds) if (this.finishCancelled(id, reason)) n++;
    return n;
  }

  cancelEverything(): void {
    for (const id of [...this.pending.keys()]) this.finishCancelled(id);
  }

  /** A pending prompt by item id (whoever asked). */
  pendingItem(itemId: string): PromptItem | undefined {
    return this.pending.get(itemId)?.item;
  }

  /** Every pending prompt with the agent that asked it, oldest first. */
  pendingItems(): { asker?: string; item: PromptItem }[] {
    return [...this.pending.values()].map(({ asker, item }) => ({
      ...(asker ? { asker } : {}),
      item,
    }));
  }

  /** The in-memory map pins of a pending prompt (never part of the saved item). */
  mapPins(itemId: string): MapPins | undefined {
    const entry = this.pending.get(itemId);
    if (!entry) return;
    entry.mapPins ??= new Map();
    return entry.mapPins;
  }

  /** Pending prompts stored under `id` or asked by it. */
  pendingCount(id: string): number {
    let n = 0;
    for (const entry of this.pending.values()) if (entry.owner === id || entry.asker === id) n++;
    return n;
  }

  private finishCancelled(itemId: string, reason?: string): boolean {
    const entry = this.pending.get(itemId);
    if (!entry) return false;
    this.pending.delete(itemId);
    entry.cleanup();
    this.syncAsker(entry.asker);
    this.store(entry.owner, { ...entry.item, status: 'cancelled' });
    this.sync(entry.owner);
    entry.reject(new PromptCancelledError(reason));
    return true;
  }

  /** The assistant's questions go to the conversation, a procedure's to its activity log. */
  private store(owner: string, item: PromptItem): void {
    if (owner === ASSISTANT_AGENT_ID) this.deps.conversation.upsertItem(item);
    else this.deps.procedures.upsertItem(owner, item);
  }

  private syncAsker(asker: string | undefined): void {
    if (!asker || asker === ASSISTANT_AGENT_ID || !this.deps.onAsking) return;
    let asking = false;
    for (const entry of this.pending.values()) if (entry.asker === asker) asking = true;
    this.deps.onAsking(asker, asking);
  }

  private sync(owner: string): void {
    if (owner === ASSISTANT_AGENT_ID) {
      this.deps.conversation.setPendingPrompts(this.pendingCount(owner));
      return;
    }
    const items: PromptItem[] = [];
    for (const entry of this.pending.values()) if (entry.owner === owner) items.push(entry.item);
    this.deps.procedures.setPrompts(owner, items);
  }
}

/** One of the slots offered, or a request for others. */
function appointmentAnswer(field: FormField, value: FormValue): value is string {
  return (
    typeof value === 'string' && (value === APPOINTMENT_MORE || !!field.slots?.includes(value))
  );
}

/** Keeps only declared fields with values of the right shape. */
export function sanitizeResponse(
  prompt: Prompt,
  response: PromptResponse,
  language: Language = 'es',
): PromptResponse {
  if (prompt.kind !== 'form' || response.kind !== 'form') return response;
  if (response.dismissed || !response.values) {
    return { kind: 'form', dismissed: true, savedToVault: [] };
  }
  const values: Record<string, FormValue> = {};
  const visible = new Set(visibleFormFields(prompt.fields, response.values).map((f) => f.key));
  for (const field of prompt.fields) {
    const value = response.values[field.key];
    if (field.type === 'map-options' && !visible.has(field.key)) continue;
    if (value === undefined) {
      if (field.type === 'map-options' && field.required && visible.has(field.key)) {
        throw new UserError(t(language, 'invalidRequest'), 'bad_request');
      }
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof value === 'boolean') values[field.key] = value;
    } else if (field.type === 'multiselect') {
      if (Array.isArray(value)) values[field.key] = value.slice(0, 50);
    } else if (field.type === 'province') {
      const province = typeof value === 'string' ? matchProvince(value) : undefined;
      if (province) values[field.key] = province.value;
    } else if (field.type === 'map-options') {
      if (typeof value === 'string' && field.options?.some((o) => o.value === value))
        values[field.key] = value;
      else throw new UserError(t(language, 'invalidRequest'), 'bad_request');
    } else if (field.type === 'appointment') {
      if (appointmentAnswer(field, value)) values[field.key] = value;
      else throw new UserError(t(language, 'invalidRequest'), 'bad_request');
    } else if (typeof value === 'string') {
      values[field.key] = value;
    }
  }
  const active = new Set(visibleFormFields(prompt.fields, values).map((field) => field.key));
  for (const key of Object.keys(values)) if (!active.has(key)) delete values[key];
  const savable = new Set(
    prompt.fields
      .filter((f) => f.vaultKey && f.type !== 'secret' && f.type !== 'document')
      .map((f) => f.key),
  );
  const savedToVault = [...new Set(response.savedToVault)].filter(
    (key) => savable.has(key) && typeof values[key] === 'string',
  );
  return {
    kind: 'form',
    values,
    dismissed: false,
    savedToVault,
    ...(response.vaultErrors?.length ? { vaultErrors: response.vaultErrors.slice(0, 50) } : {}),
  };
}

/** What the transcript keeps: secret fields masked. */
function redactResponse(prompt: Prompt, response: PromptResponse): PromptResponse {
  if (prompt.kind !== 'form' || response.kind !== 'form' || !response.values) return response;
  const secretKeys = new Set(
    (prompt as FormPrompt).fields.filter((f) => f.type === 'secret').map((f) => f.key),
  );
  if (secretKeys.size === 0) return response;
  const values: Record<string, FormValue> = {};
  for (const [key, value] of Object.entries(response.values)) {
    values[key] = secretKeys.has(key) ? REDACTED : value;
  }
  return { ...response, values };
}
