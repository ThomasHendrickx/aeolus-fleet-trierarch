import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Entry } from '../core/entry.js';
import { CollectingLogger, newId, TestClock } from '../../test/support/in-memory.js';
import { createLargestShips } from './largest-ships.js';
import { shipPodmanRuntime, trierarchPaths } from './paths.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'largest-ships-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function data(folder: string, bytes: number): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'data'), Buffer.alloc(bytes));
}

async function aShip(name: string, bytes: number): Promise<Pick<Entry, 'shipId' | 'shipName' | 'shipFolder' | 'folder'>> {
  const shipId = newId('ship');
  const shipFolder = join(root, 'ships', shipId);
  await data(shipFolder, bytes);
  return { shipId, shipName: name, shipFolder };
}

function ranking(at: { measureFolder?: (folder: string) => Promise<number> } = {}) {
  return createLargestShips({ clock: new TestClock(), logger: new CollectingLogger(), paths: trierarchPaths({ homeDirectory: root }), ...at });
}

describe('ships holding the most disk', () => {
  it('names the largest ships first without following links into host files', async () => {
    const small = await aShip('small', 10);
    const large = await aShip('large', 100);
    const host = join(root, 'host');
    await data(host, 1000);
    await symlink(host, join(small.shipFolder ?? '', 'host'));
    const largest = ranking();
    largest.refresh([small, large]);
    await Promise.all([largest.measure(small), largest.measure(large)]);
    expect(largest.read()).toEqual([{ name: 'large', bytes: 100 }, { name: 'small', bytes: 10 }]);
  });

  it('names exactly the five ships holding the most when there are six', async () => {
    const ships = await Promise.all(['one', 'two', 'three', 'four', 'five', 'six'].map((name, index) => aShip(name, index + 1)));
    const largest = ranking();
    largest.refresh(ships);
    await Promise.all(ships.map((ship) => largest.measure(ship)));
    expect(largest.read()).toEqual([{ name: 'six', bytes: 6 }, { name: 'five', bytes: 5 }, { name: 'four', bytes: 4 }, { name: 'three', bytes: 3 }, { name: 'two', bytes: 2 }]);
  });

  it('returns no ranking while the first background measurement is pending', async () => {
    const ship = await aShip('scout', 10);
    let finish: ((bytes: number) => void) | undefined;
    const largest = ranking({ measureFolder: () => new Promise<number>((resolve) => { finish = resolve; }) });
    largest.refresh([ship]);
    const pending = largest.measure(ship);
    expect(largest.read()).toBeUndefined();
    await expect.poll(() => finish).toBeTypeOf('function');
    finish?.(10);
    await pending;
  });

  it('keeps completed readings until ten minutes have passed', async () => {
    const ship = await aShip('scout', 10);
    const clock = new TestClock();
    const largest = createLargestShips({ clock, logger: new CollectingLogger(), paths: trierarchPaths({ homeDirectory: root }) });
    largest.refresh([ship]);
    await largest.measure(ship);
    await data(ship.shipFolder ?? '', 20);
    clock.advance(599_999);
    await largest.measure(ship);
    expect(largest.read()).toEqual([{ name: 'scout', bytes: 10 }]);
  });

  it('refreshes a ship at exactly ten minutes', async () => {
    const ship = await aShip('scout', 10);
    const clock = new TestClock();
    const largest = createLargestShips({ clock, logger: new CollectingLogger(), paths: trierarchPaths({ homeDirectory: root }) });
    largest.refresh([ship]);
    await largest.measure(ship);
    await data(ship.shipFolder ?? '', 20);
    clock.advance(600_000);
    await largest.measure(ship);
    expect(largest.read()).toEqual([{ name: 'scout', bytes: 20 }]);
  });

  it('uses completed readings while a refreshed measurement waits outside the pass', async () => {
    const ship = await aShip('scout', 10);
    const clock = new TestClock();
    let finish: ((bytes: number) => void) | undefined;
    let isSlow = false;
    const largest = createLargestShips({ clock, logger: new CollectingLogger(), paths: trierarchPaths({ homeDirectory: root }), measureFolder: () => isSlow ? new Promise<number>((resolve) => { finish = resolve; }) : Promise.resolve(10) });
    largest.refresh([ship]);
    await largest.measure(ship);
    clock.advance(600_000);
    isSlow = true;
    largest.refresh([ship]);
    const pending = largest.measure(ship);
    expect(largest.read()).toEqual([{ name: 'scout', bytes: 10 }]);
    await expect.poll(() => finish).toBeTypeOf('function');
    finish?.(20);
    await pending;
  });

  it('shares a pending measurement with size warnings instead of scanning twice', async () => {
    const ship = await aShip('scout', 10);
    let finish: ((bytes: number) => void) | undefined;
    const largest = ranking({ measureFolder: () => new Promise<number>((resolve) => { finish = resolve; }) });
    largest.refresh([ship]);
    const warning = largest.measure(ship);
    const report = largest.measure(ship);
    await expect.poll(() => finish).toBeTypeOf('function');
    finish?.(42);
    expect(await Promise.all([warning, report])).toEqual([42, 42]);
  });

  it('counts legacy workspaces, container homes, sockets, scratch and hold files', async () => {
    const paths = trierarchPaths({ homeDirectory: root });
    const shipId = newId('ship');
    const ship = { shipId, shipName: 'legacy', folder: join(root, 'worktree') };
    await data(ship.folder, 10);
    await data(join(paths.homes, shipId, '.local/share/containers'), 1000);
    await data(join(paths.homes, shipId, '.cache'), 100);
    await data(join(paths.sockets, shipId), 20);
    await data(join(paths.ships, shipId, 'tmp'), 30);
    await data(join(paths.sessions, shipId), 40);
    const largest = ranking();
    largest.refresh([ship]);
    await largest.measure(ship);
    expect(largest.read()).toEqual([{ name: 'legacy', bytes: 1200 }]);
  });

  it('counts current ship folders, separate hold files and Podman runtime without counting nested parts twice', async () => {
    const paths = trierarchPaths({ homeDirectory: root });
    const ship = await aShip('current', 10);
    const runtimeDirectory = join(root, 'runtime');
    await data(join(ship.shipFolder ?? '', 'home/.cache'), 100);
    await data(join(ship.shipFolder ?? '', 'containers/graph'), 1000);
    await data(join(ship.shipFolder ?? '', 'repositories/main'), 20);
    await data(join(ship.shipFolder ?? '', 'tmp'), 30);
    await data(join(paths.sessions, ship.shipId), 40);
    await data(shipPodmanRuntime(runtimeDirectory, ship.shipId), 50);
    const largest = createLargestShips({ clock: new TestClock(), logger: new CollectingLogger(), paths, runtimeDirectory });
    const current = { ...ship, folder: join(ship.shipFolder ?? '', 'repositories') };
    largest.refresh([current]);
    await largest.measure(current);
    expect(largest.read()).toEqual([{ name: 'current', bytes: 1250 }]);
  });

  it('ranks a legacy ship whose home outweighs a larger workspace first', async () => {
    const paths = trierarchPaths({ homeDirectory: root });
    const small = await aShip('workspace-heavy', 100);
    const shipId = newId('ship');
    const legacy = { shipId, shipName: 'home-heavy', folder: join(root, 'legacy') };
    await data(legacy.folder, 10);
    await data(join(paths.homes, shipId), 1000);
    const largest = ranking();
    largest.refresh([small, legacy]);
    await Promise.all([largest.measure(small), largest.measure(legacy)]);
    expect(largest.read()).toEqual([{ name: 'home-heavy', bytes: 1010 }, { name: 'workspace-heavy', bytes: 100 }]);
  });

  it('omits a ship with no known name instead of exposing its id', async () => {
    const ship = await aShip('scout', 10);
    const unnamed = { shipId: ship.shipId, ...(ship.shipFolder !== undefined && { shipFolder: ship.shipFolder }) };
    const largest = ranking();
    largest.refresh([unnamed]);
    await largest.measure(unnamed);
    expect(largest.read()).toEqual([]);
  });

  it('drops a departed ship from the ranking', async () => {
    const ship = await aShip('scout', 10);
    const largest = ranking();
    largest.refresh([ship]);
    await largest.measure(ship);
    largest.refresh([]);
    expect(largest.read()).toEqual([]);
  });

  it('discards the old reading when the ship folder is replaced', async () => {
    const ship = await aShip('scout', 10);
    const other = await aShip('other', 100);
    const largest = ranking();
    largest.refresh([ship]);
    await largest.measure(ship);
    const replaced = { ...ship, shipFolder: other.shipFolder };
    largest.refresh([replaced]);
    await largest.measure(replaced);
    expect(largest.read()).toEqual([{ name: 'scout', bytes: 100 }]);
  });

  it('still names measurable ships when another measurement fails', async () => {
    const present = await aShip('present', 10);
    const broken = await aShip('broken', 100);
    const largest = ranking({ measureFolder: (folder) => folder === broken.shipFolder ? Promise.reject(new Error('cannot read')) : Promise.resolve(10) });
    largest.refresh([broken, present]);
    await largest.measure(broken).catch(() => undefined);
    await largest.measure(present);
    expect(largest.read()).toEqual([{ name: 'present', bytes: 10 }]);
  });
});


it('waits ten minutes after a failed measurement before trying the ship again', async () => {
  const ship = await aShip('scout', 10);
  const clock = new TestClock();
  let isFailing = true;
  const largest = createLargestShips({ clock, logger: new CollectingLogger(), paths: trierarchPaths({ homeDirectory: root }), measureFolder: () => isFailing ? Promise.reject(new Error('unreadable')) : Promise.resolve(10) });
  largest.refresh([ship]);
  await expect(largest.measure(ship)).rejects.toThrow('unreadable');
  isFailing = false;
  clock.advance(599_999);
  await expect(largest.measure(ship)).rejects.toThrow('unreadable');
  clock.advance(1);
  expect(await largest.measure(ship)).toBe(10);
});
