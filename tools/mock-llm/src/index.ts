/**
 * @sa/mock-llm — scripted OpenAI-compatible LLM server for tests and demos.
 *
 *   const llm = await createMockLlm({ scenario: { rules: [...] } });
 *   // configure the agent with provider "custom", baseUrl llm.baseUrl, api "openai-completions"
 *   llm.requests(); // recorded request bodies (assert secrets never reach the LLM)
 *   await llm.close();
 *
 * HTTP API: POST /v1/chat/completions (SSE streaming and plain JSON), GET /v1/models,
 * GET /key/info (LiteLLM-style, for mock voucher keys), POST /__scenario (JSON scenario, or {"name":"demo"} for a built-in one), GET /__scenario,
 * GET /__requests, POST /__reset.
 */
export {
  analyzeRequest,
  type ChatMessage,
  type ChatRequest,
  MatchSpec,
  matchRule,
  parseScenario,
  ReplySpec,
  RuleSpec,
  type Scenario,
  type ScenarioInput,
  ScenarioSpec,
  ToolCallSpec,
} from './scenario';
export { BUILTIN_SCENARIOS, builtinScenario } from './scenarios';
export { createMockLlm, type MockLlm, type MockLlmOptions, type RecordedRequest } from './server';
