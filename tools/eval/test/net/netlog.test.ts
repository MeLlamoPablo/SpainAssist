import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetRecord } from '../../src/contracts';
import {
  bodyFields,
  headersToRecord,
  MAX_BODY_BYTES,
  NetLog,
  type NetRecordInput,
  REDACTED,
} from '../../src/net/netlog';
import { followNetLog, parseNetLog, readNetLog } from '../../src/net/netlog-reader';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sa-netlog-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function input(over: Partial<NetRecordInput> = {}): NetRecordInput {
  return {
    channel: 'browser',
    method: 'GET',
    url: 'https://portal.example-gov.test/',
    host: 'portal.example-gov.test',
    route: 'mapped',
    reqHeaders: {},
    durationMs: 3,
    ...over,
  };
}

describe('headersToRecord', () => {
  it('lower-cases names and joins repeated headers', () => {
    expect(
      headersToRecord(['Accept', 'a', 'ACCEPT', 'b', 'Cookie', 'x=1', 'cookie', 'y=2']),
    ).toEqual({
      accept: 'a, b',
      cookie: 'x=1; y=2',
    });
    expect(headersToRecord({ 'X-A': ['1', '2'], 'x-n': 3, 'x-u': undefined })).toEqual({
      'x-a': '1, 2',
      'x-n': '3',
    });
    expect(headersToRecord(new Headers({ 'Content-Type': 'text/plain' }))).toEqual({
      'content-type': 'text/plain',
    });
    expect(headersToRecord([['A', '1']])).toEqual({ a: '1' });
    expect(headersToRecord([])).toEqual({});
  });
});

describe('bodyFields', () => {
  it('keeps text as text', () => {
    expect(bodyFields(Buffer.from('dni=53918274H'), 13)).toEqual({
      reqBody: 'dni=53918274H',
      reqBodyBytes: 13,
    });
  });

  it('encodes binary bodies as base64', () => {
    const bytes = Buffer.from([0, 1, 2, 255, 254]);
    expect(bodyFields(bytes, 5)).toEqual({
      reqBody: bytes.toString('base64'),
      reqBodyEncoding: 'base64',
      reqBodyBytes: 5,
    });
  });

  it('keeps the first 64 KB and the full size', () => {
    const big = Buffer.alloc(MAX_BODY_BYTES + 500, 'a');
    const fields = bodyFields(big, big.length);
    expect(fields.reqBody).toHaveLength(MAX_BODY_BYTES);
    expect(fields.reqBodyBytes).toBe(MAX_BODY_BYTES + 500);
  });

  it('does not cut a UTF-8 character in half', () => {
    const text = `${'a'.repeat(9)}ñññ`; // 9 + 6 bytes
    const bytes = Buffer.from(text);
    const fields = bodyFields(bytes, bytes.length, 10); // cuts inside the first ñ
    expect(fields.reqBody).toBe('a'.repeat(9));
    expect(fields.reqBodyEncoding).toBeUndefined();
    expect(bodyFields(bytes, bytes.length, 11).reqBody).toBe(`${'a'.repeat(9)}ñ`);
  });

  it('says only the size when the bytes were not kept, and nothing for an empty body', () => {
    expect(bodyFields(undefined, 12)).toEqual({ reqBodyBytes: 12 });
    expect(bodyFields(undefined, 0)).toEqual({});
    expect(bodyFields(Buffer.alloc(0), 0)).toEqual({});
  });
});

