import type { HourTokens } from '../core/ports.js';
import { plusTokens } from '../core/token-cost.js';

const HOUR_MS = 60 * 60_000;

/** The start of the UTC hour the time falls in. */
export function hourOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);
}

/** A ship's tokens counted per model, login and UTC hour (#353, api keys K8, the usage design): what each message used is added to the login of the session that wrote it, or to none when the reader is told no logins, in the hour it was used. */
export interface TokensPerLogin {
  add(used: HourTokens): void;
  /** What was added, in order of model, then login, then hour. */
  list(): HourTokens[];
}

export function createTokensPerLogin(): TokensPerLogin {
  const counted = new Map<string, HourTokens>();
  return {
    add: ({ model, login, hour, tokens }) => {
      const key = `${model}\u0000${login ?? ''}\u0000${String(hour.getTime())}`;
      const before = counted.get(key)?.tokens;
      counted.set(key, { model, ...(login !== undefined && { login }), hour, tokens: before === undefined ? tokens : plusTokens(before, tokens) });
    },
    list: () => [...counted.values()].sort((a, b) => a.model.localeCompare(b.model) || (a.login ?? '').localeCompare(b.login ?? '') || a.hour.getTime() - b.hour.getTime()),
  };
}
