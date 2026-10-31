import type { TrierarchReportDetails } from '@aeolus-fleet/common';

import type { HourTokens, Logger, ModelTokens, StatePort, SubscriptionWindow, UsagePort } from './ports.js';
import type { Clock } from './shared/clock.js';
import { estimatedCostUsd, plusTokens, type PriceTable } from './token-cost.js';

/** The harnesses' usage as a trierarch reports it (#353): each harness's subscription windows, and each crewed ship's tokens per model with their estimated cost. */
export type HarnessUsage = NonNullable<TrierarchReportDetails['usage']>;

/** The harnesses' usage, each part read on its own interval: the last read between. */
export type ReadUsage = () => Promise<HarnessUsage>;

/** How often the ships' tokens are read from their transcripts: a report on them at most this often. */
export const TOKENS_READ_INTERVAL_MS = 5 * 60_000;

/** How often a harness's subscription is read at most: Claude Code's costs a short turn of its own. */
export const SUBSCRIPTION_READ_INTERVAL_MS = 30 * 60_000;

type ShipUsage = HarnessUsage['ships'][number];

/** A harness's subscription as last read: its windows, none when it could not say, when, and its ships' tokens then. */
interface SubscriptionRead {
  readonly windows: readonly SubscriptionWindow[] | undefined;
  readonly at: Date;
  readonly tokens: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A ship's tokens added up per model and login over the hours, in the order they came: the report says no hours. */
function perModelOf(hours: readonly HourTokens[]): ModelTokens[] {
  const summed = new Map<string, ModelTokens>();
  for (const { model, login, tokens } of hours) {
    const key = `${model}\u0000${login ?? ''}`;
    const before = summed.get(key)?.tokens;
    summed.set(key, { model, ...(login !== undefined && { login }), tokens: before === undefined ? tokens : plusTokens(before, tokens) });
  }
  return [...summed.values()];
}

const totalOf = (models: readonly ModelTokens[]): number => models.reduce((sum, { tokens }) => sum + tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite, 0);

/**
 * Use case: the trierarch reads its harnesses' usage (#353). Every 5 minutes
 * it reads the tokens each ship it crews used per model and login (api keys
 * K8), since its folder was
 * made, and estimates their cost from the price table. A harness's
 * subscription is read at start, then again only once 30 minutes passed and
 * the harness's ships did work since: Claude Code's read is a turn of its own.
 * A read that fails keeps what was read before.
 */
export function createReadUsage(deps: { usage: UsagePort; state: StatePort; clock: Clock; logger: Pick<Logger, 'warn'>; harnesses: readonly string[]; prices: PriceTable }): ReadUsage {
  let ships: readonly ShipUsage[] = [];
  let tokensReadAt: number | undefined;
  /** Each harness's ships' tokens at the last read, so a subscription is read again only after work. */
  let tokensByHarness = new Map<string, number>();
  const subscriptions = new Map<string, SubscriptionRead>();

  const readTokens = async (): Promise<void> => {
    const { entries } = await deps.state.load();
    const read: ShipUsage[] = [];
    const totals = new Map<string, number>();
    for (const entry of Object.values(entries)) {
      if (entry.folder === undefined) {
        continue;
      }
      // An entry saved before its login was kept says no login, and its tokens none (K8).
      const logins = entry.login === undefined ? undefined : { login: entry.login, ...(entry.earlierLogins !== undefined && { earlierLogins: entry.earlierLogins }) };
      const models = await deps.usage.tokensOf({ shipId: entry.shipId, harness: entry.harness, folder: entry.folder, ...(logins !== undefined && { logins }) }).catch((error: unknown) => {
        deps.logger.warn(`Could not read the usage of ${entry.shipId}: ${messageOf(error)}`);
        return undefined;
      });
      const usage =
        models === undefined
          ? ships.find((ship) => ship.shipId === entry.shipId)
          : { shipId: entry.shipId, models: perModelOf(models).map(({ model, login, tokens }) => ({ model, ...(login !== undefined && { login }), tokens, estimatedCostUsd: estimatedCostUsd(tokens, deps.prices[model]) })) };
      if (usage !== undefined && usage.models.length > 0) {
        read.push(usage);
        totals.set(entry.harness, (totals.get(entry.harness) ?? 0) + totalOf(usage.models));
      }
    }
    ships = read;
    tokensByHarness = totals;
  };

  const readSubscription = async (harness: string, now: Date): Promise<void> => {
    const tokens = tokensByHarness.get(harness) ?? 0;
    const last = subscriptions.get(harness);
    if (last !== undefined && (now.getTime() - last.at.getTime() < SUBSCRIPTION_READ_INTERVAL_MS || tokens === last.tokens)) {
      return;
    }
    const windows = await deps.usage.subscriptionOf(harness).catch((error: unknown) => {
      deps.logger.warn(`Could not read the ${harness} subscription: ${messageOf(error)}`);
      return undefined;
    });
    subscriptions.set(harness, windows === undefined && last?.windows !== undefined ? { ...last, tokens } : { windows, at: now, tokens });
  };

  return async () => {
    const now = deps.clock.now();
    if (tokensReadAt === undefined || now.getTime() - tokensReadAt >= TOKENS_READ_INTERVAL_MS) {
      await readTokens();
      tokensReadAt = now.getTime();
    }
    for (const harness of deps.harnesses) {
      await readSubscription(harness, now);
    }
    return {
      subscriptions: deps.harnesses.flatMap((harness) => {
        const read = subscriptions.get(harness);
        return read?.windows === undefined
          ? []
          : [{ harness, readAt: read.at.toISOString(), windows: read.windows.map((window) => ({ windowMinutes: window.windowMinutes, usedPercent: window.usedPercent, resetsAt: window.resetsAt.toISOString() })) }];
      }),
      ships: [...ships],
    };
  };
}
