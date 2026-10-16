/**
 * @sa/agent — everything pi-specific (see docs/research/pi.md and packages/agent/README.md).
 *
 *  - Agent host (src/host, bundled to dist/host.js): one Node process per active agent (the
 *    assistant that runs the chat, or one procedure's agent) that
 *    uses the pi SDK (`createAgentSessionRuntime` + `runRpcMode`) to speak pi's RPC JSONL protocol
 *    over stdio, with ONLY SpainAssist tools, the exact system prompt, no discovery of
 *    extensions/skills/context files, PI_OFFLINE / PI_TELEMETRY=0, and a CredentialStore that
 *    asks the app for credentials over the host bridge (nothing secret on disk or in env).
 *  - Tools (inline pi extension): bridge-backed (procedure, prompts, vault, browser, feedback) or
 *    local (fetch_url, BOE API). Web research: our key server for voucher users (Parallel),
 *    OpenAI's web search on ChatGPT plans, Exa's keyless tier for BYOK and custom endpoints.
 *  - `buildAgentLaunch()` / `PiRpcClient`: how the desktop main process runs and drives a host.
 *  - Provider helpers for main: Sign in with ChatGPT (own OAuth flow), refresh, model lists,
 *    BYOK catalogue, vouchers (LiteLLM gateway credit and models).
 *
 * This entry point is light (no HTML/PDF libraries): those live only in dist/host.js.
 */

export {
  type AgentHostConfig,
  AgentHostConfigSchema,
  parseHostConfig,
} from './config';
export { configureModel } from './host/model';
export {
  type AgentLaunch,
  type AgentLaunchOptions,
  agentHostPath,
  buildAgentLaunch,
  INHERITED_ENV_VARS,
} from './launch';
export { buildAssistantPrompt, REPORT_PREFIX } from './prompt/assistant';
export { buildSystemPrompt, type SystemPromptOptions } from './prompt/system';
export {
  CHATGPT_ENDPOINTS,
  type ChatGPTEndpoints,
  type ChatGPTLoginCallbacks,
  ChatGPTLoginError,
  type ChatGPTLoginPages,
  type ChatGPTLoginResult,
  credentialNeedsRefresh,
  loginChatGPT,
  refreshOAuthCredential,
  revokeChatGPTCredential,
} from './providers/chatgpt';
export {
  ASSISTANT_MODELS,
  DEFAULT_MODELS,
  type FixedModel,
  listByokProviders,
  listProviderModels,
} from './providers/models';
export {
  getChatGPTKey,
  getVoucherCredit,
  KeyServerError,
  redeemVoucher,
} from './providers/services';
export type { LoginStage, PiCredential } from './providers/types';
export {
  type AgentSessionInfo,
  PiRpcClient,
  type PiRpcClientOptions,
  type PromptDisposition,
  type PromptImage,
  type PromptOptions,
} from './rpc/client';
export { type AgentErrorKind, type AgentEvent, classifyAgentError } from './rpc/events';
export { type RpcTransport, type RpcTransportFactory, spawnTransport } from './rpc/transport';
export {
  ASSISTANT_TOOL_NAMES,
  type AssistantToolName,
  TOOL_NAMES,
  type ToolName,
} from './tools/names';
