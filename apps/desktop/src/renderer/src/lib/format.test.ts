import { describe, expect, it } from 'vitest';
import { formatCredits } from './format';

describe('formatCredits', () => {
  it('shows one credit per cent', () => {
    expect(formatCredits(2.64, 'es')).toBe('264 ✦');
  });

  it('absorbs float error instead of losing a credit', () => {
    expect(formatCredits(0.29, 'es')).toBe('29 ✦');
  });

  it('rounds partial credits down and never goes below zero', () => {
    expect(formatCredits(0.019, 'es')).toBe('1 ✦');
    expect(formatCredits(-0.5, 'es')).toBe('0 ✦');
  });
});
