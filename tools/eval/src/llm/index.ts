/**
 * Model access for the eval suite: the loopback meter proxy (cost, budget, ledger, record/replay
 * cache), the Codex device login and credential store, the answerer client and the budget report.
 * See tools/eval/README.md ("LLM access") and docs/EVAL.md.
 */

export {
  ANSWERER_AGENT_KEY,
  type Answerer,
  AnswererError,
  type AnswererOptions,
  type AnswererRequest,
  type AnswererResult,
  type ConversationTurn,
  createAnswerer,
  createDirectorySink,
  DEFAULT_ANSWERER_MODEL,
  DEFAULT_ANSWERER_THINKING,
  DEFAULT_CODEX_ANSWERER_MODEL,
} from './answerer';
export { budgetStatus } from './budget';
export { CACHE_MODES } from './cache';
export type { VolatilePattern } from './canonical';
export { CODEX_CONSENT_FLAG } from './codex-auth';
export { type CredentialSource, createCredentialSource, credentialSecrets } from './credentials';
export { evalHome, loadVoucherCredential } from './home';
export { Ledger } from './ledger';
export { DEFAULT_LIMITS, type MeterLimitsInput } from './limits';
export {
  createMeter,
  type MeterEvent,
  type MeterHandle,
  type MeterRun,
  type MeterRunSummary,
  type OpenRunOptions,
} from './meter';
