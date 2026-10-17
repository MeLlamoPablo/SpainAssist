/**
 * The smallest run: the orchestrator alone answers a message. No browser, no procedure: what a
 * machine without Chromium can still check of the composition.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectNoEgress, prepareHostBundle, removeRunDir, startStack } from './support';

let host: Awaited<ReturnType<typeof prepareHostBundle>>;
beforeAll(async () => {
  host = await prepareHostBundle();
}, 180_000);
afterAll(() => host?.cleanup());
afterAll(expectNoEgress);

describe('the smallest run', () => {
  it('composes the app, lets the orchestrator answer once, and closes', async () => {
    const stack = await startStack({
      hostBundle: host.bundle,
      scenario: { rules: [], fallback: { text: 'Hola, soy el asistente.' } },
    });
    try {
      await stack.app.send('hola');
      expect(await stack.app.untilIdle({ timeoutMs: 60_000 })).toBe(true);
      expect(
        stack
          .observations()
          .filter((o) => o.type !== 'net')
          .map((o) => [o.type, o.type === 'assistant_message' ? o.text : undefined]),
      ).toEqual([['assistant_message', 'Hola, soy el asistente.']]);
      // The one request the orchestrator made, to the gateway under its own key.
      expect(stack.of('net').map((o) => [o.record.channel, o.record.route])).toEqual([
        ['llm', 'llm'],
      ]);
      expect(stack.app.counters()).toEqual({ toolCalls: 0, prompts: 0 });
      expect(stack.app.pendingPrompts()).toEqual([]);
    } finally {
      await stack.close();
    }
    expect(readdirSync(stack.runDir).sort()).toEqual([
      'events.jsonl',
      'host',
      'logs',
      'net',
      'profile',
      'transcripts',
    ]);
    expect(existsSync(join(stack.runDir, 'transcripts', 'assistant', 'session.jsonl'))).toBe(true);
    removeRunDir(stack.runDir);
  }, 120_000);
});
