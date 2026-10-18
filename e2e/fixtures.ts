import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import {
  _electron,
  test as base,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import * as feedback from '@sa/feedback-server';
import * as keys from '@sa/key-server';
import { createMockLlm, type MockLlm } from '@sa/mock-llm';
import { type MockSede, startMockSede } from '@sa/mock-sede';
import type { SaApi, SaArgs, SaMethod, SaResult } from '@sa/shared';

declare global {
  interface Window {
    sa: SaApi;
  }
}

const root = resolve(import.meta.dirname, '..');
const executablePath = createRequire(import.meta.url)('electron') as string;

export async function invoke<M extends SaMethod>(
  page: Page,
  method: M,
  ...args: SaArgs<M>
): Promise<SaResult<M>> {
  return page.evaluate(
    ({ method, args }) => {
      const call = window.sa.invoke as (method: SaMethod, ...args: unknown[]) => Promise<unknown>;
      return call(method, ...args);
    },
    { method: method as SaMethod, args: args as unknown[] },
  ) as Promise<SaResult<M>>;
}

// Playwright only traces browser contexts it creates itself, so the Electron window would show
// up in UI mode and trace.zip as an empty about:blank. Hook the app's context into the runner's
// own (private) per-test tracing so `--ui`, `--trace on` and retain-on-failure all get snapshots.
interface RunnerTracing {
  traceOptions(): Record<string, unknown> | undefined;
  traceTitle(): string;
  tracesDir(): string;
  generateNextTraceRecordingName(): string;
  maybeGenerateNextTraceRecordingPath(): string | undefined;
}

function runnerTracing(info: TestInfo): RunnerTracing | undefined {
  const tracing = (info as TestInfo & { _tracing?: RunnerTracing })._tracing;
  return typeof tracing?.traceOptions === 'function' ? tracing : undefined;
}

async function startTracing(app: ElectronApplication, tracing: RunnerTracing | undefined) {
  const options = tracing?.traceOptions();
  if (!tracing || !options) return false;
  await app.context().tracing.start({
    ...options,
    title: tracing.traceTitle(),
    name: tracing.generateNextTraceRecordingName(),
  });
  return true;
}

export interface Harness {
  app: ElectronApplication;
  page: Page;
  llm: MockLlm;
  sede: MockSede;
  userData: string;
  restart(): Promise<void>;
}

export const test = base.extend<{ harness: Harness }>({
  // Like browser tests, the app window stays hidden unless run with --headed (or headless: false);
  // UI mode and traces still show it through DOM snapshots and screencast frames.
  harness: async ({ headless }, use, testInfo) => {
    const tracing = runnerTracing(testInfo);
    const userData = await mkdtemp(join(tmpdir(), 'sa-e2e-'));
    const close: (() => Promise<unknown>)[] = [
      () => rm(userData, { recursive: true, force: true }),
    ];
    try {
      const llm = await createMockLlm({ scenario: 'echo', chunkDelayMs: 2 });
      close.unshift(() => llm.close());
      const sede = await startMockSede({ port: 0, certPort: 0 });
      close.unshift(() => sede.close());
      const keyDb = await keys.openDatabase('pglite://memory');
      close.unshift(() => keyDb.close());
      await keys.migrate(keyDb);
      const config = keys.loadConfig({
        DATABASE_URL: 'pglite://memory',
        DEV_SEED: '1',
        RATE_LIMIT: '0',
        MOCK_LLM_BASE_URL: llm.baseUrl,
      });
      await keys.ensureDemoVoucher(keyDb, { pepper: config.voucherPepper });
      const keyApp = keys.createApp({
        db: keyDb,
        config,
        provisioner: new keys.MockProvisioner({ baseUrl: llm.baseUrl }),
        logger: keys.silentLogger,
      });
      const feedbackDb = await feedback.openDb('pglite://memory');
      close.unshift(() => feedbackDb.close());
      await feedback.migrate(feedbackDb);
      await feedback.seedFeedback(feedbackDb);
      const feedbackApp = feedback.createApp({ db: feedbackDb, mcp: false });
      async function listen(fetch: Parameters<typeof serve>[0]['fetch']): Promise<string> {
        const server = serve({ fetch, hostname: '127.0.0.1', port: 0 });
        close.unshift(
          () =>
            new Promise<void>((done, reject) => {
              server.close((err) => (err ? reject(err) : done()));
              if ('closeAllConnections' in server) server.closeAllConnections();
            }),
        );
        if (!server.listening) await once(server, 'listening');
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      }
      const keyUrl = await listen(keyApp.fetch);
      const feedbackUrl = await listen(feedbackApp.fetch);
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.ELECTRON_RENDERER_URL;
      Object.assign(env, {
        SA_E2E: '1',
        SA_USER_DATA_DIR: userData,
        SA_KEY_SERVER_URL: keyUrl,
        SA_FEEDBACK_SERVER_URL: feedbackUrl,
        SA_FEATURE_FLAGS: 'feedback-server,dnie-phone',
        SA_EXTRA_TRUSTED_HOSTS: 'localhost,127.0.0.1',
        SA_BROWSER_HEADLESS: '1',
        SA_HIDE_WINDOW: headless ? '1' : '0',
        SA_AGENT_HOST: join(root, 'packages/agent/dist/host.js'),
      });
      async function launch() {
        const app = await _electron.launch({
          executablePath,
          args: [join(root, 'apps/desktop')],
          env,
          tracesDir: tracing?.tracesDir(),
        });
        const traced = await startTracing(app, tracing);
        const page = await app.firstWindow();
        await page.waitForFunction(() => typeof window.sa?.invoke === 'function');
        return { app, page, traced };
      }
      async function closeApp({ app, traced }: { app: ElectronApplication; traced: boolean }) {
        // A missing path means the runner discards this trace (e.g. retain-on-failure + pass).
        if (traced)
          await app
            .context()
            .tracing.stop({ path: tracing?.maybeGenerateNextTraceRecordingPath() });
        await app.close();
      }
      let current = await launch();
      const harness: Harness = {
        app: current.app,
        page: current.page,
        llm,
        sede,
        userData,
        async restart() {
          await closeApp(current);
          current = await launch();
          Object.assign(harness, { app: current.app, page: current.page });
        },
      };
      close.unshift(() => closeApp(current));
      await use(harness);
    } finally {
      for (const cleanup of close) await cleanup();
    }
  },
});

export { expect } from '@playwright/test';
