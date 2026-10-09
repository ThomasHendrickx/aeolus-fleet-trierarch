import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ShipId } from '@aeolus-fleet/common';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The shared Postgres container's URL, which the global setup provides to every file.
import type {} from '../../core/test/postgres.global-setup.js';
import { createApp } from '../../core/src/app.js';
import { createPrismaClient, type PrismaClient } from '../../core/src/adapters/prisma/client.js';
import { createUseCases } from '../../core/src/wiring.js';
import { FLEET_URL, OPERATOR, operatorCaller, secretOf } from '../../core/test/support/core-fixtures.js';
import { createMigratedDatabase } from '../../core/test/support/database.js';
import { newKey } from '../../core/test/support/keys.js';
import { unwrap } from '../../core/test/support/result.js';
import { createClaudeCodeHarness } from '../src/adapters/claude-code.js';
import { adapterFlagsOf, riskyFlagsOf } from '../src/adapters/harnesses.js';
import { createClaudeCodeSetup } from '../src/adapters/claude-code-setup.js';
import { readCrewFile } from '../src/adapters/files.js';
import { runCommand } from '../src/adapters/run-command.js';
import { createGitWorkspace } from '../src/adapters/git-workspace.js';
import { createJsonState } from '../src/adapters/json-state.js';
import { trierarchPaths, type TrierarchPaths } from '../src/adapters/paths.js';
import { createRestFleet } from '../src/adapters/rest-fleet.js';
import type { Tmux } from '../src/adapters/tmux.js';
import { createTrust } from '../src/adapters/trust.js';
import { initTrierarch } from '../src/cli/init.js';
import type { ObservedSession } from '../src/core/ports.js';
import { createRunPass } from '../src/core/run-pass.js';
import { CONFIGURATION } from './support/in-memory.js';

// The trierarch against a real fleet server on Postgres, over REST: a crew
// request assigned to it is crewed in a worktree of a real git repository,
// with the folder's identity written through the aeolus plugin's own script,
// and removing the request ends the lease. Only the sessions are stand-ins:
// no Claude Code runs here.

const PLUGIN_ROOT = fileURLToPath(new URL('../../../plugins/aeolus', import.meta.url));
const GIT_ENV = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };

let database: PrismaClient;
let server: FastifyInstance;
let address: string;
let home: string;
let paths: TrierarchPaths;
let repository: string;
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

async function git(args: string[]): Promise<void> {
  const result = await runCommand('git', { args, env: GIT_ENV });
  expect(result.status, result.stderr).toBe(0);
}

beforeEach(async () => {
  const databaseUrl = await createMigratedDatabase();
  database = createPrismaClient(databaseUrl);
  server = createApp({ databaseUrl, publicUrl: FLEET_URL, logger: false, receiveWaitMs: 100 });
  address = await server.listen({ host: '127.0.0.1', port: 0 });
  home = realpathSync(mkdtempSync(join(tmpdir(), 'trierarch-home-')));
  paths = trierarchPaths({ homeDirectory: home });
  repository = join(home, 'aeolus-fleet');
  await git(['init', '-q', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), 'hello\n');
  await git(['-C', repository, 'add', '.']);
  await git(['-C', repository, 'commit', '-q', '-m', 'init']);
  mkdirSync(join(home, 'notes'));
  pluginData = join(home, 'plugin-data');
});

afterEach(async () => {
  await server.close();
  await database.$disconnect();
  rmSync(home, { recursive: true, force: true });
});

