import { describe, expect, it } from 'vitest';

import { aMachineLoad, aTrierarch, CollectingLogger, InMemoryFleet, InMemoryMachine, InMemoryState, TestClock } from '../../test/support/in-memory.js';
import { createReadLoad } from './read-load.js';

const GIB = 1024 ** 3;
const MINUTE_MS = 60_000;

/** 4 of 64 GiB available: 6.25 %, below the 10 % floor. */
const LOW_MEMORY = aMachineLoad({ memory: { totalBytes: 64 * GIB, availableBytes: 4 * GIB } });

/** 20 of 1000 GB free: 2 %, below the 5 % floor. */
const LOW_DISK = aMachineLoad({ disk: { totalBytes: 1_000_000_000_000, freeBytes: 20_000_000_000 } });

describe("the machine's load, as the trierarch reads it (#400)", () => {
  it('answers the load the machine has', async () => {
    const trierarch = aTrierarch();

    expect(await trierarch.readLoad()).toEqual(aMachineLoad());
  });

  it('reads the machine again only once a minute has passed', async () => {
    const trierarch = aTrierarch();
    await trierarch.readLoad();
    trierarch.machine.current = LOW_DISK;

    trierarch.clock.advance(MINUTE_MS - 1);
    const within = await trierarch.readLoad();
    trierarch.clock.advance(1);
    const after = await trierarch.readLoad();

    expect([within, after]).toEqual([aMachineLoad(), LOW_DISK]);
  });

  it('keeps the last load it read when the machine cannot be read, and says why in its log', async () => {
    const trierarch = aTrierarch();
    await trierarch.readLoad();
    trierarch.machine.isFailing = true;
    trierarch.clock.advance(MINUTE_MS);

    expect(await trierarch.readLoad()).toEqual(aMachineLoad());
    expect(trierarch.logger.warnings).toEqual(['Could not read the machine load: statfs failed']);
  });

  it('tells argo once when the machine is low on memory, however long it stays low', async () => {
    const trierarch = aTrierarch();
    trierarch.machine.current = LOW_MEMORY;

    await trierarch.readLoad();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.readLoad();

    expect(trierarch.fleet.toArgo.map((report) => report.text.split('\n')[0])).toEqual(['Low on memory: 6 % available']);
  });

  it('tells argo what memory and disk the machine has left, and that no session is stopped for it', async () => {
    const trierarch = aTrierarch();
    trierarch.machine.current = LOW_MEMORY;

    await trierarch.readLoad();

    expect(trierarch.fleet.toArgo[0]?.text).toBe(
      ['Low on memory: 6 % available', '', '- Memory: 4.0 of 64.0 GiB available', '- Disk: 500.0 of 1000.0 GB free', '', 'The trierarch stops no session for it.'].join('\n'),
    );
  });

  it('tells argo when the machine is low on disk', async () => {
    const trierarch = aTrierarch();
    trierarch.machine.current = LOW_DISK;

    await trierarch.readLoad();

    expect(trierarch.fleet.toArgo.map((report) => report.text.split('\n')[0])).toEqual(['Low on disk: 2 % free']);
  });

  it('keeps a failing pass and the missing plugins in the state when it saves what the machine is low on (#1212)', async () => {
    const trierarch = aTrierarch();
    const failing = { reason: 'the fleet cannot be reached', since: '2026-10-06T08:00:00.000Z' };
    await trierarch.state.save({ ...trierarch.state.current(), passFailure: failing, missingPlugins: ['codex'] });
    trierarch.machine.current = LOW_MEMORY;

    await trierarch.readLoad();

    expect(trierarch.state.current()).toMatchObject({ lowResources: ['memory'], passFailure: failing, missingPlugins: ['codex'] });
  });

  it('tells argo again only after the machine recovered and dropped again', async () => {
    const trierarch = aTrierarch();
    trierarch.machine.current = LOW_MEMORY;
    await trierarch.readLoad();
    trierarch.clock.advance(MINUTE_MS);
    trierarch.machine.current = aMachineLoad();
    await trierarch.readLoad();

    trierarch.clock.advance(MINUTE_MS);
    trierarch.machine.current = LOW_MEMORY;
    await trierarch.readLoad();

    expect(trierarch.fleet.toArgo).toHaveLength(2);
  });

  it('does not tell argo again after the trierarch restarts while the machine stays low', async () => {
    const state = new InMemoryState();
    const fleet = new InMemoryFleet();
    const machine = new InMemoryMachine();
    machine.current = LOW_MEMORY;
    await createReadLoad({ machine, fleet, state, clock: new TestClock(), logger: new CollectingLogger() })();

    await createReadLoad({ machine, fleet, state, clock: new TestClock(), logger: new CollectingLogger() })();

    expect(fleet.toArgo).toHaveLength(1);
  });
});

