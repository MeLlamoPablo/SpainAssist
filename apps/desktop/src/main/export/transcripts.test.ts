import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  it('includes changes still waiting to be written (IPC)', async () => {
    const app = await createTestApp();
    try {
      const { procedureId } = await app.procedureWithToken('Empadronamiento');
      app.services.procedures.addNotice(procedureId, 'info', 'Aviso recién escrito');
      const name = await app.invoke('app.exportTranscripts');
      const files = unzip(await readFile(join(app.dir, 'Downloads', name)));
      expect(files.get(`procedures/${procedureId}/transcript.json`)).toContain(
        'Aviso recién escrito',
      );
      expect(JSON.parse(files.get(`procedures/${procedureId}/procedure.json`)!)).toMatchObject({
        title: 'Empadronamiento',
      });
    } finally {
      await app.close();
    }
  });
});
