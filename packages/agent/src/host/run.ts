import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BRIDGE_ENV, DEFAULT_THINKING_LEVEL, setExtraTrustedHosts } from '@sa/shared';
import { BridgeClient } from '../bridge/client';
import { parseHostConfig } from '../config';
import { buildAssistantPrompt } from '../prompt/assistant';
import { buildSystemPrompt } from '../prompt/system';
import { parseLiteLLMSpendHeaders } from '../providers/services';
import { createKeyServerResearchTool } from '../research/key-server-research';
import { createAssistantTools, createTools } from '../tools/index';
import { BridgeCredentialStore } from './credentials';
import { createSpainAssistExtension } from './extension';
import { IDLE_COMPACTION_MIN_TOKENS, SessionRequests } from './idle-compaction';
import { hostLog } from './log';
import { configureModel, LITELLM_PROVIDER_ID, needsPromptCacheKey } from './model';
import { redactsPages } from './redaction';
import { prepareSessionFile } from './session';

/**
 * Agent host: one process per active agent (the assistant, or one procedure's agent). Reads its configuration from the environment
 * (see BRIDGE_ENV), builds a pi session with only SpainAssist tools and serves pi's RPC
 * protocol (JSONL) on stdin/stdout via `runRpcMode`. Never returns.
 */
export async function runHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
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
  const imagesSupported = model.input.includes('image');
  const redactPages = redactsPages(model.id);

  const assistant = config.role === 'assistant';
  const tools = assistant
    ? createAssistantTools({ bridge })
    : createTools({
        bridge,
        imagesSupported,
        allowPrivateHosts: config.research.allowPrivateHosts ?? false,
        boeBaseUrl: config.research.boeBaseUrl,
        feedback: config.feedback,
        dniePhone: config.dniePhone,
        redactPages,
      });
  // Web research: voucher users through our key server (Parallel, paid from the voucher).
  const keyServerUrl = config.research.keyServerUrl;
  const webResearch = !assistant && config.model.provider === 'litellm' && !!keyServerUrl;
  if (webResearch) {
    tools.push(
      createKeyServerResearchTool({
        keyServerUrl,
        apiKey: async () => {
          const credential = await credentials.read(config.model.provider);
          return credential?.type === 'api_key' ? credential.key : undefined;
        },
        language: config.language,
      }),
    );
  }
  const systemPrompt = () =>
    assistant
      ? buildAssistantPrompt({ language: config.language, timeZone: config.timeZone })
      : buildSystemPrompt({
          language: config.language,
          timeZone: config.timeZone,
          webResearch,
          feedback: config.feedback,
          dniePhone: config.dniePhone,
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
    tools,
    systemPrompt,
    promptCacheKey: needsPromptCacheKey(model),
    redactPages,
    ...(onProviderResponse ? { onProviderResponse } : {}),
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
        tools: tools.map((tool) => tool.name),
      });
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
    `ready: ${config.role}, ${model.provider}/${model.id}, ${tools.length} tools, web research ${webResearch ? 'key server' : 'off'}`,
  );
  await pi.runRpcMode(runtime);
}
