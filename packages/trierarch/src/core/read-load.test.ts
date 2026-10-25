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
