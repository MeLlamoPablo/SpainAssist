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
import type { RunService } from './runs';

export interface CodemodeHandlerDeps {
  runs: RunService;
  procedures: ProcedureService;
  directory: CodemodeAgents;
  coordinator: CodemodeCoordinator;
  browser: BrowserHolder;
}

/**
 * The procedure of an agent's key: the same id on every run of that agent. A full procedure id
 * passes through, so two agents can share a card by its id.
 */
export function procedureIdFor(agentId: string, key: string): string {
  if (/^p_[a-f0-9]{16}$/.test(key)) return key;
  return `p_${createHash('sha256').update(`${agentId}\0${key}`).digest('hex').slice(0, 16)}`;
}

/** A card as agents read it: no runtime state. */
function card(p: Procedure | ProcedureListItem): Procedure {
  const { runtime: _, ...rest } = p as ProcedureListItem;
  return { ...structuredClone(rest), version: rest.version ?? 0 };
}

/** Codemode bridge methods (docs/codemode.md). Roles are checked by the server before. */
export function createCodemodeHandlers(deps: CodemodeHandlerDeps): CodemodeHandlers {
  const { runs, procedures, directory, coordinator } = deps;

  /** The procedure the caller means: a full id, or one of its own keys. */
  const requireProcedure = (ctx: BridgeContext, idOrKey: string): Procedure => {
    const id = procedureIdFor(ctx.agentId, idOrKey);
    const p = procedures.get(id);
    if (!p)
      throw new BridgeError(
        'not_found',
        id === idOrKey
          ? `No procedure "${id}". api.procedures.list() lists them.`
          : `No procedure of yours with the key ${JSON.stringify(idOrKey)} (${id}). api.procedures.getOrCreate({ id: ${JSON.stringify(idOrKey)}, title }) creates it; api.procedures.list() lists them all.`,
      );
    return p;
  };

  const touch = (ctx: BridgeContext, procedureId: string) => {
    if (ctx.agentId !== ASSISTANT_AGENT_ID) directory.touchProcedure(ctx.agentId, procedureId);
  };

  const mayManage = (ctx: BridgeContext, runAgent: string): boolean =>
    ctx.agentId === ASSISTANT_AGENT_ID ||
    runAgent === ctx.agentId ||
    directory.get(runAgent)?.parentId === ctx.agentId;

  async function browserCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BridgeError) throw err;
      throw new BridgeError('browser_error', truncate(errorMessage(err), 500));
    }
  }

  return {
    'run.begin': async (params, ctx) => {
      for (const id of params.procedures ?? []) {
        requireProcedure(ctx, id);
        touch(ctx, id);
      }
      // The run's default procedure (prompts, documents, the page) is the agent's latest.
      const touched = directory.get(ctx.agentId)?.procedures ?? [];
      const own = [...new Set([...(params.procedures ?? []), ...touched])].filter((id) =>
        procedures.has(id),
      );
      return { ...(await runs.begin(ctx.agentId, params)), procedures: own };
    },
    'run.memo': async (params, ctx) => {
      await runs.memo(ctx.agentId, params.runId, params.key, params.value, !!params.delete);
      return {};
    },
    'run.ui': async (params, ctx) => {
      const { runId, key } = params;
      let note: string | undefined;
      switch (params.action) {
        case 'open':
          await runs.openUi(ctx.agentId, runId, key, params.tree, params.rev ?? 1, ctx.signal);
          break;
        case 'render':
          await runs.renderUi(ctx.agentId, runId, key, params.tree, params.rev ?? 0, ctx.signal);
          break;
        case 'durable':
          if (!params.name) throw new BridgeError('bad_request', 'durable needs a name.');
          runs.durable(ctx.agentId, runId, key, params.name, params.value);
          break;
        case 'close':
          note = await runs.closeUi(ctx.agentId, runId, key, params.result ?? null);
          break;
      }
      return note ? { note } : {};
    },
    'run.setStatus': async (params, ctx) => {
      directory.setStatus(ctx.agentId, params.status);
      return {};
    },
    'run.events': (params, ctx) => runs.events(ctx.agentId, params.runId, params.after, ctx.signal),
    'run.end': async (params, ctx) => {
      await runs.end(ctx.agentId, params.runId, params.outcome, params.deliver);
      return {};
    },
    'run.resumable': async (_params, ctx) => ({
      runs: runs.resumable(ctx.agentId).map((r) => ({
        runId: r.id,
        ...(r.title ? { title: r.title } : {}),
        source: r.source,
        procedures: r.procedures.filter((id) => procedures.has(id)),
      })),
    }),
    'run.cancel': async (params, ctx) => {
      const run = runs.get(params.runId);
      if (!run) throw new BridgeError('not_found', `No run ${params.runId}.`);
      if (!mayManage(ctx, run.agentId))
        throw new BridgeError('policy_denied', 'Only its agent or the coordinator may cancel it.');
      return { cancelled: await runs.cancel(params.runId, params.reason, ctx.agentId) };
    },

    'procs.list': async (params) => ({
      procedures: procedures
        .list()
        .filter((p) => params.includeArchived || !p.archived)
        .map(card),
    }),
    'procs.get': async (params, ctx) => card(requireProcedure(ctx, params.id)),
    'procs.getOrCreate': async (params, ctx) => {
      const { id: key, title, ...initial } = params;
      const id = procedureIdFor(ctx.agentId, key);
      const { procedure, created } = await procedures.getOrCreate(id, title, initial);
      touch(ctx, id);
      return { ...card(procedure), created };
    },
    'procs.update': async (params, ctx) => {
      const { id } = requireProcedure(ctx, params.id);
      const updated = procedures.applyVersionedUpdate(id, params.expectedVersion, params.patch);
      touch(ctx, id);
      return card(updated);
    },
    'procs.context': async (params, ctx) => procedures.context(requireProcedure(ctx, params.id).id),
    'procs.setContext': async (params, ctx) => {
      const { id } = requireProcedure(ctx, params.id);
      await procedures.setContext(id, params.context);
      touch(ctx, id);
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
      requireProcedure(ctx, ctx.procedureId);
      const value = await browserCall(() =>
        deps.browser.get().query(ctx.procedureId, params.target, params.op, params.args),
      );
      // dblclick and press answer with the page they lead to.
      if (value && typeof value === 'object' && 'snapshot' in value && 'url' in value)
        return { value: null, observation: value as never };
      return { value };
    },
    'browser.reload': async (_params, ctx) => {
      requireProcedure(ctx, ctx.procedureId);
      return browserCall(() => deps.browser.get().reload(ctx.procedureId));
    },
    'browser.info': async (_params, ctx) => {
      requireProcedure(ctx, ctx.procedureId);
      return browserCall(() => deps.browser.get().info(ctx.procedureId));
    },
  };
}
