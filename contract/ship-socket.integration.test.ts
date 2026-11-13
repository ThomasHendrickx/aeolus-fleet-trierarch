import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ShipId } from '@aeolus-fleet/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { aCrewingMachine, listedEntryOf, REPOSITORY, sessionOf } from './support/crewing.js';
import { aFleet, type Fleet } from './support/fleet.js';
import { aMachine, type Machine } from './support/machine.js';

// The ship's socket, as its session calls it (decision 0026): the trierarch adds the crew token to the session's ship and fleet calls and hands back core's answer as it is; it refuses register, deregister, the tRPC door and a path that climbs out of the API (docs/trierarch.md, "Crewing a ship", step 3).

const CREWED_WITHIN_MS = 30_000;
/** A pass hands an idle session one message every 5 seconds. */
const ANSWERED_WITHIN_MS = 30_000;

let fleet: Fleet;
let machine: Machine;
let scout: ShipId;

beforeEach(async () => {
  fleet = await aFleet();
  machine = await aMachine();
  await aCrewingMachine({ fleet, machine });
  // fleet:read lets scout list the fleet; it holds no fleet:commission.
  scout = await fleet.commission('scout', { scopes: ['fleet:read'] });
  await fleet.crewInRepositories(scout, { main: REPOSITORY, harness: 'claude-code' });
  await expect.poll(async () => (await listedEntryOf(machine, scout))?.state, { timeout: CREWED_WITHIN_MS }).toBe('running');
  await expect.poll(() => sessionOf(machine, 'scout').turns().length, { timeout: CREWED_WITHIN_MS }).toBeGreaterThan(0);
});

afterEach(async ({ task }) => {
  if (task.result?.state === 'fail') {
    console.log(`The service's log:\n${machine.serviceLog()}`);
  }
  await machine.remove();
  await fleet.close();
});

const answeredSchema = z.object({ path: z.string(), status: z.number(), body: z.string() });

/** What the socket answered scout's session, each call in order. */
function answeredScout(): z.infer<typeof answeredSchema>[] {
  const file = join(sessionOf(machine, 'scout').folder, 'fake-socket-calls.jsonl');
  return existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => answeredSchema.parse(JSON.parse(line)))
    : [];
}

interface SocketCall {
  readonly method: string;
  readonly path: string;
  readonly body?: string;
}

/** Has scout's session make the calls over its ship's socket, all asked in one message it is handed: what the socket answered each, in order. */
async function scoutCalls(calls: readonly SocketCall[]): Promise<{ path: string; status: number; body: string }[]> {
  const socket = join(machine.trierarchHome, 'ships', scout, 'sockets', 'fleet.sock');
  const before = answeredScout().length;
  const asked = calls.map(({ method, path, body = '{}' }) => `socket call: ${Buffer.from(JSON.stringify({ socket, method, path, body })).toString('base64url')}`);
  await fleet.send('scout', asked.join('\n'));
  await expect.poll(() => answeredScout().length, { timeout: ANSWERED_WITHIN_MS }).toBe(before + calls.length);
  return answeredScout().slice(before);
}

describe("a fleet call over the ship's socket", () => {
  it("is forwarded with the ship's crew token: core answers the ship as itself", async () => {
    const [answered] = await scoutCalls([{ method: 'POST', path: '/api/v1/fleet/list' }]);

    expect(answered?.status, answered?.body).toBe(200);
    expect(answered?.body).toContain('"scout"');
  });

  it("hands back core's 403 for a scope the ship lacks as it is", async () => {
    const [answered] = await scoutCalls([{ method: 'POST', path: '/api/v1/fleet/commission', body: JSON.stringify({ idempotencyKey: 'k-1', name: 'lookout', type: 'reviewer' }) }]);

    expect(answered?.status).toBe(403);
    expect(answered?.body).toContain('fleet:commission');
  });
});

describe("a call the ship's socket refuses", () => {
  it('refuses register, deregister, the tRPC door and a path that climbs out of the API with 403, for ship and fleet paths alike, never forwarded to core', async () => {
    const refused = [
      '/api/v1/ship/register',
      '/api/v1/ship/deregister',
      '/api/v1/fleet/register',
      '/api/v1/fleet/deregister',
      '/trpc/ship.send',
      '/trpc/fleet.commission',
      '/api/v1/ship/../../trpc/ship.send',
      '/api/v1/fleet/../ship/register',
    ];

    const answered = await scoutCalls(refused.map((path) => ({ method: 'POST', path })));

    expect(answered.map(({ path, status, body }) => ({ path, status, isTheSockets: body.includes('This socket forwards only ship and fleet calls') }))).toEqual(refused.map((path) => ({ path, status: 403, isTheSockets: true })));
  });
});
