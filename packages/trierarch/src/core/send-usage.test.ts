import { trierarchUsageMessageSchema } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, aTrierarchSetUpBefore, FOLDER_MADE_AT, newId, PLUGIN_SHIP_ID, TRIERARCH_SHIP_ID, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import { putEntry, type Entry } from './entry.js';

// The trierarch sends its usage to the trierarch plugin's ship once an hour
// (the usage design, "What the trierarch sends, and when"): every hour whose
// totals changed since its last send that returned OK, each whole, and the
// subscription readings since then.

const HOUR_MS = 60 * 60_000;

function aCrewedEntry(name = 'scout'): Entry {
  return {
    shipId: newId('ship'),
    shipName: name,
    harness: 'claude-code',
    workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
    options: {},
    settingsVersion: 1,
    state: 'running',
    since: '2026-10-06T07:00:00.000Z',
    exits: [],
    hasStarted: true,
    folder: `${WORKTREE_ROOT}/aeolus-fleet/${name}`,
  };
}

async function withEntries(trierarch: Trierarch, ...entries: readonly Entry[]): Promise<void> {
  await trierarch.state.save(entries.reduce(putEntry, await trierarch.state.load()));
}

const OPUS_TOKENS = { model: 'claude-opus-5-5', tokens: { input: 1200, output: 45_000, cacheRead: 9_800_000, cacheWrite: 410_000 } };
/** OPUS_TOKENS at Claude Opus 5.5's list prices (4, 20, 0.2 and 8 dollars per million), kind by kind. */
const OPUS_COST = { input: 0.0048, output: 0.9, cacheRead: 1.96, cacheWrite: 3.28 };
const FIVE_HOURS = { windowMinutes: 300, usedPercent: 3, resetsAt: new Date('2026-10-06T12:00:00.000Z') };

/** Each usage message the plugin's ship was sent, parsed as common's schema. */
function sentMessages(trierarch: Trierarch) {
  return trierarch.fleet.sentUsage.map(({ payload }) => trierarchUsageMessageSchema.parse(JSON.parse(payload)));
}

