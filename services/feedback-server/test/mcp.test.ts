import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/types';
import { seedFeedback } from '../src/feedback/seed';
import { makeApp, makeDb } from './helpers';

let db: Db;
beforeAll(async () => {
  db = await makeDb();
  await seedFeedback(db);
});
afterAll(() => db.close());

async function rpc(app: ReturnType<typeof makeApp>, method: string, params: unknown, id = 1) {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result: Record<string, unknown> };
}

describe('MCP endpoint', () => {
  it('initializes and lists the read-only tools', async () => {
    const app = makeApp(db);
    const init = await rpc(app, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    expect(init.result.serverInfo).toMatchObject({ name: 'spainassist-feedback' });

    const list = await rpc(app, 'tools/list', {});
    const tools = list.result.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(['search_feedback']);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('searches feedback', async () => {
    const app = makeApp(db);
    const feedback = await rpc(app, 'tools/call', {
      name: 'search_feedback',
      arguments: { query: 'renovar dni', limit: 2 },
    });
    const content = feedback.result.content as { type: string; text: string }[];
    const parsed = JSON.parse(content[0]!.text) as { results: { procedure: string }[] };
    expect(parsed.results[0]!.procedure).toBe('Renovación del DNI');
  });

  it('can be disabled', async () => {
    expect((await makeApp(db, { mcp: false }).request('/mcp', { method: 'POST' })).status).toBe(
      404,
    );
  });
});
