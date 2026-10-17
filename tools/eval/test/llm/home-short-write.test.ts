import './helpers/no-network';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHome, type TestHome } from './helpers/tmp-home';

/**
 * `writeSync` may write fewer bytes than it was given (a signal, a full pipe, a quota). The file
 * system of a temp dir never does, so this test makes it: `writeSync` writes one byte per call.
 * An implementation that calls it once would sync and rename half a credential over the good one.
 */
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync: ((fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
      const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data.buffer);
      return (actual.writeSync as (...args: unknown[]) => number)(
        fd,
        bytes.subarray(0, 1),
        ...rest,
      );
    }) as typeof actual.writeSync,
  };
});

const { writeFileAtomic } = await import('../../src/llm/home');

describe('writing a credential file when the system writes in pieces', () => {
  let t: TestHome;
  beforeEach(() => {
    t = makeHome();
  });
  afterEach(() => t.cleanup());

  it('never replaces the good file with a truncated one', () => {
    const path = join(t.home, 'codex.json');
    const content = `${JSON.stringify({ refresh: 'a-refresh-token-that-is-long-enough'.repeat(20) })}\n`;
    writeFileAtomic(path, 'the old credential');
    writeFileAtomic(path, content);
    expect(readFileSync(path, 'utf8')).toBe(content);
    expect(readdirSync(t.home)).toEqual(['codex.json']);
  });
});
