import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRIDGE_ENV, DEFAULT_THINKING_LEVEL, setExtraTrustedHosts } from '@sa/shared';
import { BridgeClient } from '../bridge/client';
import { buildDeclarations } from '../codemode/declarations';
import { WorkflowEngine } from '../codemode/engine';
import { createImageStore } from '../codemode/host-ops';
import { codemodeTool } from '../codemode/tool';
import { parseHostConfig } from '../config';
import { buildAssistantPrompt } from '../prompt/assistant';
import { buildCodemodePrompt } from '../prompt/codemode';
import { buildCoordinatorPrompt } from '../prompt/coordinator';
import { buildSystemPrompt } from '../prompt/system';
import { parseLiteLLMSpendHeaders } from '../providers/services';
import { createChatGPTResearchTool } from '../research/chatgpt-research';
import { createExaTools } from '../research/exa';
import { createKeyServerResearchTool } from '../research/key-server-research';
import type { AnyToolDefinition } from '../tools/common';
import { createAssistantTools, createCoordinatorTools, createTools } from '../tools/index';
import { EXA_TOOL_NAMES, WEB_RESEARCH_TOOL_NAME } from '../tools/names';
import { BridgeCredentialStore } from './credentials';
import { createSpainAssistExtension } from './extension';
import type { HostHooks } from './hooks';
import { IDLE_COMPACTION_MIN_TOKENS, SessionRequests } from './idle-compaction';
import { hostLog } from './log';
import { configureModel, LITELLM_PROVIDER_ID, needsPromptCacheKey } from './model';
import { redactsPages } from './redaction';
import { promptResearch, researchBackend } from './research';
import { prepareSessionFile, recordSessionSelection } from './session';

/**
 * Agent host: one process per active agent (the assistant, or one procedure's agent). Reads its configuration from the environment
 * (see BRIDGE_ENV), builds a pi session with only SpainAssist tools and serves pi's RPC
 * protocol (JSONL) on stdin/stdout via `runRpcMode`. Never returns.
 *
 * `hooks` are for harnesses and tests that run the host outside the app (see hooks.ts). The
 * shipped entry (main.ts) passes none, and without them this is exactly the product host.
 */
