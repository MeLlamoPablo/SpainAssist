import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const endpoint = 'https://api.paradigmmachines.ai/v1';
const prediction = z.object({
  screen: z.object({ width: z.number().positive(), height: z.number().positive() }),
  grid: z.object({ cols: z.number().int().positive(), rows: z.number().int().positive() }),
  mean: z.object({ map: z.array(z.number().nonnegative()) }),
});

async function predict(image: Buffer, key: string) {
  const signal = AbortSignal.timeout(150_000);
  const headers = { 'X-API-Key': key, 'Content-Type': 'application/json' };
  let response = await fetch(`${endpoint}/predict`, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal,
    body: JSON.stringify({ image: image.toString('base64') }),
  });
  for (;;) {
    if (!response.ok) throw new Error(`Orion HTTP ${response.status}`);
    const job = await response.json();
    if (job.status === 'done') return prediction.parse(job.result);
    if (!job.id || job.status === 'failed' || job.error) throw new Error('Orion prediction failed');
    await delay(1000, undefined, { signal });
    response = await fetch(`${endpoint}/predictions/${encodeURIComponent(job.id)}`, {
      headers,
      redirect: 'error',
      signal,
    });
  }
}

interface NodeBox {
  ref?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: NodeBox[];
}

export function createOrionSnapshot(keyFile: string) {
  const key = readFileSync(keyFile, 'utf8').trim();
  return async (text: string, tree: unknown, screenshot: () => Promise<Buffer>) => {
    const lines = text.split('\n');
    if (lines.length <= 16 || !Array.isArray(tree)) return text;
    const start = Date.now();
    const { screen, grid, mean } = await predict(await screenshot(), key);
    if (mean.map.length !== grid.rows * grid.cols) throw new Error('Incomplete Orion gaze map');
    const scores = new Map<string, number>();
    function visit(nodes: NodeBox[]) {
      for (const node of nodes) {
        const box = node.box;
        if (node.ref && box && box.width > 0 && box.height > 0) {
          const x = Math.floor(((box.x + box.width / 2) / screen.width) * grid.cols);
          const y = Math.floor(((box.y + box.height / 2) / screen.height) * grid.rows);
          if (x >= 0 && x < grid.cols && y >= 0 && y < grid.rows)
            scores.set(node.ref, mean.map[y * grid.cols + x] ?? 0);
        }
        if (node.children) visit(node.children);
      }
    }
    visit(tree);
    const ranked = lines
      .map((line, index) => {
        const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
        return { index, score: ref ? (scores.get(ref) ?? -1) : -1 };
      })
      .filter((row) => row.score >= 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) return text;
    const keep = new Set(ranked.slice(0, 12).map((row) => row.index));
    // Preserve form controls, headings and warnings even below the viewport.
    const slim = lines
      .filter(
        (line, index) =>
          keep.has(index) ||
          /^\s*- (?:heading|alert|dialog|textbox|combobox|checkbox|radio|button|spinbutton)\b/.test(
            line,
          ),
      )
      .join('\n');
    console.error(
      'Orion snapshot',
      JSON.stringify({ before: text.length, after: slim.length, ms: Date.now() - start }),
    );
    return slim;
  };
}
