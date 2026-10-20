/**
 * Talk to the real agent host from a terminal, without the desktop app.
 *
 *   corepack pnpm --filter @sa/agent build
 *   corepack pnpm --filter @sa/mock-llm start -- --port 8789          # other terminal
 *   corepack pnpm --filter @sa/agent dev:chat                         # mock LLM, demo scenario
 *   corepack pnpm --filter @sa/agent dev:chat -- --provider openrouter --model moonshotai/kimi-k2.6 \
 *     --key-env OPENROUTER_API_KEY                                    # a real model (your key)
 *
 * A built-in fake host bridge answers the tools: the plan card is printed, forms / confirmations /
 * manual actions are asked here, the vault is in memory, browser and web search are unavailable.
 * The API key is read by this script and served over the bridge (never in the host's env).
 */
import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { type AgentEvent, buildAgentLaunch, PiRpcClient } from '../src/index';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== '--'),
  options: {
    provider: { type: 'string', default: 'custom' },
    model: { type: 'string', default: 'mock-model' },
    'base-url': { type: 'string' },
    'key-env': { type: 'string' },
    language: { type: 'string', default: 'es' },
    session: { type: 'string' },
    thinking: { type: 'string' },
  },
});

const provider = values.provider ?? 'custom';
const baseUrl =
  values['base-url'] ?? (provider === 'custom' ? 'http://127.0.0.1:8789/v1' : undefined);
const apiKey = values['key-env'] ? process.env[values['key-env']] : undefined;
const workDir = join(tmpdir(), 'sa-dev-chat');
mkdirSync(workDir, { recursive: true });
const sessionFile = values.session ?? join(workDir, `session-${Date.now()}.jsonl`);

const rl = createInterface({ input: process.stdin, terminal: false });
const lines = rl[Symbol.asyncIterator]();
/** Reads the next input line (buffered, so piped input works too); null at end of input. */
async function ask(prompt: string): Promise<string | null> {
  process.stdout.write(prompt);
  const next = await lines.next();
  return next.done ? null : next.value;
}
const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const bold = (text: string) => `\x1b[1m${text}\x1b[0m`;
const procedure: Record<string, unknown> = {
  id: 'dev',
  title: 'Trámite',
  status: 'researching',
  steps: [],
  requirements: [],
  facts: [],
  sources: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  archived: false,
};
const vault: Record<string, string> = {};

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

const handlers: Record<string, Handler> = {
  'agent.credential': () => ({ credential: apiKey ? { type: 'api_key', key: apiKey } : null }),
  'agent.refreshCredential': () => ({ credential: null }),
  'procedure.get': () => procedure,
  'procedure.update': (params) => {
    Object.assign(procedure, params, { updatedAt: new Date().toISOString() });
    if (params.nextAction === null) delete procedure.nextAction;
    const steps = (procedure.steps as { title: string; status: string }[])
      .map((s) => `${s.title} [${s.status}]`)
      .join('; ');
    const next = procedure.nextAction as { text: string; owner: string } | undefined;
    console.log(
      dim(
        `\n[plan] ${procedure.title} · ${procedure.status}${next ? ` · next: ${next.text} (${next.owner})` : ''}\n       steps: ${steps || '-'}\n`,
      ),
    );
    return procedure;
  },
  'prompt.form': async (params) => {
    console.log(bold(`\n[form] ${params.title}`), params.message ? `\n${params.message}` : '');
    const values: Record<string, string> = {};
    for (const field of params.fields as { key: string; label: string; type: string }[]) {
      values[field.key] = (await ask(`  ${field.label} (${field.type}): `)) ?? '';
    }
    return { kind: 'form', values, dismissed: false, savedToVault: [] };
  },
  'prompt.confirm': async (params) => {
    console.log(bold(`\n[confirm:${params.confirmKind}] ${params.title}`), `\n${params.message}`);
    const answer = (await ask('  ¿Aprobar? (s/n): ')) ?? '';
    return { kind: 'confirm', approved: /^s|^y/i.test(answer) };
  },
  'prompt.userAction': async (params) => {
    console.log(bold(`\n[action:${params.actionKind}] ${params.title}`), `\n${params.message}`);
    const answer = (await ask('  ¿Hecho? (s/n): ')) ?? '';
    return { kind: 'user_action', done: /^s|^y/i.test(answer) };
  },
  'vault.read': () => ({
    personal: Object.entries(vault).map(([key, value]) => ({ key, label: key, value })),
    documents: [],
    credentials: [],
  }),
  'vault.save': (params) => {
    for (const item of params.items as { key: string; value: string }[])
      vault[item.key] = item.value;
    return { saved: (params.items as { key: string }[]).map((i) => i.key) };
  },
  // The app scrubs with @sa/pii; here only the in-memory vault's values are removed.
  'research.scrub': (params) => {
    let text = String(params.text);
    let redactions = 0;
    for (const value of Object.values(vault)) {
      if (value.length < 3 || !text.includes(value)) continue;
      redactions += text.split(value).length - 1;
      text = text.replaceAll(value, '[DATO PERSONAL]');
    }
    return { text, redactions };
  },
  'feedback.search': () => ({ results: [] }),
  'feedback.submit': (params) => {
    console.log(dim(`\n[feedback] ${JSON.stringify(params)}\n`));
    return { submitted: true, id: 'dev', redactions: 0 };
  },
  'feedback.vote': (params) => {
    console.log(dim(`\n[feedback vote] ${JSON.stringify(params)}\n`));
    return { counted: true };
  },
};

