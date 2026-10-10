import { setTimeout as wait } from 'node:timers/promises';

import { assignedCrewRequestsOutputSchema, clearRequestsOutputSchema, FLEET_BUSY_WAITS_MS, giveBackCrewRequestOutputSchema, idSchema, receivedDeliverySchema, shipDetailOutputSchema, type ShipId } from '@aeolus-fleet/common';
import { z } from 'zod';

import type { Delivery, FleetPort } from '../core/ports.js';
import { runningVersion } from './version.js';

/**
 * The fleet over its REST API (`/api/v1`), as any ship may call it: the
 * trierarch's own crew (receive, ack, pong, send to argo, report) with its
 * crew token, its `crew:run` calls for the ships assigned to it (assigned
 * requests, status, confirm, ship, getStartingPrompt, release), and a
 * session's register, inbox and report. A refusal the trierarch does not expect throws
 * with the fleet's code and message. While the fleet is busy (nothing stored),
 * each call is made again by itself with the same body, after each of the busy
 * waits, so a send keeps its idempotency key.
 */

/** What the trierarch states as model and harness: it is software, not a model, as squadrons is (#157). */
export const TRIERARCH_SELF = { model: `@aeolus-fleet/trierarch@${runningVersion()}`, harness: 'aeolus-trierarch' } as const;

/** Where the trierarch says its sessions and itself run: on the operator's machine. */
const LOCATION = { kind: 'DEVICE' } as const;

/** The harness a session the trierarch crews states when the trierarch registers it. */
const SESSION_HARNESS = 'claude-code';

const refusalSchema = z.object({ code: z.string(), message: z.string() });

/** The fleet's code for a call it could not start: nothing was stored, so the same call may be made again. */
const FLEET_BUSY = 'SERVICE_UNAVAILABLE';

/** A refusal from the fleet: its code and message, and both together as the error's message. */
export class FleetRefusal extends Error {
  constructor(
    readonly code: string,
    readonly said: string,
  ) {
    super(`${code}: ${said}`);
  }
}

/** One call to the fleet: a call with no body is a GET, as whoami is. */
interface FleetCall<T> {
  path: string;
  crewToken?: string;
  body?: unknown;
  answers: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface RestFleet extends FleetPort {
  /** The deliveries waiting for the trierarch's own ship; `signal` ends the fleet's long poll at once. */
  receive(signal?: AbortSignal): Promise<Delivery[]>;
  /** Registers a ship with its secret, as the trierarch itself at init: its crew token. */
  registerSelf(crew: { shipId: ShipId; secret: string }): Promise<{ crewToken: string }>;
}

export function createRestFleet(options: { fleetUrl: string; crewToken: string; busyWaitsMs?: readonly number[] }): RestFleet {
  const fleetUrl = options.fleetUrl.replace(/\/$/, '');
  /** A call that got no answer: said with the fleet's url, unless it was stopped on purpose. */
  const unreachable = (error: unknown, signal: AbortSignal | undefined): unknown =>
    signal?.aborted === true ? error : new Error(`The fleet at ${fleetUrl} cannot be reached: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  const busyWaitsMs = options.busyWaitsMs ?? FLEET_BUSY_WAITS_MS;
  async function call<T>(request: FleetCall<T>): Promise<T> {
    for (const waitMs of busyWaitsMs) {
      try {
        return await callOnce(request);
      } catch (error) {
        if (!(error instanceof FleetRefusal && error.code === FLEET_BUSY)) {
          throw error;
        }
        await wait(waitMs, undefined, request.signal === undefined ? {} : { signal: request.signal });
      }
    }
    return callOnce(request);
  }
  async function callOnce<T>(request: FleetCall<T>): Promise<T> {
    const headers: Record<string, string> = {};
    const crewToken = request.crewToken ?? options.crewToken;
    if (crewToken !== '') {
      headers.authorization = `Bearer ${crewToken}`;
    }
    // A call with no body is a GET, as whoami is.
    let response: Response;
    try {
      response = await fetch(
        `${fleetUrl}/api/v1${request.path}`,
        request.body === undefined
          ? { method: 'GET', headers, signal: request.signal ?? null }
          : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(request.body), signal: request.signal ?? null },
      );
    } catch (error) {
      throw unreachable(error, request.signal);
    }
    // While the fleet restarts, an answer may come empty, as a proxy's page, or cut off: none of it is the fleet's word.
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw unreachable(error, request.signal);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error(`The fleet at ${fleetUrl} cannot be reached: it answered ${String(response.status)} without JSON, as while it restarts`, { cause: error });
    }
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
    whoami: async () => call({ path: '/ship/whoami', answers: z.object({ shipId: idSchema('ship'), name: z.string() }) }),
    release: async (shipId) => {
      await call({ path: '/fleet/release', body: { shipId }, answers: z.unknown() });
    },
    receive: async (signal) => {
      const { deliveries } = await call({ path: '/ship/receive', body: { max: 10 }, answers: z.object({ deliveries: z.array(receivedDeliverySchema) }), ...(signal !== undefined && { signal }) });
      return deliveries.map(({ deliveryId, messageId, senderShipId, contentType, payload }) => ({ deliveryId, messageId, senderShipId, contentType, payload }));
    },
    ack: async (deliveryId) => {
      await call({ path: '/ship/ack', body: { deliveryId }, answers: z.unknown() });
    },
    pong: async (deliveryId) => {
      await call({ path: '/ship/pong', body: { deliveryId }, answers: z.unknown() });
    },
    reportToArgo: async ({ text, idempotencyKey }) => {
      await call({
        path: '/ship/send',
        body: { selector: { kind: 'ship', name: 'argo' }, payload: text, contentType: 'text/plain', model: TRIERARCH_SELF.model, idempotencyKey },
        answers: z.object({ messageId: idSchema('message') }),
      });
    },
    assignedRequests: async () =>
      (await call({ path: '/fleet/assignedCrewRequests', answers: assignedCrewRequestsOutputSchema })).map(({ shipId, settings, settingsVersion, status, isFinal }) => ({ shipId, settings, settingsVersion, status, isFinal })),
    writeStatus: async (shipId, { status, attempt, startedAt }) => {
      await call({ path: '/fleet/reportCrewStatus', body: { shipId, status, attempt, startedAt: startedAt?.toISOString() ?? null }, answers: z.unknown() });
    },
    giveBack: async (shipId, { settingsVersion, reason }) => {
      try {
        await call({ path: '/fleet/giveBackCrewRequest', body: { shipId, settingsVersion, reason }, answers: giveBackCrewRequestOutputSchema });
        return { kind: 'givenBack' };
      } catch (error) {
        if (error instanceof FleetRefusal) {
          return { kind: 'refused', code: error.code, message: error.said };
        }
        throw error;
      }
    },
    confirmRelease: async (shipId) => {
      await call({ path: '/fleet/confirmCrewRelease', body: { shipId }, answers: z.unknown() });
    },
    pendingClears: async () =>
      (await call({ path: '/fleet/clearRequests', answers: clearRequestsOutputSchema })).map(({ shipId, repository }) => ({ shipId, repository })),
    confirmCleared: async (cleared) => {
      await call({ path: '/fleet/confirmWorktreeCleared', body: cleared, answers: z.unknown() });
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
    reportSelf: async ({ state, note, details }) => {
      await call({ path: '/ship/report', body: { state, note, details }, answers: z.unknown() });
    },
  };
}
