import { lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';

import type { Entry } from '../core/entry.js';
import type { Logger } from '../core/ports.js';
import type { Clock } from '../core/shared/clock.js';
import { SHIP_SIZE_INTERVAL_MS } from '../core/ship-size.js';
import { shipHome, shipPodmanRuntime, shipSockets, type TrierarchPaths } from './paths.js';
import { measureShipFolder } from './ship-size.js';

/** The low disk alert names the five ships holding the most. */
const LARGEST_SHIPS_LIMIT = 5;

type Ship = Pick<Entry, 'shipId' | 'shipName' | 'shipFolder' | 'folder'>;
interface Size { readonly name: string; readonly bytes: number }
interface Reading {
  readonly folders: string;
  readonly at: number;
  pending?: Promise<number> | undefined;
  bytes?: number;
  error?: Error;
}

/**
 * Refresh starts background measurements; read only uses completed readings.
 * Rankings and configured size warnings share a scan, including failed
 * attempts, at most every ten minutes per ship and set of folders.
 */
export function createLargestShips(deps: {
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
  paths: Pick<TrierarchPaths, 'ships' | 'homes' | 'sockets' | 'sessions'>;
  runtimeDirectory?: string;
  measureFolder?: (folder: string) => Promise<number>;
}): { refresh(ships: readonly Ship[]): void; read(): readonly Size[] | undefined; measure(ship: Ship): Promise<number> } {
  const readings = new Map<ShipId, Reading>();
  let ships: readonly Ship[] = [];
  const foldersOf = (ship: Ship): readonly string[] => {
    const folders = [...new Set([
      ship.shipFolder ?? join(deps.paths.ships, ship.shipId),
      ...(ship.folder === undefined ? [] : [ship.folder]),
      shipHome(deps.paths.homes, ship),
      shipSockets(deps.paths.sockets, ship),
      join(deps.paths.sessions, ship.shipId),
      ...(deps.runtimeDirectory === undefined ? [] : [shipPodmanRuntime(deps.runtimeDirectory, ship.shipId)]),
    ].map((folder) => resolve(folder)))];
    // A current ship's home, scratch and container storage are already inside its ship folder.
    return folders.filter((folder) => !folders.some((parent) => parent !== folder && folder.startsWith(parent + sep)));
  };
  const measure = (ship: Ship): Promise<number> => {
    const folders = foldersOf(ship);
    const key = JSON.stringify(folders);
    const previous = readings.get(ship.shipId);
    const now = deps.clock.now().getTime();
    if (previous?.folders === key) {
      if (previous.pending !== undefined) return previous.pending;
      if (now - previous.at < SHIP_SIZE_INTERVAL_MS) {
        return previous.bytes === undefined ? Promise.reject(previous.error ?? new Error('No ship size reading')) : Promise.resolve(previous.bytes);
      }
    }
    const reading: Reading = { folders: key, at: now, ...(previous?.folders === key && previous.bytes !== undefined && { bytes: previous.bytes }) };
    readings.set(ship.shipId, reading);
    reading.pending = Promise.all(folders.map(async (folder) => {
      const stat = await lstat(folder).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      // Legacy homes and runtime directories need not exist. Never follow a linked root into host files.
      return stat?.isDirectory() === true ? (deps.measureFolder ?? measureShipFolder)(folder) : 0;
    })).then((sizes) => {
      const bytes = sizes.reduce((sum, size) => sum + size, 0);
      reading.bytes = bytes;
      return bytes;
    }).catch((error: unknown) => {
      reading.error = error instanceof Error ? error : new Error(String(error));
      throw error;
    }).finally(() => { reading.pending = undefined; });
    return reading.pending;
  };
  return {
    measure,
    refresh: (current) => {
      ships = current;
      const held = new Set(current.map((ship) => ship.shipId));
      for (const id of readings.keys()) if (!held.has(id)) readings.delete(id);
      for (const ship of current) {
        void measure(ship).catch((error: unknown) => {
          deps.logger.warn(`Could not measure ${ship.shipName ?? 'a ship'} for low disk: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    },
    read: () => {
      const named = ships.filter((ship) => ship.shipName !== undefined);
      if (named.some((ship) => {
        const reading = readings.get(ship.shipId);
        return reading?.bytes === undefined && reading?.pending !== undefined;
      })) return undefined;
      return named.flatMap((ship) => {
        const bytes = readings.get(ship.shipId)?.bytes;
        return ship.shipName === undefined || bytes === undefined ? [] : [{ name: ship.shipName, bytes }];
      }).sort((a, b) => b.bytes - a.bytes).slice(0, LARGEST_SHIPS_LIMIT);
    },
  };
}
