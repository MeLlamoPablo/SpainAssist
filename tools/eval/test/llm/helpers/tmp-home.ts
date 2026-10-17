import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homePaths } from '../../../src/llm/home';

export interface TestHome {
  /** A fresh credentials home (what `SPAINBENCH_DATA_DIR` would point at). */
  home: string;
  paths: ReturnType<typeof homePaths>;
  cleanup(): void;
}

/** A temp credentials home; tests never touch the real data folder. */
export function makeHome(): TestHome {
  const home = mkdtempSync(join(tmpdir(), 'sa-eval-test-'));
  chmodSync(home, 0o700);
  return {
    home,
    paths: homePaths(home),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

export const TEST_VOUCHER_KEY = 'sk-test-voucher-0123456789abcdef';

/** Writes a fake `litellm.json` (mode 600) into the home. */
export function writeLitellmFile(
  home: string,
  overrides: Record<string, unknown> = {},
  mode = 0o600,
): string {
  const path = homePaths(home).litellm;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      baseUrl: 'http://127.0.0.1:9/v1/',
      apiKey: TEST_VOUCHER_KEY,
      keyServerUrl: 'http://127.0.0.1:9',
      limitUsd: 5,
      expiresAt: null,
      ...overrides,
    }),
    { mode },
  );
  chmodSync(path, mode);
  return path;
}
