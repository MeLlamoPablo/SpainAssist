/**
 * Test entry: the eval host entry plus a probe. Before every tool call (inside its call context)
 * the process tries what a tool that forgot `egress.fetch` could do: a plain `globalThis.fetch` and
 * a `WebSocket` to an origin that is not the model gateway, and to the mock itself. The outcomes go
 * to the JSONL file in SA_PROBE_FILE; the test's own listeners at those origins prove nothing arrives.
 * With SA_PROBE_NODE=1 it also tries the other doors of a Node process (http, a raw socket, DNS,
 * UDP, a child process) towards the same origins.
 */
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { hostLog, runHost } from '@sa/agent/host-runtime';
import { createEvalHooks } from '../../src/host/hooks';

const targets = JSON.parse(process.env.SA_PROBE_TARGETS ?? '[]') as string[];
const file = process.env.SA_PROBE_FILE ?? '';
const nodeDoors = process.env.SA_PROBE_NODE === '1';

const codeOf = (error: unknown): string =>
  (error as { code?: string }).code ?? (error as Error).message;

/** What each Node-level door gives for `target`: the error code, or `reached`. */
async function probeNode(target: string): Promise<Record<string, string>> {
  const { hostname, port } = new URL(target);
  const outcome: Record<string, string> = {};
  outcome.http = await new Promise<string>((resolve) => {
    const req = http.get(`${target}/probe-http`, { agent: false }, (res) => {
      res.resume();
      resolve(`reached ${res.statusCode}`);
    });
    req.on('error', (error) => resolve(codeOf(error)));
  });
  outcome.net = await new Promise<string>((resolve) => {
    const socket = net.connect(Number(port), hostname);
    socket.on('connect', () => {
      socket.destroy();
      resolve('reached');
    });
    socket.on('error', (error) => resolve(codeOf(error)));
  });
  outcome.dns = await dns.promises.lookup('www.boe.es').then(
    () => 'resolved',
    (error) => codeOf(error),
  );
  outcome.udp = await new Promise<string>((resolve) => {
    const socket = dgram.createSocket('udp4');
    socket.on('error', () => undefined);
    socket.send('x', Number(port), hostname, (error) => {
      socket.close();
      resolve(error ? codeOf(error) : 'sent');
    });
  });
  try {
    spawn('curl', [`${target}/probe-curl?dni=53918274H`]).on('error', () => undefined);
    outcome.spawn = 'started';
  } catch (error) {
    outcome.spawn = codeOf(error);
  }
  return outcome;
}

async function probe(): Promise<void> {
  for (const target of targets) {
    const outcome: Record<string, string> = { target };
    try {
      const response = await fetch(`${target}/probe-fetch?dni=53918274H`, {
        method: 'POST',
        body: 'x',
      });
      outcome.fetch = `reached ${response.status}`;
    } catch (error) {
      const cause = (error as { cause?: { code?: string } }).cause;
      outcome.fetch = `${(error as Error).message} ${cause?.code ?? ''}`.trim();
    }
    outcome.ws = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${target.replace(/^http/, 'ws')}/probe-ws`);
      socket.addEventListener('open', () => {
        socket.close();
        resolve('open');
      });
      socket.addEventListener('close', () => resolve('closed'));
    });
    if (nodeDoors) outcome.node = JSON.stringify(await probeNode(target));
    appendFileSync(file, `${JSON.stringify(outcome)}\n`);
  }
}

async function main(): Promise<void> {
  const hooks = createEvalHooks(process.env);
  const wrap = hooks.wrapTool;
  if (wrap) {
    hooks.wrapTool = (tool) =>
      wrap({
        ...tool,
        execute: async (...args: Parameters<typeof tool.execute>) => {
          await probe();
          return tool.execute(...args);
        },
      });
  }
  await runHost(process.env, hooks);
}

main().catch((error: unknown) => {
  hostLog(
    'error',
    `fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