const token = `dev-${Date.now()}`;
const bridge = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', async () => {
    const method = (req.url ?? '').replace(/^\/rpc\//, '');
    const reply = (status: number, payload: unknown) => {
      if (res.destroyed) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply(401, { ok: false, error: { code: 'unauthorized', message: 'bad token' } });
    }
    const handler = handlers[method];
    if (!handler) {
      const code = method.startsWith('browser.') ? 'unavailable' : 'not_found';
      return reply(503, {
        ok: false,
        error: { code, message: `${method} is not available in dev-chat` },
      });
    }
    try {
      reply(200, { ok: true, result: await handler(body ? JSON.parse(body) : {}) });
    } catch (error) {
      reply(500, { ok: false, error: { code: 'internal', message: String(error) } });
    }
  });
});
await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve));

const client = new PiRpcClient(
  buildAgentLaunch({
    nodeBinary: process.execPath,
    electronRunAsNode: false,
    cwd: workDir,
    config: {
      procedureId: 'dev',
      sessionFile,
      language: values.language === 'en' ? 'en' : 'es',
      model: {
        provider,
        id: values.model ?? 'mock-model',
        ...(baseUrl ? { baseUrl } : {}),
        ...(values.thinking ? { thinkingLevel: values.thinking as 'low' } : {}),
      },
    },
    bridge: { url: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`, token },
  }),
);

let settle: (() => void) | undefined;
client.on((event: AgentEvent) => {
  switch (event.type) {
    case 'assistant_delta':
      process.stdout.write(event.delta);
      break;
    case 'assistant_end':
      process.stdout.write(event.error ? `\n[error: ${event.error}]\n` : '\n');
      break;
    case 'tool_start':
      console.log(dim(`→ ${event.tool} ${JSON.stringify(event.args).slice(0, 200)}`));
      break;
    case 'tool_end':
      console.log(dim(`← ${event.tool}${event.isError ? ' (error)' : ''}: ${event.summary ?? ''}`));
      break;
    case 'usage':
      console.log(
        dim(
          `[usage] in ${event.inputTokens} out ${event.outputTokens}${event.costUsd ? ` $${event.costUsd.toFixed(4)}` : ''}`,
        ),
      );
      break;
    case 'run_end':
      if (event.error) console.log(bold(`[run failed: ${event.errorKind}] ${event.error}`));
      if (event.aborted) console.log(bold('[aborted]'));
      settle?.();
      break;
    case 'log':
      if (event.level !== 'debug') console.log(dim(`[${event.level}] ${event.message}`));
      break;
    case 'process_exit':
      console.log(
        bold(`[agent exited ${event.code ?? event.signal}]`),
        event.stderrTail.slice(-500),
      );
      break;
  }
});

const info = await client.start();
console.log(dim(`agent ready: ${info.model?.provider}/${info.model?.id} · session ${sessionFile}`));
console.log(dim('Type a message (Ctrl+C to abort a run, Ctrl+D to quit).'));
process.on('SIGINT', () => {
  if (client.running) void client.abort();
  else void client.stop().then(() => process.exit(0));
});

for (;;) {
  const text = await ask('\n> ');
  if (text === null) break;
  if (!text.trim()) continue;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  try {
    await client.prompt(text);
    await done;
  } catch (error) {
    console.log(bold(`[prompt failed] ${(error as Error).message}`));
  }
}
await client.stop();
bridge.close();
rl.close();
