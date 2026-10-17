import type { Api, Model } from '@earendil-works/pi-ai';
import type { BridgeTransport } from '../bridge/client';
import type { ResolvedHostConfig } from '../config';
import type { BlockedRequest, HostResolver } from '../research/fetch';
import type { AnyToolDefinition } from '../tools/common';
import type { ResearchBackend } from './research';

/**
 * Seams of `runHost` for code that runs the agent host somewhere other than the shipped app: an
 * offline harness (the eval suite, tools/eval), or a test. Every hook is optional and `runHost`
 * without hooks is the product host. The product entry (`main.ts`, bundled to dist/host.js)
 * never passes any: hooks are function values given by the code that calls `runHost`, so no
 * config key or environment variable can switch them on in a shipped build.
 */

/** Where the host's own HTTP requests go. */
export interface HostEgress {
  /**
   * All outbound HTTP of `fetch_url`, `run_script` (its `fetch`) and `boe_search`. Receives the
   * real URL the agent asked for (a `URL` object from the first two, a string from BOE) and the
   * init the tool built (`redirect: 'manual'` from the first two: they follow redirects
   * themselves; BOE relies on the platform default).
   */
  fetch: typeof fetch;
  /**
   * DNS for the SSRF guard of `fetch_url` and `run_script`. The guard keeps blocking IP literals
   * and `localhost` as in production, and resolves every other name through this function
   * before it calls `fetch`: without it a name that does not exist in real DNS never reaches
   * `fetch`, and the guard's lookup would leave the machine. Must not touch the network.
   */
  resolveHost?: HostResolver;
  /**
   * Told about each request the SSRF guard of `fetch_url` and `run_script` refuses (an IP literal,
   * `localhost`, a name that resolves to a private address): those never reach `fetch`, so this
   * is the only place an offline harness can see them. Called inside the tool call that made it.
   */
  onBlocked?: (request: BlockedRequest) => void;
}

/** Replaces the host's web research (the backend choice and its tools). */
export interface HostResearchStub {
  /**
   * The backend the system prompt and the tool shape emulate; replaces `researchBackend()`.
   * Undefined: no web research (the prompt then reports it as unavailable).
   */
  backend: ResearchBackend | undefined;
  /** The research tools: replace the ones built for the backend (key server, ChatGPT, Exa). */
  tools(context: {
    config: ResolvedHostConfig;
    bridge: BridgeTransport;
    language: 'es' | 'en';
  }): AnyToolDefinition[];
}

export interface HostHooks {
  egress?: HostEgress;
  /** A procedure agent only: the assistant has no web research, stubbed or not. */
  research?: HostResearchStub;
  /**
   * Wraps every tool of the agent (its own, plus the research ones) once, when the host starts:
   * logging, or a per-call context (`AsyncLocalStorage` keyed by tool call id). The wrapper must
   * return a tool with the same `name` (the host checks) and, as a rule, keep every other
   * property (`executionMode`, `parameters`, ...) as it is.
   */
  wrapTool?: (tool: AnyToolDefinition) => AnyToolDefinition;
  /**
   * Called once the model is configured, before the host talks to anything: where to install
   * guards that need the model gateway's origin (`new URL(model.baseUrl).origin`).
   */
  onModel?: (model: Model<Api>, config: ResolvedHostConfig) => void;
  /** The clock of "Today is ..." in the system prompts, read on every turn. Default: now. */
  now?: () => Date;
}
