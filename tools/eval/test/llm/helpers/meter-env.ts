import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMockLlm, type MockLlm, type MockLlmOptions } from '@sa/mock-llm';
import type { EvalProvider } from '../../../src/contracts';
import {
  createMeter,
  type MeterHandle,
  type MeterOptions,
  type MeterRun,
  type OpenRunOptions,
} from '../../../src/llm/meter';
import { makeHome, type TestHome } from './tmp-home';

export const API_KEY = 'sk-test-agent-key-9f8e7d6c5b4a';

export interface MeterEnv {
  t: TestHome;
  llm: MockLlm;
  meter: MeterHandle;
  /** Opens a run against the mock upstream. */
  openRun(options?: Partial<OpenRunOptions>): MeterRun;
  /** Every request line of the ledger written so far (not the reservations or epochs). */
  ledgerLines(): Record<string, unknown>[];
  /** Every line of the ledger: requests, reservations, releases and epochs. */
  rawLedgerLines(): Record<string, unknown>[];
  close(): Promise<void>;
}

export interface EnvOptions {
  mock?: MockLlmOptions;
  meter?: Partial<MeterOptions>;
  provider?: EvalProvider;
  /** Upstream path prefix of the mock for the provider (default `/v1`). */
  upstreamPath?: string;
}

/** A temp home, a mock LLM upstream (LiteLLM emulation on by default) and a meter in front of it. */
export async function startEnv(options: EnvOptions = {}): Promise<MeterEnv> {
  const t = makeHome();
  const llm = await createMockLlm({
    scenario: {
      rules: [],
      fallback: { text: 'ok', usage: { promptTokens: 1000, completionTokens: 100 } },
    },
    chunkSize: 4,
    litellm: {},
    ...options.mock,
  });
  const provider = options.provider ?? 'voucher';
  const meter = await createMeter({
    home: t.home,
    upstreams: { [provider]: `${llm.url}${options.upstreamPath ?? '/v1'}` },
    ...options.meter,
  });
  const runs: MeterRun[] = [];
  const rawLines = (): Record<string, unknown>[] => {
    const dir = t.paths.ledgerDir;
    try {
      return readdirSync(dir)
        .filter((name) => /^spend-.*\.jsonl$/.test(name))
        .sort()
        .flatMap((name) =>
          readFileSync(join(dir, name), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
    } catch {
      return [];
    }
  };
  return {
    t,
    llm,
    meter,
    openRun(runOptions = {}) {
      const run = meter.openRun({ runId: `run-${runs.length + 1}`, provider, ...runOptions });
      runs.push(run);
      return run;
    },
    ledgerLines: () => rawLines().filter((line) => line.type === 'request'),
    rawLedgerLines: rawLines,
    async close() {
      await meter.close();
      await llm.close();
      t.cleanup();
    },
  };
}

export const chatBody = (messages: unknown[], extra: Record<string, unknown> = {}) => ({
  model: 'anthropic/claude-haiku-5.5',
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 8192,
  messages,
  ...extra,
});

export const userMessage = (text: string) => ({ role: 'user', content: text });

/**
 * A response whose body was read to its end. When the client has seen the whole body, the meter
 * has settled the request (cost, ledger, events), so assertions after it are deterministic.
 */
export async function buffered(res: Response): Promise<Response> {
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

/** POSTs a chat completion through the meter as the agent `agent` of `run` (body read to its end). */
export async function post(
  run: MeterRun,
  agent: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = '/chat/completions',
): Promise<Response> {
  return buffered(await postStreaming(run, agent, body, headers, path));
}

/** As `post`, but the response body is still streaming when it returns. */
export function postStreaming(
  run: MeterRun,
  agent: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  path = '/chat/completions',
): Promise<Response> {
  return fetch(`${run.agentBaseUrl(agent)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}`, ...headers },
    body: JSON.stringify(body),
  });
}

/** The text of a streamed or JSON chat completion body. */
export function completionText(raw: string): string {
  if (!raw.startsWith('data:')) {
    const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }
  let text = '';
  for (const block of raw.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    const chunk = JSON.parse(line.slice(6)) as { choices?: { delta?: { content?: string } }[] };
    for (const choice of chunk.choices ?? []) text += choice.delta?.content ?? '';
  }
  return text;
}
