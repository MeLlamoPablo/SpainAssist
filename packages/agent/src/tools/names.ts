/**
 * Web research of vouchers and ChatGPT plans: it streams the run's events, so one call waits for
 * the final result.
 */
export const WEB_RESEARCH_TOOL_NAME = 'web_research';

/**
 * Web research of BYOK and custom endpoints, on Exa's keyless tier: search, and read
 * pages. They replace `web_research`, which those agents don't have.
 */
export const EXA_TOOL_NAMES = ['exa_search', 'exa_fetch'] as const;

/**
 * Every tool of the coordinator (the chat's agent): it only delegates to background agents and
 * reads the cards they keep. No research, no questions to the user, no procedures of its own
 * (docs/codemode.md, "The coordinator").
 */
export const COORDINATOR_TOOL_NAMES = [
  'agent_start',
  'agent_message',
  'agent_stop',
  'agent_list',
  'procedure_list',
  'procedure_read',
] as const;
