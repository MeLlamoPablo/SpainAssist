import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareScanStorage, ScanTranscript } from './transcript';

describe('scan artifact retention', () => {
  it('removes earlier artifacts in production and never creates new transcript/frame files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sa-scan-retention-'));
    const directory = join(root, 'conversations');
    try {
      const old = new ScanTranscript(join(directory, 'old-session'));
      await old.initialize('mock', 'custom');
      await old.record({
        role: 'user',
        content: [{ type: 'image', data: '/9j/2Q==', mimeType: 'image/jpeg' }],
        timestamp: 1,
      });
      expect(await readdir(directory)).toEqual(['old-session']);
      const storage = await prepareScanStorage(directory, false);
      expect(storage).toBeUndefined();
      const production = new ScanTranscript(storage);
      await production.initialize('mock', 'custom');
      await production.record({
        role: 'user',
        content: [{ type: 'image', data: '/9j/2Q==', mimeType: 'image/jpeg' }],
        timestamp: 1,
      });
      await production.end('cancelled');
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves development transcripts on the next startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sa-scan-dev-retention-'));
    try {
      const session = new ScanTranscript(join(directory, 'dev-session'));
      await session.initialize('mock', 'custom');
      await session.end('error');
      expect(await prepareScanStorage(directory, true)).toBe(directory);
      expect(await readFile(join(directory, 'dev-session', 'session.jsonl'), 'utf8')).toContain(
        '"status":"error"',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