/** Managed leftovers are stored separately from the disk reading. */
function diskTrierarch(at: { hasRecovered?: boolean; isFailing?: boolean } = {}) {
  const machine = new InMemoryMachine();
  machine.current = LOW_DISK;
  const fleet = new InMemoryFleet();
  const state = new InMemoryState();
  const clock = new TestClock();
  const logger = new CollectingLogger();
  const leftovers = { trash: ['discarded-worktree'], images: ['old-session-image'] };
  const ranking: { ships: readonly { name: string; bytes: number }[] | undefined } = { ships: [{ name: 'large-ship', bytes: 900 }, { name: 'small-ship', bytes: 100 }] };
  const read = createReadLoad({ machine, fleet, state, clock, logger, disk: {
    removeUnusedImages: () => { leftovers.images = []; return Promise.resolve(); },
    free: () => {
      if (at.isFailing === true) return Promise.reject(new Error('cannot clean'));
      leftovers.trash = [];
      leftovers.images = [];
      if (at.hasRecovered === true) machine.current = aMachineLoad();
      return Promise.resolve();
    },
    largestShips: () => ranking.ships,
  } });
  return { read, machine, fleet, state, clock, logger, leftovers, ranking };
}

describe('low disk cleanup before telling argo (#352)', () => {
  it('returns the recovered load when freeing disk reaches 5 percent', async () => {
    const trierarch = diskTrierarch({ hasRecovered: true });
    expect(await trierarch.read()).toEqual(aMachineLoad());
  });

  it('tells nobody when freeing disk recovers the machine', async () => {
    const trierarch = diskTrierarch({ hasRecovered: true });
    await trierarch.read();
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('clears the stored low disk state after cleanup recovers the machine', async () => {
    const trierarch = diskTrierarch({ hasRecovered: true });
    await trierarch.state.save({ ...trierarch.state.current(), lowResources: ['disk'] });
    await trierarch.read();
    expect(trierarch.state.current().lowResources).toBeUndefined();
  });

  it('names the ships holding the most when the disk is still low after freeing', async () => {
    const trierarch = diskTrierarch();
    await trierarch.read();
    expect(trierarch.fleet.toArgo[0]?.text).toContain('Ships holding the most:\n- large-ship: 900 bytes\n- small-ship: 100 bytes');
  });

  it('stores the remaining low disk condition', async () => {
    const trierarch = diskTrierarch();
    await trierarch.read();
    expect(trierarch.state.current().lowResources).toEqual(['disk']);
  });

  it('tells argo only once while the disk remains low', async () => {
    const trierarch = diskTrierarch();
    await trierarch.read();
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.read();
    expect(trierarch.fleet.toArgo).toHaveLength(1);
  });

  it('reclaims new trash while the disk remains low', async () => {
    const trierarch = diskTrierarch();
    await trierarch.read();
    trierarch.leftovers.trash.push('another-discarded-worktree');
    trierarch.clock.advance(MINUTE_MS);
    await trierarch.read();
    expect(trierarch.leftovers.trash).toEqual([]);
  });

  it('still tells argo when cleanup fails and the disk remains low', async () => {
    const trierarch = diskTrierarch({ isFailing: true });
    await trierarch.read();
    expect(trierarch.fleet.toArgo[0]?.text).toContain('Low on disk: 2 % free');
  });

  it('logs why disk cleanup failed', async () => {
    const trierarch = diskTrierarch({ isFailing: true });
    await trierarch.read();
    expect(trierarch.logger.warnings).toContain('Could not free disk: cannot clean');
  });

  it('tells again after recovery and another drop', async () => {
    const trierarch = diskTrierarch();
    await trierarch.read();
    trierarch.clock.advance(MINUTE_MS);
    trierarch.machine.current = aMachineLoad();
    await trierarch.read();
    trierarch.clock.advance(MINUTE_MS);
    trierarch.machine.current = LOW_DISK;
    await trierarch.read();
    expect(trierarch.fleet.toArgo).toHaveLength(2);
  });

  it('leaves trash alone at exactly 5 percent free', async () => {
    const trierarch = diskTrierarch();
    trierarch.machine.current = aMachineLoad({ disk: { totalBytes: 100, freeBytes: 5 } });
    await trierarch.read();
    expect(trierarch.leftovers.trash).toEqual(['discarded-worktree']);
  });

  it('tells nobody at exactly 5 percent free', async () => {
    const trierarch = diskTrierarch();
    trierarch.machine.current = aMachineLoad({ disk: { totalBytes: 100, freeBytes: 5 } });
    await trierarch.read();
    expect(trierarch.fleet.toArgo).toEqual([]);
  });
});

it('removes unused session images on the first pass even with healthy disk', async () => {
  const trierarch = diskTrierarch();
  trierarch.machine.current = aMachineLoad();
  await trierarch.read();
  expect(trierarch.leftovers.images).toEqual([]);
});

it('keeps image maintenance to the first healthy pass', async () => {
  const trierarch = diskTrierarch();
  trierarch.machine.current = aMachineLoad();
  await trierarch.read();
  trierarch.leftovers.images.push('new-unused-image');
  trierarch.clock.advance(MINUTE_MS);
  await trierarch.read();
  expect(trierarch.leftovers.images).toEqual(['new-unused-image']);
});

it('reclaims unused images along with trash on low disk', async () => {
  const trierarch = diskTrierarch();
  await trierarch.read();
  expect(trierarch.leftovers).toEqual({ images: [], trash: [] });
});


describe('low disk while background ship measurements are pending', () => {
  it('returns the load without waiting for a ranking', async () => {
    const trierarch = diskTrierarch();
    trierarch.ranking.ships = undefined;
    expect(await trierarch.read()).toEqual(LOW_DISK);
  });

  it('keeps the disk notification pending until ship measurements are ready', async () => {
    const trierarch = diskTrierarch();
    trierarch.ranking.ships = undefined;
    await trierarch.read();
    expect(trierarch.fleet.toArgo).toEqual([]);
  });

  it('does not store an unsent disk notification as told', async () => {
    const trierarch = diskTrierarch();
    trierarch.ranking.ships = undefined;
    await trierarch.read();
    expect(trierarch.state.current().lowResources).toBeUndefined();
  });

  it('sends the completed ranking on the next pass within the load read interval', async () => {
    const trierarch = diskTrierarch();
    const completed = trierarch.ranking.ships;
    trierarch.ranking.ships = undefined;
    await trierarch.read();
    trierarch.ranking.ships = completed;
    trierarch.clock.advance(5000);
    await trierarch.read();
    expect(trierarch.fleet.toArgo[0]?.text).toContain('Ships holding the most:\n- large-ship: 900 bytes\n- small-ship: 100 bytes');
  });

  it('stores the disk notification after the completed ranking is sent', async () => {
    const trierarch = diskTrierarch();
    const completed = trierarch.ranking.ships;
    trierarch.ranking.ships = undefined;
    await trierarch.read();
    trierarch.ranking.ships = completed;
    await trierarch.read();
    expect(trierarch.state.current().lowResources).toEqual(['disk']);
  });
});
