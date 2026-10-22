// Smoke test of the BUILT app (run `corepack pnpm --filter @sa/desktop build` first):
// launches Electron through playwright-core `_electron` with an isolated userData dir and e2e
// mode, then calls a few renderer IPC methods through `window.sa` and checks push events.
//   corepack pnpm --filter @sa/desktop smoke
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron');
const userData = mkdtempSync(join(tmpdir(), 'sa-smoke-'));

const env = {
  ...process.env,
  SA_E2E: '1',
  SA_USER_DATA_DIR: userData,
  SA_PROVIDER: 'custom|http://127.0.0.1:8789/v1|mock-model',
  SA_EXTRA_TRUSTED_HOSTS: 'localhost',
};
delete env.ELECTRON_RENDERER_URL;
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: electronPath,
  args: [appDir],
  env,
  timeout: 30_000,
});
const results = {};
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.sa?.invoke === 'function', null, {
    timeout: 15_000,
  });
  assert.match(page.url(), /^app:\/\/bundle\//, 'renderer is served from app://bundle');

  const call = (method, ...args) =>
    page.evaluate(([m, a]) => window.sa.invoke(m, ...a), [method, args]);

  await page.evaluate(() => {
    window.__saEvents = [];
    window.sa.on((event) => window.__saEvents.push(event.type));
  });

  const info = await call('app.info');
  assert.equal(info.name, 'Spain Assist Dev');
  assert.equal(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()),
    'Spain Assist Dev',
  );
  assert.equal(info.isE2E, true);
  results.info = info;

  const settings = await call('settings.get');
  assert.equal(settings.language, 'es');
  const updated = await call('settings.update', { onboardingCompleted: true });
  assert.equal(updated.onboardingCompleted, true);

  const status = await call('providers.status');
  assert.equal(status.configured, true);
  assert.equal(status.kind, 'custom');
  results.provider = status;

  assert.deepEqual(await call('procedures.list'), []);
  const overview = await call('vault.overview');
  assert.ok(Array.isArray(overview.personal));
  results.storage = overview.storage;

  const saved = await call('vault.setPersonal', [{ key: 'givenName', value: 'Lucía' }]);
  assert.equal(saved.personal[0].value, 'Lucía');

  // Invalid arguments are rejected by the zod validation in main; errors arrive as plain messages.
  const errorOf = (method, ...args) =>
    page.evaluate(
      ([m, a]) =>
        window.sa.invoke(m, ...a).then(
          () => null,
          (err) => err.message,
        ),
      [method, args],
    );
  assert.equal(await errorOf('procedures.rename', 42), 'La petición no es válida.');
  assert.equal(await errorOf('chat.transcript', 'p_0000000000000000'), 'Ese trámite ya no existe.');

  // A procedure: created with a placeholder title; the agent cannot start here (no agent host
  // in this smoke run), which shows up as an error notice in the transcript.
  const procedure = await call('procedures.create', { message: 'Quiero renovar el DNI' });
  assert.equal(procedure.title, 'Quiero renovar el DNI');
  await page.waitForFunction(() => window.__saEvents.includes('chat.item'));
  const transcript = await call('chat.transcript', procedure.id);
  assert.equal(transcript[0].type, 'user');
  results.procedure = { title: procedure.title, items: transcript.map((i) => i.type) };

  await page.waitForFunction(() => window.__saEvents.includes('settings.changed'));
  results.events = await page.evaluate(() => [...new Set(window.__saEvents)]);
  assert.ok(results.events.includes('vault.changed'));

  console.log(JSON.stringify({ ok: true, ...results }, null, 2));
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
