import { isPingContentType } from '@aeolus-fleet/common';

import type { Delivery, FleetPort, Logger } from './ports.js';

/**
 * Use case: a message arrives at the trierarch's own ship. Its ship stays a
 * normal ship (docs/trierarch.md): a ping gets pong. A trierarch takes work
 * only through the crew requests assigned to it, never from a message, so
 * any other delivery is acknowledged, logged as not handled, and acted on
 * never: no ship can start or stop a session on the machine by messaging it
 * (#301).
 */
export type HandleDelivery = (delivery: Delivery) => Promise<void>;

export function createHandleDelivery(deps: { fleet: FleetPort; logger: Logger }): HandleDelivery {
  return async (delivery) => {
    if (isPingContentType(delivery.contentType)) {
      await deps.fleet.pong(delivery.deliveryId);
      return;
    }
    await deps.fleet.ack(delivery.deliveryId);
    deps.logger.warn(`Not handled: ${delivery.contentType} from ${delivery.senderShipId}. A trierarch takes work only through the crew requests assigned to it.`);
  };
}