export async function runHost(
  env: NodeJS.ProcessEnv = process.env,
  hooks: HostHooks = {},
): Promise<void> {
  // Everything this process creates (session file, pi's private dir) is private to the user.
  process.umask(0o077);
  // pi must never phone home or touch ~/.pi.
  env.PI_OFFLINE = env.PI_OFFLINE || '1';
  env.PI_TELEMETRY = '0';
  env.PI_SKIP_VERSION_CHECK = '1';

  const config = parseHostConfig(env[BRIDGE_ENV.config] ?? '');
  const bridgeUrl = env[BRIDGE_ENV.url] ?? '';
  const bridgeToken = env[BRIDGE_ENV.token] ?? '';
  const sessionFile = prepareSessionFile(config.sessionFile);
  const agentDir = env.PI_CODING_AGENT_DIR || join(dirname(sessionFile), '.pi-agent');
  env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (config.extraTrustedHosts?.length) setExtraTrustedHosts(config.extraTrustedHosts);

  const bridge = new BridgeClient({ url: bridgeUrl, token: bridgeToken });
  // Keep the token out of the environment of anything pi might spawn.
  delete env[BRIDGE_ENV.token];
  const cwd = process.cwd();

  // Import pi only now: it reads PI_* variables at runtime.
  const pi = await import('@earendil-works/pi-coding-agent');

  const credentials = new BridgeCredentialStore(bridge, config.model.provider, 5_000, (message) =>
    hostLog('warn', message),
  );
  const modelRuntime = await pi.ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const model = configureModel(modelRuntime, config.model);
  hooks.onModel?.(model, config);
  const imagesSupported = model.input.includes('image');
  const redactPages = redactsPages(model.id);

  // Codemode (docs/codemode.md): its agents write workflows; its coordinator, the chat's agent,
  // only delegates to them with a few plain tools.
  const codemode = config.role === 'agent';
  const coordinator = config.role === 'orchestrator';
  const assistant = config.role === 'assistant';
  // The chat's agent: its final messages link documents the user sees.
  const chatAgent = assistant || coordinator;
  const tools = codemode
    ? []
    : coordinator
      ? createCoordinatorTools({ bridge })
      : assistant
        ? createAssistantTools({ bridge, timeZone: config.timeZone })
        : createTools({
            bridge,
            imagesSupported,
            allowPrivateHosts: config.research.allowPrivateHosts ?? false,
            boeBaseUrl: config.research.boeBaseUrl,
            fetchImpl: hooks.egress?.fetch,
            resolveHost: hooks.egress?.resolveHost,
            onBlocked: hooks.egress?.onBlocked,
            now: hooks.now,
            feedback: config.feedback,
            dniePhone: config.dniePhone,
            redactPages,
            timeZone: config.timeZone,
          });
  // Web research (see ResearchBackend): vouchers through our key server, ChatGPT plans with
  // OpenAI's hosted web search, BYOK and custom endpoints on Exa's keyless tier. A research
  // stub (hooks) replaces both the choice and the tools, for procedure agents only (and every
  // codemode agent). The codemode coordinator never researches.
  const stub = assistant || coordinator ? undefined : hooks.research;
  const researchTools: AnyToolDefinition[] = [];
  const keyServerUrl = config.research.keyServerUrl;
  const research = coordinator
    ? undefined
    : stub
      ? stub.backend
      : await researchBackend(
          config,
          async () => (await credentials.read(config.model.provider))?.type === 'oauth',
        );
  if (stub) {
    researchTools.push(...stub.tools({ config, bridge, language: config.language }));
  } else if (research === 'key server' && keyServerUrl) {
    researchTools.push(
      createKeyServerResearchTool({
        keyServerUrl,
        apiKey: async () => {
          const credential = await credentials.read(config.model.provider);
          return credential?.type === 'api_key' ? credential.key : undefined;
        },
        language: config.language,
      }),
    );
  } else if (research === 'chatgpt') {
    researchTools.push(
      createChatGPTResearchTool({
        runtime: modelRuntime,
        // The catalog's model of that id, at the agent model's endpoint (a mock in e2e runs).
        model: (id) => ({
          ...(modelRuntime.getModel(model.provider, id) ?? model),
          id,
          baseUrl: model.baseUrl,
        }),
        language: config.language,
        ...(config.research.chatgptModels ? { models: config.research.chatgptModels } : {}),
      }),
    );
  } else if (research === 'exa') {
    researchTools.push(
      ...createExaTools({
        apiKey: async () => (await bridge.call('agent.exaKey', {})).key ?? undefined,
        language: config.language,
        ...(config.research.exaBaseUrl ? { baseUrl: config.research.exaBaseUrl } : {}),
      }),
    );
  }
  let engine: WorkflowEngine | undefined;
  if (codemode) {
    // Codemode: research, fetch and every other capability become the workflow API; the
    // model's only tool is `codemode` (docs/codemode.md).
    const wrappedResearch = wrapTools(researchTools, hooks.wrapTool);
    const searchTool =
      wrappedResearch.find((t) => t.name === WEB_RESEARCH_TOOL_NAME) ??
      wrappedResearch.find((t) => t.name === EXA_TOOL_NAMES[0]);
    const images = createImageStore();
    engine = new WorkflowEngine({
      bridge,
      images,
      imagesSupported,
      ...(searchTool
        ? {
            research: {
              kind: searchTool.name === WEB_RESEARCH_TOOL_NAME ? 'web_research' : 'exa',
              search: searchTool,
            },
          }
        : {}),
      allowPrivateHosts: config.research.allowPrivateHosts ?? false,
      ...(config.research.boeBaseUrl ? { boeBaseUrl: config.research.boeBaseUrl } : {}),
      ...(hooks.egress?.fetch ? { fetchImpl: hooks.egress.fetch } : {}),
      ...(hooks.egress?.resolveHost ? { resolveHost: hooks.egress.resolveHost } : {}),
      ...(hooks.egress?.onBlocked ? { onBlocked: hooks.egress.onBlocked } : {}),
      detachAfterMs: 2 * 60_000,
    });
    tools.push(codemodeTool({ engine, images, imagesSupported, language: config.language }));
  } else {
    tools.push(...researchTools);
  }
  const declarations = codemode
    ? buildDeclarations({
        search: researchTools.length > 0,
        ...(config.feedback ? { feedback: config.feedback } : {}),
        dniePhone: config.dniePhone,
      })
    : '';
  const agentTools = wrapTools(tools, hooks.wrapTool);
  const systemPrompt = () =>
    codemode
      ? buildCodemodePrompt({
          language: config.language,
          timeZone: config.timeZone,
          now: hooks.now?.(),
          research: researchTools.length ? promptResearch(research) : undefined,
          ...(config.feedback ? { feedback: config.feedback } : {}),
          dniePhone: config.dniePhone,
          certificateRequests: config.certificateRequests,
          declarations,
        })
      : coordinator
        ? buildCoordinatorPrompt({
            language: config.language,
            timeZone: config.timeZone,
            now: hooks.now?.(),
          })
        : assistant
          ? buildAssistantPrompt({
              language: config.language,
              timeZone: config.timeZone,
              now: hooks.now?.(),
            })
          : buildSystemPrompt({
              language: config.language,
              timeZone: config.timeZone,
              now: hooks.now?.(),
              research: promptResearch(research),
              feedback: config.feedback,
              dniePhone: config.dniePhone,
              certificateRequests: config.certificateRequests,
            });
  // Voucher keys: LiteLLM reports the key's spend on every call; the app shows it live.
  const onProviderResponse =
    config.model.provider === LITELLM_PROVIDER_ID
      ? (headers: Record<string, string>) => {
          const spend = parseLiteLLMSpendHeaders(headers);
          if (!spend) return;
          bridge
            .call('agent.voucherSpend', spend)
            .catch((err: unknown) => hostLog('warn', `voucher spend not sent: ${String(err)}`));
        }
      : undefined;
  // The session's requests, kept to summarize from the prompt cache (see idle-compaction.ts).
  let currentSession: { getSessionId(): string } | undefined;
  const requests = new SessionRequests(modelRuntime, () => currentSession?.getSessionId() ?? '');
  const extension = createSpainAssistExtension({
    tools: agentTools,
    systemPrompt,
    promptCacheKey: needsPromptCacheKey(model),
    redactPages,
    ...(onProviderResponse ? { onProviderResponse } : {}),
    // Only the assistant's messages reach the chat, where document links show as cards.
    ...(chatAgent
      ? {
          savedDocuments: async () =>
            (await bridge.call('vault.read', { keys: [] })).documents.map(({ id, name }) => ({
              id,
              name,
            })),
        }
      : {}),
    idleCompaction: {
      requests,
      minTokens: config.idleCompaction?.minTokens ?? IDLE_COMPACTION_MIN_TOKENS,
      ...(config.idleCompaction?.cacheTtlMs
        ? { cacheTtlMs: config.idleCompaction.cacheTtlMs }
        : {}),
    },
  });

  const settingsManager = pi.SettingsManager.inMemory({
    enableInstallTelemetry: false,
    enableAnalytics: false,
    defaultProjectTrust: 'never',
    defaultTools: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
    packages: [],
    retry: { enabled: true, maxRetries: 3 },
    compaction: { enabled: true },
    images: { autoResize: true, blockImages: !imagesSupported },
    cacheWarming: 'off',
    quietStartup: true,
  });
  const sessionManager = pi.SessionManager.open(sessionFile, dirname(sessionFile), cwd);

  const runtime = await pi.createAgentSessionRuntime(
    async (options) => {
      currentSession = options.sessionManager;
      const services = await pi.createAgentSessionServices({
        cwd: options.cwd,
        agentDir: options.agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPromptOverride: () => systemPrompt(),
          appendSystemPromptOverride: () => [],
          extensionFactories: [{ name: 'spainassist', factory: extension }],
        },
      });
      const result = await pi.createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model,
        thinkingLevel: config.model.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
        tools: agentTools.map((tool) => tool.name),
      });
      recordSessionSelection(options.sessionManager, result.session);
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager },
  );

  for (const diagnostic of runtime.diagnostics) {
    hostLog(
      diagnostic.type === 'error' ? 'error' : diagnostic.type === 'warning' ? 'warn' : 'info',
      diagnostic.message,
    );
  }
  if (runtime.modelFallbackMessage) hostLog('warn', runtime.modelFallbackMessage);
  hostLog(
    'info',
    `ready: ${config.role}, ${model.provider}/${model.id}, ${agentTools.length} tools, web research ${research ?? 'off'}`,
  );
  // Codemode: workflows that waited for the user resume in this process (their state is in the
  // app). In the background: their outcomes reach the agent as messages through the app.
  if (engine) {
    const resumer = engine;
    setTimeout(() => resumer.startResuming(), 0);
  }
  await pi.runRpcMode(runtime);
}

/** `wrap` applied to every tool; a wrapper that renames a tool breaks the session's tool list. */
function wrapTools(tools: AnyToolDefinition[], wrap: HostHooks['wrapTool']): AnyToolDefinition[] {
  if (!wrap) return tools;
  return tools.map((tool) => {
    const wrapped = wrap(tool);
    if (wrapped.name !== tool.name) {
      throw new Error(
        `HostHooks.wrapTool must keep the tool name: "${tool.name}" became "${wrapped.name}"`,
      );
    }
    return wrapped;
  });
}
