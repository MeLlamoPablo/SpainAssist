import { createHash } from 'node:crypto';
import { ASSISTANT_AGENT_ID, type Procedure, type ProcedureListItem } from '@sa/shared';
import type { BridgeContext, CodemodeHandlers } from '../bridge/server';
import type { BrowserHolder } from '../browser/holder';
import { BridgeError } from '../core/errors';
import { truncate } from '../core/logger';
import { errorMessage } from '../core/util';
import type { ProcedureService } from '../procedures/service';
import type { CodemodeAgents } from './agents';
import type { CodemodeCoordinator } from './coordinator';
import type { WorkflowService } from './workflows';

export interface CodemodeHandlerDeps {
  workflows: WorkflowService;
  procedures: ProcedureService;
  directory: CodemodeAgents;
  coordinator: CodemodeCoordinator;
  browser: BrowserHolder;
}

/**
 * The procedure of a workflow's key: the same id on every run of that workflow, whoever runs it
 * (an agent that replaces another finds it). A full procedure id passes through.
 */
export function procedureIdFor(workflowId: string, key: string): string {
  if (/^p_[a-f0-9]{16}$/.test(key)) return key;
  return `p_${createHash('sha256').update(`${workflowId}\0${key}`).digest('hex').slice(0, 16)}`;
}

/** A card as agents read it: no runtime state. */
function card(p: Procedure | ProcedureListItem): Procedure {
  const { runtime: _, ...rest } = p as ProcedureListItem;
  return { ...structuredClone(rest), version: rest.version ?? 0 };
}

