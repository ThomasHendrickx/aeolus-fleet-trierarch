import { describe, expect, it } from 'vitest';

import { CollectingLogger, inRepositories, newId, TestClock } from '../../test/support/in-memory.js';
import { EMPTY_STATE, putEntry, type Entry } from './entry.js';
import { createShipSize } from './ship-size.js';

const INTERVAL = 600_000;
function aShip(): Entry {
  return { shipId: newId('ship'), shipName: 'scout', shipFolder: '/ships/scout', harness: 'codex', workspace: inRepositories('main'), options: {}, settingsVersion: 1, state: 'running', since: '2026-10-06T07:00:00.000Z', exits: [], hasStarted: true };
}

function setup(limit: number | undefined) {
  const clock = new TestClock();
  const logger = new CollectingLogger();
  const reports: string[] = [];
  let size = 101;
  let reads = 0;
  const ship = aShip();
  let state = putEntry(EMPTY_STATE, ship);
  const check = createShipSize({ limit, clock, logger, measure: () => { reads += 1; return Promise.resolve(size); }, tell: (entry, bytes) => { reports.push(`${entry.shipName}: ${String(bytes)}`); return Promise.resolve(); } });
  const pass = async () => { state = await check(state); await Promise.resolve(); };
  return { clock, reports, ship, pass, reads: () => reads, setSize: (value: number) => { size = value; }, state: () => state };
}

describe('ship folder size', () => {
  it('tells the owner once per crossing, again only after it was below', async () => {
    const test = setup(100);
    await test.pass(); await test.pass();
    test.clock.advance(INTERVAL); await test.pass(); await test.pass();
    test.setSize(100); test.clock.advance(INTERVAL); await test.pass(); await test.pass();
    test.setSize(99); test.clock.advance(INTERVAL); await test.pass(); await test.pass();
    test.setSize(101); test.clock.advance(INTERVAL); await test.pass(); await test.pass();
    expect(test.reports).toEqual(['scout: 101', 'scout: 101']);
  });

  it('does not measure more often than ten minutes', async () => {
    const test = setup(100);
    await test.pass(); await test.pass();
    test.clock.advance(INTERVAL - 1); await test.pass();
    expect(test.reads()).toBe(1);
    test.clock.advance(1); await test.pass();
    expect(test.reads()).toBe(2);
  });

  it('does not warn or measure when no size is configured', async () => {
    const test = setup(undefined);
    await test.pass(); await test.pass();
    expect([test.reads(), test.reports]).toEqual([0, []]);
  });

  it('keeps the crossing over a restart', async () => {
    const test = setup(100);
    await test.pass(); await test.pass();
    expect(test.state().entries[test.ship.shipId]?.isShipSizeTold).toBe(true);
  });

  it('retries a lost report using the same crossing key after restart', async () => {
    const ship = aShip();
    const clock = new TestClock();
    const logger = new CollectingLogger();
    const keys: string[] = [];
    const measure = () => Promise.resolve(101);
    const tell = (_entry: Entry, _bytes: number, key: string) => {
      keys.push(key);
      return keys.length === 1 ? Promise.reject(new Error('lost reply')) : Promise.resolve();
    };
    let state = putEntry(EMPTY_STATE, ship);
    const first = createShipSize({ limit: 100, clock, logger, measure, tell });
    state = await first(state); await Promise.resolve();
    state = await first(state); await Promise.resolve();
    state = await first(state);
    const second = createShipSize({ limit: 100, clock, logger, measure, tell });
    state = await second(state);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^ship-size:/);
    expect(keys[0]).toBe(keys[1]);
    expect(state.entries[ship.shipId]?.isShipSizeTold).toBe(true);
  });

  it('does not wait for a slow measurement', async () => {
    const ship = aShip();
    const check = createShipSize({ limit: 100, clock: new TestClock(), logger: new CollectingLogger(), measure: () => new Promise<number>(() => undefined), tell: () => Promise.resolve() });
    const state = putEntry(EMPTY_STATE, ship);
    expect(await check(state)).toEqual(state);
  });
});
