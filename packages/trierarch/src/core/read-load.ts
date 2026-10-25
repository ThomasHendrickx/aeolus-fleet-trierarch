import { lowResourceText } from './argo-reports.js';
import { lowResourcesOf, type MachineLoad } from './machine-load.js';
import type { FleetPort, Logger, MachinePort, StatePort } from './ports.js';
import type { Clock } from './shared/clock.js';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The machine's load, read at most once a minute: the last one read, or none before any could be. */
export type ReadLoad = () => Promise<MachineLoad | undefined>;

/** How often the machine's load is read: often enough to see memory run out, rarely enough that a report on it does not flood the fleet. */
export const LOAD_READ_INTERVAL_MS = 60_000;

/**
 * Use case: the trierarch reads its machine's load (#400), at most once a
 * minute, keeping the last one when the machine cannot be read. Each time
 * the machine starts to be low on memory or disk, argo is told once: again
 * only after it recovered and dropped again. What argo was told is kept in
 * the state, so a restart while it stays low tells nothing again.
 */
export function createReadLoad(deps: { machine: MachinePort; fleet: Pick<FleetPort, 'reportToArgo'>; state: StatePort; clock: Clock; logger: Pick<Logger, 'warn'> }): ReadLoad {
  let last: { load: MachineLoad; at: number } | undefined;

  const tellArgo = async (load: MachineLoad, now: Date): Promise<void> => {
    const state = await deps.state.load();
    const told = state.lowResources ?? [];
    const low = lowResourcesOf(load);
    for (const resource of low.filter((each) => !told.includes(each))) {
      await deps.fleet.reportToArgo({ text: lowResourceText(resource, load), idempotencyKey: `low-${resource}-${now.toISOString()}` });
    }
    if (low.length !== told.length || low.some((each) => !told.includes(each))) {
      await deps.state.save({ ...state, lowResources: low.length > 0 ? low : undefined });
    }
  };

  return async () => {
    const now = deps.clock.now();
    if (last !== undefined && now.getTime() - last.at < LOAD_READ_INTERVAL_MS) {
      return last.load;
    }
    const read = await deps.machine.load().catch((error: unknown) => {
      deps.logger.warn(`Could not read the machine load: ${messageOf(error)}`);
      return undefined;
    });
    if (read === undefined) {
      return last?.load;
    }
    last = { load: read, at: now.getTime() };
    await tellArgo(read, now).catch((error: unknown) => {
      deps.logger.warn(`Could not tell argo the machine is low: ${messageOf(error)}`);
    });
    return read;
  };
}
