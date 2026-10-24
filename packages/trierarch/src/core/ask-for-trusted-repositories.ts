import type { ShipId } from '@aeolus-fleet/common';

import type { FleetPort, Logger } from './ports.js';

/** Asks the trierarch plugin's ship for the trusted repositories, until one ask is sent; then nothing. */
export type AskForTrustedRepositories = () => Promise<void>;

/**
 * Use case: as it starts knowing the trierarch plugin's ship, the trierarch
 * asks it for the trusted repositories (aeolus-fleet#384), so a machine set
 * up before, which dropped the list until init kept that ship, gets it on
 * the trierarch plugin's next pass. It asks once per process; an ask the
 * fleet does not take is asked again on the next pass. A machine that does
 * not know the ship asks nothing.
 */
export function createAskForTrustedRepositories(deps: { fleet: Pick<FleetPort, 'askForTrustedRepositories'>; logger: Logger; pluginShipId?: ShipId }): AskForTrustedRepositories {
  let isAsked = false;
  return async () => {
    if (isAsked || deps.pluginShipId === undefined) {
      return;
    }
    try {
      await deps.fleet.askForTrustedRepositories(deps.pluginShipId);
      isAsked = true;
    } catch (error) {
      deps.logger.warn(`Could not ask the trierarch plugin's ship for the trusted repositories: ${error instanceof Error ? error.message : String(error)}; the next pass asks again`);
    }
  };
}
