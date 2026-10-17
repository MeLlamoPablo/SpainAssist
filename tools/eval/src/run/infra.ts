import type { AgentErrorKind } from '@sa/agent';
import type { Observation } from '../contracts';
import type { MeterEvent } from '../llm';

type CapReason = Extract<MeterEvent, { type: 'cap' }>['reason'];

/**
 * Whose fault a thing that stopped an agent is (docs/EVAL.md, "Run loop"). The score is the agent's:
 * a model that makes bad tool calls, says wrong things, loops or fills its context with junk has
 * failed. Everything else is not the agent's doing and must never be read as it:
 *
 * - the INFRASTRUCTURE failed (the model gateway, an agent host process that crashed, Chromium that
 *   would not launch, SpainBench): the run ends as `error`, unscored;
 * - the harness's own BUDGET said no (the key's reserve, the daily and lifetime caps, the kill
 *   switch, the gateway's limits, a Codex plan window): the run ends as `limit:budget`, unscored
 *   (status `aborted`);
 * - the AGENT hit a limit its own behaviour trips (the per-run and per-agent request and dollar
 *   caps): the run ends as `limit:requests` or `limit:cost` and the rules judge what happened.
 */
export type Blame =
  | { by: 'infrastructure'; source: 'model' | 'host' | 'browser'; kind: string }
  | { by: 'budget' }
  | { by: 'agent' };

/**
 * What the app reports when an agent's turn fails (`AgentErrorKind` of `@sa/agent`, set on the
 * `run_end` that pi's own retries (three, for 429 and 5xx) did not recover, and by the client when
 * the host process dies mid-run). Only `context` is the agent's: its conversation outgrew the
 * model's window. `quota` is the gateway or plan refusing to spend more, so the harness's budget;
 * the meter reports the caps it enforces itself (`classifyCap`) before the agent even sees them.
 * Every other kind is the model gateway or the host failing: a 401 or 403 (an expired or refused
 * key, a Codex login that is dead), a 429 that outlasted the retries, a 5xx or overload, the
 * network, a host that crashed, and an error nobody could name (`unknown`: the harness cannot show
 * it was the agent's, so it does not score it).
 */
export function classifyAgentFailure(kind: AgentErrorKind): Blame {
  switch (kind) {
    case 'context':
      return { by: 'agent' };
    case 'quota':
      return { by: 'budget' };
    case 'crash':
      return { by: 'infrastructure', source: 'host', kind };
    default:
      return { by: 'infrastructure', source: 'model', kind };
  }
}

/** What a meter cap, by its reason and the agent whose request it refused, ends the run as. */
export type CapEnding = 'limit:cost' | 'limit:requests' | 'limit:budget';

/**
 * The meter's caps, by who trips them. The dollar and request caps of a run and of one agent stop
 * an agent that loops or bloats its context: the agent's doing, so they are scored limits (`run_budget`
 * is the fixture's own cost limit; `requests_cap` counts the whole run). Caps of the simulated user
 * (the `answerer` agent, a few cents) are the harness's. So are the key's reserve, the daily and
 * lifetime caps, the kill switch and the Codex plan windows.
 */
export function classifyCap(reason: CapReason, agent: string): CapEnding {
  const answerer = agent === 'answerer';
  switch (reason) {
    case 'run_budget':
      return 'limit:cost';
    case 'requests_cap':
      return 'limit:requests';
    case 'agent_requests_cap':
      return answerer ? 'limit:budget' : 'limit:requests';
    case 'agent_budget':
    case 'input_too_large':
    case 'codex_tokens':
      return answerer ? 'limit:budget' : 'limit:cost';
    case 'stopped':
    case 'lifetime':
    case 'daily':
    case 'key_reserve':
    case 'codex_window':
    case 'codex_cooldown':
      return 'limit:budget';
  }
}

/** Playwright's own words for a Chromium that cannot start (the result of a browser tool). */
const BROWSER_LAUNCH_FAILURE = /Executable doesn't exist|browserType\.launch|Failed to launch/i;

/**
 * A browser tool that failed because Chromium could not be started: a missing browser build, or a
 * launch that fails on this machine. Nothing the model does changes that, so it is not scored.
 * Returns what the tool said, or undefined for any other result.
 */
export function browserLaunchFailure(observation: Observation): string | undefined {
  if (observation.type !== 'tool_end' || !observation.isError) return undefined;
  if (!observation.tool.startsWith('browser_')) return undefined;
  return BROWSER_LAUNCH_FAILURE.test(observation.text) ? observation.text : undefined;
}