describe("the trierarch sends its usage to the trierarch plugin's ship (the usage design)", () => {
  it("sends each ship's tokens per UTC hour with its folder, harness, login and cost per kind, and the subscription readings", async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    trierarch.usage.subscriptions.set('claude-code', [FIVE_HOURS]);

    await trierarch.sendUsage();

    expect(trierarch.fleet.sentUsage.map(({ pluginShipId, idempotencyKey }) => ({ pluginShipId, idempotencyKey }))).toEqual([
      { pluginShipId: PLUGIN_SHIP_ID, idempotencyKey: `usage:${TRIERARCH_SHIP_ID}:2026-10-06T08:00:00.000Z` },
    ]);
    expect(sentMessages(trierarch)).toEqual([
      {
        hours: [
          {
            hour: '2026-10-06T07:00:00.000Z',
            ships: [{ shipId: entry.shipId, harness: 'claude-code', folderMadeAt: FOLDER_MADE_AT.toISOString(), login: null, models: [{ ...OPUS_TOKENS, estimatedCostUsd: OPUS_COST }] }],
          },
        ],
        subscriptions: [{ harness: 'claude-code', readAt: '2026-10-06T08:00:00.000Z', windows: [{ windowMinutes: 300, usedPercent: 3, resetsAt: '2026-10-06T12:00:00.000Z' }] }],
        readAt: '2026-10-06T08:00:00.000Z',
      },
    ]);
  });

  it('names the login a ship ran on, and no cost for a model it does not price', async () => {
    const trierarch = aTrierarch();
    const entry: Entry = { ...aCrewedEntry(), login: 'apiKey' };
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [{ model: 'claude-mystery-1', login: 'apiKey', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } }]);

    await trierarch.sendUsage();

    expect(sentMessages(trierarch)[0]?.hours[0]?.ships).toEqual([
      { shipId: entry.shipId, harness: 'claude-code', folderMadeAt: FOLDER_MADE_AT.toISOString(), login: 'apiKey', models: [{ model: 'claude-mystery-1', tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, estimatedCostUsd: null }] },
    ]);
  });

  it('sends again only once the hour turns', async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    await trierarch.sendUsage();
    trierarch.usage.tokens.set(entry.shipId, [{ ...OPUS_TOKENS, hour: new Date('2026-10-06T08:00:00.000Z') }, OPUS_TOKENS]);

    trierarch.clock.advance(59 * 60_000);
    await trierarch.sendUsage();
    expect(trierarch.fleet.sentUsage).toHaveLength(1);

    trierarch.clock.advance(60_000);
    await trierarch.sendUsage();
    expect(trierarch.fleet.sentUsage).toHaveLength(2);
  });

  it('sends only the hours whose totals changed since its last send that returned OK, each whole', async () => {
    const trierarch = aTrierarch();
    const scout = aCrewedEntry('scout');
    const mate = aCrewedEntry('mate');
    await withEntries(trierarch, scout, mate);
    trierarch.usage.tokens.set(scout.shipId, [OPUS_TOKENS]);
    trierarch.usage.tokens.set(mate.shipId, [OPUS_TOKENS]);
    await trierarch.sendUsage();
    // A late transcript entry changes scout's 07:00 hour; mate's stays as sent.
    trierarch.usage.tokens.set(scout.shipId, [{ ...OPUS_TOKENS, tokens: { ...OPUS_TOKENS.tokens, output: 46_000 } }]);

    trierarch.clock.advance(HOUR_MS);
    await trierarch.sendUsage();

    const resent = sentMessages(trierarch)[1]?.hours;
    expect(resent?.map(({ hour, ships }) => ({ hour, ships: ships.map((ship) => ship.shipId).sort() }))).toEqual([{ hour: '2026-10-06T07:00:00.000Z', ships: [scout.shipId, mate.shipId].sort() }]);
  });

  it('sends nothing when no hour changed and no subscription was read since its last send', async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    await trierarch.sendUsage();

    trierarch.clock.advance(HOUR_MS);
    await trierarch.sendUsage();

    expect(trierarch.fleet.sentUsage).toHaveLength(1);
  });

  it('marks nothing sent when the fleet refuses a send, so the next send carries those hours too', async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    trierarch.fleet.isRefusingUsage = true;
    await trierarch.sendUsage();
    trierarch.fleet.isRefusingUsage = false;

    trierarch.clock.advance(HOUR_MS);
    await trierarch.sendUsage();

    expect(sentMessages(trierarch).map(({ hours }) => hours.map(({ hour }) => hour))).toEqual([['2026-10-06T07:00:00.000Z']]);
    expect(trierarch.logger.warnings.some((line) => line.includes('Could not send the usage'))).toBe(true);
  });

  it("keeps a ship's fresh folder apart: its hours are sent though the old folder's same hours were", async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    await trierarch.sendUsage();
    const freshMadeAt = new Date('2026-10-06T07:30:00.000Z');
    trierarch.usage.madeAtOf.set(entry.folder ?? '', freshMadeAt);

    trierarch.clock.advance(HOUR_MS);
    await trierarch.sendUsage();

    expect(sentMessages(trierarch)[1]?.hours[0]?.ships[0]?.folderMadeAt).toBe(freshMadeAt.toISOString());
  });

  it('splits a send over 64 KB into messages of whole hours, each under 64 KB', async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    const hours = Array.from({ length: 400 }, (_, index) => ({ ...OPUS_TOKENS, hour: new Date(Date.parse('2026-09-20T00:00:00.000Z') + index * HOUR_MS) }));
    trierarch.usage.tokens.set(entry.shipId, hours);

    await trierarch.sendUsage();

    const sent = trierarch.fleet.sentUsage;
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every(({ payload }) => new TextEncoder().encode(payload).length <= 64 * 1024)).toBe(true);
    expect(new Set(sent.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(sent.length);
    expect(sentMessages(trierarch).flatMap((message) => message.hours.map(({ hour }) => hour))).toEqual(hours.map(({ hour }) => hour.toISOString()));
  });

  it("sends nothing on a machine that does not know the trierarch plugin's ship", async () => {
    const trierarch = aTrierarchSetUpBefore();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);

    await trierarch.sendUsage();

    expect(trierarch.fleet.sentUsage).toEqual([]);
  });
});
