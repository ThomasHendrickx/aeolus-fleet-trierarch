import type { ShipId, TrierarchUsageMessage } from '@aeolus-fleet/common';

import { putEntry, type Entry } from './entry.js';
import type { FleetPort, HourTokens, Logger, StatePort, UsagePort } from './ports.js';
import type { ReadUsage } from './read-usage.js';
import type { Clock } from './shared/clock.js';
import { estimatedCostPerKindUsd, type PriceTable } from './token-cost.js';

/** Sends the trierarch plugin's ship the usage that changed, once the hour turned since the last send. */
export type SendUsage = () => Promise<void>;

const HOUR_MS = 60 * 60_000;

/** The most one usage message holds (the usage design): a send over it goes as several messages of whole hours. */
const MESSAGE_MAX_BYTES = 64 * 1024;

type MessageHour = TrierarchUsageMessage['hours'][number];
type MessageShip = MessageHour['ships'][number];
type SubscriptionReading = TrierarchUsageMessage['subscriptions'][number];

/** One ship's usage of one UTC hour, as it goes into the message, and its key in the entry's sentUsage. */
interface ShipHour {
  readonly shipId: ShipId;
  readonly hour: string;
  readonly key: string;
  readonly ships: readonly MessageShip[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const bytesOf = (message: TrierarchUsageMessage): number => new TextEncoder().encode(JSON.stringify(message)).length;

/** Whole hours packed into messages under the most a message holds, oldest hour first; the subscription readings go with the first. */
function messagesOf(hours: readonly MessageHour[], first: { subscriptions: readonly SubscriptionReading[]; readAt: string }): TrierarchUsageMessage[] {
  const { subscriptions, readAt } = first;
  const messages: TrierarchUsageMessage[] = [{ hours: [], subscriptions: [...subscriptions], readAt }];
  for (const hour of hours) {
    const last = messages.at(-1) ?? { hours: [], subscriptions: [], readAt };
    const grown = { ...last, hours: [...last.hours, hour] };
    if (last.hours.length > 0 && bytesOf(grown) > MESSAGE_MAX_BYTES) {
      messages.push({ hours: [hour], subscriptions: [], readAt });
    } else {
      messages[messages.length - 1] = grown;
    }
  }
  return messages;
}

/** What reading a ship's usage takes: the harnesses' usage, and the prices it estimates the cost by. */
interface ReadShipHoursDeps {
  readonly usage: UsagePort;
  readonly prices: PriceTable;
}

/** A crewed ship's usage per UTC hour, as it goes into the message; none before its folder is made. A read that fails rejects. */
async function readShipHours(entry: Entry, deps: ReadShipHoursDeps): Promise<ShipHour[]> {
  if (entry.folder === undefined) {
    return [];
  }
  const { folder } = entry;
  const logins = entry.login === undefined ? undefined : { login: entry.login, ...(entry.earlierLogins !== undefined && { earlierLogins: entry.earlierLogins }) };
  const [madeAt, tokens] = await Promise.all([deps.usage.madeAt(folder), deps.usage.tokensOf({ shipId: entry.shipId, harness: entry.harness, folder, ...(logins !== undefined && { logins }) })]);
  const byHour = new Map<string, HourTokens[]>();
  for (const used of tokens) {
    const hour = used.hour.toISOString();
    byHour.set(hour, [...(byHour.get(hour) ?? []), used]);
  }
  const folderMadeAt = madeAt.toISOString();
  return [...byHour].map(([hour, used]) => {
    const byLogin = new Map<string | null, HourTokens[]>();
    for (const each of used) {
      const login = each.login ?? null;
      byLogin.set(login, [...(byLogin.get(login) ?? []), each]);
    }
    const ships = [...byLogin].map(([login, models]) => ({
      shipId: entry.shipId,
      harness: entry.harness,
      folderMadeAt,
      login,
      models: models.map(({ model, tokens: counts }) => ({ model, tokens: counts, estimatedCostUsd: estimatedCostPerKindUsd(counts, deps.prices[model]) })),
    }));
    return { shipId: entry.shipId, hour, key: `${folderMadeAt} ${hour}`, ships };
  });
}

/** The ship hours whose totals differ from what the entry says was sent of them. */
function changedOf(entry: Entry | undefined, shipHours: readonly ShipHour[]): ShipHour[] {
  return shipHours.filter(({ key, ships }) => entry?.sentUsage?.[key] !== JSON.stringify(ships));
}

/**
 * Use case: the trierarch sends its usage to the trierarch plugin's ship
 * (the usage design, "What the trierarch sends, and when"). At the first pass
 * after the hour turns, and at the first after it starts, it reads each
 * crewed ship's tokens per UTC hour and sends every hour whose totals changed
 * since its last send that returned OK, each hour whole across its ships,
 * and every subscription reading since, gathered each pass. An hour's tokens are its total so
 * far: sending it again changes nothing. Over 64 KB it goes as several
 * messages of whole hours. Only a send that returned OK marks its hours sent,
 * in the ship's entry, so a refused one (fleet unreachable, the daily message
 * limit) is carried by the next. A machine that does not know the plugin's
 * ship, or not its own, sends nothing.
 */
export function createSendUsage(deps: {
  fleet: Pick<FleetPort, 'sendUsage'>;
  usage: UsagePort;
  state: StatePort;
  readUsage: ReadUsage;
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
  prices: PriceTable;
  /** The trierarch's own ship; a crew file written before it was kept names none, and the machine then sends nothing. */
  trierarchShipId?: ShipId;
  pluginShipId?: ShipId;
}): SendUsage {
  let triedHour: number | undefined;
  /** The subscription readings not sent yet, by harness and when, gathered each pass: a harness is read again within an hour. */
  const pendingReadings = new Map<string, SubscriptionReading>();
  const sentReadings = new Set<string>();

  const shipHoursOf = (entry: Entry): Promise<ShipHour[]> =>
    readShipHours(entry, deps).catch((error: unknown) => {
      deps.logger.warn(`Could not read the usage of ${entry.shipId} to send: ${messageOf(error)}`);
      return [];
    });

  /** Marks the ship hours sent in their entries, as the state holds them now. */
  const markSent = async (sent: readonly ShipHour[]): Promise<void> => {
    let state = await deps.state.load();
    for (const { shipId, key, ships } of sent) {
      const entry = state.entries[shipId];
      if (entry !== undefined) {
        state = putEntry(state, { ...entry, sentUsage: { ...entry.sentUsage, [key]: JSON.stringify(ships) } });
      }
    }
    await deps.state.save(state);
  };

  return async () => {
    const { pluginShipId, trierarchShipId } = deps;
    if (pluginShipId === undefined || trierarchShipId === undefined) {
      return;
    }
    const { subscriptions } = await deps.readUsage();
    const current = new Set(subscriptions.map(({ harness, readAt }) => `${harness} ${readAt}`));
    // Only the readings the read still answers can come again: the others need not be remembered as sent.
    for (const key of sentReadings) {
      if (!current.has(key)) {
        sentReadings.delete(key);
      }
    }
    for (const reading of subscriptions) {
      const key = `${reading.harness} ${reading.readAt}`;
      if (!sentReadings.has(key)) {
        pendingReadings.set(key, reading);
      }
    }
    const now = deps.clock.now();
    const hourNow = Math.floor(now.getTime() / HOUR_MS);
    if (triedHour === hourNow) {
      return;
    }
    triedHour = hourNow;
    const { entries } = await deps.state.load();
    const shipHours = (await Promise.all(Object.values(entries).map(shipHoursOf))).flat();
    const changedHours = new Set(Object.values(entries).flatMap((entry) => changedOf(entry, shipHours.filter(({ shipId }) => shipId === entry.shipId))).map(({ hour }) => hour));
    const newReadings = [...pendingReadings.values()].sort((a, b) => a.readAt.localeCompare(b.readAt) || a.harness.localeCompare(b.harness));
    if (changedHours.size === 0 && newReadings.length === 0) {
      return;
    }
    const hours = [...changedHours].sort().map((hour) => ({ hour, ships: shipHours.filter((shipHour) => shipHour.hour === hour).flatMap(({ ships }) => ships) }));
    const readAt = now.toISOString();
    const messages = messagesOf(hours, { subscriptions: newReadings, readAt });
    for (const [index, message] of messages.entries()) {
      const idempotencyKey = `usage:${trierarchShipId}:${readAt}${index === 0 ? '' : `:${String(index + 1)}`}`;
      try {
        await deps.fleet.sendUsage({ pluginShipId, payload: JSON.stringify(message), idempotencyKey });
      } catch (error) {
        deps.logger.warn(`Could not send the usage to the trierarch plugin's ship: ${messageOf(error)}; the next send carries it`);
        return;
      }
      const sentHours = new Set(message.hours.map(({ hour }) => hour));
      await markSent(shipHours.filter(({ hour }) => sentHours.has(hour)));
      for (const { harness, readAt: readingAt } of message.subscriptions) {
        const key = `${harness} ${readingAt}`;
        sentReadings.add(key);
        pendingReadings.delete(key);
      }
    }
  };
}

/** Sends a released ship's last usage, read once more, before its folder goes; rejects when the fleet does not take it, so the folder stays. */
export type SendReleasedUsage = (entry: Entry) => Promise<void>;

/**
 * Use case: as a ship is released, here or elsewhere, the trierarch reads its
 * transcripts once more and sends the plugin's ship every hour of it whose
 * totals changed since its last send that returned OK (the usage design, U9).
 * Its folder is removed only after that: a read or a send that fails rejects,
 * and the release tries again on the next pass. Nothing to send, or a machine
 * that does not know the plugin's ship or its own, sends nothing. The key
 * names the ship, as an hourly send may share the moment.
 */
export function createSendReleasedUsage(deps: {
  fleet: Pick<FleetPort, 'sendUsage'>;
  usage: UsagePort;
  clock: Clock;
  prices: PriceTable;
  trierarchShipId?: ShipId;
  pluginShipId?: ShipId;
}): SendReleasedUsage {
  return async (entry) => {
    const { pluginShipId, trierarchShipId } = deps;
    if (pluginShipId === undefined || trierarchShipId === undefined) {
      return;
    }
    const changed = changedOf(entry, await readShipHours(entry, deps));
    if (changed.length === 0) {
      return;
    }
    const hours = [...new Set(changed.map(({ hour }) => hour))].sort().map((hour) => ({ hour, ships: changed.filter((shipHour) => shipHour.hour === hour).flatMap(({ ships }) => ships) }));
    const readAt = deps.clock.now().toISOString();
    for (const [index, message] of messagesOf(hours, { subscriptions: [], readAt }).entries()) {
      const idempotencyKey = `usage:${trierarchShipId}:${readAt}:${entry.shipId}${index === 0 ? '' : `:${String(index + 1)}`}`;
      await deps.fleet.sendUsage({ pluginShipId, payload: JSON.stringify(message), idempotencyKey });
    }
  };
}
