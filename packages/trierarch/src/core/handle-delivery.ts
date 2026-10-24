import { isPingContentType, type ShipId } from '@aeolus-fleet/common';

import type { Delivery, FleetPort, Logger, TrustedRepositoriesPort } from './ports.js';
import { readTrustedRepositories, TRUSTED_REPOSITORIES_CONTENT_TYPE } from './trusted-repositories.js';

/**
 * Use case: a message arrives at the trierarch's own ship. Its ship stays a
 * normal ship (docs/trierarch.md): a ping gets pong. A trierarch takes work
 * only through the crew requests assigned to it, never from a message, so
 * any other delivery is acknowledged, logged as not handled, and acted on
 * never: no ship can start or stop a session on the machine by messaging it
 * (#301). The one message it takes is the trusted repositories
 * (aeolus-fleet#384), and only from the trierarch plugin's ship init kept: a
 * sender's type is any ship's to pick, so no other ship can make the machine
 * clone a repository.
 */
export type HandleDelivery = (delivery: Delivery) => Promise<void>;

export function createHandleDelivery(deps: { fleet: FleetPort; logger: Logger; trustedRepositories: TrustedRepositoriesPort; pluginShipId?: ShipId }): HandleDelivery {
  const takeTrustedRepositories = async (delivery: Delivery): Promise<void> => {
    const from = `Not handled: trusted repositories from ${delivery.senderShipId}.`;
    if (deps.pluginShipId === undefined) {
      deps.logger.warn(`${from} This machine does not know the trierarch plugin's ship: run aeolus-trierarch init --plugin-ship-id <its ship id>.`);
      return;
    }
    if (delivery.senderShipId !== deps.pluginShipId) {
      deps.logger.warn(`${from} The trierarch takes them only from the trierarch plugin's ship ${deps.pluginShipId}.`);
      return;
    }
    const read = readTrustedRepositories(delivery.payload);
    if (!read.isOk) {
      deps.logger.warn(`Not handled: trusted repositories that do not fit (${read.error.reason}). The trierarch keeps the list it holds.`);
      return;
    }
    await deps.trustedRepositories.accept(read.value);
  };
  return async (delivery) => {
    if (isPingContentType(delivery.contentType)) {
      await deps.fleet.pong(delivery.deliveryId);
      return;
    }
    if (delivery.contentType === TRUSTED_REPOSITORIES_CONTENT_TYPE) {
      await takeTrustedRepositories(delivery);
      await deps.fleet.ack(delivery.deliveryId);
      return;
    }
    await deps.fleet.ack(delivery.deliveryId);
    deps.logger.warn(`Not handled: ${delivery.contentType} from ${delivery.senderShipId}. A trierarch takes work only through the crew requests assigned to it.`);
  };
}
