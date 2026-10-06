import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { trierarchContentType, type ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

// The shared Postgres container's URL, which the global setup provides to every file.
import type {} from '../../server/test/postgres.global-setup.js';
import { createApp } from '../../server/src/app.js';
import { createPrismaClient, type PrismaClient } from '../../server/src/adapters/prisma/client.js';
import { createUseCases } from '../../server/src/wiring.js';
import { FLEET_URL, OPERATOR, operatorCaller, secretOf } from '../../server/test/support/core-fixtures.js';
import { createMigratedDatabase } from '../../server/test/support/database.js';
import { newKey } from '../../server/test/support/keys.js';
import { unwrap } from '../../server/test/support/result.js';
import { createClaudeCodeHarness } from '../src/adapters/claude-code.js';
import { readCrewFile } from '../src/adapters/files.js';
import { runCommand } from '../src/adapters/run-command.js';
import { createGitWorkspace } from '../src/adapters/git-workspace.js';
import { createJsonState } from '../src/adapters/json-state.js';
import { trierarchPaths, type TrierarchPaths } from '../src/adapters/paths.js';
import { createRestFleet, type RestFleet } from '../src/adapters/rest-fleet.js';
import type { Tmux } from '../src/adapters/tmux.js';
import { initTrierarch } from '../src/cli/init.js';
import { createHandleDelivery } from '../src/core/handle-delivery.js';
import type { ObservedSession } from '../src/core/ports.js';
import { createRunPass } from '../src/core/run-pass.js';
import { CONFIGURATION } from './support/in-memory.js';

// The trierarch against a real fleet server on Postgres, over REST: a want
// crews the ship and writes its folder's identity through the aeolus plugin's
// own script, and release ends the lease. Only the sessions are stand-ins:
// no Claude Code runs here.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../plugins/aeolus', import.meta.url));

let database: PrismaClient;
let server: FastifyInstance;
let address: string;
let home: string;
let paths: TrierarchPaths;
let notes: string;
let pluginData: string;

/** Sessions as a map, standing in for tmux: started ones run until stopped. */
function standInSessions(): Tmux {
  const sessions = new Map<ShipId, ObservedSession['status']>();
  return {
    list: () => Promise.resolve([...sessions].map(([shipId, status]) => ({ shipId, status }))),
    stop: (shipId) => {
      sessions.delete(shipId);
      return Promise.resolve();
    },
    start: ({ shipId }) => {
      sessions.set(shipId, 'running');
      return Promise.resolve();
    },
    type: () => Promise.resolve(),
  };
}

beforeEach(async () => {
  const databaseUrl = await createMigratedDatabase();
  database = createPrismaClient(databaseUrl);
  server = createApp({ databaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: 100 });
  address = await server.listen({ host: '127.0.0.1', port: 0 });
  home = mkdtempSync(join(tmpdir(), 'trierarch-home-'));
  paths = trierarchPaths({ homeDirectory: home });
  notes = join(home, 'notes');
  mkdirSync(notes);
  notes = realpathSync(notes);
  pluginData = join(home, 'plugin-data');
});

afterEach(async () => {
  await server.close();
  await database.$disconnect();
  rmSync(home, { recursive: true, force: true });
});

describe('the trierarch on a real fleet', () => {
  it('crews a wanted ship and writes its identity, and release ends its lease', async () => {
    const useCases = createUseCases({ prisma: database });
    const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
    const commission = async (name: string, more: { type: string; fleetScopes?: ['fleet:crew'] }) => {
      const { shipId, secret } = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name, ...more }));
      return { shipId, secret: secretOf(secret) };
    };
    const trierarchShip = await commission('mac-mini', { type: 'trierarch', fleetScopes: ['fleet:crew'] });
    const orchestrator = await commission('orchestrator', { type: 'orchestrator' });
    const scout = await commission('scout', { type: 'reviewer' });

    await initTrierarch({ paths, crew: { fleetUrl: address, ...trierarchShip }, fleetAt: (fleetUrl) => createRestFleet({ fleetUrl, crewToken: '' }) });
    const fleet = createRestFleet(await readCrewFile(paths.crewToken));
    const configuration = { ...CONFIGURATION, folders: { notes: { path: notes } } };
    const sessions = standInSessions();
    const harness = createClaudeCodeHarness({ configuration, plugin: { root: PLUGIN_ROOT, data: pluginData }, sessions });
    const workspace = createGitWorkspace({ configuration, root: paths.worktrees });
    const state = createJsonState(paths.state);
    const clock = { now: () => new Date() };
    const logger = { warn: () => undefined };
    const setup = { configuration, version: '0.0.0' };
    const handle = createHandleDelivery({ fleet, workspace, state, setup, clock, logger });
    const pass = createRunPass({ fleet, harness, processes: sessions, workspace, state, setup, clock, logger });
    const handleWhatCame = async (trierarch: RestFleet) => {
      for (const delivery of await trierarch.receive()) {
        await handle(delivery);
      }
    };

    const requester = createRestFleet({ fleetUrl: address, crewToken: '' });
    const requesterToken = (await requester.registerSelf(orchestrator)).crewToken;
    const asRequester = createRestFleet({ fleetUrl: address, crewToken: requesterToken });
    const command = async (name: string, payload: unknown) => {
      const response = await fetch(`${address}/api/v1/ship/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${requesterToken}` },
        body: JSON.stringify({ selector: { kind: 'ship', shipId: trierarchShip.shipId }, payload: JSON.stringify(payload), contentType: trierarchContentType(name), model: 'claude-opus-5-5', idempotencyKey: newKey() }),
      });
      expect(response.status).toBe(200);
    };
    /** What the requester received, each acknowledged. */
    const answers = async () => {
      const received = await asRequester.receive();
      for (const delivery of received) {
        await asRequester.ack(delivery.deliveryId);
      }
      return received;
    };
    const leasesOf = (shipId: ShipId) => database.lease.count({ where: { shipId, endedAt: null } });

    await command('want', { shipId: scout.shipId, harness: 'claude-code', workspace: { kind: 'folder', name: 'notes' }, options: {} });
    await handleWhatCame(fleet);
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(1);
    const identityPath = runCommand('bash', {
      args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'],
      env: { AEOLUS_FOLDER: notes, AEOLUS_DATA: pluginData },
    });
    const identity = readFileSync((await identityPath).stdout.trim(), 'utf8');
    expect(identity).toContain(`shipId=${scout.shipId}\n`);
    expect(identity).toContain('shipName=scout\n');
    expect(identity).toContain('wakeBy=trierarch\n');
    const sessionToken = /^crewToken=(.+)$/m.exec(identity)?.[1] ?? '';
    await expect(fleet.inbox(sessionToken)).resolves.toEqual({ kind: 'waiting', count: 0 });
    const answered = await answers();
    expect(answered.map((delivery) => delivery.contentType)).toEqual([trierarchContentType('wanted'), trierarchContentType('running')]);

    await command('release', { shipId: scout.shipId });
    await handleWhatCame(fleet);
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(0);
    await expect(fleet.inbox(sessionToken)).resolves.toEqual({ kind: 'leaseEnded' });
    const [released, ...more] = await answers();
    expect(more).toEqual([]);
    expect(released?.contentType).toBe(trierarchContentType('released'));
    expect(z.object({ shipId: z.string(), workspace: z.string() }).parse(JSON.parse(released?.payload ?? '{}'))).toMatchObject({ shipId: scout.shipId, workspace: 'kept' });
  });
});
