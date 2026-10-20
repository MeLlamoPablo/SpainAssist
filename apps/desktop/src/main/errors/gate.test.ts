import { describe, expect, it } from 'vitest';
import { errorReportsAllowed } from './gate';

describe('error reporting consent', () => {
  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])('flag=%s, anonymous sharing=%s allows reports=%s', (errorReports, shareLearnings, allowed) => {
    expect(errorReportsAllowed({ errorReports }, { shareLearnings })).toBe(allowed);
  });
});
