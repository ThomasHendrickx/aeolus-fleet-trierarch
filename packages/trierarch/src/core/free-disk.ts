import type { Logger, TrashPort } from './ports.js';
import type { Clock } from './shared/clock.js';

/** Reclaims only managed leftovers. A failed step leaves the other steps free to reclaim space. */
export function createFreeDisk(deps: {
  trash: Pick<TrashPort, 'empty'>;
  images: { removeUnused(): Promise<void> };
  cache: { trim(now: Date, options: { isUrgent: boolean }): Promise<void> };
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
}): () => Promise<void> {
  const warn = (error: unknown): void => { deps.logger.warn(`Could not free disk: ${error instanceof Error ? error.message : String(error)}`); };
  return async () => {
    await deps.trash.empty().catch(warn);
    await deps.images.removeUnused().catch(warn);
    await deps.cache.trim(deps.clock.now(), { isUrgent: true }).catch(warn);
    // A trim moves evicted entries aside; reclaim those bytes before the machine is read again.
    await deps.trash.empty().catch(warn);
  };
}
