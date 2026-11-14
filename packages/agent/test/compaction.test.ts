import type { Api, Model } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { reserveTokens } from '../src/host/run';

const model = { contextWindow: 1_000_000 } as Model<Api>;

describe('reserveTokens', () => {
  it('makes pi compact at the given context size', () => {
    expect(reserveTokens(model, 184_000)).toBe(816_000);
  });

  it("keeps pi's default without a limit, or with one closer to the window than it", () => {
    expect(reserveTokens(model, undefined)).toBe(16_384);
    expect(reserveTokens(model, 995_000)).toBe(16_384);
  });
});
