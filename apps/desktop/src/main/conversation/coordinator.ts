import { REPORT_PREFIX } from '@sa/agent';
import {
  type ActivityItem,
  ASSISTANT_AGENT_ID,
  type Language,
  type Procedure,
  REPORT_TOOL,
} from '@sa/shared';
import type { AgentManager, SendOptions } from '../agents/manager';
import type { RunResult } from '../chat/mapper';
import type { PromptManager } from '../chat/prompts';
import { friendlyAgentError, NoProviderError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage } from '../core/util';
import type { ProcedureService } from '../procedures/service';
import type { ConversationService } from './service';

/** Upward communication is minimal: a report never exceeds this (the assistant lives forever). */
export const MAX_REPORT_CHARS = 600;

export interface CoordinatorDeps {
  procedures: ProcedureService;
  conversation: ConversationService;
  agents: AgentManager;
  prompts: PromptManager;
  logger: Logger;
  clock: Clock;
  lang(): Language;
}

/**
 * Glue between the assistant (orchestrator) and the procedure agents:
 *   - down: the assistant's `procedures.start` / `procedures.message` / `procedures.cancel`;
 *   - up: when a procedure's agent finishes a run, a short report (card status + its last
 *     message, clipped) is queued to the assistant, and shown in the chat as a compact row.
 * Procedure agents ask the user directly; the coordinator can abort obsolete requests on resume.
 */
export class Coordinator {
  private readonly deliveries = new Set<Promise<void>>();

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Creates a procedure and waits for agent acceptance, not for the run to finish. */
  async start(title: string, brief: string): Promise<Procedure> {
    const procedure = await this.deps.procedures.create(title);
    await this.dispatch(procedure.id, brief);
    return procedure;
  }

  /** Passes a message to a procedure's agent. Queued if it is busy. */
  message(procedureId: string, text: string): Promise<'started' | 'queued'> {
    this.deps.procedures.require(procedureId);
    return this.dispatch(procedureId, text);
  }

  /** Abort the old run and pending requests, then start with the user's change of plan. */
  resume(procedureId: string, text: string): Promise<'started' | 'queued'> {
    this.deps.procedures.require(procedureId);
    return this.dispatch(procedureId, text, { restart: true });
  }

  /** Stops a procedure's agent and marks it cancelled. False if it was already over. */
  async cancel(procedureId: string, reason?: string): Promise<boolean> {
    const { procedures } = this.deps;
    const procedure = procedures.require(procedureId);
    const wasActive = this.deps.agents.isActive(procedureId);
    await this.deps.agents.stop(procedureId);
    this.deps.prompts.cancelAll(procedureId);
    if (procedure.status === 'cancelled' || procedure.status === 'done') return wasActive;
    procedures.applyUpdate(procedureId, { status: 'cancelled', nextAction: null });
    if (reason) procedures.addNotice(procedureId, 'info', reason);
    return true;
  }

  /** Interrupts a procedure's current run at the user's explicit request. */
  async stop(procedureId: string): Promise<void> {
    this.deps.procedures.require(procedureId);
    await this.deps.agents.abort(procedureId);
  }

  /** Waits for background deliveries (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries]);
  }

  private track(promise: Promise<void>): void {
    const delivery = promise.finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
  }

  private dispatch(
    procedureId: string,
    text: string,
    options: SendOptions = { followUp: true },
  ): Promise<'started' | 'queued'> {
    const { procedures, agents } = this.deps;
    // The procedure's log shows what it was asked to do (the brief, or the assistant's message).
    procedures.upsertItem(procedureId, {
      id: procedures.newItemId('u'),
      createdAt: this.deps.clock().toISOString(),
      type: 'user',
      text,
    });
    procedures.setError(procedureId, undefined);
    procedures.setRunning(procedureId, true);
    procedures.touch(procedureId);
    const delivery = agents.send(procedureId, text, undefined, options).catch((err) => {
      if (!procedures.has(procedureId)) throw err;
      const lang = this.deps.lang();
      const message =
        err instanceof NoProviderError
          ? t(lang, 'agentErrorNoProvider')
          : friendlyAgentError(errorMessage(err), lang);
      this.deps.logger.warn('procedure delivery failed', {
        procedureId,
        error: errorMessage(err),
      });
      procedures.setRunning(procedureId, false);
      procedures.addNotice(procedureId, 'error', message);
      procedures.setError(procedureId, message);
      this.onRunEnd(procedureId, { aborted: false, error: message, text: '' });
      throw err;
    });
    // Track acceptance for shutdown/tests while callers also receive delivery failures.
    this.track(
      delivery.then(
        () => {},
        () => {},
      ),
    );
    return delivery;
  }

  /** AgentManager hook: a run of some agent ended. Procedure runs are reported upward. */
  onRunEnd(agentId: string, result: RunResult): void {
    if (agentId === ASSISTANT_AGENT_ID || result.aborted) return;
    const procedure = this.deps.procedures.get(agentId);
    if (!procedure) return;
    const summary = clipReport(
      result.error ? `It failed: ${result.error}` : result.text || '(no report)',
    );
    const next = procedure.nextAction
      ? ` · next: ${procedure.nextAction.text} (${procedure.nextAction.owner})`
      : '';
    const header = `${REPORT_PREFIX} ${procedure.id} "${procedure.title}" · status: ${procedure.status}${next}]`;
    const now = this.deps.clock().toISOString();
    const row: ActivityItem = {
      id: this.deps.conversation.newItemId('a'),
      createdAt: now,
      type: 'activity',
      toolCallId: `report-${procedure.id}-${now}`,
      tool: REPORT_TOOL,
      args: { procedureId: procedure.id, title: procedure.title },
      status: result.error ? 'error' : 'done',
      summary,
      finishedAt: now,
    };
    this.deps.conversation.upsertItem(row);
    this.deliverToAssistant(`${header}\n${summary}`);
  }

  private deliverToAssistant(text: string): void {
    const { conversation, agents } = this.deps;
    this.track(
      agents
        .send(ASSISTANT_AGENT_ID, text, undefined, { followUp: true })
        .then(() => {})
        .catch((err) => {
          const lang = this.deps.lang();
          const message =
            err instanceof NoProviderError
              ? t(lang, 'agentErrorNoProvider')
              : friendlyAgentError(errorMessage(err), lang);
          this.deps.logger.warn('report delivery failed', { error: errorMessage(err) });
          conversation.setRunning(false);
          conversation.addNotice('error', message);
          conversation.setError(message);
        }),
    );
  }
}

export function clipReport(text: string): string {
  const flat = text.replace(/\n{3,}/g, '\n\n').trim();
  return flat.length > MAX_REPORT_CHARS
    ? `${flat.slice(0, MAX_REPORT_CHARS - 1).trimEnd()}…`
    : flat;
}
