import { idSchema, releaseCommandSchema, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import { describedOf, listedOf } from './answers.js';
import { checkWant, fieldOf, newEntry, type Refusal } from './check-want.js';
import { putEntry, removeEntry, withState, type Outgoing, type TrierarchState } from './entry.js';
import type { Delivery, FleetPort, Logger, StatePort, TrierarchSetup, WorkspacePort } from './ports.js';
import type { Clock } from './shared/clock.js';

/**
 * Use case: a command arrives at the trierarch's ship (docs/trierarch.md).
 * Messages only edit the wanted list; the loop does the rest. The edit and
 * the answers are saved before the ack, so a stop between them loses
 * nothing, and a message applied before changes nothing: its answers are sent
 * again, under the same idempotency keys.
 */
export type HandleDelivery = (delivery: Delivery) => Promise<void>;

export interface HandleDeliveryDeps {
  fleet: FleetPort;
  workspace: WorkspacePort;
  state: StatePort;
  setup: TrierarchSetup;
  clock: Clock;
  logger: Logger;
}

const CONTENT_TYPE = /^application\/vnd\.aeolus\.trierarch\.(\w+)\+json$/;
const shipIdOnly = z.looseObject({ shipId: idSchema('ship') });

/** What applying one command gives: the next state and the answers to send. */
interface Applied {
  readonly state: TrierarchState;
  readonly answers: readonly Outgoing[];
}

export function createHandleDelivery(deps: HandleDeliveryDeps): HandleDelivery {
  return async (delivery) => {
    const state = await deps.state.load();
    const before = state.applied[delivery.messageId];
    if (before !== undefined) {
      await deps.fleet.ack(delivery.deliveryId);
      await Promise.all(before.map((answer) => deps.fleet.send(answer)));
      return;
    }
    const { state: next, answers } = await apply(state, { delivery, deps });
    await deps.state.save({ ...next, applied: { ...next.applied, [delivery.messageId]: answers } });
    await deps.fleet.ack(delivery.deliveryId);
    for (const answer of answers) {
      await deps.fleet.send(answer);
    }
  };
}

interface ApplyContext {
  readonly delivery: Delivery;
  readonly deps: HandleDeliveryDeps;
}

async function apply(state: TrierarchState, context: ApplyContext): Promise<Applied> {
  const { delivery, deps } = context;
  const name = CONTENT_TYPE.exec(delivery.contentType)?.[1] ?? '';
  const payload = parsedJson(delivery.payload);
  const answer = answerTo(delivery);
  switch (name) {
    case 'describe':
      return { state, answers: [answer('described', describedOf(deps.setup, state))] };
    case 'list':
      return { state, answers: [answer('listed', listedOf(state))] };
    case 'want':
      return want(state, { payload, context });
    case 'release':
      return release(state, { payload, context });
    default:
      deps.logger.warn(`A message the trierarch does not read: ${delivery.contentType}, from ${delivery.senderShipId}`);
      return { state, answers: [] };
  }
}

/** The payload as JSON, or undefined when it is none: the schemas then refuse it. */
function parsedJson(payload: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed;
  } catch {
    return undefined;
  }
}

function answerTo(delivery: Delivery) {
  return (name: string, payload: Readonly<Record<string, unknown>>): Outgoing => ({
    to: delivery.senderShipId,
    inReplyTo: delivery.messageId,
    name,
    payload,
    idempotencyKey: `trierarch:${delivery.messageId}:${name}`,
  });
}

function refused(context: ApplyContext, refusal: Refusal & { shipId: ShipId }): Outgoing {
  return answerTo(context.delivery)('refused', {
    shipId: refusal.shipId,
    ...(refusal.field !== undefined && { field: refusal.field }),
    reason: refusal.reason,
  });
}

/** A command whose ship id does not parse cannot be answered: refused names a ship. */
function unanswerable(state: TrierarchState, context: ApplyContext): Applied {
  context.deps.logger.warn(`A command with no ship id the trierarch can answer, from ${context.delivery.senderShipId}`);
  return { state, answers: [] };
}

async function want(state: TrierarchState, at: { payload: unknown; context: ApplyContext }): Promise<Applied> {
  const { payload, context } = at;
  const { deps, delivery } = context;
  const target = shipIdOnly.safeParse(payload);
  if (!target.success) {
    return unanswerable(state, context);
  }
  const { shipId } = target.data;
  const existing = state.entries[shipId];
  if (existing !== undefined && existing.state !== 'crashed') {
    return { state, answers: [refused(context, { shipId, field: 'shipId', reason: `${shipId} is on the wanted list already` })] };
  }
  const checked = checkWant(payload, { configuration: deps.setup.configuration, state: removeEntry(state, shipId) });
  if (!checked.isOk) {
    return { state, answers: [refused(context, { shipId, ...checked.error })] };
  }
  const now = deps.clock.now();
  const entry = newEntry(checked.value, { requester: delivery.senderShipId, now });
  const wanted = answerTo(delivery)('wanted', { shipId });
  if (existing !== undefined) {
    // Wanted again after it crashed: its session starts again in its folder, with its lease still held.
    const again = { ...entry, state: 'running' as const, hasStarted: existing.hasStarted, ...(existing.folder !== undefined && { folder: existing.folder }) };
    return { state: putEntry(state, again), answers: [wanted] };
  }
  const ship = await deps.fleet.ship(shipId);
  switch (ship.kind) {
    case 'notFound':
      return { state, answers: [refused(context, { shipId, field: 'shipId', reason: `The fleet has no ship ${shipId}` })] };
    case 'retired':
      return { state, answers: [refused(context, { shipId, field: 'shipId', reason: `${shipId} is retired` })] };
    case 'crewed':
      return { state, answers: [refused(context, { shipId, field: 'shipId', reason: `${ship.name} is crewed by another session` })] };
    case 'awaitingCrew':
      return { state: putEntry(state, entry), answers: [wanted] };
  }
}

async function release(state: TrierarchState, at: { payload: unknown; context: ApplyContext }): Promise<Applied> {
  const { payload, context } = at;
  const { deps, delivery } = context;
  const parsed = releaseCommandSchema.safeParse(payload);
  if (!parsed.success) {
    const target = shipIdOnly.safeParse(payload);
    if (!target.success) {
      return unanswerable(state, context);
    }
    const [issue] = parsed.error.issues;
    return { state, answers: [refused(context, { shipId: target.data.shipId, ...fieldOf(issue?.path), reason: issue?.message ?? 'The release does not parse' })] };
  }
  const { shipId, force = false } = parsed.data;
  const entry = state.entries[shipId];
  if (entry !== undefined) {
    const releasing = { ...withState(entry, { state: 'releasing', now: deps.clock.now() }), release: { messageId: delivery.messageId, sender: delivery.senderShipId, isForced: force } };
    return { state: putEntry(state, releasing), answers: [] };
  }
  const kept = state.kept.find((each) => each.shipId === shipId);
  if (kept === undefined) {
    return { state, answers: [refused(context, { shipId, field: 'shipId', reason: `${shipId} is not on the wanted list` })] };
  }
  const answer = answerTo(delivery);
  if (!force) {
    return { state, answers: [answer('released', { shipId, workspace: 'kept', path: kept.path })] };
  }
  // A release with force clears a kept worktree.
  await deps.workspace.remove(kept.path);
  return { state: { ...state, kept: state.kept.filter((each) => each !== kept) }, answers: [answer('released', { shipId, workspace: 'removed' })] };
}
