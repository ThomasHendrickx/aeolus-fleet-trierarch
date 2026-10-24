import { PING_CONTENT_TYPE } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, CONFIGURATION, newId, PLUGIN_SHIP_ID } from '../../test/support/in-memory.js';

describe("what arrives at the trierarch's own ship", () => {
  it('answers a ping with pong, and does not ack it', async () => {
    const trierarch = aTrierarch();

    const ping = await trierarch.deliver({ contentType: PING_CONTENT_TYPE, payload: '' });

    expect(trierarch.fleet.pongs).toEqual([ping.deliveryId]);
    expect(trierarch.fleet.acked).toEqual([]);
  });

  it.each([
    ['a message asking for a ship to be crewed, which crews nothing (#301)', 'application/json'],
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

  describe('the trusted repositories (aeolus-fleet#384)', () => {
    const CONTENT_TYPE = 'application/vnd.aeolus.trierarch.trusted-repositories+json';
    const HEMMA = { name: 'hemma', url: 'git@github.com:ThomasHendrickx/hemma.git' };
    const payload = JSON.stringify({ repositories: [HEMMA] });

    it("takes them from the trierarch plugin's ship, and acks", async () => {
      const trierarch = aTrierarch();

      const delivery = await trierarch.deliver({ contentType: CONTENT_TYPE, payload, senderShipId: PLUGIN_SHIP_ID });

      expect(trierarch.trustedRepositories.current()).toEqual([HEMMA]);
      expect(trierarch.fleet.acked).toEqual([delivery.deliveryId]);
      expect(trierarch.logger.warnings).toEqual([]);
    });

    it('takes an empty list too, so a repository that left it is offered no more', async () => {
      const trierarch = aTrierarch();
      await trierarch.deliver({ contentType: CONTENT_TYPE, payload, senderShipId: PLUGIN_SHIP_ID });

      await trierarch.deliver({ contentType: CONTENT_TYPE, payload: '{"repositories":[]}', senderShipId: PLUGIN_SHIP_ID });

      expect(trierarch.trustedRepositories.current()).toEqual([]);
    });

    it("takes them from no other ship, whatever its type: a type is any ship's to pick", async () => {
      const trierarch = aTrierarch();
      const other = newId('ship');

      const delivery = await trierarch.deliver({ contentType: CONTENT_TYPE, payload, senderShipId: other });

      expect(trierarch.trustedRepositories.accepted).toEqual([]);
      expect(trierarch.fleet.acked).toEqual([delivery.deliveryId]);
      expect(trierarch.logger.warnings).toEqual([`Not handled: trusted repositories from ${other}. The trierarch takes them only from the trierarch plugin's ship ${PLUGIN_SHIP_ID}.`]);
    });

    it("takes none on a machine set up before init kept the trierarch plugin's ship, saying how to take them", async () => {
      const trierarch = aTrierarch(CONFIGURATION, {}, { pluginShipId: null });

      await trierarch.deliver({ contentType: CONTENT_TYPE, payload, senderShipId: PLUGIN_SHIP_ID });

      expect(trierarch.trustedRepositories.accepted).toEqual([]);
      expect(trierarch.logger.warnings).toEqual([
        `Not handled: trusted repositories from ${PLUGIN_SHIP_ID}. This machine does not know the trierarch plugin's ship: run aeolus-trierarch init --plugin-ship-id <its ship id>.`,
      ]);
    });

    it('keeps the list it holds when the one that came does not fit, saying why', async () => {
      const trierarch = aTrierarch();
      await trierarch.deliver({ contentType: CONTENT_TYPE, payload, senderShipId: PLUGIN_SHIP_ID });

      await trierarch.deliver({ contentType: CONTENT_TYPE, payload: JSON.stringify({ repositories: [{ name: 'hemma', url: 'file:///srv/hemma' }] }), senderShipId: PLUGIN_SHIP_ID });

      expect(trierarch.trustedRepositories.current()).toEqual([HEMMA]);
      expect(trierarch.logger.warnings).toEqual([
        'Not handled: trusted repositories that do not fit (hemma: a trusted repository is an https:// or ssh URL, never a path, a file URL or a credential). The trierarch keeps the list it holds.',
      ]);
    });
  });
});
