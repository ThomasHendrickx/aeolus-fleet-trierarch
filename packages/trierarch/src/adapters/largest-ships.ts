import type { Logger } from '../core/ports.js';
import type { Clock } from '../core/shared/clock.js';
import { SHIP_SIZE_INTERVAL_MS } from '../core/ship-size.js';
import { measureShipFolder } from './ship-size.js';

/** Low disk reports reuse readings for ten minutes, independent of the optional ship size warning. */
export function createLargestShips(deps: { clock: Clock; logger: Pick<Logger, 'warn'> }): (ships: readonly { name: string; folder: string }[]) => Promise<readonly { name: string; bytes: number }[]> {
  const readings = new Map<string, { at: number; bytes: number }>();
  return async (ships) => {
    const folders = new Set(ships.map((ship) => ship.folder));
    for (const folder of readings.keys()) if (!folders.has(folder)) readings.delete(folder);
    const held = await Promise.all(ships.map(async (ship) => {
      try {
        const previous = readings.get(ship.folder);
        const now = deps.clock.now().getTime();
        const reading = previous !== undefined && now - previous.at < SHIP_SIZE_INTERVAL_MS ? previous : { at: now, bytes: await measureShipFolder(ship.folder) };
        readings.set(ship.folder, reading);
        return [{ name: ship.name, bytes: reading.bytes }];
      } catch (error) {
        deps.logger.warn(`Could not measure ${ship.name} for low disk: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    }));
    return held.flat().sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  };
}
