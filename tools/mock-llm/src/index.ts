/**
 * @sa/mock-llm — scripted OpenAI-compatible LLM server for tests and demos.
 *
 *   const llm = await createMockLlm({ scenario: { rules: [...] } });
 *   // configure the agent with provider "custom", baseUrl llm.baseUrl, api "openai-completions"
 *   llm.requests(); // recorded request bodies (assert secrets never reach the LLM)
 *   await llm.close();
 *
 * HTTP API: POST /v1/chat/completions (SSE streaming and plain JSON), POST /v1/responses and
 * POST /backend-api/codex/responses (the Responses API: SSE events, zstd request bodies, ChatGPT
 * credentials required on the Codex path, 426 on WebSocket upgrades), GET /v1/models,
 * GET /key/info (LiteLLM-style, for mock voucher keys), POST /__scenario (JSON scenario, or {"name":"demo"} for a built-in one), GET /__scenario,
 * GET /__requests, POST /__reset, GET|POST /__litellm (the simulated key).
 *
 * `createMockLlm({ litellm: { maxBudgetUsd } })` emulates a LiteLLM gateway: `x-litellm-key-spend`,
 * `x-litellm-key-max-budget` and `x-litellm-response-cost` headers, cache-read, cache-write and
 * reasoning tokens in the usage, and the 422 "Budget has been exceeded!" answer.
 */
export {
  HAIKU_PRICES,
  type KeyState,
  type LiteLlmOptions,
  type LiteLlmPrices,
} from './litellm';
export {
  analyzeRequest,
  type CallInfo,
  type ChatMessage,
  type ChatRequest,
  MatchSpec,
  matchRule,
  parseScenario,
  ReplySpec,
  type RequestFacts,
  RuleSpec,
  type Scenario,
  type ScenarioInput,
  ScenarioSpec,
  type ScenarioState,
  ToolCalledSpec,
  ToolCallSpec,
} from './scenario';
export { BUILTIN_SCENARIOS, builtinScenario } from './scenarios';
export { createMockLlm, type MockLlm, type MockLlmOptions, type RecordedRequest } from './server';