/** A trierarch set up with init on a real fleet, with a ship scout of the fleet to crew, and one pass of its loop. */
async function aTrierarchOnTheFleet() {
  const useCases = createUseCases({ prisma: database });
  const argo = operatorCaller(unwrap(await useCases.initialiseFleet({ name: 'home fleet', ...OPERATOR })));
  const trierarchShip = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'mac-mini', type: 'trierarch', fleetScopes: ['crew:run'] }));
  const scout = unwrap(await useCases.commissionShip(argo, { idempotencyKey: newKey(), name: 'scout', type: 'reviewer' }));

  const service = { install: () => Promise.resolve(), restart: () => Promise.resolve(), status: () => Promise.resolve({ file: 'none', isInstalled: true, isRunning: true }) };
  // The places come with init, as an operator adds them: adding a place through init is what trusts it (#381).
  const configuration = { ...CONFIGURATION, repositories: { 'aeolus-fleet': { path: repository } }, folders: { notes: { path: join(home, 'notes') } } };
  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, JSON.stringify(configuration));
  const quiet = { text: () => Promise.reject(new Error('asked')), secret: () => Promise.reject(new Error('asked')), confirm: () => Promise.reject(new Error('asked')), say: () => undefined, step: () => undefined };
  await initTrierarch({
    homeDirectory: home,
    paths,
    flags: { fleetUrl: address, shipId: trierarchShip.shipId, secret: secretOf(trierarchShip.secret), isYes: true },
    prompter: quiet,
    fleetAt: (fleetUrl) => createRestFleet({ fleetUrl, crewToken: '' }),
    claudeCode: createClaudeCodeSetup({ homeDirectory: home }),
    codex: { trust: () => Promise.reject(new Error('no Codex here')), trustAeolusHooks: () => Promise.reject(new Error('no Codex here')) },
    isCodexInstalled: false,
    service,
    detect: () => Promise.resolve({}),
  });
  const fleet = createRestFleet(await readCrewFile(paths.crewToken));
  const sessions = standInSessions();
  const harness = createClaudeCodeHarness({ configuration, plugin: { root: PLUGIN_ROOT, data: pluginData }, projects: join(home, '.claude', 'projects'), sessions });
  const workspace = createGitWorkspace({ configuration, root: paths.worktrees });
  const state = createJsonState(paths.state);
  const clock = { now: () => new Date() };
  const logger = { warn: () => undefined, action: () => undefined };
  const setup = { configuration, version: '0.0.0', adapterFlags: adapterFlagsOf(configuration), riskyFlags: riskyFlagsOf(configuration) };
  const pass = createRunPass({ fleet, harnesses: { 'claude-code': harness }, processes: sessions, workspace, trust: createTrust({ configuration, homeDirectory: home, env: {} }), state, setup, clock, logger });
  const leasesOf = (shipId: ShipId) => database.lease.count({ where: { shipId, endedAt: null } });
  const worktree = join(paths.worktrees, 'aeolus-fleet', 'scout');

  return { useCases, argo, trierarchShip, scout, pass, leasesOf, worktree };
}

describe('the trierarch on a real fleet', () => {
  it('crews an assigned request, its status reads running, and removing it ends the lease, removes the clean worktree and the request', async () => {
    const { useCases, argo, trierarchShip, scout, pass, leasesOf, worktree } = await aTrierarchOnTheFleet();
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(1);
    await expect(database.crewRequest.findUniqueOrThrow({ where: { shipId: scout.shipId } })).resolves.toMatchObject({ status: 'running' });
    expect(existsSync(join(worktree, 'README.md'))).toBe(true);
    const identityPath = await runCommand('bash', { args: [`${PLUGIN_ROOT}/scripts/aeolus-identity.sh`, 'path'], env: { AEOLUS_FOLDER: worktree, AEOLUS_DATA: pluginData } });
    const identity = readFileSync(identityPath.stdout.trim(), 'utf8');
    expect(identity).toContain(`shipId=${scout.shipId}\n`);
    expect(identity).toContain('wakeBy=trierarch\n');

    unwrap(await useCases.removeCrewRequest(argo, { shipId: scout.shipId }));
    await pass();

    await expect(leasesOf(scout.shipId)).resolves.toBe(0);
    expect(existsSync(worktree)).toBe(false);
    await expect(database.crewRequest.findUnique({ where: { shipId: scout.shipId } })).resolves.toBeNull();
  });

  it('clears a kept worktree when argo asks, and confirms it removed it (#325, decision 0032)', async () => {
    const { useCases, argo, trierarchShip, scout, pass, worktree } = await aTrierarchOnTheFleet();
    unwrap(await useCases.requestCrew(argo, { shipId: scout.shipId, settings: { harness: 'claude-code', workspace: { kind: 'worktree', repository: 'aeolus-fleet' }, options: {} } }));
    unwrap(await useCases.assignCrew(argo, { shipId: scout.shipId, trierarchShipId: trierarchShip.shipId }));
    await pass();
    writeFileSync(join(worktree, 'draft.md'), 'work in progress\n');
    unwrap(await useCases.removeCrewRequest(argo, { shipId: scout.shipId }));
    await pass();
    expect(existsSync(worktree)).toBe(true);

    unwrap(await useCases.requestWorktreeClear(argo, { trierarchShipId: trierarchShip.shipId, shipId: scout.shipId, repository: 'aeolus-fleet' }));
    await pass();

    expect(existsSync(worktree)).toBe(false);
    await expect(useCases.readClearRequests(argo)).resolves.toEqual([]);
    await expect(database.event.findMany({ where: { type: 'WorktreeCleared' }, select: { details: true } })).resolves.toEqual([
      { details: { worktreeShipId: scout.shipId, repository: 'aeolus-fleet', outcome: 'removed' } },
    ]);
  });
});
