import { mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real `open`, which a test makes fail for one log (chmod can't make a file unreadable on
// Windows).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

import { createTestApp } from '../testing/harness';
import { exportTranscripts, type TranscriptExportDeps } from './transcripts';

/** Reads a zip written by ZipWriter: path -> contents (checks every CRC). */
function unzip(zip: Buffer): Map<string, string> {
  const end = zip.length - 22;
  expect(zip.readUInt32LE(end)).toBe(0x06054b50);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const data = inflateRawSync(zip.subarray(start, start + compressed));
    expect(crc32(data)).toBe(crc);
    files.set(name, data.toString('utf8'));
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return files;
}

let dir: string;
let deps: TranscriptExportDeps;
let flushed: number;

async function put(path: string, contents: string) {
  await mkdir(dirname(join(dir, path)), { recursive: true });
  await writeFile(join(dir, path), contents);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sa-export-'));
  flushed = 0;
  deps = {
    appInfo: { name: 'Spain Assist', version: '1.2.3', platform: 'darwin' },
    assistantDir: join(dir, 'assistant'),
    proceduresDir: join(dir, 'procedures'),
    scanTranscriptsDir: join(dir, 'scanner'),
    logsDir: join(dir, 'logs'),
    downloadsDir: join(dir, 'Downloads'),
    flush: async () => {
      flushed++;
    },
    clock: () => new Date('2026-10-12T10:30:00Z'),
    lang: () => 'es',
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('exportTranscripts', () => {
  it('zips the transcripts and sessions, without media, work files or symlinks', async () => {
    await put('assistant/transcript.json', '[{"id":"a"}]');
    await put('assistant/session.jsonl', '{"type":"session"}\n');
    await put('assistant/work/notes.txt', 'agent scratch');
    await put(
      'procedures/p_0123456789abcdef/procedure.json',
      '{"id":"p_0123456789abcdef","title":"Empadronamiento"}',
    );
    await put('procedures/p_0123456789abcdef/transcript.json', '[{"text":"Hola, ñandú"}]');
    await put('procedures/p_0123456789abcdef/session.jsonl', '{"type":"message"}\n');
    await put('procedures/p_0123456789abcdef/transcript.json.123.abcd.tmp', 'partial');
    await put('procedures/p_0123456789abcdef/media/shot.png', 'png');
    await put('procedures/..bad/transcript.json', 'nope');
    await put('scanner/scan_1/session.jsonl', '{"type":"session"}\n');
    await put('secret.txt', 'outside');
    await symlink(join(dir, 'secret.txt'), join(dir, 'procedures/p_0123456789abcdef/link.json'));

    expect(await exportTranscripts(deps)).toBe('SpainAssist-transcripts-2026-10-12.zip');
    expect(flushed).toBe(1);
    const files = unzip(
      await readFile(join(dir, 'Downloads', 'SpainAssist-transcripts-2026-10-12.zip')),
    );
    expect([...files.keys()]).toEqual([
      'manifest.json',
      'assistant/session.jsonl',
      'assistant/transcript.json',
      'procedures/p_0123456789abcdef/procedure.json',
      'procedures/p_0123456789abcdef/session.jsonl',
      'procedures/p_0123456789abcdef/transcript.json',
      'scanner/scan_1/session.jsonl',
    ]);
    expect(files.get('procedures/p_0123456789abcdef/transcript.json')).toBe(
      '[{"text":"Hola, ñandú"}]',
    );
    expect(JSON.parse(files.get('manifest.json')!)).toEqual({
      app: 'Spain Assist',
      version: '1.2.3',
      platform: 'darwin',
      exportedAt: '2026-10-12T10:30:00.000Z',
      logs: [],
    });
  });

  it('never overwrites an earlier export and works with nothing stored', async () => {
    await put('Downloads/SpainAssist-transcripts-2026-10-12.zip', 'earlier');
    expect(await exportTranscripts(deps)).toBe('SpainAssist-transcripts-2026-10-12 (1).zip');
    expect(
      await readFile(join(dir, 'Downloads/SpainAssist-transcripts-2026-10-12.zip'), 'utf8'),
    ).toBe('earlier');
    const files = unzip(
      await readFile(join(dir, 'Downloads/SpainAssist-transcripts-2026-10-12 (1).zip')),
    );
    expect([...files.keys()]).toEqual(['manifest.json']);
    expect(await readdir(join(dir, 'Downloads'))).toHaveLength(2);
  });

  it('adds the logs and their rotated predecessor, without other files', async () => {
    await put('logs/main.log', '2026-10-12T10:29:00.000Z INFO  starting\n');
    await put('logs/main.1.log', '2026-10-11T09:00:00.000Z INFO  bye\n');
    await put('logs/crash.dmp', 'binary');
    await put('logs/old/main.log', 'nested');
    await put('outside.log', 'outside');
    await symlink(join(dir, 'outside.log'), join(dir, 'logs/link.log'));

    await exportTranscripts(deps);
    const files = unzip(
      await readFile(join(dir, 'Downloads', 'SpainAssist-transcripts-2026-10-12.zip')),
    );
    expect([...files.keys()]).toEqual(['manifest.json', 'logs/main.1.log', 'logs/main.log']);
    expect(files.get('logs/main.log')).toBe('2026-10-12T10:29:00.000Z INFO  starting\n');
    expect(files.get('logs/main.1.log')).toBe('2026-10-11T09:00:00.000Z INFO  bye\n');
    expect(JSON.parse(files.get('manifest.json')!).logs).toEqual([
      { file: 'logs/main.1.log', bytes: 35 },
      { file: 'logs/main.log', bytes: 40 },
    ]);
  });

  it('keeps the last 5 MiB of a larger log, from a line start, and says so', async () => {
    const line = (i: number) => `2026-10-12T10:00:00.000Z DEBUG line ${i} ${'x'.repeat(80)}\n`;
    const log = Array.from({ length: 70_000 }, (_, i) => line(i)).join('');
    expect(log.length).toBeGreaterThan(5 * 1024 * 1024);
    await put('logs/main.1.log', log);

    await exportTranscripts(deps);
    const files = unzip(
      await readFile(join(dir, 'Downloads', 'SpainAssist-transcripts-2026-10-12.zip')),
    );
    const zipped = files.get('logs/main.1.log')!;
    const [note, first] = zipped.split('\n');
    const kept = zipped.slice(note!.length + 1);
    expect(kept.length).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(kept.length).toBeGreaterThan(5 * 1024 * 1024 - line(0).length * 2);
    expect(log.endsWith(kept)).toBe(true);
    expect(first).toMatch(/^2026-10-12T10:00:00\.000Z DEBUG line \d+ x+$/);
    expect(note).toBe(
      `[Spain Assist export: only the last ${kept.length} of this log's ${log.length} bytes]`,
    );
    expect(JSON.parse(files.get('manifest.json')!).logs).toEqual([
      { file: 'logs/main.1.log', bytes: log.length, keptLastBytes: kept.length },
    ]);
  });

  it('exports anyway when a log is unreadable or the logs are not a folder', async () => {
    await put('logs/main.log', 'readable\n');
    await put('logs/main.1.log', 'unreadable\n');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      if (String(path).endsWith('main.1.log'))
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return actual.open(path, flags, mode);
    });

    await exportTranscripts(deps);
    vi.mocked(open).mockImplementation(actual.open);
    let files = unzip(
      await readFile(join(dir, 'Downloads', 'SpainAssist-transcripts-2026-10-12.zip')),
    );
    expect([...files.keys()]).toEqual(['manifest.json', 'logs/main.log']);
    expect(JSON.parse(files.get('manifest.json')!).logs).toEqual([
      { file: 'logs/main.1.log', error: 'EACCES' },
      { file: 'logs/main.log', bytes: 9 },
    ]);

    deps.logsDir = join(dir, 'logs/main.log');
    expect(await exportTranscripts(deps)).toBe('SpainAssist-transcripts-2026-10-12 (1).zip');
    files = unzip(
      await readFile(join(dir, 'Downloads', 'SpainAssist-transcripts-2026-10-12 (1).zip')),
    );
    expect([...files.keys()]).toEqual(['manifest.json']);
    expect(JSON.parse(files.get('manifest.json')!).logs).toEqual([
      { file: 'logs/', error: 'ENOTDIR' },
    ]);
  });

  it('includes changes still waiting to be written (IPC)', async () => {
    const app = await createTestApp();
    try {
      const { procedureId } = await app.procedureWithToken('Empadronamiento');
      app.services.procedures.addNotice(procedureId, 'info', 'Aviso recién escrito');
      await mkdir(app.paths.logsDir, { recursive: true });
      await writeFile(join(app.paths.logsDir, 'main.log'), 'INFO  ready\n');
      const name = await app.invoke('app.exportTranscripts');
      const files = unzip(await readFile(join(app.dir, 'Downloads', name)));
      expect(files.get(`procedures/${procedureId}/transcript.json`)).toContain(
        'Aviso recién escrito',
      );
      expect(JSON.parse(files.get(`procedures/${procedureId}/procedure.json`)!)).toMatchObject({
        title: 'Empadronamiento',
      });
      expect(files.get('logs/main.log')).toBe('INFO  ready\n');
    } finally {
      await app.close();
    }
  });
});
