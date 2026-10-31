/** FNMT certificate requests exist only with the `fnmt-certificates` feature flag. */
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

async function launch(fnmtCertificates: boolean) {
  await app?.close();
  app = await createTestApp({ features: { fnmtCertificates }, signer: signerLib(silentLogger) });
  expect((await app.invoke('providers.setCustom', PROVIDER)).ok).toBe(true);
  app.services.browser.get();
  const { procedureId } = await app.startProcedure();
  return {
    fnmt: app.browserOptions.at(-1)?.fnmt,
    afirma: app.browserOptions.at(-1)?.afirma,
    config: app.agentFor(procedureId)?.launch.config,
  };
}

it('gives FNMT pages the shim and the agent its prompt line only with the flag', async () => {
  const off = await launch(false);
  expect(off.fnmt).toBeUndefined();
  expect(off.afirma).toBeDefined();
  expect(off.config).toMatchObject({ certificateRequests: false });

  const on = await launch(true);
  expect(on.fnmt?.shimSource).toContain('FnmtCertRequest');
  expect(on.config).toMatchObject({ certificateRequests: true });
});