describe('NetLog', () => {
  it('numbers records, stamps them and keeps a bounded tail', () => {
    const log = new NetLog({ worldId: 'w1', tail: 3, now: () => new Date('2026-10-16T10:00:00Z') });
    for (let i = 0; i < 5; i++) log.append(input({ url: `https://x.test/${i}` }));
    expect(log.tail().map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(log.tail(2).map((r) => r.url)).toEqual(['https://x.test/3', 'https://x.test/4']);
    expect(log.tail()[0]).toMatchObject({ worldId: 'w1', t: '2026-10-16T10:00:00.000Z' });
  });

  it('numbers by request start when the caller took the seq early', () => {
    const log = new NetLog({ worldId: 'w' });
    const first = log.nextSeq();
    const second = log.nextSeq();
    log.append(input({ seq: second }));
    log.append(input({ seq: first }));
    expect(log.tail().map((r) => r.seq)).toEqual([second, first]);
    expect(log.nextSeq()).toBe(3);
  });

  it('redacts credentials in headers, any case, and scrubs typed secrets everywhere', () => {
    const log = new NetLog({
      worldId: 'w',
      scrub: (text) => text.split('hunter2').join('«secret:1»'),
    });
    const record = log.append(
      input({
        url: 'https://clave.example-gov.test/login?p=hunter2',
        reqHeaders: {
          Authorization: 'Bearer sk-live-123',
          'X-Api-Key': 'k',
          Cookie: 'sid=abc',
          'x-p': 'hunter2',
        },
        reqBody: 'user=ana&password=hunter2',
        error: 'failed for hunter2',
      }),
    );
    expect(record.reqHeaders).toEqual({
      authorization: REDACTED,
      'x-api-key': REDACTED,
      cookie: 'sid=abc',
      'x-p': '«secret:1»',
    });
    expect(record.url).toBe('https://clave.example-gov.test/login?p=«secret:1»');
    expect(record.reqBody).toBe('user=ana&password=«secret:1»');
    expect(record.error).toBe('failed for «secret:1»');
    expect(JSON.stringify(log.tail())).not.toContain('sk-live-123');
  });

  it('lets the run choose which headers are redacted', () => {
    const log = new NetLog({ worldId: 'w', redactHeaders: ['Cookie'] });
    const record = log.append(input({ reqHeaders: { cookie: 's=1', authorization: 'x' } }));
    expect(record.reqHeaders).toEqual({ cookie: REDACTED, authorization: 'x' });
  });

  it('does not scrub base64 bodies', () => {
    const log = new NetLog({ worldId: 'w', scrub: () => 'X' });
    const record = log.append(input({ reqBody: 'AAEC', reqBodyEncoding: 'base64' }));
    expect(record.reqBody).toBe('AAEC');
  });

  it('tells listeners about every record until they stop', () => {
    const log = new NetLog({ worldId: 'w' });
    const seen: number[] = [];
    const stop = log.on((r) => seen.push(r.seq));
    log.append(input());
    log.append(input());
    stop();
    log.append(input());
    expect(seen).toEqual([1, 2]);
  });

  it('survives a listener that throws', () => {
    const errors: unknown[] = [];
    const log = new NetLog({ worldId: 'w', onError: (e) => errors.push(e) });
    const seen: number[] = [];
    log.on(() => {
      throw new Error('boom');
    });
    log.on((r) => seen.push(r.seq));
    log.append(input());
    expect(seen).toEqual([1]);
    expect(String(errors[0])).toContain('boom');
  });

  it('writes one JSON line per record and reads them back', async () => {
    const file = path.join(dir, 'net', 'browser.jsonl');
    const log = new NetLog({ worldId: 'w', file });
    log.append(input({ url: 'https://a.test/1', bench: { kind: 'ok', page: 'home', seq: 7 } }));
    log.append(input({ url: 'https://a.test/2', status: 200, resBytes: 10 }));
    // On disk as soon as it is appended: a killed process loses nothing.
    const text = await fsp.readFile(file, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
    const records = await readNetLog(file);
    expect(records.map((r) => r.url)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(records[0]?.bench).toEqual({ kind: 'ok', page: 'home', seq: 7 });
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600);
    log.close();
    log.close();
    expect(() => log.append(input())).toThrow(/closed/);
  });

  it('keeps the lines of concurrent writers to one file whole', async () => {
    const file = path.join(dir, 'shared.jsonl');
    const a = new NetLog({ worldId: 'a', file });
    const b = new NetLog({ worldId: 'b', file });
    const big = 'x'.repeat(20_000);
    for (let i = 0; i < 200; i++) {
      (i % 2 ? a : b).append(input({ url: `https://t.test/${i}`, reqBody: big }));
    }
    a.close();
    b.close();
    const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(200);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(new Set(lines.map((l) => (JSON.parse(l) as NetRecord).url)).size).toBe(200);
  });

  it('fails at once when the file cannot be opened, and reports later write failures', () => {
    // A directory cannot be opened as a file.
    expect(() => new NetLog({ worldId: 'w', file: dir })).toThrow();

    const errors: unknown[] = [];
    const log = new NetLog({
      worldId: 'w',
      file: path.join(dir, 'ok.jsonl'),
      onError: (e) => errors.push(e),
    });
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    try {
      const record = log.append(input());
      expect(record.seq).toBe(1); // the record still reaches the tail and the listeners
    } finally {
      write.mockRestore();
    }
    expect(String(errors[0])).toContain('ENOSPC');
    expect(() => log.close()).toThrow(/ENOSPC/);
  });

  it('finishes a write that the disk took in pieces', () => {
    const file = path.join(dir, 'pieces.jsonl');
    const log = new NetLog({ worldId: 'w', file });
    const real = fs.writeSync;
    const write = vi.spyOn(fs, 'writeSync').mockImplementation(((
      fd: number,
      buf: Buffer,
      offset?: number,
    ) => {
      // The first call takes 10 bytes only.
      const rest = buf.subarray(offset ?? 0);
      return real(fd, rest.subarray(0, write.mock.calls.length === 1 ? 10 : rest.length));
    }) as never);
    try {
      log.append(input({ url: 'https://a.test/whole' }));
    } finally {
      write.mockRestore();
    }
    log.close();
    expect(parseNetLog(fs.readFileSync(file, 'utf8')).map((r) => r.url)).toEqual([
      'https://a.test/whole',
    ]);
  });

  it('keeps records in memory without a file', () => {
    const log = new NetLog({ worldId: 'w' });
    log.append(input());
    log.close();
    expect(log.tail()).toHaveLength(1);
  });
});

describe('reading a log', () => {
  it('skips blank, cut and invalid lines', () => {
    const good = JSON.stringify({ ...input(), seq: 1, t: 'x', worldId: 'w' });
    const text = `${good}\n\n{"seq":2,"t":\n{"nope":true}\n${good}\n{"seq":3`;
    expect(parseNetLog(text)).toHaveLength(2);
  });

  it('returns nothing for a log that does not exist yet', async () => {
    expect(await readNetLog(path.join(dir, 'absent.jsonl'))).toEqual([]);
  });

  it('follows a file another writer appends to, delivering whole lines only', async () => {
    const file = path.join(dir, 'host.jsonl');
    const seen: number[] = [];
    const follower = followNetLog(file, (r) => seen.push(r.seq), { intervalMs: 10 });
    await follower.drain(); // no file yet
    expect(seen).toEqual([]);

    const line = (seq: number) =>
      `${JSON.stringify({ ...input(), seq, t: 't', worldId: 'w', url: `https://ñ.test/${seq}` })}\n`;
    const second = line(2);
    await fsp.writeFile(file, line(1) + second.slice(0, 40));
    await follower.drain();
    expect(seen).toEqual([1]); // the second line is still being written
    await fsp.appendFile(file, second.slice(40));
    await follower.drain();
    expect(seen).toEqual([1, 2]);

    // A multi-byte character split between two writes is not lost.
    const third = Buffer.from(line(3));
    const cut = third.indexOf(0xc3) + 1;
    await fsp.appendFile(file, third.subarray(0, cut));
    await follower.drain();
    await fsp.appendFile(file, third.subarray(cut));
    await follower.stop();
    expect(seen).toEqual([1, 2, 3]);
  });

  it('starts over when the file is truncated', async () => {
    const file = path.join(dir, 'host.jsonl');
    const mk = (seq: number) => `${JSON.stringify({ ...input(), seq, t: 't', worldId: 'w' })}\n`;
    await fsp.writeFile(file, mk(1) + mk(2));
    const seen: number[] = [];
    const follower = followNetLog(file, (r) => seen.push(r.seq), { intervalMs: 1000 });
    await follower.drain();
    await fsp.writeFile(file, mk(9));
    await follower.stop();
    expect(seen).toEqual([1, 2, 9]);
  });
});
