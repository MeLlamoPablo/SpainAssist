import { createHash } from 'node:crypto';
import { AGENT_REPORT_PREFIX, WORKFLOW_RESULT_PREFIX } from '@sa/agent';
import {
  type ActivityItem,
  ASSISTANT_AGENT_ID,
  type DocumentMeta,
  type Language,
  type Procedure,
  REPORT_TOOL,
} from '@sa/shared';
import type { AgentManager, Delivery } from '../agents/manager';
import type { RunResult } from '../chat/mapper';
import type { PromptManager } from '../chat/prompts';
import type { ConversationService } from '../conversation/service';
import { BridgeError, friendlyAgentError, NoProviderError } from '../core/errors';
import { t } from '../core/i18n';
import type { Logger } from '../core/logger';
import { type Clock, errorMessage } from '../core/util';
import type { ProcedureService } from '../procedures/service';
import type { CodemodeAgents } from './agents';
import type { WorkflowEnd, WorkflowRecord, WorkflowService } from './workflows';

/** Upward messages stay short: the coordinator's context lives forever. */
const MAX_REPORT_CHARS = 800;
const MAX_RESULT_CHARS = 4_000;

export interface CodemodeCoordinatorDeps {
  agents: AgentManager;
  directory: CodemodeAgents;
  workflows: WorkflowService;
  procedures: ProcedureService;
  conversation: ConversationService;
  prompts: PromptManager;
  logger: Logger;
  clock: Clock;
  lang(): Language;
  documents(): DocumentMeta[];
}

/**
 * The codemode harness's glue in main (docs/codemode.md): the coordinator's background agents,
 * independent of procedures.
 *   - down: `agents.start/message/stop` from the coordinator's tools (agent_start, …);
 *   - up: an agent's run ends → a short report to the coordinator; a workflow that ended after
 *     its `codemode` call returned → its outcome to the agent that ran it;
 *   - resume: the user acts on an interface of a workflow no process runs → its agent is woken
 *     and its host resumes the workflow from its state.
 * Every agent's first message, and later ones when they changed, carry the procedures' cards.
 */
export class CodemodeCoordinator {
  private readonly deliveries = new Set<Promise<unknown>>();
  /** Last digest of procedures each agent was sent. */
  private readonly digests = new Map<string, string>();
  /** When each agent's current run started (for its report's documents). */
  private readonly waking = new Set<string>();

  constructor(private readonly deps: CodemodeCoordinatorDeps) {}

  private now(): string {
    return this.deps.clock().toISOString();
  }

  // --- what agents read -----------------------------------------------------------------------

  /** The procedures' cards, compact, for an agent's message (only when they changed for it). */
  procedurePreface(agentId: string, force = false): string {
    const list = this.deps.procedures.list().filter((p) => !p.archived);
    const lines = list.map((p) => {
      const next = p.nextAction ? ` · next (${p.nextAction.owner}): ${p.nextAction.text}` : '';
      const missing = p.requirements.filter((r) => r.status === 'missing').map((r) => r.label);
      const current = p.steps.find((s) => s.status === 'current');
      return `- ${p.id} v${p.version ?? 0} "${p.title}" · ${p.status}${current ? ` · step: ${current.title}` : ''}${missing.length ? ` · missing: ${missing.slice(0, 5).join(', ')}` : ''}${next}`;
    });
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    if (!force && this.digests.get(agentId) === digest) return '';
    this.digests.set(agentId, digest);
    const fresh = agentId === ASSISTANT_AGENT_ID ? 'procedure_read' : 'api.procedures.list()';
    return lines.length
      ? `[Procedures (as the user sees them; ${fresh} for fresh ones)]\n${lines.join('\n')}\n\n`
      : '[Procedures: none yet]\n\n';
  }

  /** Workflows of this agent interrupted while it was away (it decides what to do). */
  private interruptedNote(agentId: string): string {
    const list = this.deps.workflows
      .list()
      .filter((w) => w.agentId === agentId && w.status === 'interrupted');
    if (!list.length) return '';
    return `[Interrupted workflows (the app or your process restarted while they ran; memoized steps are kept, re-run with the same id to continue): ${list.map((w) => `"${w.id}"${w.title ? ` (${w.title})` : ''}`).join(', ')}]\n\n`;
  }

