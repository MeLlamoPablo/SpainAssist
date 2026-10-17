/**
 * `HostHooks` of the eval host (packages/agent/src/host/hooks.ts): what makes the real agent host
 * believe in a world that is a SpainBench mock.
 *
 *   egress       `createWorldFetch` for `fetch_url`, `run_script` and `boe_search`: every mapped host
 *                is served by SpainBench with the real URL, `Host` and errors; every other host fails
 *                like a dead domain. DNS for the product's SSRF guard answers a documentation
 *                address for every name, so the guard keeps working and nothing is resolved for real.
 *                The product's guard runs first: what it refuses never reaches the transport, so
 *                `onBlocked` writes it to the net log (`route: 'denied'`) with the tool that tried.
 *   research     the recorded research answer through the product's own tool factories.
 *   wrapTool     every tool call runs in its call context, so each request in the net log says
 *                which tool call made it.
 *   onModel      the deny-by-default guard (egress-guard.ts): `globalThis.fetch` and `WebSocket`
 *                reach only the model gateway (and what the config adds); sockets, DNS, UDP and
 *                child processes reach that, the mock and the bridge. pi creates its HTTP client
 *                per request, so the patch made here captures the LLM traffic too.
 *   now          the frozen clock of the system prompts. Response `Date` headers start there and
 *                run at real speed, like the app's own clock.
 *
 * Plain Node: bundled into the eval host (`dist/eval-host.js`), never into the product host. Never
 * print to stdout (the host's RPC channel); `hostLog` writes to stderr.
 */
import { type HostHooks, hostLog } from '@sa/agent/host-runtime';
import { BRIDGE_ENV } from '@sa/shared';
import { z } from 'zod';
import type { HostEvalConfig } from '../contracts';
import { createEgressGuard } from '../net/egress-guard';
import { HostTable } from '../net/hosts';
import { NetLog } from '../net/netlog';
import { docAddress } from '../net/wire';
import {
  channelOfTool,
  createWorldFetch,
  currentCallContext,
  withCallContext,
} from '../net/world-fetch';
import { loadHostEvalConfig } from './config';
import { createResearchStub } from './research-stub';

/** Where a refused request was going, without its path or query (they may hold what it sent). */
function originOf(record: { url: string; host: string }): string {
  try {
    const { origin } = new URL(record.url);
    return origin === 'null' ? record.host : origin;
  } catch {
    return record.host;
  }
}

export interface EvalHooksOptions {
  /** pi provider id of the agent (`litellm`, `openai-codex`, `custom`...). */
  provider: string;
  /** The app's bridge (`SA_BRIDGE_URL`): the one other place the process opens a socket to. */
  bridgeOrigin?: string;
  /** Milliseconds of real time, for the response `Date` (tests). Default `Date.now`. */
  wallClock?: () => number;
}

export interface EvalHooks {
  hooks: HostHooks;
  /** The process' network log (`config.netlog`). */
  log: NetLog;
  /** Puts the guard's patches back and closes the log. The host never needs it; tests do. */
  close(): void;
}

/** The hooks for a validated config. `createEvalHooks` is this plus reading the environment. */
export function buildEvalHooks(config: HostEvalConfig, options: EvalHooksOptions): EvalHooks {
  const log = new NetLog({ worldId: config.worldId, file: config.netlog });
  // The prompts' "today" is the frozen instant; the `Date` of a response is that instant plus the
  // time that has passed since, so it agrees with the prompt and moves like a real server's.
  const clock = () => new Date(config.now);
  const wallClock = options.wallClock ?? Date.now;
  const startedAt = wallClock();
  const frozenMs = Date.parse(config.now);
  const ticking = () => new Date(frozenMs + (wallClock() - startedAt));
  const worldFetch = createWorldFetch(
    {
      worldId: config.worldId,
      mockOrigin: config.mockOrigin,
      scoringOrigin: config.scoringOrigin,
      routes: new HostTable(config.routes),
      unmapped: config.unmapped,
    },
    log,
    { now: ticking },
  );
  // A denied request is a tool that did not use `egress.fetch`: say so where a human looks (the
  // details, which may hold what the agent tried to send, stay in the net log).
  log.on((record) => {
    if (record.route === 'denied') {
      hostLog('warn', `denied: ${record.method} ${originOf(record)} (see the net log)`);
    }
  });

  let restoreGlobals: (() => void) | undefined;
  const hooks: HostHooks = {
    egress: {
      fetch: worldFetch,
      resolveHost: async (host) => [{ address: docAddress(host) }],
      // The product's SSRF guard refused it before any request: it is still an attempt.
      onBlocked: ({ url, method, message }) => {
        const ctx = currentCallContext();
        log.append({
          seq: log.nextSeq(),
          t: log.stamp(),
          channel: channelOfTool(ctx?.tool),
          ...(ctx?.toolCallId ? { toolCallId: ctx.toolCallId } : {}),
          method,
          url: url.href,
          host: url.hostname.replace(/^\[|\]$/g, ''),
          route: 'denied',
          reqHeaders: {},
          durationMs: 0,
          error: message,
        });
      },
    },
    research: createResearchStub({ config: config.research, provider: options.provider, log }),
    wrapTool: (tool) => ({
      ...tool,
      execute: (toolCallId, params, signal, onUpdate, ctx) =>
        withCallContext({ tool: tool.name, toolCallId }, () =>
          tool.execute(toolCallId, params, signal, onUpdate, ctx),
        ),
    }),
    onModel: (model) => {
      if (restoreGlobals) throw new Error('The eval host guard is already installed');
      let gateway: string;
      try {
        gateway = new URL(model.baseUrl).origin;
      } catch {
        // Fail closed: without the gateway's origin the guard would deny the model's own traffic.
        throw new Error(`The model ${model.provider}/${model.id} has no usable base URL`);
      }
      const guard = createEgressGuard({
        allowOrigins: [gateway, ...config.llm.extraAllowOrigins],
        socketOrigins: [config.mockOrigin, ...(options.bridgeOrigin ? [options.bridgeOrigin] : [])],
        log,
      });
      restoreGlobals = guard.install();
    },
    now: clock,
  };
  return {
    hooks,
    log,
    close() {
      restoreGlobals?.();
      restoreGlobals = undefined;
      log.close();
    },
  };
}

/** Only the part of the agent host config (`SA_AGENT_CONFIG`) this module reads. */
const AgentProvider = z.looseObject({ model: z.looseObject({ provider: z.string().min(1) }) });

/** The pi provider of the agent this process is going to run (the product host parses the rest). */
export function agentProviderOf(env: NodeJS.ProcessEnv): string {
  const raw = env[BRIDGE_ENV.config];
  if (!raw) throw new Error(`${BRIDGE_ENV.config} is not set: this is not an agent host launch`);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${BRIDGE_ENV.config} is not JSON`);
  }
  const parsed = AgentProvider.safeParse(json);
  if (!parsed.success) throw new Error(`${BRIDGE_ENV.config} has no model.provider`);
  return parsed.data.model.provider;
}

/**
 * The hooks of the eval host entry: reads the config file `SA_EVAL_CONFIG` names (validated) and the
 * provider of `SA_AGENT_CONFIG`. Throws when either is missing or invalid; the entry reports it as a
 * fatal error.
 */
export function createEvalHooks(env: NodeJS.ProcessEnv = process.env): HostHooks {
  const bridgeOrigin = env[BRIDGE_ENV.url];
  return buildEvalHooks(loadHostEvalConfig(env), {
    provider: agentProviderOf(env),
    ...(bridgeOrigin ? { bridgeOrigin } : {}),
  }).hooks;
}
