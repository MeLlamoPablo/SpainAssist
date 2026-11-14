import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentLaunch, PiRpcClient } from '@sa/agent';
import { createHeadlessApp, type HeadlessApp } from '@sa/desktop/headless';
import type { SaEvent, UiNode, WorkflowInfo } from '@sa/shared';

/**
 * A real app for codemode tests (docs/codemode.md, "Verification"):
 * `createHeadlessApp` with the real agent hosts (`@sa/agent`'s dist/host.js) talking to a
 * scripted model (`tools/mock-llm`), and a local "official" site. Nothing leaves 127.0.0.1.
 */

export interface LocalSite {
  url: string;
  close(): Promise<void>;
}

/** A tiny official-looking page server for the research step. */
export async function startLocalSite(pages: Record<string, string>): Promise<LocalSite> {
  const server: Server = createServer((req, res) => {
    const body = pages[req.url ?? '/'];
    if (!body) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RealApp {
  app: HeadlessApp;
  events: SaEvent[];
  close(): Promise<void>;
}

/**
 * The app with the real agent host, a custom provider at `llmBaseUrl` and, for the local site,
 * private hosts allowed to the agents' HTTP (the tests' stand-in for the eval's egress hooks).
 */
export async function openRealApp(options: {
  llmBaseUrl: string;
  hostScript?: string;
}): Promise<RealApp> {
  const root = await mkdtemp(join(tmpdir(), 'sa-codemode-real-'));
  const app = await createHeadlessApp({
    userDataDir: join(root, 'userData'),
    tmpRoot: join(root, 'tmp'),
    ...(options.hostScript ? { hostScript: options.hostScript } : {}),
    agentLib: {
      buildAgentLaunch: (opts) =>
        buildAgentLaunch({
          ...opts,
          config: {
            ...opts.config,
            research: { ...opts.config.research, allowPrivateHosts: true },
          },
        }),
      createClient: (launch) => new PiRpcClient(launch),
    },
  });
  const events: SaEvent[] = [];
  app.on((e) => events.push(e));
  const set = await app.invoke('providers.setCustom', {
    baseUrl: options.llmBaseUrl,
    api: 'openai-completions',
    model: 'mock-model',
  });
  if (!set.ok) throw new Error(`Provider not set: ${set.error}`);
  return {
    app,
    events,
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Polls until `check` returns a value (not undefined), or fails after `ms`. */
export async function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  ms = 60_000,
  what = 'condition',
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The first node of a tree of that type (and text). */
export function findNode(
  tree: UiNode | undefined,
  type: string,
  text?: string,
): Exclude<UiNode, string> | undefined {
  if (!tree || typeof tree === 'string') return undefined;
  if (tree.type === type && (text === undefined || tree.children.includes(text))) return tree;
  for (const child of tree.children) {
    const found = findNode(child, type, text);
    if (found) return found;
  }
  return undefined;
}

export function handler(node: Exclude<UiNode, string> | undefined, prop: string): string {
  const value = node?.props[prop] as { $handler?: string } | undefined;
  if (!value?.$handler) throw new Error(`No ${prop} handler`);
  return value.$handler;
}

/** The open interface of a workflow, once it is on screen. */
export async function openInterface(
  app: HeadlessApp,
  key: string,
  ms = 60_000,
): Promise<{ workflow: WorkflowInfo; tree: UiNode; rev: number }> {
  return waitFor(
    async () => {
      const state = await app.invoke('codemode.state');
      for (const workflow of state.workflows) {
        const ui = workflow.ui.find((u) => u.key === key);
        if (ui?.tree) return { workflow, tree: ui.tree, rev: ui.rev };
      }
      return undefined;
    },
    ms,
    `interface "${key}"`,
  );
}