  /**
   * Workflows of this agent whose interfaces are still on screen: a message may answer them (the
   * user attached the document instead of typing the number), and then they must not stay up.
   */
  private waitingNote(agentId: string): string {
    const list = this.deps.workflows
      .list()
      .filter((w) => w.agentId === agentId && Object.values(w.ui).some((u) => u.status === 'open'));
    if (!list.length) return '';
    const items = list.map((w) => {
      const keys = Object.values(w.ui)
        .filter((u) => u.status === 'open')
        .map((u) => `"${u.key}"`);
      return `"${w.id}"${w.title ? ` (${w.title})` : ''}: ${keys.join(', ')}`;
    });
    return `[Your interfaces the user still sees (if this message answers one or makes it obsolete, cancel its workflow with api.workflows.cancel and continue with the answer): ${items.join('; ')}]\n\n`;
  }

  /** The user's chat message as the coordinator reads it. */
  decorateUserMessage(text: string): string {
    return `${this.procedurePreface(ASSISTANT_AGENT_ID)}${this.interruptedNote(ASSISTANT_AGENT_ID)}${text}`;
  }

  // --- agents (the coordinator's agent_* tools) ----------------------------------------------

  async startAgent(
    parentId: string,
    input: { status: string; brief: string; procedures?: string[] },
  ): Promise<string> {
    for (const id of input.procedures ?? [])
      if (!this.deps.procedures.has(id))
        throw new BridgeError('not_found', `No procedure "${id}".`);
    const record = await this.deps.directory.create({
      status: input.status,
      brief: input.brief,
      parentId,
      procedures: input.procedures ?? [],
    });
    const text = [
      this.procedurePreface(record.id, true),
      input.procedures?.length
        ? `[Procedures to continue: ${input.procedures.join(', ')}]\n\n`
        : '',
      `[Brief from the coordinator]\n${input.brief}`,
    ].join('');
    this.deps.directory.sinkFor(record.id).upsertItem({
      id: this.deps.directory.sinkFor(record.id).newItemId('u'),
      createdAt: this.now(),
      type: 'user',
      text: input.brief,
    });
    this.deps.directory.setRunning(record.id, true);
    this.track(this.send(record.id, text, { followUp: true }));
    return record.id;
  }

  messageAgent(
    agentId: string,
    message: string,
    urgent = false,
    status?: string,
  ): Promise<Delivery> {
    this.requireAgent(agentId);
    this.deps.directory.setStopped(agentId, false);
    if (status) this.deps.directory.setStatus(agentId, status);
    const text = `${this.procedurePreface(agentId)}${this.interruptedNote(agentId)}${this.waitingNote(agentId)}[Message from the coordinator]\n${message}`;
    return this.send(agentId, text, urgent ? { cancelPrompts: true } : { followUp: true });
  }

  async stopAgent(agentId: string): Promise<boolean> {
    this.requireAgent(agentId);
    const wasActive = this.deps.agents.isActive(agentId);
    await this.deps.agents.abort(agentId);
    await this.deps.agents.stop(agentId);
    this.deps.directory.setStopped(agentId, true);
    this.deps.directory.setRunning(agentId, false);
    return wasActive;
  }

  listAgents() {
    return this.deps.directory
      .infos()
      .filter((a) => a.kind === 'agent')
      .map((a) => ({
        id: a.id,
        status: a.status,
        activity: a.activity,
        ...(a.now ? { now: a.now } : {}),
        procedures: a.procedures,
      }));
  }

  private requireAgent(agentId: string): void {
    if (this.deps.directory.kindOf(agentId) !== 'agent')
      throw new BridgeError('not_found', `No agent "${agentId}". agent_list lists them.`);
  }

