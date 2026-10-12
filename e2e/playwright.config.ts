import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // Each test gets its own app profile and backends on random ports, so tests run in parallel.
  fullyParallel: true,
  workers: '50%',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  webServer: {
    command:
      'corepack pnpm --filter @sa/desktop build:web && corepack pnpm --filter @sa/desktop serve:web --host 127.0.0.1 --port 5186',
    url: 'http://127.0.0.1:5186',
    timeout: 120_000,
  },
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
