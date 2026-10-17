import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestService, page, startServer, type TestServer } from './helpers';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const listeners = () => SIGNALS.map((signal) => process.listeners(signal).length);

let server: TestServer;
beforeAll(async () => {
  server = await startServer({ '/': page('<h1>Hola</h1>') });
});
afterAll(async () => {
  await server?.close();
});

describe('signal handlers while a browser runs', () => {
  it("are Playwright's by default: it closes the browser and exits the process (130 for SIGINT)", async () => {
    const before = listeners();
    const t = createTestService();
    try {
      await t.service.open('p', `${server.origin}/`);
      const during = listeners();
      for (const [index, signal] of SIGNALS.entries()) {
        expect(during[index], signal).toBeGreaterThan(before[index] as number);
      }
    } finally {
      await t.cleanup();
    }
    expect(listeners()).toEqual(before);
  });

  it('are left alone with handleSignals: false, for a host that handles them itself', async () => {
    const before = listeners();
    const t = createTestService({ handleSignals: false });
    try {
      await t.service.open('p', `${server.origin}/`);
      expect(listeners()).toEqual(before);
    } finally {
      await t.cleanup();
    }
    expect(listeners()).toEqual(before);
  });
});