  private send(
    agentId: string,
    text: string,
    options: { followUp?: boolean; cancelPrompts?: boolean | 'forms' },
  ): Promise<Delivery> {
    return this.deps.agents.send(agentId, text, undefined, options).catch((err) => {
      const lang = this.deps.lang();
      const message =
        err instanceof NoProviderError
          ? t(lang, 'agentErrorNoProvider')
          : friendlyAgentError(errorMessage(err), lang);
      this.deps.logger.warn('codemode delivery failed', { agentId, error: errorMessage(err) });
      if (agentId === ASSISTANT_AGENT_ID) {
        this.deps.conversation.setRunning(false);
        this.deps.conversation.addNotice('error', message);
        this.deps.conversation.setError(message);
      } else {
        this.deps.directory.setRunning(agentId, false);
        this.deps.directory.setError(agentId, message);
        this.deps.directory.sinkFor(agentId).addNotice('error', message);
      }
      throw err;
    });
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.then(
      () => {},
      () => {},
    );
    const entry = tracked.finally(() => this.deliveries.delete(entry));
    this.deliveries.add(entry);
  }

  /** Waits for background deliveries (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.deliveries.size) await Promise.allSettled([...this.deliveries]);
  }

  // --- lifecycle hooks -----------------------------------------------------------------------

  /** AgentManager: a run of some codemode agent ended. */
  onRunEnd(agentId: string, result: RunResult): void {
    if (agentId === ASSISTANT_AGENT_ID || result.aborted) return;
    const record = this.deps.directory.get(agentId);
    if (record?.kind !== 'agent') return;
    this.deps.directory.setRunning(agentId, false);
    if (result.error) this.deps.directory.setError(agentId, result.error);
    const summary = clip(
      result.error ? `It failed: ${result.error}` : result.text || '(no report)',
      MAX_REPORT_CHARS,
    );
    const saved = this.savedDocuments(record.procedures, result.startedAt);
    const touched = record.procedures
      .slice(0, 5)
      .map((id) => this.deps.procedures.get(id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map(
        (p: Procedure) =>
          `${p.id} "${p.title}" (${p.status}${p.nextAction ? ` · next: ${p.nextAction.text}` : ''})`,
      );
    const primary = record.procedures[0]
      ? this.deps.procedures.get(record.procedures[0])
      : undefined;
    const header = `${AGENT_REPORT_PREFIX} ${record.id} "${record.status}"${touched.length ? ` · procedures: ${touched.join('; ')}` : ''}]`;
    const now = this.now();
    const row: ActivityItem = {
      id: this.deps.conversation.newItemId('a'),
      createdAt: now,
      type: 'activity',
      toolCallId: `report-${record.id}-${now}`,
      tool: REPORT_TOOL,
      args: {
        agentId: record.id,
        // The chat's chip names the work ("Novedades de «Renovar el DNI»"), not what it was doing.
        ...(primary ? { title: primary.title } : {}),
        ...(record.procedures[0] ? { procedureId: record.procedures[0] } : {}),
      },
      status: result.error ? 'error' : 'done',
      summary,
      finishedAt: now,
    };
    this.deps.conversation.upsertItem(row);
    this.track(this.send(ASSISTANT_AGENT_ID, `${header}\n${summary}${saved}`, { followUp: true }));
  }

  private savedDocuments(procedures: string[], since: string | undefined): string {
    if (!since) return '';
    let documents: DocumentMeta[];
    try {
      documents = this.deps.documents();
    } catch {
      return '';
    }
    const saved = documents
      .filter((d) => d.procedureId && procedures.includes(d.procedureId) && d.createdAt >= since)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .map((d) => `${d.id} "${d.name}"`);
    return saved.length ? `\nSaved documents: ${saved.join('; ')}` : '';
  }

  /** WorkflowService: a run ended. When its codemode call had returned, the agent hears now. */
  onWorkflowEnd(end: WorkflowEnd): void {
    // The agent hears the result: it works on from the workflow without a gap in the meter.
    const wakes =
      end.deliver &&
      end.agentId !== ASSISTANT_AGENT_ID &&
      this.deps.directory.kindOf(end.agentId) === 'agent';
    if (wakes) this.deps.directory.setRunning(end.agentId, true);
    this.refreshWorkflows(end.agentId);
    if (!end.deliver) return;
    const w = end.workflow;
    const title = w.title ? ` (${w.title})` : '';
    const body =
      end.outcome.status === 'succeeded'
        ? end.outcome.value === undefined
          ? 'main returned nothing.'
          : `Result:\n${clip(end.outcome.value, MAX_RESULT_CHARS)}`
        : end.outcome.status === 'failed'
          ? `Error:\n${clip(end.outcome.error ?? 'unknown', MAX_RESULT_CHARS)}\nFix the module and re-run it with the same id: memoized steps and closed interfaces are kept.`
          : `Cancelled${end.outcome.error ? `: ${end.outcome.error}` : ''}.`;
    const logs = end.outcome.logs ? `\n\nLogs:\n${clip(end.outcome.logs, MAX_RESULT_CHARS)}` : '';
    const text = `${WORKFLOW_RESULT_PREFIX} "${w.id}"${title} ${end.outcome.status}]\n${body}${logs}`;
    this.track(this.send(end.agentId, text, { followUp: true }));
  }

  /**
   * WorkflowService: a running workflow's run stopped reaching main (its host lost it). Its
   * agent hears it, so it can re-run the workflow (its memoized steps are kept).
   */
  onStale(workflow: WorkflowRecord): void {
    this.refreshWorkflows(workflow.agentId);
    const title = workflow.title ? ` (${workflow.title})` : '';
    this.track(
      this.send(
        workflow.agentId,
        `${WORKFLOW_RESULT_PREFIX} "${workflow.id}"${title} interrupted]\nIts run stopped while it worked. Memoized steps and closed interfaces are kept: re-run it with the same id to continue.`,
        { followUp: true },
      ),
    );
  }

  /** WorkflowService: the user acted on an interface no process runs: wake its agent. */
  onDetachedEvent(workflow: WorkflowRecord): void {
    const agentId = workflow.agentId;
    if (this.waking.has(agentId)) return;
    this.waking.add(agentId);
    this.track(
      this.deps.agents
        .wake(agentId)
        .catch((err) => {
          this.deps.logger.warn('could not wake an agent to resume its workflow', {
            agentId,
            workflowId: workflow.id,
            error: errorMessage(err),
          });
        })
        .finally(() => this.waking.delete(agentId)),
    );
  }

  /** AgentManager: an agent's process ended (stopped, idle, crashed). */
  onAgentGone(agentId: string): void {
    const interrupted = this.deps.workflows.detachAgent(agentId);
    if (interrupted.length)
      this.deps.logger.info('workflows interrupted with their agent', {
        agentId,
        workflows: interrupted.map((w) => w.id),
      });
    this.refreshWorkflows(agentId);
  }

  /** Whether the agent's process must stay up: one of its workflows runs (not only waits). */
  keepAlive(agentId: string): boolean {
    return this.deps.workflows
      .list()
      .some(
        (w) => w.agentId === agentId && w.status === 'running' && this.deps.workflows.isLive(w.id),
      );
  }

  /** A workflow changed (it began or ended, an interface opened or closed): its agent's state in the meter. */
  onWorkflowChanged(agentId: string): void {
    this.refreshWorkflows(agentId);
  }

  /**
   * The agent's workflows in the meter: one waits for the user, or one runs on its own (after
   * its codemode call returned, the agent's run may have ended while the workflow still works).
   */
  private refreshWorkflows(agentId: string): void {
    if (agentId === ASSISTANT_AGENT_ID || !this.deps.directory.has(agentId)) return;
    this.deps.directory.setWaitingUser(
      agentId,
      this.deps.workflows.list().some((w) => w.agentId === agentId && w.status === 'waiting_user'),
    );
    this.deps.directory.setWorkflowRunning(agentId, this.keepAlive(agentId));
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\n{3,}/g, '\n\n').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
