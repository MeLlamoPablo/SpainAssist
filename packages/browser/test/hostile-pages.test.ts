import { describe, expect, it } from 'vitest';
import { cleanPlaywrightMessage } from '../src/errors';
import { detectPageNotes } from '../src/notes';

// Pages choose their URLs and error texts. Main matches them with regexes: before they were
// bounded, a 520 KB URL took 32 s, and main (the whole app) waited.
describe('pages that write huge URLs and errors', () => {
  const quickly = (fn: () => unknown) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it('are read for notes quickly', () => {
    const url = `https://example.org/#${'hcaptcha.com/'.repeat(40_000)}`;
    expect(
      quickly(() => detectPageNotes({ url, title: '', text: '', frameUrls: [url, url] })),
    ).toBeLessThan(500);
  });

  it('have their errors cleaned quickly, keeping the message', () => {
    expect(quickly(() => cleanPlaywrightMessage(`Error${'\n'.repeat(40_000)}x`))).toBeLessThan(500);
    expect(
      cleanPlaywrightMessage('locator.click: Timeout 30000ms exceeded.\nCall log:\n  - x'),
    ).toBe('Timeout 30000ms exceeded.');
    expect(cleanPlaywrightMessage('page.goto: net::ERR_FAILED\n  Call log:\n  - y')).toBe(
      'net::ERR_FAILED',
    );
  });
});
