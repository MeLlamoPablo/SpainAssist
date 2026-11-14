/** FNMT certificate requests are on in every build (no feature flag). */
import { afterEach, expect, it } from 'vitest';
import { signerLib } from '../app/libs';
import { silentLogger } from '../core/logger';
import { createTestApp, type TestApp } from '../testing/harness';

const PROVIDER = {
  baseUrl: 'http://127.0.0.1:8789/v1',
  api: 'openai-completions',
  model: 'mock-model',
} as const;

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it('gives FNMT pages the shim and the agent its prompt line', async () => {
  app = await createTestApp({ signer: signerLib(silentLogger) });
  expect((await app.invoke('providers.setCustom', PROVIDER)).ok).toBe(true);
  app.services.browser.get();
  const { agentId } = await app.startProcedure();
  const options = app.browserOptions.at(-1);
  expect(options?.fnmt?.shimSource).toContain('FnmtCertRequest');
  expect(options?.afirma).toBeDefined();
  expect(app.agentFor(agentId)?.launch.config).toMatchObject({ certificateRequests: true });
});
