import { describe, expect, it } from 'vitest';
import {
  BROWSER_STATE_FORMAT,
  hasBrowserState,
  parseBrowserState,
  serializeBrowserState,
} from '../../../src/run/app/browser';

const state = JSON.stringify({
  cookies: [{ name: 'sid', value: '1', domain: 'portal.example.test', path: '/' }],
  origins: [{ origin: 'https://portal.example.test', localStorage: [{ name: 'k', value: 'v' }] }],
});

describe('the browser state of a checkpoint', () => {
  it('round-trips the storage states by procedure', () => {
    const text = serializeBrowserState({ p_00000000000000aa: state });
    expect(JSON.parse(text).format).toBe(BROWSER_STATE_FORMAT);
    const back = parseBrowserState(text);
    expect(Object.keys(back)).toEqual(['p_00000000000000aa']);
    expect(JSON.parse(back.p_00000000000000aa as string)).toEqual(JSON.parse(state));
  });

  it('refuses a file of another format or shape', () => {
    expect(() => parseBrowserState(JSON.stringify({ format: 'x/1', procedures: {} }))).toThrow(
      /Invalid browser state file/,
    );
    expect(() =>
      parseBrowserState(
        JSON.stringify({ format: BROWSER_STATE_FORMAT, procedures: { p: 'text' } }),
      ),
    ).toThrow(/Invalid browser state file/);
    expect(() => parseBrowserState('not json')).toThrow();
  });

  it('keeps only states with something in them', () => {
    expect(hasBrowserState(state)).toBe(true);
    expect(hasBrowserState(JSON.stringify({ cookies: [], origins: [] }))).toBe(false);
    expect(hasBrowserState('{')).toBe(false);
  });
});
