import type { Entry, TrierarchState } from './entry.js';
import { putEntry } from './entry.js';
import type { Logger } from './ports.js';
import type { Clock } from './shared/clock.js';

/** A ship's folder is measured at most once every ten minutes. */
export const SHIP_SIZE_INTERVAL_MS = 600_000;

/** Measurements run outside the pass; completed readings are applied by the next pass. */
export function createShipSize(deps: { limit: number | undefined; clock: Clock; logger: Pick<Logger, 'warn'>; measure: (entry: Entry) => Promise<number>; tell: (entry: Entry, report: { bytes: number; key: string }) => Promise<void> }): (state: TrierarchState) => Promise<TrierarchState> {
  const pending = new Set<string>();
  const readings = new Map<string, { folder: string; bytes: number }>();
  return async (state) => {
    if (deps.limit === undefined) { return state; }
    let next = state;
    for (const entry of Object.values(next.entries)) {
      if (entry.shipSizePending === undefined) { continue; }
      try {
        await deps.tell(entry, entry.shipSizePending);
        next = putEntry(next, { ...entry, isShipSizeTold: true, shipSizePending: undefined });
      } catch (error) {
        deps.logger.warn(`Could not tell the owner the size of ${entry.shipId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [id, reading] of readings) {
      const entry = next.entries[id];
      if (entry?.shipFolder !== reading.folder) { readings.delete(id); continue; }
      if (reading.bytes > deps.limit && entry.isShipSizeTold !== true && entry.shipSizePending === undefined) {
        const key = `ship-size:${id}:${deps.clock.now().toISOString()}`;
        next = putEntry(next, { ...entry, shipSizePending: { key, bytes: reading.bytes } });
      } else if (reading.bytes < deps.limit && entry.isShipSizeTold === true) {
        next = putEntry(next, { ...entry, isShipSizeTold: undefined });
      }
      readings.delete(id);
    }
    const now = deps.clock.now().getTime();
    for (const entry of Object.values(next.entries)) {
      if (entry.shipFolder === undefined || pending.has(entry.shipId) || readings.has(entry.shipId) || (entry.shipSizeMeasuredAt !== undefined && now - Date.parse(entry.shipSizeMeasuredAt) < SHIP_SIZE_INTERVAL_MS)) { continue; }
      const folder = entry.shipFolder;
      next = putEntry(next, { ...entry, shipSizeMeasuredAt: new Date(now).toISOString() });
      pending.add(entry.shipId);
      void deps.measure(entry).then((bytes) => { readings.set(entry.shipId, { folder, bytes }); }).catch((error: unknown) => {
        deps.logger.warn(`Could not measure ${entry.shipId}: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => { pending.delete(entry.shipId); });
    }
    return next;
  };
}
