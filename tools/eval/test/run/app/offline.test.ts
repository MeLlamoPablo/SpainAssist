/**
 * The app process of a run reaches nothing but the network layer: every way the app has of
 * getting to a service (a provider sign-in, a probe of an endpoint, a voucher) is stubbed or fails,
 * and the one provider that is on went through the stubbed voucher flow.
 */
import { BUNDLED_MODEL_LISTS } from '@sa/agent';
import type { HeadlessApp } from '@sa/desktop/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvalAppWith } from '../../../src/run/app';
import {
  egressAttempts,
  expectNoEgress,
  prepareHostBundle,
  removeRunDir,
  startWorld,
} from './support';

let host: Awaited<ReturnType<typeof prepareHostBundle>>;
beforeAll(async () => {
  host = await prepareHostBundle();
}, 180_000);
afterAll(() => host?.cleanup());

describe('the app process', () => {
  it('has the voucher provider on, and no way to a service of the outside world', async () => {
    const world = await startWorld({ hostBundle: host.bundle });
    let headless: HeadlessApp | undefined;
    const app = await createEvalAppWith(world.spec, world.deps, {
      hostBundle: { bundle: host.bundle, sources: [] },
      onApp: (created) => {
        headless = created;
      },
    });
    try {
      const invoke = (headless as HeadlessApp).invoke;
      const status = await invoke('providers.status');
      expect(status).toMatchObject({ configured: true, kind: 'voucher' });
      // The credit the UI shows comes from the stub: the meter's spend against a display limit.
      expect(status.credit).toMatchObject({ limitUsd: 100 });

      // Other ways to a provider fail here, with nothing sent anywhere.
      expect(await invoke('providers.loginChatGPT')).toMatchObject({ ok: false });
      expect(
        await invoke('providers.probeCustom', {
          baseUrl: 'https://api.openai.com/v1',
          api: 'openai-completions',
          model: 'gpt',
        }),
      ).toMatchObject({ reachable: false });
      expect(await invoke('providers.listByok')).toBeInstanceOf(Array);

      // The key the app holds is the meter's placeholder, in memory only.
      const services = (headless as HeadlessApp).services;
      expect(await services.providers.credentialFor('litellm')).toEqual({
        type: 'api_key',
        key: 'sk-eval-placeholder-not-a-key',
      });
      expect(await services.providers.credentialFor('openai-codex')).toBeNull();
      const model = await services.providers.agentModel('assistant');
      expect(model).toMatchObject({
        provider: 'litellm',
        ...BUNDLED_MODEL_LISTS.voucher.assistant[0],
        maxTokens: 8192,
      });
      expect(model.baseUrl).toBe(world.run.agentBaseUrl('app'));
      expect(egressAttempts).toEqual([]);
    } finally {
      await app.close();
      world.run.close();
      await world.env.close();
      await world.bench.close();
      world.log.close();
      removeRunDir(world.runDir);
    }
  }, 120_000);

  it('sees an attempt to reach outside, which the guard refuses (the recorder works)', async () => {
    await expect(fetch('https://example.invalid/')).rejects.toThrow(/Network guard/);
    expect(egressAttempts).toEqual([
      'Network guard: refusing to reach example.invalid; offline tests may only use 127.0.0.1',
    ]);
    expect(expectNoEgress).toThrow(/tried to reach outside this machine/);
    egressAttempts.length = 0;
    expect(expectNoEgress).not.toThrow();
  });
});

afterAll(expectNoEgress);
