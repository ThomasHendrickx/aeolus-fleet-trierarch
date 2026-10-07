import { PING_CONTENT_TYPE } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch } from '../../test/support/in-memory.js';

describe("what arrives at the trierarch's own ship", () => {
  it('answers a ping with pong, and does not ack it', async () => {
    const trierarch = aTrierarch();

    const ping = await trierarch.deliver({ contentType: PING_CONTENT_TYPE, payload: '' });

    expect(trierarch.fleet.pongs).toEqual([ping.deliveryId]);
    expect(trierarch.fleet.acked).toEqual([]);
  });

  it.each([
    ['a 0.17 want, which no longer starts a session (#301)', 'application/vnd.aeolus.trierarch.want+json'],
    ['any other message', 'text/plain'],
  ])('acks %s, logs it as not handled, and acts on nothing', async (_label, contentType) => {
    const trierarch = aTrierarch();

    const delivery = await trierarch.deliver({ contentType, payload: '{"shipId":"shp_01m3tbfspe96yf1rnr4ank9h1a"}' });
    await trierarch.pass();

    expect(trierarch.fleet.acked).toEqual([delivery.deliveryId]);
    expect(trierarch.logger.warnings).toEqual([
      `Not handled: ${contentType} from ${delivery.senderShipId}. A trierarch takes work only through the crew requests assigned to it.`,
    ]);
    expect(trierarch.harness.launches).toEqual([]);
    expect(trierarch.state.current().entries).toEqual({});
  });
});
