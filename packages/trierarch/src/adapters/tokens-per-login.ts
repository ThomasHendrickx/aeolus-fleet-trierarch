import type { ModelTokens } from '../core/ports.js';
import type { TokenCounts } from '../core/token-cost.js';

/** A ship's tokens counted per model and login (#353, api keys K8): what each message used is added to the login of the session that wrote it, or to none when the reader is told no logins. */
export interface TokensPerLogin {
  add(used: ModelTokens): void;
  /** What was added, in order of model, then login. */
  list(): ModelTokens[];
}

export function createTokensPerLogin(): TokensPerLogin {
  const counted = new Map<string, ModelTokens>();
  return {
    add: ({ model, login, tokens }) => {
      const key = `${model}\u0000${login ?? ''}`;
      const before = counted.get(key)?.tokens;
      counted.set(key, { model, ...(login !== undefined && { login }), tokens: before === undefined ? tokens : plus(before, tokens) });
    },
    list: () => [...counted.values()].sort((a, b) => a.model.localeCompare(b.model) || (a.login ?? '').localeCompare(b.login ?? '')),
  };
}

function plus(a: TokenCounts, b: TokenCounts): TokenCounts {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}
