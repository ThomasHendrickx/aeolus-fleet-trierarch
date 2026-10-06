import { idSchema, receivedDeliverySchema, shipDetailOutputSchema, trierarchContentType, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { Delivery, FleetPort } from '../core/ports.js';
import { runningVersion } from './version.js';

/**
 * The fleet over its REST API (`/api/v1`), as any ship may call it: the
 * trierarch's own crew (receive, ack, send) with its crew token, its
 * `fleet:crew` calls (ship, getStartingPrompt, release), and a session's
 * register, inbox and report. A refusal the trierarch does not expect throws
 * with the fleet's code and message.
 */

/** What the trierarch states as model and harness: it is software, not a model, as squadrons is (#157). */
export const TRIERARCH_SELF = { model: `@aeolus-fleet/trierarch@${runningVersion()}`, harness: 'aeolus-trierarch' } as const;

/** Where the trierarch says its sessions and itself run: on the operator's machine. */
const LOCATION = { kind: 'DEVICE' } as const;

/** The harness a session the trierarch crews states when the trierarch registers it. */
const SESSION_HARNESS = 'claude-code';

const refusalSchema = z.object({ code: z.string(), message: z.string() });

/** A refusal from the fleet: its code and message. */
export class FleetRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface RestFleet extends FleetPort {
  /** The deliveries waiting for the trierarch's own ship. */
  receive(): Promise<Delivery[]>;
  /** Registers a ship with its secret, as the trierarch itself at init: its crew token. */
  registerSelf(crew: { shipId: ShipId; secret: string }): Promise<{ crewToken: string }>;
}

export function createRestFleet(options: { fleetUrl: string; crewToken: string }): RestFleet {
  const fleetUrl = options.fleetUrl.replace(/\/$/, '');
  async function call<T>(request: { path: string; crewToken?: string; body: unknown; answers: z.ZodType<T> }): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const crewToken = request.crewToken ?? options.crewToken;
    if (crewToken !== '') {
      headers.authorization = `Bearer ${crewToken}`;
    }
    const response = await fetch(`${fleetUrl}/api/v1${request.path}`, { method: 'POST', headers, body: JSON.stringify(request.body) });
    const body: unknown = await response.json();
    if (!response.ok) {
      const refusal = refusalSchema.safeParse(body);
      throw refusal.success ? new FleetRefusal(refusal.data.code, refusal.data.message) : new FleetRefusal(String(response.status), 'The fleet refused');
    }
    return request.answers.parse(body);
  }
  const register = (crew: { shipId: ShipId; secret: string }, harness: string) =>
    call({ path: '/ship/register', crewToken: '', body: { ...crew, location: LOCATION, harness }, answers: z.object({ crewToken: z.string() }) });

  return {
    url: fleetUrl,
    ship: async (shipId) => {
      try {
        const ship = await call({ path: '/fleet/ship', body: { shipId }, answers: shipDetailOutputSchema });
        switch (ship.status) {
          case 'awaitingCrew':
            return { kind: 'awaitingCrew', name: ship.name };
          case 'crewed':
            return { kind: 'crewed', name: ship.name };
          case 'retired':
            return { kind: 'retired' };
        }
      } catch (error) {
        if (error instanceof FleetRefusal && error.code === 'NOT_FOUND') {
          return { kind: 'notFound' };
        }
        throw error;
      }
    },
    getStartingPrompt: async (shipId) => call({ path: '/fleet/getStartingPrompt', body: { shipId }, answers: z.object({ secret: z.string() }) }),
    register: async (crew) => register(crew, SESSION_HARNESS),
    registerSelf: async (crew) => register(crew, TRIERARCH_SELF.harness),
    release: async (shipId) => {
      await call({ path: '/fleet/release', body: { shipId }, answers: z.unknown() });
    },
    receive: async () => {
      const { deliveries } = await call({ path: '/ship/receive', body: { max: 10 }, answers: z.object({ deliveries: z.array(receivedDeliverySchema) }) });
      return deliveries.map(({ deliveryId, messageId, senderShipId, contentType, payload }) => ({ deliveryId, messageId, senderShipId, contentType, payload }));
    },
    ack: async (deliveryId) => {
      await call({ path: '/ship/ack', body: { deliveryId }, answers: z.unknown() });
    },
    send: async (message) => {
      await call({
        path: '/ship/send',
        body: {
          selector: { kind: 'ship', shipId: message.to },
          payload: JSON.stringify(message.payload),
          contentType: trierarchContentType(message.name),
          model: TRIERARCH_SELF.model,
          idempotencyKey: message.idempotencyKey,
          ...(message.inReplyTo !== undefined && { inReplyTo: message.inReplyTo }),
        },
        answers: z.object({ messageId: idSchema('message') }),
      });
    },
    inbox: async (crewToken) => {
      try {
        const { waiting } = await call({ path: '/ship/inbox', crewToken, body: {}, answers: z.object({ waiting: z.int() }) });
        return { kind: 'waiting', count: waiting };
      } catch (error) {
        if (error instanceof FleetRefusal && (error.code === 'LEASE_ENDED' || error.code === 'UNAUTHORIZED')) {
          return { kind: 'leaseEnded' };
        }
        throw error;
      }
    },
    report: async ({ crewToken, state, note }) => {
      await call({ path: '/ship/report', crewToken, body: { state, note }, answers: z.unknown() });
    },
  };
}
