import { describe, expect, it } from 'vitest';

import { estimatedCostUsd, priceTableOf } from './token-cost.js';

describe('the estimated cost of the tokens a ship used (#353)', () => {
  it('prices input, output, cache read and cache write tokens by the model, per million, to the cent', () => {
    const price = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 };
    // 0.0048 + 0.9 + 1.96 + 3.28 = 6.1448
    const tokens = { input: 1200, output: 45_000, cacheRead: 9_800_000, cacheWrite: 410_000 };

    expect(estimatedCostUsd(tokens, price)).toBe(6.14);
  });

  it('estimates nothing for a model the price table does not price', () => {
    expect(estimatedCostUsd({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, undefined)).toBeNull();
  });

  it('prices the current Claude and OpenAI models at their list prices', () => {
    const prices = priceTableOf(undefined);

    expect([prices['claude-opus-5-5'], prices['gpt-5.6-sol']]).toEqual([
      { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
      { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
    ]);
  });

  it("takes the configuration's price of a model over its list price, and keeps the list prices of the others", () => {
    const prices = priceTableOf({ 'claude-opus-5-5': { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 'my-model': { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 } });

    expect([prices['claude-opus-5-5'], prices['my-model'], prices['claude-sonnet-5-5']]).toEqual([
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 },
      { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
    ]);
  });
});
