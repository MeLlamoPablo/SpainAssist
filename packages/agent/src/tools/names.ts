/**
 * Every tool a procedure's agent has. Nothing else is ever active (no shell, no file tools).
 */
export const TOOL_NAMES = [
  'procedure_update',
  'ask_user',
  'confirm_action',
  'request_user_action',
  'request_credential',
  'request_phone_call',
  'vault_read',
  'vault_save',
  'document_read',
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_fill_from_vault',
  'browser_login_clave',
  'browser_fill_from_user',
  'browser_select',
  'browser_check',
  'browser_press',
  'browser_wait',
  'browser_back',
  'browser_tabs',
  'browser_screenshot',
  'browser_upload',
  'browser_use_certificate',
  'browser_close',
  'download_save',
  'fetch_url',
  'run_script',
  'boe_search',
  'feedback_search',
  'feedback_submit',
  'feedback_vote',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Every tool the assistant (the orchestrator behind the chat) has: it delegates all research and
 * online work to procedure agents, and only talks to the user and their saved data.
 */
export const ASSISTANT_TOOL_NAMES = [
  'procedure_list',
  'procedure_read',
  'procedure_start',
  'procedure_message',
  'procedure_respond',
  'procedure_stop',
  'procedure_cancel',
  'ask_user',
  'vault_read',
  'vault_save',
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

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