/** Codemode bridge methods (docs/codemode.md). Roles are checked by the server before. */
export function createCodemodeHandlers(deps: CodemodeHandlerDeps): CodemodeHandlers {
  const { workflows, procedures, directory, coordinator } = deps;

  const requireProcedure = (id: string): Procedure => {
    const p = procedures.get(id);
    if (!p)
      throw new BridgeError(
        'not_found',
        /^p_/.test(id)
          ? `No procedure "${id}". api.procedures.list() lists them.`
          : `No procedure "${id}": ids look like "p_…". api.procedures.getOrCreate({ id: ${JSON.stringify(id)}, title }) returns the one this workflow made with that key; api.procedures.list() lists them all.`,
      );
    return p;
  };

  const touch = (ctx: BridgeContext, procedureId: string) => {
    if (ctx.agentId !== ASSISTANT_AGENT_ID) directory.touchProcedure(ctx.agentId, procedureId);
  };

  const mayManage = (ctx: BridgeContext, workflowAgent: string): boolean =>
    ctx.agentId === ASSISTANT_AGENT_ID ||
    workflowAgent === ctx.agentId ||
    directory.get(workflowAgent)?.parentId === ctx.agentId;

  async function browserCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('browser_error', truncate(errorMessage(err), 500));
    }
  }

  return {
    'workflow.begin': async (params, ctx) => {
      for (const id of params.procedures ?? []) requireProcedure(id);
      const { runId, record, resumed } = await workflows.begin(ctx.agentId, params);
      for (const id of record.procedures) if (procedures.has(id)) touch(ctx, id);
      return {
        runId,
        resumed,
        procedures: [...record.procedures],
        state: workflows.stateOf(record),
      };
    },
    'workflow.memo': async (params, ctx) => {
      await workflows.memo(ctx.agentId, params.runId, params.key, params.value, !!params.delete);
      return {};
    },
    'workflow.ui': async (params, ctx) => {
      const { runId, key } = params;
      switch (params.action) {
        case 'open':
          await workflows.openUi(ctx.agentId, runId, key, params.tree, params.rev ?? 1, ctx.signal);
          break;
        case 'render':
          await workflows.renderUi(
            ctx.agentId,
            runId,
            key,
            params.tree,
            params.rev ?? 0,
            ctx.signal,
          );
          break;
        case 'durable':
          if (!params.name) throw new BridgeError('bad_request', 'durable needs a name.');
          workflows.durable(ctx.agentId, runId, key, params.name, params.value);
          break;
        case 'close':
          await workflows.closeUi(ctx.agentId, runId, key, params.result ?? null);
          break;
      }
      return {};
    },
    'workflow.setStatus': async (params, ctx) => {
      directory.setStatus(ctx.agentId, params.status);
      return {};
    },
    'workflow.events': (params, ctx) =>
      workflows.events(ctx.agentId, params.runId, params.after, ctx.signal),
    'workflow.end': async (params, ctx) => {
      await workflows.end(ctx.agentId, params.runId, params.outcome, params.deliver);
      return {};
    },
    'workflow.resumable': async (_params, ctx) => ({
      workflows: workflows.resumable(ctx.agentId).map((w) => ({
        workflowId: w.id,
        ...(w.title ? { title: w.title } : {}),
        source: w.source,
        procedures: w.procedures.filter((id) => procedures.has(id)),
      })),
    }),
    'workflows.list': async () => ({
      workflows: workflows
        .list()
        .slice(0, 50)
        .map((w) => ({
          id: w.id,
          ...(w.title ? { title: w.title } : {}),
          status: w.status,
          agentId: w.agentId,
          procedures: w.procedures,
          openUi: Object.values(w.ui)
            .filter((u) => u.status === 'open')
            .map((u) => u.key),
        })),
    }),
    'workflows.get': async (params) => {
      const w = workflows.get(params.id);
      if (!w) throw new BridgeError('not_found', `No workflow "${params.id}".`);
      let result: unknown;
      try {
        result = w.result === undefined ? undefined : JSON.parse(w.result);
      } catch {
        result = w.result;
      }
      return {
        id: w.id,
        ...(w.title ? { title: w.title } : {}),
        status: w.status,
        agentId: w.agentId,
        procedures: w.procedures,
        memoKeys: Object.keys(w.memo),
        openUi: Object.values(w.ui)
          .filter((u) => u.status === 'open')
          .map((u) => u.key),
        ...(result !== undefined ? { result } : {}),
        ...(w.error ? { error: w.error.slice(0, 2000) } : {}),
      };
    },
    'workflows.cancel': async (params, ctx) => {
      const w = workflows.get(params.id);
      if (!w) throw new BridgeError('not_found', `No workflow "${params.id}".`);
      if (!mayManage(ctx, w.agentId))
        throw new BridgeError('policy_denied', 'Only its agent or the coordinator may cancel it.');
      return { cancelled: await workflows.cancel(params.id, params.reason, ctx.agentId) };
    },

    'procs.list': async (params) => ({
      procedures: procedures
        .list()
        .filter((p) => params.includeArchived || !p.archived)
        .map(card),
    }),
    'procs.get': async (params) => card(requireProcedure(params.id)),
    'procs.getOrCreate': async (params, ctx) => {
      const workflow = workflows.workflowOfRun(params.runId, ctx.agentId);
      const { runId: _, id: key, title, ...initial } = params;
      const id = procedureIdFor(workflow.id, key);
      const { procedure, created } = await procedures.getOrCreate(id, title, initial);
      workflows.addProcedure(workflow.id, id);
      touch(ctx, id);
      return { ...card(procedure), created };
    },
    'procs.update': async (params, ctx) => {
      requireProcedure(params.id);
      const updated = procedures.applyVersionedUpdate(
        params.id,
        params.expectedVersion,
        params.patch,
      );
      touch(ctx, params.id);
      return card(updated);
    },
    'procs.context': async (params) => {
      requireProcedure(params.id);
      return procedures.context(params.id);
    },
    'procs.setContext': async (params, ctx) => {
      requireProcedure(params.id);
      await procedures.setContext(params.id, params.context);
      touch(ctx, params.id);
      return {};
    },

    'agents.start': async (params, ctx) => ({
      agentId: await coordinator.startAgent(ctx.agentId, params),
    }),
    'agents.message': (params) =>
      coordinator.messageAgent(
        params.agentId,
        params.message,
        params.urgent ?? false,
        params.status,
      ),
    'agents.stop': async (params) => ({ stopped: await coordinator.stopAgent(params.agentId) }),
    'agents.list': async () => ({ agents: coordinator.listAgents() }),

    'browser.query': async (params, ctx) => {
      requireProcedure(ctx.procedureId);
      const value = await browserCall(() =>
        deps.browser.get().query(ctx.procedureId, params.target, params.op, params.args),
      );
      // dblclick and press answer with the page they lead to.
      if (value && typeof value === 'object' && 'snapshot' in value && 'url' in value)
        return { value: null, observation: value as never };
      return { value };
    },
    'browser.reload': async (_params, ctx) => {
      requireProcedure(ctx.procedureId);
      return browserCall(() => deps.browser.get().reload(ctx.procedureId));
    },
    'browser.info': async (_params, ctx) => {
      requireProcedure(ctx.procedureId);
      return browserCall(() => deps.browser.get().info(ctx.procedureId));
    },
  };
}
