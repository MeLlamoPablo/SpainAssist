import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const created: string[] = [];

/** A fresh temp directory (removed after each test); the vault lives in a subfolder. */
export async function tempVaultDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'sa-vault-test-'));
  created.push(base);
  return join(base, 'vault');
}

afterEach(async () => {
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});
