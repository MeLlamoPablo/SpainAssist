import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskHome, maskHomeInTree } from '../../../src/run/app/home-paths';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('the home folder in run outputs', () => {
  it('becomes ~ where a path segment ends, in plain and JSON-escaped spellings', () => {
    expect(maskHome('at file:///Users/ana/proj/x.js:1', '/Users/ana')).toBe(
      'at file://~/proj/x.js:1',
    );
    expect(maskHome('"netlog": "/Users/ana"', '/Users/ana')).toBe('"netlog": "~"');
    // Another user whose name starts the same is not this home.
    expect(maskHome('/Users/anabel/x', '/Users/ana')).toBe('/Users/anabel/x');
    expect(maskHome('{"cwd":"C:\\\\Users\\\\ana\\\\x"}', 'C:\\Users\\ana')).toBe(
      '{"cwd":"~\\\\x"}',
    );
    // A root home would match every path: left alone.
    expect(maskHome('/etc/hosts', '/')).toBe('/etc/hosts');
  });

  it('rewrites the text files of a tree and leaves the others', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sa-home-'));
    const home = '/Users/ana';
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'a', 'b', 'session.jsonl'), `{"stack":"${home}/p/x.js"}\n`);
    writeFileSync(join(dir, 'a', 'doc.pdf'), `%PDF ${home}`);
    await maskHomeInTree(dir, home);
    expect(readFileSync(join(dir, 'a', 'b', 'session.jsonl'), 'utf8')).toBe(
      '{"stack":"~/p/x.js"}\n',
    );
    expect(readFileSync(join(dir, 'a', 'doc.pdf'), 'utf8')).toBe(`%PDF ${home}`);
  });
});
