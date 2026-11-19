import type { Logger, TrashPort } from './ports.js';
import type { Clock } from './shared/clock.js';

/** The urgent cache measure and the image pass run at most this often while the disk stays low (disk-under-control design, unhappy paths). */
export const COSTLY_FREE_INTERVAL_MS = 60 * 60 * 1000;

/** Reclaims only managed leftovers. A failed step leaves the other steps free to reclaim space. */
export function createFreeDisk(deps: {
  trash: Pick<TrashPort, 'empty'>;
  images: { removeUnused(): Promise<void> };
  cache: { trim(now: Date, options: { isUrgent: boolean }): Promise<void> };
  clock: Clock;
  logger: Pick<Logger, 'warn'>;
}): () => Promise<void> {
  const warn = (error: unknown): void => { deps.logger.warn(`Could not free disk: ${error instanceof Error ? error.message : String(error)}`); };
  let lastImages: number | undefined;
  let lastCache: number | undefined;
  const isDue = (last: number | undefined, now: number): boolean => last === undefined || now - last >= COSTLY_FREE_INTERVAL_MS;
  return async () => {
    const now = deps.clock.now();
    await deps.trash.empty().catch(warn);
    if (isDue(lastImages, now.getTime())) {
      lastImages = now.getTime();
      await deps.images.removeUnused().catch(warn);
    }
    if (isDue(lastCache, now.getTime())) {
      lastCache = now.getTime();
      await deps.cache.trim(now, { isUrgent: true }).catch(warn);
    }
    // A trim moves evicted entries aside; reclaim those bytes before the machine is read again.
    await deps.trash.empty().catch(warn);
  };
}
