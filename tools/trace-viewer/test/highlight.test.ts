import { describe, expect, it } from 'vitest';
import { highlight } from '../src/ui/highlight';

const MODULE = `export async function main(api) {
  await api.setStatus('Leyendo');
  return 1;
}`;

/** The token whose text is `content`, on any line. */
async function tokenOf(content: string) {
  const token = (await highlight(MODULE, 'javascript'))
    .flat()
    .find((t) => t.content.trim() === content);
  if (!token) throw new Error(`No token "${content}"`);
  return token;
}

/** The light theme's color of each token, by its text. */
async function jsonColors(json: string) {
  const tokens = (await highlight(json, 'json')).flat();
  return new Map(tokens.map((t) => [t.content.trim(), t.htmlStyle?.['--shiki-light']]));
}

describe('highlight', () => {
  it('keeps the text, line by line', async () => {
    const lines = await highlight(MODULE, 'javascript');
    expect(lines.map((line) => line.map((t) => t.content).join(''))).toEqual(MODULE.split('\n'));
  });

  it('gives each token a color for each theme', async () => {
    const keyword = await tokenOf('await');
    expect(keyword.htmlStyle).toMatchObject({
      '--shiki-light': expect.any(String),
      '--shiki-dark': expect.any(String),
    });
  });

  it('colors keywords and strings differently', async () => {
    const keyword = await tokenOf('await');
    const string = await tokenOf("'Leyendo'");
    expect(keyword.htmlStyle?.['--shiki-light']).not.toBe(string.htmlStyle?.['--shiki-light']);
  });

  it('colors JSON keys and string values differently', async () => {
    const colors = await jsonColors('{\n  "query": "cambio de titularidad"\n}');
    expect(colors.get('"query"')).toBeDefined();
    expect(colors.get('"query"')).not.toBe(colors.get('"cambio de titularidad"'));
  });
});
