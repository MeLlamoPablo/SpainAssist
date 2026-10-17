import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObservationLog } from '../../src/run/observation-log';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sa-obslog-'));
  dirs.push(dir);
  return dir;
}

describe('ObservationLog', () => {
  it('numbers observations in push order and stamps the time', () => {
    const log = new ObservationLog({ now: () => new Date('2026-10-16T10:00:00Z') });
    const a = log.push({ type: 'user_message', text: 'hola' });
    const b = log.push({ type: 'quiescent' });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.t).toBe('2026-10-16T10:00:00.000Z');
    expect(log.all()).toEqual([a, b]);
    expect(log.since(1)).toEqual([b]);
    expect(log.lastSeq).toBe(2);
  });

  it('continues the numbering of a resumed run', () => {
    const log = new ObservationLog({ startSeq: 41 });
    expect(log.push({ type: 'note', text: 'x' }).seq).toBe(42);
  });

  it('writes a private JSONL file before listeners run and scrubs it', () => {
    const file = join(tmp(), 'run', 'events.jsonl');
    const log = new ObservationLog({ file, scrub: (text) => text.replaceAll('hunter2', '***') });
    const seen: string[] = [];
    log.on(() => seen.push(readFileSync(file, 'utf8').trim().split('\n').at(-1) ?? ''));
    const pushed = log.push({ type: 'user_message', text: 'mi clave es hunter2' });
    log.close();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ seq: 1, text: 'mi clave es ***' });
    expect(seen[0]).toContain('"seq":1');
    expect(pushed.type === 'user_message' && pushed.text).toBe('mi clave es hunter2');
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('keeps going when a listener throws and reports the first failure', () => {
    const errors: Error[] = [];
    const log = new ObservationLog({ onError: (e) => errors.push(e) });
    const calls: number[] = [];
    log.on(() => {
      throw new Error('boom');
    });
    log.on((o) => calls.push(o.seq));
    log.push({ type: 'quiescent' });
    log.push({ type: 'quiescent' });
    expect(calls).toEqual([1, 2]);
    expect(errors).toHaveLength(2);
    expect(log.failure?.message).toBe('boom');
  });

  it('stops delivering to an unsubscribed listener', () => {
    const log = new ObservationLog();
    const seen: number[] = [];
    const off = log.on((o) => seen.push(o.seq));
    log.push({ type: 'quiescent' });
    off();
    log.push({ type: 'quiescent' });
    expect(seen).toEqual([1]);
  });

  it('writes RegExp and bytes readably', () => {
    const file = join(tmp(), 'events.jsonl');
    const log = new ObservationLog({ file });
    log.push({ type: 'note', text: 'a' });
    log.push({ type: 'bench', what: 'download', data: { re: /x/i, bytes: new Uint8Array(3) } });
    log.close();
    const last = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[1] ?? '{}');
    expect(last.data).toEqual({ re: '/x/i', bytes: '<3 bytes>' });
  });
});
