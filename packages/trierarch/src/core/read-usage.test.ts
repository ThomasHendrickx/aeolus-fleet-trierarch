import { describe, expect, it } from 'vitest';

import { aTrierarch, newId, WORKTREE_ROOT, type Trierarch } from '../../test/support/in-memory.js';
import { putEntry, type Entry } from './entry.js';

const MINUTE_MS = 60_000;

/** An entry crewing the ship in its worktree, its session running. */
function aCrewedEntry(at: { isWorkspaceMade?: boolean } = {}): Entry {
  const shipId = newId('ship');
  return {
    shipId,
    shipName: 'scout',
    harness: 'claude-code',
    workspace: { kind: 'worktree', repository: 'aeolus-fleet' },
    options: {},
    settingsVersion: 1,
    state: 'running',
    since: '2026-10-06T07:00:00.000Z',
    exits: [],
    hasStarted: true,
    ...(at.isWorkspaceMade !== false && { folder: `${WORKTREE_ROOT}/aeolus-fleet/scout` }),
  };
}

async function withEntries(trierarch: Trierarch, ...entries: readonly Entry[]): Promise<void> {
  await trierarch.state.save(entries.reduce(putEntry, await trierarch.state.load()));
}

const OPUS_TOKENS = { model: 'claude-opus-5-5', tokens: { input: 1200, output: 45_000, cacheRead: 9_800_000, cacheWrite: 410_000 } };

const FIVE_HOURS = { windowMinutes: 300, usedPercent: 3, resetsAt: new Date('2026-10-06T12:00:00.000Z') };
const SEVEN_DAYS = { windowMinutes: 10_080, usedPercent: 68, resetsAt: new Date('2026-10-09T08:00:00.000Z') };

describe("the harnesses' usage, as the trierarch reads it (#353)", () => {
  it("answers each crewed ship's tokens per model, with their cost estimated from the price table, and none for a model it does not price", async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS, { model: 'claude-mystery-1', tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } }]);

    const usage = await trierarch.readUsage();

    expect(usage.ships).toEqual([
      {
        shipId: entry.shipId,
        models: [
          { ...OPUS_TOKENS, estimatedCostUsd: 6.14 },
          { model: 'claude-mystery-1', tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, estimatedCostUsd: null },
        ],
      },
    ]);
  });

  it('leaves out a ship whose workspace is not made yet, and one that used no tokens', async () => {
    const trierarch = aTrierarch();
    const unmade = aCrewedEntry({ isWorkspaceMade: false });
    const idle = aCrewedEntry();
    await withEntries(trierarch, unmade, idle);
    trierarch.usage.tokens.set(unmade.shipId, [OPUS_TOKENS]);

    expect((await trierarch.readUsage()).ships).toEqual([]);
  });

  it("leaves out a ship whose transcripts cannot be read, and says why in its log", async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.unreadable.add(entry.shipId);

    expect((await trierarch.readUsage()).ships).toEqual([]);
    expect(trierarch.logger.warnings).toEqual([`Could not read the usage of ${entry.shipId}: EACCES`]);
  });

  it('reads the tokens again only once 5 minutes have passed', async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    await trierarch.readUsage();
    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);

    trierarch.clock.advance(5 * MINUTE_MS - 1);
    const within = await trierarch.readUsage();
    trierarch.clock.advance(1);
    const after = await trierarch.readUsage();

    expect([within.ships.length, after.ships.length]).toEqual([0, 1]);
  });

  it("answers each harness's subscription windows as it read them, and when", async () => {
    const trierarch = aTrierarch();
    trierarch.usage.subscriptions.set('claude-code', [FIVE_HOURS, SEVEN_DAYS]);

    expect((await trierarch.readUsage()).subscriptions).toEqual([
      {
        harness: 'claude-code',
        readAt: '2026-10-06T08:00:00.000Z',
        windows: [
          { windowMinutes: 300, usedPercent: 3, resetsAt: '2026-10-06T12:00:00.000Z' },
          { windowMinutes: 10_080, usedPercent: 68, resetsAt: '2026-10-09T08:00:00.000Z' },
        ],
      },
    ]);
  });

  it('leaves out a harness that cannot say how much of its subscription is used', async () => {
    const trierarch = aTrierarch();

    expect((await trierarch.readUsage()).subscriptions).toEqual([]);
  });

  it("reads a harness's subscription again only after 30 minutes and once its sessions did work since", async () => {
    const trierarch = aTrierarch();
    const entry = aCrewedEntry();
    await withEntries(trierarch, entry);
    trierarch.usage.subscriptions.set('claude-code', [FIVE_HOURS]);
    await trierarch.readUsage();
    trierarch.usage.subscriptions.set('claude-code', [{ ...FIVE_HOURS, usedPercent: 40 }]);

    trierarch.usage.tokens.set(entry.shipId, [OPUS_TOKENS]);
    trierarch.clock.advance(30 * MINUTE_MS - 1);
    const withinWithWork = await trierarch.readUsage();
    trierarch.clock.advance(1);
    const afterWithWork = await trierarch.readUsage();

    expect([withinWithWork, afterWithWork].map((usage) => usage.subscriptions[0]?.windows[0]?.usedPercent)).toEqual([3, 40]);
  });

  it("does not read a harness's subscription again while its sessions did no work, however long", async () => {
    const trierarch = aTrierarch();
    await withEntries(trierarch, aCrewedEntry());
    trierarch.usage.subscriptions.set('claude-code', [FIVE_HOURS]);
    await trierarch.readUsage();
    trierarch.usage.subscriptions.set('claude-code', [{ ...FIVE_HOURS, usedPercent: 40 }]);

    trierarch.clock.advance(3 * 60 * MINUTE_MS);

    expect((await trierarch.readUsage()).subscriptions[0]?.windows[0]?.usedPercent).toBe(3);
  });

  it('splits each model\'s tokens per login, each counted to the login of the session that used them, with its own cost (api keys K8)', async () => {
    const trierarch = aTrierarch();
    const entry: Entry = { ...aCrewedEntry(), login: 'apiKey', earlierLogins: [{ login: 'subscription', until: '2026-10-06T07:30:00.000Z' }] };
    await withEntries(trierarch, entry);
    trierarch.usage.written.set(entry.shipId, [
      { ...OPUS_TOKENS, at: new Date('2026-10-06T07:10:00.000Z') },
      { ...OPUS_TOKENS, at: new Date('2026-10-06T07:40:00.000Z') },
      { ...OPUS_TOKENS, at: new Date('2026-10-06T07:50:00.000Z') },
    ]);

    const usage = await trierarch.readUsage();

    expect(usage.ships).toEqual([
      {
        shipId: entry.shipId,
        models: [
          { model: 'claude-opus-5-5', login: 'apiKey', tokens: { input: 2400, output: 90_000, cacheRead: 19_600_000, cacheWrite: 820_000 }, estimatedCostUsd: 12.28 },
          { ...OPUS_TOKENS, login: 'subscription', estimatedCostUsd: 6.14 },
        ],
      },
    ]);
  });
});
