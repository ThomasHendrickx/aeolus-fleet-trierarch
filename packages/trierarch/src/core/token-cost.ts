/** The tokens a ship's sessions used of one model (#353): input not read from a cache, output, and the input read from and written to the prompt cache. */
export interface TokenCounts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** What a model costs, in US dollars per million tokens of each kind. */
export type ModelPrice = TokenCounts;

/** The price of each model, by its id as the harness names it. */
export type PriceTable = Readonly<Record<string, ModelPrice>>;

const TOKENS_PER_PRICE = 1_000_000;
const CENTS_PER_DOLLAR = 100;

/**
 * The list prices of the current Claude and OpenAI models, standard tier, as
 * published on 2026-10-25 (platform.claude.com pricing; developers.openai.com/api/docs/pricing,
 * short context). A Claude cache write is priced at the 1 hour rate, twice the
 * input, as Claude Code writes its cache for an hour; an OpenAI one at its 30
 * minute rate, or at the input where none is listed. The configuration's
 * `prices` replace a model's price here and add others.
 */
const LIST_PRICES: PriceTable = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.2 },
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
};

/** Policy: the prices the trierarch estimates by: the list prices, with the configuration's own for a model in place of its list price. */
export function priceTableOf(configured: PriceTable | undefined): PriceTable {
  return { ...LIST_PRICES, ...configured };
}

/** Policy: what the tokens cost at the model's price, to the cent; none for a model the table does not price. */
export function estimatedCostUsd(tokens: TokenCounts, price: ModelPrice | undefined): number | null {
  if (price === undefined) {
    return null;
  }
  const dollars = (tokens.input * price.input + tokens.output * price.output + tokens.cacheRead * price.cacheRead + tokens.cacheWrite * price.cacheWrite) / TOKENS_PER_PRICE;
  return Math.round(dollars * CENTS_PER_DOLLAR) / CENTS_PER_DOLLAR;
}
