import { describe, expect, it } from 'vitest';
import {
  compareValue,
  deepEqual,
  parsePath,
  pathSatisfies,
  resolvePath,
  showValues,
} from '../../src/rules/path';

const state = {
  sites: {
    'seg-social-es': { loginMethod: 'clave-permanente', failedLogins: 0, filter: null },
  },
  downloads: [
    { record: { report: 'acotada', csv: 'AAA' } },
    { record: { report: 'completa', csv: 'BBB' } },
  ],
  wrongTurns: { count: 2, items: [] },
};

describe('resolvePath', () => {
  it('walks own properties, including hyphenated site ids', () => {
    expect(resolvePath(state, 'sites.seg-social-es.loginMethod')).toEqual(['clave-permanente']);
    expect(resolvePath(state, 'wrongTurns.count')).toEqual([2]);
  });

  it('reaches null values and nothing for missing ones', () => {
    expect(resolvePath(state, 'sites.seg-social-es.filter')).toEqual([null]);
    expect(resolvePath(state, 'sites.seg-social-es.nope')).toEqual([]);
    expect(resolvePath(state, 'nope.deeper.still')).toEqual([]);
  });

  it('indexes arrays, also from the end, and reads length', () => {
    expect(resolvePath(state, 'downloads.0.record.csv')).toEqual(['AAA']);
    expect(resolvePath(state, 'downloads.-1.record.csv')).toEqual(['BBB']);
    expect(resolvePath(state, 'downloads.5.record.csv')).toEqual([]);
    expect(resolvePath(state, 'downloads.length')).toEqual([2]);
    expect(resolvePath('abcd', 'length')).toEqual([4]);
  });

  it('fans out with * over arrays and objects', () => {
    expect(resolvePath(state, 'downloads.*.record.report')).toEqual(['acotada', 'completa']);
    expect(resolvePath(state, 'wrongTurns.*')).toEqual([2, []]);
  });

  it('never reaches the prototype chain', () => {
    expect(() => parsePath('a.__proto__.b')).toThrow(/not allowed/);
    expect(() => parsePath('constructor')).toThrow(/not allowed/);
    expect(() => parsePath('a..b')).toThrow(/empty segment/);
    expect(resolvePath({}, ['toString'])).toEqual([]);
    expect(resolvePath({}, ['hasOwnProperty'])).toEqual([]);
    expect(resolvePath([], ['map'])).toEqual([]);
  });
});

describe('compareValue', () => {
  it('compares structurally for equals', () => {
    expect(compareValue({ a: [1, { b: null }] }, { equals: { a: [1, { b: null }] } })).toBe(true);
    expect(compareValue({ a: 1 }, { equals: { a: 1, b: 2 } })).toBe(false);
    expect(compareValue(null, { equals: null })).toBe(true);
    expect(compareValue(undefined, { equals: null })).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('tests regexes on scalars only, without lastIndex state', () => {
    const re = /^compl/g;
    expect(compareValue('completa', { matches: re })).toBe(true);
    expect(compareValue('completa', { matches: re })).toBe(true);
    expect(compareValue(42, { matches: /^4/ })).toBe(true);
    expect(compareValue({ x: 'completa' }, { matches: /completa/ })).toBe(false);
  });

  it('compares numbers for gte and lte and rejects other types', () => {
    expect(compareValue(3, { gte: 3, lte: 3 })).toBe(true);
    expect(compareValue(3, { gte: 4 })).toBe(false);
    expect(compareValue('3', { gte: 1 })).toBe(false);
    expect(compareValue(2, { lte: 1 })).toBe(false);
  });
});

describe('pathSatisfies', () => {
  it('without a comparison asks that the value exists', () => {
    expect(pathSatisfies(state, 'wrongTurns.count', {}).matched).toBe(true);
    expect(pathSatisfies(state, 'sites.seg-social-es.filter', {}).matched).toBe(false);
    expect(pathSatisfies(state, 'missing', {}).matched).toBe(false);
  });

  it('is true when any fanned-out value satisfies every comparison', () => {
    expect(pathSatisfies(state, 'downloads.*.record.report', { equals: 'completa' }).matched).toBe(
      true,
    );
    expect(pathSatisfies(state, 'downloads.*.record.csv', { matches: /^C/ }).matched).toBe(false);
  });

  it('renders values compactly', () => {
    expect(showValues([])).toBe('not found');
    expect(showValues(['x'])).toBe('"x"');
    expect(showValues([1, 2])).toBe('[1,2]');
    expect(showValues(['y'.repeat(500)], 20)).toHaveLength(20);
  });
});
