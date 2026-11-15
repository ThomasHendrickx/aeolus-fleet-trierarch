/** Reports recognised session usage-limit stops each pass without changing session or restart policy (#1629). */
import { putEntry, type TrierarchState } from './entry.js';
import type { RunPassDeps } from './run-pass.js';

export async function reportUsageLimits(state: TrierarchState, deps: RunPassDeps): Promise<TrierarchState> {
  let next = state;
  for (const entry of Object.values(state.entries)) {
    if (entry.folder === undefined || entry.crewToken === undefined || entry.state === 'releasing') { continue; }
    try {
      const limit = await deps.harnesses[entry.harness]?.usageLimitOf?.({ ...entry, folder: entry.folder });
      if (limit === undefined || limit.occurrence === entry.usageLimitTold) { continue; }
      const note = `${entry.harness} usage limit reached: ${limit.reason}`;
      await deps.fleet.report({ crewToken: entry.crewToken, state: 'blocked', note });
      const recipient = await deps.fleet.usageLimitRecipient(entry.shipId);
      if (recipient === undefined) { continue; }
      const answer = await deps.fleet.reportToOwner({ ownerShipId: recipient,
        text: `${entry.shipName ?? 'A ship'} reached its usage limit\n\n${note}`,
        idempotencyKey: `trierarch:usage-limit:${entry.shipId}:${String(entry.settingsVersion)}:${limit.occurrence}` });
      if (answer.kind === 'refused') { deps.logger.warn(`Usage-limit notice for ${entry.shipId} was refused: ${answer.code}; the next pass tries again`); continue; }
      next = putEntry(next, { ...entry, usageLimitTold: limit.occurrence });
      await deps.state.save(next);
    } catch (error) {
      deps.logger.warn(`Usage-limit stop for ${entry.shipId} was not reported: ${error instanceof Error ? error.message : String(error)}; the next pass tries again`);
    }
  }
  return next;
}
