import type { Language } from '@sa/shared';
import type { BridgeTransport } from '../bridge/client';
import { assistantTools } from './assistant';
import { BindingGate } from './binding';
import { browserTools } from './browser';
import type { AnyToolDefinition } from './common';
import { documentTools } from './documents';
import { downloadTools } from './downloads';
import { fetchUrlTool } from './fetch-url';
import { createHostPolicy } from './hosts';
import { ASSISTANT_TOOL_NAMES, TOOL_NAMES } from './names';
import { procedureTools } from './procedure';
import { researchTools } from './research';
import { runScriptTool } from './run-script';
import { userTools } from './user';
import { vaultTools } from './vault';

export type { AnyToolDefinition } from './common';

export {
  ASSISTANT_TOOL_NAMES,
  type AssistantToolName,
  TOOL_NAMES,
  type ToolName,
} from './names';

export interface ToolDeps {
  bridge: BridgeTransport;
  /** Whether the model accepts images (browser_screenshot). */
  imagesSupported: boolean;
  /** Dev/e2e only: fetch_url and run_script may reach localhost / private networks. */
  allowPrivateHosts?: boolean;
  /** BOE API base URL override (tests). */
  boeBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Community learnings: feedback_search, plus feedback_submit / feedback_vote when on. */
  feedback?: { submit: boolean; vote: boolean };
  /** The DNIe through the phone app (feature flag): browser_use_certificate offers it. */
  dniePhone?: boolean;
  /** Old page results are redacted from the context (see host/redaction.ts). */
  redactPages?: boolean;
  /** The user's IANA time zone, for times in tool results (default Europe/Madrid). */
  timeZone?: string;
  /** Language of the app's prompts raised by tools (host approvals). Default es. */
  language?: Language;
}

/** The tools of a procedure's agent. */
export function createTools(deps: ToolDeps): AnyToolDefinition[] {
  const active = (name: string) =>
    name === 'feedback_search'
      ? !!deps.feedback
      : name === 'feedback_submit'
        ? !!deps.feedback?.submit
        : name === 'feedback_vote'
          ? !!deps.feedback?.vote
          : true;
  // One per agent run: an approved host stays approved for fetch_url, run_script and the browser.
  const hosts = createHostPolicy({ bridge: deps.bridge, language: deps.language });
  // Shared by confirm_action (the user's approval) and the browser tools (binding actions).
  const gate = new BindingGate();
  return finish(
    TOOL_NAMES.filter(active),
    [
      ...procedureTools(deps.bridge),
      ...userTools(deps.bridge, { dniePhone: deps.dniePhone ?? false, gate }),
      ...vaultTools(deps.bridge, { timeZone: deps.timeZone }),
      ...documentTools(deps.bridge, { imagesSupported: deps.imagesSupported }),
      ...browserTools(deps.bridge, {
        imagesSupported: deps.imagesSupported,
        dniePhone: deps.dniePhone ?? false,
        redactPages: deps.redactPages ?? false,
        gate,
        hosts,
      }),
      ...downloadTools(deps.bridge),
      ...researchTools(deps.bridge, { baseUrl: deps.boeBaseUrl, fetchImpl: deps.fetchImpl }),
      fetchUrlTool({ hosts, allowPrivateHosts: deps.allowPrivateHosts, fetchImpl: deps.fetchImpl }),
      runScriptTool({
        hosts,
        allowPrivateHosts: deps.allowPrivateHosts,
        fetchImpl: deps.fetchImpl,
      }),
    ].filter((tool) => active(tool.name)),
  );
}

/** The tools of the assistant (orchestrator). */
export function createAssistantTools(
  deps: Pick<ToolDeps, 'bridge' | 'timeZone'>,
): AnyToolDefinition[] {
  const ask = userTools(deps.bridge).filter((tool) => tool.name === 'ask_user');
  return finish(ASSISTANT_TOOL_NAMES, [
    ...assistantTools(deps.bridge),
    ...ask,
    ...vaultTools(deps.bridge, { timeZone: deps.timeZone }),
  ]);
}

/** Checks the list against `names`, marks stateful tools sequential and sorts it like `names`. */
function finish(names: readonly string[], tools: AnyToolDefinition[]): AnyToolDefinition[] {
  const order = new Map<string, number>(names.map((name, i) => [name, i]));
  const missing = names.filter((name) => !tools.some((t) => t.name === name));
  const extra = tools.filter((t) => !order.has(t.name)).map((t) => t.name);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Tool list mismatch. Missing: ${missing.join(', ')}; extra: ${extra.join(', ')}`,
    );
  }
  for (const tool of tools) {
    // Tools that change state or wait for the user never run concurrently with other calls
    // (pi runs a whole batch sequentially when one of its calls is sequential).
    if (tool.name.startsWith('browser_') || SEQUENTIAL_TOOLS.has(tool.name)) {
      tool.executionMode = 'sequential';
    }
  }
  return tools.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
}

const SEQUENTIAL_TOOLS: ReadonlySet<string> = new Set([
  'procedure_update',
  'procedure_start',
  'procedure_message',
  'procedure_respond',
  'procedure_resume',
  'procedure_stop',
  'procedure_cancel',
  'ask_user',
  'confirm_action',
  'request_user_action',
  'request_credential',
  'request_phone_call',
  'vault_save',
  'download_save',
  'feedback_submit',
  'feedback_vote',
]);
