/**
 * `@sa/agent/host-runtime`: the agent host as a library, for code that runs it outside the shipped
 * app (the eval suite's own host entry, tests). The product host is `main.ts` (dist/host.js),
 * which calls `runHost()` with no hooks and imports nothing from here.
 *
 * An embedder bundles its own entry that builds `HostHooks` and calls `runHost(process.env,
 * hooks)`. It must keep pi, typebox and @napi-rs/canvas external (see scripts/build-host.mjs)
 * and, like every host code, never write to stdout: it carries the RPC protocol (use `hostLog`).
 */
export type { BridgeTransport } from '../bridge/client';
export type { ResolvedHostConfig } from '../config';
export {
  type ChatGPTResearchOptions,
  createChatGPTResearchTool,
} from '../research/chatgpt-research';
export { createExaTools, type ExaToolsOptions } from '../research/exa';
export type { HostResolver } from '../research/fetch';
export {
  createKeyServerResearchTool,
  type KeyServerResearchOptions,
} from '../research/key-server-research';
export type { AnyToolDefinition } from '../tools/common';
export type { HostEgress, HostHooks, HostResearchStub } from './hooks';
export { hostLog } from './log';
export type { ResearchBackend } from './research';
export { runHost } from './run';
