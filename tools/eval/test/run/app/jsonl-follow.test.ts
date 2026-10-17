import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { followJsonl } from '../../../src/run/app/jsonl-follow';
import { SessionTail } from '../../../src/run/app/session-tail';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sa-jsonl-'));
  file = join(dir, 'session.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe('followJsonl', () => {
  it('delivers each complete line once, a line written in two parts when it is complete', async () => {
    const seen: unknown[] = [];
    const follower = followJsonl(file, (v) => seen.push(v), { intervalMs: 5 });
    await follower.drain();
    expect(seen).toEqual([]);
    writeFileSync(file, line({ n: 1 }) + line({ n: 2 }));
    await follower.drain();
    appendFileSync(file, '{"n":');
    await follower.drain();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    appendFileSync(file, '3}\n');
    await follower.drain();
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    await follower.stop();
  });

  it('skips what the file held when it started, with fromEnd', async () => {
    writeFileSync(file, line({ old: true }));
    const seen: unknown[] = [];
    const follower = followJsonl(file, (v) => seen.push(v), { intervalMs: 5, fromEnd: true });
    appendFileSync(file, line({ new: true }));
    await follower.stop();
    expect(seen).toEqual([{ new: true }]);
  });

  it('ignores lines that are not JSON, and starts again when the file is rewritten shorter', async () => {
    const bad: string[] = [];
    const seen: unknown[] = [];
    const follower = followJsonl(file, (v) => seen.push(v), {
      intervalMs: 5,
      onInvalid: (l) => bad.push(l),
    });
    writeFileSync(file, `${line({ a: 1 })}no es json\n\n${line({ b: 2 })}`);
    await follower.drain();
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
    expect(bad).toEqual(['no es json']);
    writeFileSync(file, line({ c: 3 }));
    await follower.drain();
    expect(seen.at(-1)).toEqual({ c: 3 });
    await follower.stop();
  });

  it('delivers what is left when stopped', async () => {
    const seen: unknown[] = [];
    const follower = followJsonl(file, (v) => seen.push(v), { intervalMs: 60_000 });
    writeFileSync(file, line({ last: true }));
    await follower.stop();
    expect(seen).toEqual([{ last: true }]);
  });
});

describe('SessionTail', () => {
  const entry = (id: string, extra: object = {}) => ({ type: 'message', id, ...extra });

  it('skips the entries of an earlier run and delivers each new one once, even when pi rewrites the file', async () => {
    writeFileSync(file, line(entry('a')) + line(entry('b')));
    const seen: string[] = [];
    const tail = new SessionTail(file, (e) => seen.push((e as { id: string }).id));
    appendFileSync(file, line(entry('c')));
    await tail.drain();
    expect(seen).toEqual(['c']);
    // pi rewrites the whole file (it does on some operations): nothing is delivered twice.
    writeFileSync(file, line(entry('a')) + line(entry('b')) + line(entry('c')) + line(entry('d')));
    await tail.drain();
    await tail.stop();
    expect(seen).toEqual(['c', 'd']);
  });

  it('follows a file that does not exist yet', async () => {
    const seen: string[] = [];
    const tail = new SessionTail(file, (e) => seen.push((e as { id: string }).id));
    writeFileSync(file, line(entry('first')));
    await tail.stop();
    expect(seen).toEqual(['first']);
  });
});
