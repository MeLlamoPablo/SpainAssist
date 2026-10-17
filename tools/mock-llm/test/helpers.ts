import { request as httpRequest } from 'node:http';
import type { MockLlm } from '../src/index';

export interface SseEvent {
  event?: string;
  data: Record<string, unknown> | '[DONE]';
}

export function parseSseBody(raw: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of raw.split('\n\n')) {
    if (!block.trim()) continue;
    let event: string | undefined;
    let data = '';
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    events.push({
      ...(event ? { event } : {}),
      data: data === '[DONE]' ? '[DONE]' : (JSON.parse(data) as Record<string, unknown>),
    });
  }
  return events;
}

export const user = (text: string) => ({ role: 'user', content: text });

export function chat(
  llm: MockLlm,
  messages: unknown[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return fetch(`${llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key', ...headers },
    body: JSON.stringify({
      model: 'mock-model',
      stream: true,
      stream_options: { include_usage: true },
      messages,
      tools: [{ type: 'function', function: { name: 'fetch_url', parameters: {} } }],
      ...extra,
    }),
  });
}

/** The text a chat completion answered (stream or JSON). */
export async function chatText(res: Response): Promise<string> {
  const raw = await res.text();
  if (!raw.startsWith('data:')) {
    const json = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }
  let text = '';
  for (const { data } of parseSseBody(raw)) {
    if (data === '[DONE]') continue;
    for (const choice of (data.choices ?? []) as { delta?: { content?: string } }[]) {
      text += choice.delta?.content ?? '';
    }
  }
  return text;
}

/** A request with an `Upgrade: websocket` header; resolves with the status the server answered. */
export function tryUpgrade(url: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGVzdA==' },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('upgrade', () => resolve(101));
    req.on('error', reject);
    req.end();
  });
}
