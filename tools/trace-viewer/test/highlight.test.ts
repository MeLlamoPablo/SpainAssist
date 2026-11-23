import { describe, expect, it } from 'vitest';
import { highlightJs } from '../src/ui/highlight';

const MODULE = `export async function main(api) {
  await api.setStatus('Leyendo');
  return 1;
}`;

/** The token whose text is `content`, on any line. */
async function tokenOf(content: string) {
  const token = (await highlightJs(MODULE)).flat().find((t) => t.content.trim() === content);
  if (!token) throw new Error(`No token "${content}"`);
  return token;
}

describe('highlightJs', () => {
  it('keeps the text, line by line', async () => {
    const lines = await highlightJs(MODULE);
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
});
