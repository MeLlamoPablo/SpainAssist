import './helpers/no-network';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMeter, type MeterHandle } from '../../src/llm/meter';
import { type RealisticBackend, startRealisticBackend } from './helpers/codex-backend';
import { makeHome, type TestHome } from './helpers/tmp-home';

/**
 * A cooldown file that cannot be understood must not be read as "no usage limit": the meter would
 * go on sending requests into a limit that is probably there.
 */
describe('the meter with a broken Codex cooldown file', () => {
  let t: TestHome;
  let backend: RealisticBackend;
  let meter: MeterHandle;
  beforeEach(async () => {
    t = makeHome();
    backend = await startRealisticBackend({ holdMs: 10 });
    meter = await createMeter({
      home: t.home,
      upstreams: { codex: backend.url },
      codexConsent: true,
    });
  });
  afterEach(async () => {
    await meter.close();
    await backend.close();
    t.cleanup();
  });

  const post = () =>
    fetch(
      `${meter.openRun({ runId: 'r', provider: 'codex' }).agentBaseUrl('main')}/codex/responses`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer a-token-123456' },
        body: JSON.stringify({ model: 'gpt-6-luna', stream: true, input: [] }),
      },
    );

  it('answers locally with the usage-limit 429 and sends nothing to OpenAI', async () => {
    mkdirSync(dirname(t.paths.codexCooldown), { recursive: true });
    writeFileSync(t.paths.codexCooldown, '{"untilMs": 17');
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get('x-sa-eval')).toBe('codex-cooldown');
    expect(backend.requests).toHaveLength(0);
  });

  it('does not block when there is no file', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    await res.text();
    expect(backend.requests).toHaveLength(1);
  });
});
