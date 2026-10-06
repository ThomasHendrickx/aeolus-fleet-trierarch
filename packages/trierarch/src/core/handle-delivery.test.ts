import { describedAnswerSchema, listedAnswerSchema, refusedAnswerSchema } from '@aeolus-fleet/common';
import type { ShipId } from '@aeolus-fleet/common';
import { describe, expect, it } from 'vitest';

import { aTrierarch, aWant, newId, type Trierarch } from '../../test/support/in-memory.js';

describe('a command to the trierarch', () => {
  it('saves the want before it acknowledges the delivery', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');

    const delivery = await trierarch.command('want', aWant(shipId));

    expect(trierarch.fleet.acked).toEqual([delivery.deliveryId]);
    expect(trierarch.fleet.stateAtAck.get(delivery.deliveryId)?.entries[shipId]?.state).toBe('wanted');
  });

  it('answers wanted, in reply to the want, to its sender', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');

    const delivery = await trierarch.command('want', aWant(shipId));

    expect(trierarch.fleet.sentTo(trierarch.requester, 'wanted')).toEqual([
      { to: trierarch.requester, inReplyTo: delivery.messageId, name: 'wanted', payload: { shipId }, idempotencyKey: `trierarch:${delivery.messageId}:wanted` },
    ]);
  });

  it('changes nothing for a message it applied before, and answers it again under the same key', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    const delivery = await trierarch.command('want', aWant(shipId));
    const saves = trierarch.state.saved.length;

    await trierarch.handle({ ...delivery, deliveryId: newId('delivery') });

    expect(trierarch.state.saved).toHaveLength(saves);
    expect(trierarch.fleet.acked).toHaveLength(2);
    expect(trierarch.fleet.sentTo(trierarch.requester, 'wanted')).toHaveLength(1);
    expect(Object.keys(trierarch.state.current().entries)).toEqual([shipId]);
  });

  it('refuses a want with the field named, adding nothing', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');

    await trierarch.command('want', aWant(shipId, { options: { model: 'haiku' } }));

    const [answer] = trierarch.fleet.sentTo(trierarch.requester, 'refused');
    expect(refusedAnswerSchema.parse(answer?.payload)).toMatchObject({ shipId, field: 'options.model' });
    expect(trierarch.state.current().entries).toEqual({});
  });

  it.each([
    [
      'crewed by another session',
      (trierarch: Trierarch, shipId: ShipId) => {
        trierarch.fleet.crewElsewhere(shipId);
      },
    ],
    [
      'retired',
      (trierarch: Trierarch, shipId: ShipId) => {
        trierarch.fleet.retire(shipId);
      },
    ],
  ])('refuses a want for a ship %s: a ship must exist and await crew', async (_label, arrange) => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    arrange(trierarch, shipId);

    await trierarch.command('want', aWant(shipId));

    expect(trierarch.fleet.sentTo(trierarch.requester, 'refused')[0]?.payload).toMatchObject({ shipId, field: 'shipId' });
    expect(trierarch.state.current().entries).toEqual({});
  });

  it('refuses a want for a ship the fleet does not have', async () => {
    const trierarch = aTrierarch();
    const shipId = newId('ship');

    await trierarch.command('want', aWant(shipId));

    expect(trierarch.fleet.sentTo(trierarch.requester, 'refused')[0]?.payload).toMatchObject({ shipId, field: 'shipId' });
  });

  it('refuses a second want for a ship on the list', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));

    await trierarch.command('want', aWant(shipId));

    expect(trierarch.fleet.sentTo(trierarch.requester, 'refused')[0]?.payload).toMatchObject({ shipId, field: 'shipId' });
  });

  it('keeps the squadron a want names on its entry', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('implementer-k3x9');

    await trierarch.command('want', aWant(shipId, { squadron: 'hemma-feature-a1b2c3' }));

    expect(trierarch.state.current().entries[shipId]?.squadron).toBe('hemma-feature-a1b2c3');
  });

  it('describes its harnesses with their options as a JSON Schema, its workspaces, caps, kept worktrees and version', async () => {
    const trierarch = aTrierarch();

    await trierarch.command('describe', {});

    const described = describedAnswerSchema.parse(trierarch.fleet.sentTo(trierarch.requester, 'described')[0]?.payload);
    expect(described).toEqual({
      harnesses: [
        {
          harness: 'claude-code',
          options: { type: 'object', properties: { model: { enum: ['opus', 'sonnet'], default: 'opus' } }, additionalProperties: false },
          flags: ['--remote-control'],
        },
      ],
      workspaces: { repositories: ['aeolus-fleet'], folders: ['notes'] },
      caps: { ships: 8, running: 4 },
      kept: [],
      version: '0.1.0',
    });
  });

  it('lists its ships, with their state, since when and their restarts', async () => {
    const trierarch = aTrierarch();
    const shipId = trierarch.fleet.commission('scout');
    await trierarch.command('want', aWant(shipId));

    await trierarch.command('list', {});

    expect(listedAnswerSchema.parse(trierarch.fleet.sentTo(trierarch.requester, 'listed')[0]?.payload)).toEqual({
      ships: [{ shipId, harness: 'claude-code', state: 'wanted', since: '2026-10-06T08:00:00.000Z', restarts: 0 }],
      kept: [],
      orphans: [],
    });
  });

  it('refuses a release for a ship not on the list', async () => {
    const trierarch = aTrierarch();
    const shipId = newId('ship');

    await trierarch.command('release', { shipId });

    expect(trierarch.fleet.sentTo(trierarch.requester, 'refused')[0]?.payload).toMatchObject({ shipId, field: 'shipId' });
  });

  it('acknowledges a message it does not read and answers nothing, so it never comes back', async () => {
    const trierarch = aTrierarch();

    const delivery = await trierarch.command('sail', {});

    expect(trierarch.fleet.acked).toEqual([delivery.deliveryId]);
    expect(trierarch.fleet.sent).toEqual([]);
    expect(trierarch.logger.warnings).toHaveLength(1);
  });
});
