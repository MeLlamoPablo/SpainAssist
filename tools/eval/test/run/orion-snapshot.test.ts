import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createOrionSnapshot } from '../../src/run/app/orion-snapshot';

const root = mkdtempSync(join(tmpdir(), 'orion-unit-'));
const key = join(root, 'key');
writeFileSync(key, 'test');
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

it('keeps high-attention refs and offscreen form controls in page order', async () => {
  const lines = Array.from({ length: 19 }, (_, i) => `- link "Link ${i}" [ref=e${i}]`);
  lines.push('- textbox "Name" [ref=e19]');
  const tree = lines.map((_, i) => ({
    ref: `e${i}`,
    box: { x: i, y: 0, width: 1, height: 1 },
  }));
  const predict = vi.fn().mockResolvedValue(
    Response.json({
      status: 'done',
      result: {
        screen: { width: 18, height: 1 },
        grid: { cols: 18, rows: 1 },
        mean: { map: Array.from({ length: 18 }, (_, i) => i / 153) },
      },
    }),
  );
  vi.stubGlobal('fetch', predict);
  const snapshot = createOrionSnapshot(key);
  const screenshot = vi.fn(async () => Buffer.from('mock'));
  expect(await snapshot(lines[0]!, tree, screenshot)).toBe(lines[0]);
  expect(screenshot).not.toHaveBeenCalled();
  expect(await snapshot(lines.join('\n'), tree, screenshot)).toBe(
    [...lines.slice(6, 18), lines[19]].join('\n'),
  );
  expect(predict).toHaveBeenCalledTimes(1);
});
